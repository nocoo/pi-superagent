/**
 * The command line, which is this agent's primary surface. Everything a supervisor needs is answered here; see
 * docs/005-cli.md for the design. Conventions: data on stdout, everything else on stderr, `--json` for scripts, exit 2
 * for a wrong invocation and 1 for a right one whose answer is no.
 */
import { Command, CommanderError } from 'commander'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from './prompts.ts'
import { CliError, EXIT, UsageError } from './cli/errors.ts'
import type { Cli } from './cli/output.ts'
import { stateDirPath } from './cli/context.ts'
import { status } from './cli/commands/status.ts'
import { source } from './cli/commands/source.ts'
import { threadList, threadShow } from './cli/commands/thread.ts'
import { triggerShow } from './cli/commands/trigger.ts'
import { decisionList, decisionShow } from './cli/commands/decision.ts'
import { ticketList, ticketRead, ticketShow } from './cli/commands/ticket.ts'
import { configEdit, configSet, configShow } from './cli/commands/config.ts'
import { run } from './cli/commands/run.ts'

const version = (): string => (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version

/** The name of the command being run, for the `command` field of JSON output and error objects. */
let invoked = 'pi-superagent'

const program = new Command()
program
  .name('pi-superagent')
  .description('A proactive agent for one repository. Run `pi-superagent <command>` to inspect it.')
  .version(version(), '-V, --version', 'print the version')
  .option('--state-dir <dir>', 'instance directory (default: $PI_SUPERAGENT_STATE_DIR or ~/.pi-superagent/state)')
  .option('--json', 'print one JSON object instead of prose')
  .showHelpAfterError()
  .exitOverride()
  .hook('preAction', (_program, action) => {
    const path: string[] = []
    // Stop before the root program, so the name is `ticket list` rather than `pi-superagent ticket list`.
    for (let command: Command | null = action; command?.parent; command = command.parent) path.unshift(command.name())
    invoked = path.join(' ')
  })

/** Reads the global flags, which commander exposes to every subcommand. */
const context = (command: Command): Cli => {
  const options = command.optsWithGlobals() as { stateDir?: string; json?: boolean }
  return { stateDir: stateDirPath(options.stateDir), json: options.json === true }
}

const wrap = <A extends unknown[]>(handler: (cli: Cli, ...args: A) => Promise<void> | void) =>
  async (...args: A): Promise<void> => {
    const command = args.at(-1) instanceof Command ? args.at(-1) as Command : undefined
    await handler(context(command!), ...args)
  }

// Reading the whole system

program.command('status')
  .description('what needs a person, then system health')
  .option('--check', 'exit 1 when something needs a person')
  .action(wrap((cli, options: { check?: boolean }) => status(cli, options)))

program.command('source')
  .description('the Sources: whether they run, what is arriving')
  .action(wrap(cli => source(cli)))

// Following one piece of work

const thread = program.command('thread').description('Threads and their Triggers')
thread.command('list')
  .description('list threads')
  .option('--source <source>', 'only this Source')
  .option('--subscribed', 'only threads a Ticket subscribes to')
  .option('--limit <n>', 'how many to show', '20')
  .action(wrap((cli, options: { source?: string; subscribed?: boolean; limit: string }) => threadList(cli, options)))
thread.command('show <thread>')
  .description('one thread, its Triggers in time order, and what became of each')
  .option('--limit <n>', 'how many Triggers to show', '30')
  .action(wrap((cli, key: string, options: { limit: string }) => threadShow(cli, key, options)))

program.command('trigger')
  .description('one Trigger and where it went')
  .command('show <trigger>')
  .description('one Trigger in full, with its disposition')
  .action(wrap((cli, id: string) => triggerShow(cli, id)))

const decision = program.command('decision').description('what an Eval concluded and why')
decision.command('list')
  .description('list decisions')
  .option('--kind <kind...>', 'only these kinds: accept, stop, ignore, unavailable')
  .option('--since <duration>', 'only decisions about Triggers newer than this, such as 24h or 7d', '24h')
  .option('--limit <n>', 'how many to show', '20')
  .action(wrap((cli, options: { kind?: string[]; since: string; limit: string }) => decisionList(cli, options)))
decision.command('show <decision>')
  .description('one decision: why, which rules matched, and the direction it judged')
  .action(wrap((cli, id: string) => decisionShow(cli, id)))

const ticket = program.command('ticket').description('authorized work')
ticket.command('list')
  .description('list tickets, grouped by the stage that decides whom they wait for')
  .option('--stage <stage>', 'person, working, idle or ended')
  .option('--all', 'include ended tickets')
  .option('--limit <n>', 'how many to show', '30')
  .action(wrap((cli, options: { stage?: string; all?: boolean; limit: string }) => ticketList(cli, options)))
ticket.command('show <ticket>')
  .description('one ticket: its mandate, assignments and inputs')
  .action(wrap((cli, id: string) => ticketShow(cli, id)))
ticket.command('read <ticket>')
  .description("the worker's own conversation")
  .option('--lines <n>', 'how many messages to show', '40')
  .action(wrap((cli, id: string, options: { lines: string }) => ticketRead(cli, id, options)))

// Configuring

const config = program.command('config').description('the deployment and the Policy')
config.command('show', { isDefault: true })
  .description('the deployment, the rules and the settings')
  .action(wrap(cli => configShow(cli)))
config.command('set')
  .description('change one part of the configuration, printing what changed')
  .option('--repository <owner/name>', 'the repository the agent works on')
  .option('--allowed <login...>', 'replace the whole allowed list')
  .option('--add-allowed <login...>', 'add logins to the allowed list')
  .option('--remove-allowed <login...>', 'remove logins from the allowed list')
  .option('--mode <mode>', 'off, observe or auto')
  .option('--model <route>', 'worker model, as provider/model')
  .option('--assess-model <route>', 'assessment model, as provider/model')
  .option('--max-workers <n>', 'how many tickets may run at once')
  .option('--prepare <command>', 'shell command that creates a ticket directory')
  .option('--pause', 'stop starting new work')
  .option('--resume', 'start new work again')
  .option('--dry-run', 'print what would change and write nothing')
  .option('--yes', 'do not refuse a change that removes authorized logins')
  .action(wrap((cli, options: Record<string, unknown>) => configSet(cli, options)))
config.command('edit')
  .description('edit the stored settings in $EDITOR; parts flags cannot express')
  .action(wrap(cli => configEdit(cli)))

program.command('run')
  .description('start the agent')
  .option('--verbose', 'log every domain event')
  .action(wrap((cli, options: { verbose?: boolean }) => run(cli, options)))

/** Reports a failure in the shape the conventions promise, and returns the process status. */
function report(error: unknown, json: boolean): number {
  const known = error instanceof CliError ? error
    : error instanceof UsageError ? new CliError('usage', error.message)
      : undefined
  if (known) {
    if (json) process.stderr.write(`${JSON.stringify({ command: invoked, error: { code: known.code, message: known.message } })}\n`)
    else process.stderr.write(`pi-superagent: ${known.message}\n${known.hint ? `  ${known.hint}\n` : ''}`)
    return known.code === 'usage' ? EXIT.usage : EXIT.failed
  }
  const message = error instanceof Error ? error.message : String(error)
  if (json) process.stderr.write(`${JSON.stringify({ command: invoked, error: { code: 'failed', message } })}\n`)
  else process.stderr.write(`pi-superagent: ${message}\n`)
  return EXIT.failed
}

try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError) {
    // Help and version are answers, not failures; commander has already printed them.
    if (['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(error.code)) process.exit(EXIT.ok)
    process.exit(EXIT.usage)
  }
  process.exit(report(error, program.opts().json === true))
}
