/** `run`: start the agent, and nothing else. No flag here changes the stored configuration. */
import { CliError } from '../errors.ts'
import { openForRead, locked } from '../context.ts'
import { emit, line, type Cli } from '../output.ts'
import { resolveAccount } from '../../config.ts'
import { KV } from '../../kv.ts'
import { Host } from '../../runtime/host.ts'
import { githubKind } from '../../sources/github.ts'
import { imKind } from '../../sources/im.ts'
import { policyVersion, type Settings } from '../../policy.ts'

/** How long a graceful stop may take before the process exits anyway. */
const STOP_TIMEOUT_MS = 15_000

/** The Sources that can be running, by the name a configuration uses. */
const KINDS = { github: githubKind, im: imKind }

/** The Sources this instance has enabled. A Source kind that is not installed is skipped rather than failing the start. */
const enabled = (settings: Settings): string[] =>
  Object.entries(settings.sources).filter(([, stored]) => stored.enabled && stored.enabled).map(([name]) => name)

export async function run(cli: Cli, options: { verbose?: boolean }): Promise<void> {
  const store = openForRead(cli)
  let settings: Settings
  try { settings = store.settings() } finally { store.close() }

  const running = enabled(settings).filter(name => name in KINDS)
  if (!running.length) {
    throw new CliError('not_configured', 'this instance has no Source enabled', [
      'configure GitHub: pi-superagent config set --repository owner/name',
      'or the local IM: pi-superagent config set --im',
    ].join('\n  '))
  }
  if (locked(cli.stateDir)) throw new CliError('locked', `another process holds ${cli.stateDir}`, 'stop it before starting another')

  const github = running.includes('github') ? settings.sources.github?.config as { repository?: string; cli?: string } | undefined : undefined
  if (running.includes('github') && !github?.repository) {
    throw new CliError('not_configured', 'the GitHub Source has no repository', 'configure one with: pi-superagent config set --repository owner/name')
  }
  const cliName = github?.cli ?? 'gh'
  const account = github ? await resolveAccount(cliName) : undefined

  const host = new Host({ stateDir: cli.stateDir, deployment: { repository: github?.repository ?? '', github: { cli: cliName, login: account?.login ?? '', noreply: account?.noreply ?? '' } } })
  if (account) host.store.set(KV.runtime.account, { login: account.login, noreply: account.noreply })
  if (options.verbose) process.env.PI_SUPERAGENT_LOG = '1'

  for (const name of running) host.register(KINDS[name as keyof typeof KINDS] as never)
  host.start()

  emit(cli, 'run', { sources: running, repository: github?.repository, account: account?.login, stateDir: cli.stateDir,
    policy: policyVersion(settings) }, () => {
    const identity = account ? ` as @${account.login}` : ''
    const where = github?.repository ? ` ${github.repository}` : ''
    line(`running ${running.join(', ')}${where}${identity}; state in ${cli.stateDir}`)
  })

  await new Promise<void>(resolve => {
    let stopping = false
    /** Stops once; a second signal exits at once, so a wedged worker cannot trap the operator. */
    const stop = (signal: string): void => {
      if (stopping) { process.stderr.write(`${signal} again; exiting now\n`); process.exit(1) }
      stopping = true
      process.stderr.write(`${signal}; stopping…\n`)
      const deadline = setTimeout(() => { process.stderr.write('stop took too long; exiting\n'); process.exit(1) }, STOP_TIMEOUT_MS)
      deadline.unref()
      void host.stop().then(() => resolve(), error => {
        process.stderr.write(`stop failed: ${error instanceof Error ? error.message : String(error)}\n`)
        resolve()
      })
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))
  })
}
