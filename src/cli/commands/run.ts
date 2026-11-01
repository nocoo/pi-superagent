/** `run`: start the agent, and nothing else. No flag here changes the stored configuration. */
import { CliError } from '../errors.ts'
import { openForRead, locked } from '../context.ts'
import { emit, line, type Cli } from '../output.ts'
import { resolveAccount } from '../../config.ts'
import { KV } from '../../kv.ts'
import { Host } from '../../runtime/host.ts'
import { githubKind } from '../../sources/github.ts'
import { policyVersion } from '../../policy.ts'

/** How long a graceful stop may take before the process exits anyway. */
const STOP_TIMEOUT_MS = 15_000

export async function run(cli: Cli, options: { verbose?: boolean }): Promise<void> {
  const store = openForRead(cli)
  let settings
  try { settings = store.settings() } finally { store.close() }

  const config = settings.sources.github?.config as { repository?: string; cli?: string } | undefined
  if (!config?.repository) {
    throw new CliError('not_configured', `this instance has no repository`, 'configure one with: pi-superagent config set --repository owner/name')
  }
  if (locked(cli.stateDir)) {
    throw new CliError('locked', `another process holds ${cli.stateDir}`, 'stop it before starting another')
  }

  const cliName = config.cli ?? 'gh'
  const account = await resolveAccount(cliName)
  const host = new Host({ stateDir: cli.stateDir, deployment: { repository: config.repository, github: { cli: cliName, ...account } } })
  host.store.set(KV.runtime.account, { login: account.login, noreply: account.noreply })
  if (options.verbose) process.env.PI_SUPERAGENT_LOG = '1'

  host.register(githubKind)
  host.start()

  emit(cli, 'run', { repository: config.repository, account: account.login, stateDir: cli.stateDir, policy: policyVersion(settings) },
    () => line(`watching ${config.repository} as @${account.login}; state in ${cli.stateDir}`))

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
