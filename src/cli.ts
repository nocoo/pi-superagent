#!/usr/bin/env node
/** Command line entry: `run` starts the agent, `status` prints what it is doing. */
import { parseArgs } from 'node:util'
import { mkdirSync } from 'node:fs'
import { Host } from './runtime/host.ts'
import { githubKind } from './sources/github.ts'
import { policyVersion, type Settings } from './policy.ts'
import { Store } from './store/store.ts'
import { join } from 'node:path'

const USAGE = `pi-superagent — a proactive agent for one repository

  pi-superagent run    --state-dir DIR --repository OWNER/NAME [--allowed LOGIN]... [options]
  pi-superagent status --state-dir DIR

run options
  --github-cli NAME     the gh wrapper signed in to the agent account (default: gh)
  --prepare COMMAND     shell command that creates a ticket's directory (default: none, an empty directory)
  --model PROVIDER/MODEL  worker model (default: Pi's configured default)
  --assess-model PROVIDER/MODEL  assessment model (default: the worker model)
  --max-workers N       concurrent tickets (default: 3)

The first run writes settings; later runs reuse them and only apply the options they are given.`

/** Reads repeatable and single-valued options from argv. */
function options(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'state-dir': { type: 'string' },
      repository: { type: 'string' },
      allowed: { type: 'string', multiple: true },
      'github-cli': { type: 'string' },
      prepare: { type: 'string' },
      model: { type: 'string' },
      'assess-model': { type: 'string' },
      'max-workers': { type: 'string' },
    },
  })
  return { command: positionals[0], values }
}

/** Splits `provider/model` into the Policy's role model shape. */
function roleModel(route: string | undefined) {
  if (!route) return null
  const slash = route.indexOf('/')
  if (slash <= 0) throw new Error(`--model must be PROVIDER/MODEL, not ${route}`)
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

/** Applies the options given on the command line over the stored settings. */
function settingsFrom(stored: Settings, values: ReturnType<typeof options>['values']): Settings {
  const github = stored.sources.github
  const config = { ...(github?.config ?? {}) }
  const allowed = values.allowed?.map(id => ({ id })) ?? stored.policy.sources.github?.allowed ?? []
  const model = roleModel(values.model)
  const assess = roleModel(values['assess-model'])
  return {
    ...stored,
    sources: { ...stored.sources, github: { enabled: true, config } },
    policy: {
      ...stored.policy,
      sources: { ...stored.policy.sources, github: { admission: {}, ...stored.policy.sources.github, allowed } },
    },
    eval: { ...stored.eval, ...assess ? { model: assess } : {} },
    executor: {
      ...stored.executor,
      ...model ? { model } : {},
      ...values.prepare !== undefined ? { prepare: values.prepare } : {},
      ...values['max-workers'] ? { maxWorkers: Number(values['max-workers']) } : {},
    },
  }
}

async function run(argv: string[]): Promise<void> {
  const { values } = options(argv)
  const stateDir = values['state-dir']
  if (!stateDir) throw new Error('--state-dir is required')
  const repository = values.repository
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('--repository OWNER/NAME is required')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const host = new Host({ stateDir, deployment: { repository, github: { cli: values['github-cli'] ?? 'gh', login: '', noreply: '' } } })
  const before = host.settings()
  const after = settingsFrom(before, values)
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    host.store.saveSettings(after, { source: 'internal', block: 'policy', policyVersion: policyVersion(after), policyChanged: false, notified: [] })
  }
  host.register(githubKind)
  host.start()
  const shutdown = (): void => { void host.stop().then(() => process.exit(0)) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  console.log(`pi-superagent is watching ${repository}; state in ${stateDir}`)
  await new Promise<void>(() => { setInterval(() => {}, 1 << 30) })
}

function status(argv: string[]): void {
  const { values } = options(argv)
  const stateDir = values['state-dir']
  if (!stateDir) throw new Error('--state-dir is required')
  const store = new Store(join(stateDir, 'superagent.sqlite'))
  try {
    const settings = store.settings()
    const open = store.tickets.open()
    console.log(`policy ${policyVersion(settings)} · mode ${settings.eval.mode} · paused ${settings.paused}`)
    console.log(`${open.length} open ticket(s)`)
    for (const ticket of open) {
      const assignment = ticket.assignments.at(-1)
      console.log(`  ${ticket.id} ${ticket.title}\n    mandate ${ticket.mandate.strength} · ${assignment?.state ?? 'no assignment'}`
        + `${assignment?.report ? ` · report ${assignment.report.state}: ${assignment.report.summary.slice(0, 120)}` : ''}`)
    }
  } finally { store.close() }
}

const { command } = options(process.argv.slice(2))
try {
  if (command === 'run') await run(process.argv.slice(2))
  else if (command === 'status') status(process.argv.slice(2))
  else { console.log(USAGE); process.exit(command ? 1 : 0) }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
