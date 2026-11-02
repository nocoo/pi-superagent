#!/usr/bin/env node
/**
 * The command line, which is this agent's primary surface. Everything a supervisor needs is answered here; see
 * docs/005-cli.md for the design. Conventions: data on stdout, everything else on stderr, `--json` for scripts, exit 2
 * for a wrong invocation and 1 for a right one whose answer is no.
 */
import { Command, CommanderError, InvalidArgumentError } from 'commander'
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
import { ticketList, ticketRead, ticketShow, ticketWait } from './cli/commands/ticket.ts'
import { configEdit, configSet, configShow } from './cli/commands/config.ts'
import { run } from './cli/commands/run.ts'
import { chat } from './cli/commands/chat.ts'
import { intervention, promptShow, promptHistory, promptPreview, promptSet, promptRestore, configImport, configHistory,
  search, coordinatorRead, sourceReceive, sourceReplies } from './cli/commands/manage.ts'
import { ControlError } from './runtime/control.ts'
import { LookupError } from './infra/identifiers.ts'

const version = (): string => (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version

/**
 * Option parsers. Commander turns a rejected one into a usage error, so a bad value fails before the command runs and
 * the message names what was expected, in one place rather than in each handler.
 */
const integer = (value: string): number => {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError('a whole number')
  return Number(value)
}
const oneOf = (...choices: string[]) => (value: string): string => {
  if (!choices.includes(value)) throw new InvalidArgumentError(`one of ${choices.join(', ')}`)
  return value
}

/** The name of the command being run, for the `command` field of JSON output and error objects. */
let invoked = 'pi-superagent'

const program = new Command()
program
  .name('pi-superagent')
  .description('A CLI-first agent for messages and general tasks. Run `pi-superagent <command>` to inspect it.')
  .version(version(), '-V, --version', 'print the version')
  .option('--state-dir <dir>', 'instance directory (default: $PI_SUPERAGENT_STATE_DIR or ~/.pi-superagent/state)')
  .option('--json', 'print one JSON object instead of prose')
  .showHelpAfterError()
  .exitOverride()
  .action(() => { program.outputHelp() })
  .hook('preAction', (_program, action) => {
    const path: string[] = []
    // Stop before the root program, so the name is `ticket list` rather than `pi-superagent ticket list`.
    for (let command: Command | null = action; command?.parent; command = command.parent) path.unshift(command.name())
    invoked = path.join(' ')
  })

/**
 * Declares a command group. Naming a group on its own prints that group's commands on stdout and succeeds, so it is a
 * question rather than a usage error — commander would otherwise print to stderr and treat it as a failure.
 */
const group = (name: string, description: string): Command => {
  const command = program.command(name).description(description)
  command.action(() => { command.outputHelp() })
  return command
}

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

const sources = program.command('source')
  .description('the Sources: whether they run, what is arriving')
  .action(wrap(cli => source(cli)))
sources.command('receive').description('receive a standard event from an external system')
  .requiredOption('--file <path>', 'event JSON file, or - for stdin')
  .action(wrap((cli, options: { file: string }) => sourceReceive(cli, options)))
sources.command('replies').description('read replies delivered to external adapters locally')
  .option('--system <name>', 'only this external system')
  .option('--limit <n>', 'latest replies', integer, 100)
  .action(wrap((cli, options: { system?: string; limit: number }) => sourceReplies(cli, options)))

// Following one piece of work

const thread = group('thread', 'Threads and their Triggers')
thread.command('list')
  .description('list threads')
  .option('--source <source>', 'only this Source')
  .option('--subscribed', 'only threads a Ticket subscribes to')
  .option('--limit <n>', 'how many to show', integer, 20)
  .action(wrap((cli, options: { source?: string; subscribed?: boolean; limit: number }) => threadList(cli, options)))
thread.command('show <thread>')
  .description('one thread, its Triggers in time order, and what became of each')
  .option('--limit <n>', 'how many Triggers to show', integer, 30)
  .action(wrap((cli, key: string, options: { limit: number }) => threadShow(cli, key, options)))

const trigger = group('trigger', 'events and where they went')
trigger.command('show <trigger>')
  .description('one Trigger in full, with its disposition')
  .action(wrap((cli, id: string) => triggerShow(cli, id)))

const decision = group('decision', 'what an Eval concluded and why')
decision.command('list')
  .description('list decisions')
  .option('--kind <kind...>', 'only these kinds: accept, stop, ignore, unavailable')
  .option('--since <duration>', 'only decisions about Triggers newer than this, such as 24h or 7d', '24h')
  .option('--limit <n>', 'how many to show', integer, 20)
  .action(wrap((cli, options: { kind?: string[]; since: string; limit: number }) => decisionList(cli, options)))
decision.command('show <decision>')
  .description('one decision: why, which rules matched, and the direction it judged')
  .action(wrap((cli, id: string) => decisionShow(cli, id)))

const ticket = group('ticket', 'authorized work')
ticket.command('list')
  .description('list tickets, grouped by the stage that decides whom they wait for')
  .option('--stage <stage>', 'person, working, idle or ended', oneOf('person', 'working', 'idle', 'ended'))
  .option('--all', 'include ended tickets')
  .option('--limit <n>', 'how many to show per group', integer, 30)
  .action(wrap((cli, options: { stage?: string; all?: boolean; limit: number }) => ticketList(cli, options)))
ticket.command('show <ticket>')
  .description('one ticket: its mandate, assignments and inputs')
  .action(wrap((cli, id: string) => ticketShow(cli, id)))
ticket.command('wait <ticket>')
  .description('block until the ticket reaches a stage')
  .option('--until <stage>', 'person, working, idle or ended', oneOf('person', 'working', 'idle', 'ended'), 'ended')
  .option('--timeout <ms>', 'how long to wait before failing', integer)
  .option('--interval <ms>', 'how often to re-read', integer, 500)
  .action(wrap((cli, id: string, options: { until?: string; timeout?: number; interval?: number }) => ticketWait(cli, id, options)))
ticket.command('read <ticket>')
  .description("the worker's own conversation")
  .option('--lines <n>', 'how many messages to show', integer, 40)
  .action(wrap((cli, id: string, options: { lines: number }) => ticketRead(cli, id, options)))

for (const name of ['stop', 'retry', 'request-status'] as const) {
  const command = ticket.command(`${name} <ticket>`).description(`${name} a ticket through the running instance`)
  if (name === 'stop') command.option('--reason <text>', 'why this work is stopped')
  command.action(wrap((cli, id: string, options: { reason?: string }) => intervention(cli, `ticket.${name}`, id, options)))
}
for (const name of ['note', 'answer'] as const) {
  ticket.command(`${name} <ticket>`).description(name === 'answer' ? 'answer a worker as the local operator' : 'give the worker additional context')
    .requiredOption('--text <text>', 'the message')
    .action(wrap((cli, id: string, options: { text: string }) => intervention(cli, `ticket.${name}`, id, options)))
}
ticket.command('attach <ticket>').description('attach an existing event to a ticket')
  .requiredOption('--trigger <id>', 'event to attach').option('--note <text>', 'routing context')
  .action(wrap((cli, id: string, options: { trigger: string; note?: string }) => intervention(cli, 'ticket.attach', id, options)))
trigger.command('reevaluate <trigger>').description('queue a fresh evaluation')
  .action(wrap((cli, id: string) => intervention(cli, 'trigger.reevaluate', id, {})))
thread.command('unsubscribe <thread>').description('stop following a thread')
  .action(wrap((cli, id: string) => intervention(cli, 'thread.unsubscribe', id, {})))
decision.command('dismiss <decision>').description('dismiss an unavailable decision')
  .action(wrap((cli, id: string) => intervention(cli, 'decision.dismiss', id, {})))
program.command('search <query>').description('search messages, tasks and conversations')
  .action(wrap((cli, query: string) => search(cli, query)))

const coordinator = group('coordinator', 'the persistent main session')
coordinator.command('show').description('session and configuration revisions')
  .action(wrap(cli => coordinatorRead(cli, { lines: 40 }, true)))
coordinator.command('read').description('read the main session conversation')
  .option('--lines <n>', 'messages to show', integer, 40)
  .action(wrap((cli, options: { lines: number }) => coordinatorRead(cli, options)))

// Configuring

const config = group('config', 'the deployment and the Policy')
config.command('show')
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
  .option('--max-workers <n>', 'how many tickets may run at once', integer)
  .option('--prepare <command>', 'shell command that creates a ticket directory')
  .option('--im', 'enable the local IM Source')
  .option('--im-agent <name>', 'the name the agent speaks as in the IM')
  .option('--im-observed <channel...>', 'channels whose unaddressed messages are candidates')
  .option('--im-allowed <name...>', 'names that may originate work in the IM')
  .option('--inbox', 'enable the generic external-event Source')
  .option('--inbox-allowed <id...>', 'authorized system:actor identities')
  .option('--inbox-observed <system...>', 'systems whose unaddressed events may become candidates')
  .option('--pause', 'stop starting new work')
  .option('--resume', 'start new work again')
  .option('--dry-run', 'print what would change and write nothing')
  .option('--yes', 'do not refuse a change that removes authorized logins')
  .action(wrap((cli, options: Record<string, unknown>) => configSet(cli, options)))
config.command('edit')
  .description('edit the stored settings in $EDITOR; parts flags cannot express')
  .action(wrap(cli => configEdit(cli)))

config.command('import').description('save a complete settings document with conflict detection')
  .requiredOption('--file <path>', 'JSON file, or - for stdin')
  .requiredOption('--base-revision <n>', 'revision being edited', integer)
  .action(wrap((cli, options: { file: string; baseRevision: number }) => configImport(cli, options)))
config.command('history').description('saved configuration revisions')
  .action(wrap(cli => configHistory(cli)))

const prompts = group('prompt', 'versioned agent instructions')
prompts.command('show').description('current or historical prompt configuration')
  .option('--revision <n>', 'revision to read', integer)
  .action(wrap((cli, options: { revision?: number }) => promptShow(cli, options)))
prompts.command('history').description('immutable prompt versions').action(wrap(cli => promptHistory(cli)))
prompts.command('preview').description('compose instructions without saving')
  .requiredOption('--file <path>', 'JSON file, or - for stdin')
  .action(wrap((cli, options: { file: string }) => promptPreview(cli, options)))
prompts.command('set').description('save a prompt configuration')
  .requiredOption('--file <path>', 'JSON file, or - for stdin')
  .requiredOption('--base-revision <n>', 'revision being edited', integer)
  .action(wrap((cli, options: { file: string; baseRevision: number }) => promptSet(cli, options)))
prompts.command('restore <revision>').description('restore an earlier configuration as a new version')
  .requiredOption('--base-revision <n>', 'current revision', integer)
  .action(wrap((cli, revision: string, options: { baseRevision: number }) => promptRestore(cli, integer(revision), options)))

program.command('chat <channel>')
  .description('open the local IM channel, or write one message with --send')
  .option('--send <text>', 'write one message and exit')
  .option('--as <name>', 'send as this name (default: your OS user)')
  .option('--reply-to <id>', 'answer this message id')
  .option('--lines <n>', 'how much history to show when opening', integer, 20)
  .action(wrap((cli, channel: string, options: { send?: string; as?: string; replyTo?: string; lines: number }) => chat(cli, channel, options)))

program.command('run')
  .description('start the agent')
  .option('--verbose', 'log every domain event')
  .action(wrap((cli, options: { verbose?: boolean }) => run(cli, options)))

program.command('web').description('serve the local management panel over the CLI')
  .option('--port <n>', 'loopback port', integer, 7062)
  .action(wrap(async (cli, options: { port: number }) => {
    if (options.port < 1 || options.port > 65535) throw new CliError('usage', '--port must be between 1 and 65535')
    const { startWebServer } = await import('./web/server.ts')
    const close = await startWebServer({ stateDir: cli.stateDir, cliPath: join(packageRoot(), 'lib', 'cli.js'),
      staticDir: join(packageRoot(), 'web', 'dist'), port: options.port })
    process.stderr.write(`Management panel: https://superagent.dev.hexly.ai (127.0.0.1:${options.port})\n`)
    process.once('SIGINT', () => { void close() })
    process.once('SIGTERM', () => { void close() })
  }))

/** Reports a failure in the shape the conventions promise, and returns the process status. */
function report(error: unknown, json: boolean): number {
  const known = error instanceof CliError || error instanceof ControlError || error instanceof LookupError ? error
    : error instanceof UsageError ? new CliError('usage', error.message)
      : undefined
  if (known) {
    if (json) process.stderr.write(`${JSON.stringify({ command: invoked, error: { code: known.code, message: known.message } })}\n`)
    else process.stderr.write(`pi-superagent: ${known.message}\n${known instanceof CliError && known.hint ? `  ${known.hint}\n` : ''}`)
    return known.code === 'usage' ? EXIT.usage : EXIT.failed
  }
  const message = error instanceof Error ? error.message : String(error)
  if (json) process.stderr.write(`${JSON.stringify({ command: invoked, error: { code: 'failed', message } })}\n`)
  else process.stderr.write(`pi-superagent: ${message}\n`)
  return EXIT.failed
}

// The status is set rather than exited: `process.exit` does not wait for a pipe to flush, so a `--help` piped into
// another command would arrive truncated.
try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError) {
    // Help and version are answers, not failures; commander has already printed them.
    process.exitCode = ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(error.code) ? EXIT.ok : EXIT.usage
  } else {
    process.exitCode = report(error, program.opts().json === true)
  }
}
