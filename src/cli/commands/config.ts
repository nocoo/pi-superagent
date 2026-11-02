/**
 * `config`: the deployment and the Policy. This is the only command that changes state, and it always says what it
 * changed — a configuration the operator cannot see is worse than one they have to type.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, policyVersion, type Settings } from '../../policy.ts'
import { KV } from '../../kv.ts'
import { CliError } from '../errors.ts'
import { openForRead } from '../context.ts'
import { writeInstance } from './manage.ts'
import { clip, emit, line, table, type Cli } from '../output.ts'

/** A field that changed, with the values a person can compare. */
interface Change { field: string; before: string; after: string }

const show = (value: unknown): string => value === undefined || value === null || value === '' ? '—'
  : Array.isArray(value) ? value.join(', ') || '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** Splits `provider/model` into the Policy's role model shape, at the first slash. */
function roleModel(route: string, flag: string): { provider: string; model: string } {
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) throw new CliError('usage', `${flag} must be provider/model, not ${route}`)
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

export function configShow(cli: Cli): void {
  const store = openForRead(cli)
  try {
    const settings = store.settings()
    const account = store.get(KV.runtime.account)
    const github = settings.sources.github?.config as { repository?: string; cli?: string } | undefined
    const enabled = settings.policy.rules.filter(rule => rule.enabled)

    emit(cli, 'config show', { settings, account, revision: store.get(KV.settings.revision) ?? 0, policyVersion: policyVersion(settings) }, () => {
      table([
        ['repository', github?.repository ?? '—'],
        ['account', account ? `@${account.login} via ${github?.cli ?? 'gh'}` : 'resolved when the agent starts'],
        ['state', cli.stateDir],
      ])
      if (settings.sources.im?.enabled) {
        const im = settings.sources.im.config as { agent?: string; observed?: string[] }
        table([['im', `agent @${im.agent ?? 'agent'} · observes ${im.observed?.length ? im.observed.join(', ') : 'nothing unaddressed'}`]])
        line()
      }
      table([
        ['policy', `${policyVersion(settings).slice(0, 8)} · accept ${settings.eval.mode} · ${enabled.length} rules`
          + ` · ${Object.values(settings.policy.sources).reduce((total, part) => total + (part.allowed?.length ?? 0), 0)} allowed`],
        ...enabled.map((rule, index) => [index ? '' : 'rules', `${rule.id.padEnd(10)} ${clip(rule.instruction, 80)}`]),
        ['eval', `timeout ${settings.eval.timeoutSeconds}s${settings.eval.model ? ` · model ${settings.eval.model.provider}/${settings.eval.model.model}` : ''}`],
        ['executor', `${settings.executor.model ? `model ${settings.executor.model.provider}/${settings.executor.model.model} · ` : ''}${settings.executor.maxWorkers} workers`],
        ['', settings.executor.prepare ? `prepare  ${clip(settings.executor.prepare, 80)}` : 'prepare  none — the worker starts in an empty directory'],
      ])
    })
  } finally { store.close() }
}

export async function configSet(cli: Cli, options: Record<string, unknown>): Promise<void> {
  const store = existsSync(join(cli.stateDir, 'superagent.sqlite')) ? openForRead(cli) : undefined
  const before = store?.settings() ?? SettingsSchema.parse({})
  const revision = store?.get(KV.settings.revision) ?? 0
  store?.close()
  {
    const after = apply(before, options)
    const changes = diff(before, after)
    const dry = options.dryRun === true
    const removed = removedLogins(before, after)

    if (removed.length && options.yes !== true && !dry) {
      throw new CliError('usage', `--allowed would remove ${removed.join(', ')}`,
        'use --add-allowed to widen the list, or pass --yes to accept the removal')
    }
    if (!changes.length) {
      emit(cli, 'config set', { changes: [], policyVersion: policyVersion(after) }, () => line('nothing to change'))
      return
    }
    if (!dry) {
      await writeInstance(cli, { action: 'settings.save', payload: { value: after, baseRevision: revision } })
    }

    emit(cli, 'config set', { changes, dryRun: dry, policyVersion: policyVersion(after) }, () => {
      table(changes.map(change => [change.field, show(change.before), '→', show(change.after)]))
      if (removed.length) line(`removes ${removed.join(', ')} from the allowed list`)
      if (policyVersion(after) !== policyVersion(before)) {
        line(`policy ${policyVersion(before).slice(0, 8)} → ${policyVersion(after).slice(0, 8)}`)
      }
      line(dry ? 'dry run — nothing written' : 'written')
    })
  }
}

/** Applies the flags over the stored settings, leaving every field they do not name untouched. */
function apply(settings: Settings, options: Record<string, unknown>): Settings {
  const next = structuredClone(settings)
  // A Source is enabled only by a flag that concerns it, so configuring one never switches another one on.
  const githubFlags = ['repository', 'allowed', 'addAllowed', 'removeAllowed'] as const
  if (githubFlags.some(flag => options[flag] !== undefined)) {
    const github = (next.sources.github ??= { enabled: true, config: {} })
    github.enabled = true
    const config = github.config as Record<string, unknown>
    if (typeof options.repository === 'string') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) {
        throw new CliError('usage', `--repository must be owner/name, not ${options.repository}`)
      }
      config.repository = options.repository
    }
    const part = (next.policy.sources.github ??= { allowed: [], admission: {} })
    const logins = part.allowed ?? []
    if (Array.isArray(options.allowed)) part.allowed = (options.allowed as string[]).map(id => ({ id }))
    if (Array.isArray(options.addAllowed)) {
      const added = (options.addAllowed as string[]).filter(id => !logins.some(entry => entry.id === id)).map(id => ({ id }))
      part.allowed = [...logins, ...added]
    }
    if (Array.isArray(options.removeAllowed)) {
      part.allowed = logins.filter(entry => !(options.removeAllowed as string[]).includes(entry.id))
    }
  }
  if (typeof options.mode === 'string') {
    if (!['off', 'observe', 'auto'].includes(options.mode)) throw new CliError('usage', `--mode ${options.mode} is not off, observe or auto`)
    next.eval.mode = options.mode as Settings['eval']['mode']
  }
  if (typeof options.model === 'string') next.executor.model = { ...roleModel(options.model, '--model'), ...effort(next.executor.model) }
  if (typeof options.assessModel === 'string') next.eval.model = { ...roleModel(options.assessModel, '--assess-model'), ...effort(next.eval.model) }
  if (typeof options.maxWorkers === 'number') {
    if (options.maxWorkers < 1) throw new CliError('usage', `--max-workers must be at least 1, not ${options.maxWorkers}`)
    next.executor.maxWorkers = options.maxWorkers
  }
  if (typeof options.prepare === 'string') next.executor.prepare = options.prepare
  const imFlags = ['im', 'imAgent', 'imObserved', 'imAllowed'] as const
  if (imFlags.some(flag => options[flag] !== undefined)) {
    const im = (next.sources.im ??= { enabled: true, config: {} })
    im.enabled = true
    const imConfig = im.config as Record<string, unknown>
    if (typeof options.imAgent === 'string') imConfig.agent = options.imAgent
    if (Array.isArray(options.imObserved)) imConfig.observed = options.imObserved as string[]
    if (Array.isArray(options.imAllowed)) {
      const part = (next.policy.sources.im ??= { allowed: [], admission: {} })
      part.allowed = (options.imAllowed as string[]).map(id => ({ id }))
    }
  }
  if (options.inbox === true || options.inboxAllowed !== undefined || options.inboxObserved !== undefined) {
    const inbox = (next.sources.inbox ??= { enabled: true, config: {} })
    inbox.enabled = true
    if (Array.isArray(options.inboxObserved)) inbox.config.observed = options.inboxObserved
    if (Array.isArray(options.inboxAllowed)) {
      const part = (next.policy.sources.inbox ??= { allowed: [], admission: {} })
      part.allowed = (options.inboxAllowed as string[]).map(id => ({ id }))
    }
  }
  if (options.pause === true) next.paused = true
  if (options.resume === true) next.paused = false
  return SettingsSchema.parse(next)
}

/** Keeps a configured reasoning level when only the route changes. */
const effort = (model: Settings['eval']['model']): { reasoningEffort?: string } =>
  model?.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}

/** The fields a person would name, and only those that differ. */
function diff(before: Settings, after: Settings): Change[] {
  const changes: Change[] = []
  const compare = (field: string, was: unknown, now: unknown): void => {
    const [a, b] = [show(was), show(now)]
    if (a !== b) changes.push({ field, before: a, after: b })
  }
  const was = before.sources.github?.config as Record<string, unknown> | undefined
  const now = after.sources.github?.config as Record<string, unknown> | undefined
  compare('repository', was?.repository, now?.repository)
  compare('allowed', before.policy.sources.github?.allowed.map(entry => entry.id),
    after.policy.sources.github?.allowed.map(entry => entry.id))
  compare('mode', before.eval.mode, after.eval.mode)
  compare('model', route(before.executor.model), route(after.executor.model))
  compare('assess-model', route(before.eval.model), route(after.eval.model))
  compare('max-workers', before.executor.maxWorkers, after.executor.maxWorkers)
  compare('prepare', before.executor.prepare, after.executor.prepare)
  compare('paused', before.paused, after.paused)
  compare('im', before.sources.im?.enabled, after.sources.im?.enabled)
  const wasIm = before.sources.im?.config as Record<string, unknown> | undefined
  const nowIm = after.sources.im?.config as Record<string, unknown> | undefined
  compare('im-obs', wasIm?.observed as string[] | undefined, nowIm?.observed as string[] | undefined)
  compare('im-allowed', before.policy.sources.im?.allowed.map(entry => entry.id), after.policy.sources.im?.allowed.map(entry => entry.id))
  compare('inbox', before.sources.inbox?.enabled, after.sources.inbox?.enabled)
  compare('inbox-allowed', before.policy.sources.inbox?.allowed.map(entry => entry.id), after.policy.sources.inbox?.allowed.map(entry => entry.id))
  compare('inbox-observed', before.sources.inbox?.config.observed, after.sources.inbox?.config.observed)
  compare('rules', rulesOf(before), rulesOf(after))
  compare('admission', admissionOf(before), admissionOf(after))
  compare('bots', botsOf(before), botsOf(after))
  // Anything the named comparisons do not cover still has to be reported, so an edit can never be dropped silently.
  if (!changes.length && JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push({ field: 'settings', before: 'as stored', after: 'changed' })
  }
  return changes
}

/** Rules as a person reads them: the id and whether it is on. */
const rulesOf = (settings: Settings): string[] =>
  settings.policy.rules.map(rule => `${rule.id}${rule.enabled ? '' : ' (off)'}`)

/** The admission table, flattened to `source row cell=choice`. */
const admissionOf = (settings: Settings): string[] =>
  Object.entries(settings.policy.sources).flatMap(([source, part]) =>
    Object.entries(part.admission ?? {}).flatMap(([row, cells]) =>
      Object.entries(cells ?? {}).map(([cell, choice]) => `${source} ${row} ${cell}=${String(choice)}`)))

/** The bots whose messages may become candidates, per Source. */
const botsOf = (settings: Settings): string[] =>
  Object.entries(settings.policy.sources).flatMap(([source, part]) =>
    ((part as { bots?: { id: string }[] }).bots ?? []).map(bot => `${source}:${bot.id}`))

const route = (model: { provider: string; model: string } | null | undefined): string | undefined =>
  model ? `${model.provider}/${model.model}` : undefined

/** The logins a change would drop from the allowed list. */
const removedLogins = (before: Settings, after: Settings): string[] => {
  const was = before.policy.sources.github?.allowed.map(entry => entry.id) ?? []
  const now = new Set(after.policy.sources.github?.allowed.map(entry => entry.id) ?? [])
  return was.filter(id => !now.has(id))
}

/** Opens the settings in `$EDITOR` for the parts flags cannot express: rules, the admission table, bots. */
export async function configEdit(cli: Cli): Promise<void> {
  const store = openForRead(cli)
  let before: Settings
  let revision: number
  try { before = store.settings(); revision = store.get(KV.settings.revision) ?? 0 } finally { store.close() }

  const editor = process.env.EDITOR ?? process.env.VISUAL
  if (!editor) throw new CliError('failed', 'no editor configured', 'set $EDITOR, or use config set for the fields it supports')

  const directory = mkdtempSync(join(tmpdir(), 'pi-superagent-config-'))
  const file = join(directory, 'settings.json')
  writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`)
  try {
    // Through a shell, so an $EDITOR that carries arguments (`code -w`, `vim -u NONE`) still works.
    const result = spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' })
    if (result.status !== 0) throw new CliError('failed', `the editor exited with ${result.status ?? 'no status'}; nothing written`)
    const edited = readFileSync(file, 'utf8')
    let parsed: unknown
    try { parsed = JSON.parse(edited) } catch (error) {
      throw new CliError('failed', `the settings are not valid JSON, nothing written: ${error instanceof Error ? error.message : String(error)}`)
    }
    const validated = SettingsSchema.safeParse(parsed)
    if (!validated.success) {
      const first = validated.error.issues[0]
      throw new CliError('failed', `the settings are not valid, nothing written: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown problem'}`)
    }
    const after = validated.data
    const changes = diff(before, after)
    if (!changes.length) { line('nothing to change'); return }
    await writeInstance(cli, { action: 'settings.save', payload: { value: after, baseRevision: revision } })
    table(changes.map(change => [change.field, clip(change.before, 60), '→', clip(change.after, 60)]))
    line('written')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
