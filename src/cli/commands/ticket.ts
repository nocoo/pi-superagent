import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
/** `ticket`: authorized work, grouped by the stage that decides whom it waits for, with the mandate that allows it. */
import { ticketStage, type Assignment, type Ticket, type TicketInput } from '../../core/index.ts'
import { CliError } from '../errors.ts'
import { openForRead, resolveId } from '../context.ts'
import { age, clip, count, emit, line, short, table, type Cli } from '../output.ts'

const STAGES = ['person', 'working', 'idle', 'ended'] as const

/** A human stage label: `person / review`, `working / queued`, `idle`, `ended`. */
function stageName(ticket: Ticket): string {
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') return `person / ${stage.action}`
  if (stage.stage === 'working') return stage.action ? `working / ${stage.action}` : 'working'
  return stage.stage
}

/** The one fact a reader wants about a ticket's progress, in its own words. */
function outcome(ticket: Ticket): string {
  const assignment = ticket.assignments.at(-1)
  const report = assignment?.report
  if (ticket.ended) return `${ticket.ended.outcome}${ticket.ended.reason ? ` — ${clip(ticket.ended.reason, 60)}` : ''}`
  if (ticket.attention) return `"${clip(ticket.attention.question, 60)}"`
  if (report) return `${report.state} — ${clip(report.summary.replace(/\s+/g, ' '), 60)}`
  return assignment ? assignment.state : 'no assignment'
}

export function ticketList(cli: Cli, options: { stage?: string; all?: boolean; limit: number }): void {
  const store = openForRead(cli)
  try {
    const limit = options.limit
    const all = options.all ? store.tickets.list() : store.tickets.open()
    const wanted = options.stage as (typeof STAGES)[number] | undefined
    if (wanted && !STAGES.includes(wanted)) throw new CliError('usage', `--stage ${wanted} is not one of ${STAGES.join(', ')}`)
    const rows = all.map(ticket => ({ ticket, stage: ticketStage(ticket).stage })).filter(item => !wanted || item.stage === wanted)

    const grouped = STAGES.flatMap(stage => {
      const items = rows.filter(item => item.stage === stage).slice(0, limit)
      return items.length ? [{ stage, items }] : []
    })

    emit(cli, 'ticket list', { tickets: rows.map(item => ({ ...item.ticket, stage: item.stage })) }, () => {
      if (!grouped.length) { line(options.all ? 'no tickets' : 'no open tickets'); return }
      for (const [index, group] of grouped.entries()) {
        if (index) line()
        line(`${group.stage} (${group.items.length})`)
        table(group.items.map(item => [`  ${short(item.ticket.id)}`, clip(item.ticket.title, 46).padEnd(46), outcome(item.ticket)]))
      }
    })
  } finally { store.close() }
}

/** Resolves a ticket by any unambiguous prefix. */
export function findTicket(store: ReturnType<typeof openForRead>, prefix: string): Ticket {
  return resolveId(prefix, store.tickets.list(), ticket => ticket.id, 'ticket')
}

export function ticketShow(cli: Cli, id: string): void {
  const store = openForRead(cli)
  try {
    const ticket = findTicket(store, id)
    const trigger = store.triggers.get(ticket.origin.triggerId)

    emit(cli, 'ticket show', { ticket, origin: trigger }, () => {
      line(`${clip(ticket.title, 60)}  ${short(ticket.id)}`)
      line(`${stageName(ticket)} · ${outcome(ticket)}`)
      line()
      const mandate = ticket.mandate
      table([
        ['mandate', `${mandate.strength} · policy ${mandate.policyVersion.slice(0, 8)}${mandate.basis.rules?.length ? ` · rules ${mandate.basis.rules.join(', ')}` : ''}`],
        ['scope', mandate.scope],
        ['basis', describeBasis(mandate.basis)],
      ])
      if (ticket.assignments.length) {
        line()
        line('assignments')
        table(ticket.assignments.map(assignment => [`  ${time(assignment.createdAt)}`, describeAssignment(assignment)]))
      }
      if (ticket.inputs.length) {
        line()
        line('inputs')
        table(ticket.inputs.map(input => [`  ${time(input.at)}`, describeInput(input, ticket)]))
      }
      line()
      line(`follows   ${ticket.follows?.map(follow => `${follow.thread}${follow.own ? ' (own' + (follow.closed ? ', closed' : '') + ')' : ''}`).join(', ') || '—'}`)
      line(`channels  ${ticket.channels.map(channel => `${channel.source} ${channel.thread}`).join(', ') || '—'}`)
      if (trigger) line(`origin    ${short(trigger.id)}  ${clip(trigger.text.replace(/\s+/g, ' '), 70)}`)
    })
  } finally { store.close() }
}

const describeBasis = (basis: Ticket['mandate']['basis']): string => {
  const where = [basis.via, 'cell' in basis ? basis.cell : '', 'addressed' in basis ? basis.addressed : '', basis.row ?? '']
    .filter(Boolean).join(' · ')
  const observation = 'observation' in basis && basis.observation ? ` · observation ${(basis.observation as { mode?: string }).mode ?? ''}` : ''
  return `${where}${observation}`.replace(/ · $/, '')
}

const describeAssignment = (assignment: Assignment): string =>
  `${assignment.state}${assignment.report ? `   ${assignment.report.state}   ${clip(assignment.report.summary.replace(/\s+/g, ' '), 70)}` : ''}`

const describeInput = (input: TicketInput, ticket: Ticket): string => {
  const read = ticket.undelivered.includes(input.id) ? 'waiting' : 'read'
  if (input.kind === 'trigger') return `trigger ${short(input.triggerId).padEnd(9)} ${read}`
  if (input.kind === 'text' || input.kind === 'note') return `${input.kind.padEnd(16)} ${clip(input.text, 50)}`
  return `${input.kind} ${read}`
}

const time = (iso: string): string => {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(5, 19).replace('T', ' ') : iso
}

/** The stages `wait` accepts, in the order of the engineering table. */
const WAITABLE = STAGES

/**
 * Blocks until the ticket reaches `--until`, for a script that asked for work and wants the answer. The store is re-read
 * on every poll, so a Ticket another process advances is seen without reopening the database.
 */
export async function ticketWait(cli: Cli, id: string, options: { until?: string; timeout?: number; interval?: number }): Promise<void> {
  const until = (options.until ?? 'ended') as (typeof STAGES)[number]
  if (!WAITABLE.includes(until)) throw new CliError('usage', `--until ${until} is not one of ${WAITABLE.join(', ')}`)
  const timeout = options.timeout ?? Infinity
  if (!(timeout > 0)) throw new CliError('usage', '--timeout must be a positive number of milliseconds')
  const interval = Math.max(50, options.interval ?? 500)

  const first = openForRead(cli)
  let ticket: Ticket
  try { ticket = findTicket(first, id) } finally { first.close() }

  const deadline = Date.now() + timeout
  for (;;) {
    const store = openForRead(cli)
    let current: Ticket | undefined
    try { current = store.tickets.get(ticket.id) } finally { store.close() }
    if (!current) throw new CliError('not_found', `ticket ${short(ticket.id)} is gone`)
    const stage = ticketStage(current).stage
    if (stage === until) {
      emit(cli, 'ticket wait', { ticket: current, stage }, () => line(`${short(current!.id)}  ${stage}  ${outcome(current!)}`))
      return
    }
    if (Date.now() >= deadline) {
      throw new CliError('failed', `${short(ticket.id)} is ${stageName(current)}, not ${until} after ${timeout} ms`)
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

/** One message of a worker's conversation, as rendered for a person. */
interface Rendered { role: string; text: string }

/** Reads the worker's session file, which is the only place an agent's actual work is visible. */
export function ticketRead(cli: Cli, id: string, options: { lines: number }): void {
  const store = openForRead(cli)
  let ticket: Ticket
  try { ticket = findTicket(store, id) } finally { store.close() }
  const file = join(cli.stateDir, 'sessions', `worker-${ticket.id}.jsonl`)
  if (!existsSync(file)) {
    throw new CliError('not_found', `no worker session for ${short(ticket.id)}`,
      'the ticket has not been launched yet, or its directory was removed')
  }
  const messages = render(readFileSync(file, 'utf8'))
  const shown = messages.slice(-options.lines)
  emit(cli, 'ticket read', { ticket: ticket.id, messages: shown }, () => {
    if (!shown.length) { line('the worker session has no messages yet'); return }
    for (const message of shown) {
      const [first, ...rest] = message.text.split('\n')
      line(`${message.role.padEnd(11)} ${clip(first ?? '', 110)}`)
      for (const more of rest.slice(0, 6)) line(`${' '.repeat(12)}${clip(more, 110)}`)
    }
  })
}

/** Turns session entries into role and text, folding a tool call into one line. */
function render(jsonl: string): Rendered[] {
  const messages: Rendered[] = []
  for (const lineText of jsonl.split('\n')) {
    if (!lineText.trim()) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(lineText) as Record<string, unknown> } catch { continue }
    if (entry.type !== 'message') continue
    const message = entry.message as { role?: string; content?: unknown } | undefined
    if (!message?.role || message.role === 'system') continue
    const parts = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : []
    const text = parts.filter(part => part.type === 'text').map(part => String(part.text ?? '')).join(' ')
      || (typeof message.content === 'string' ? message.content : '')
    const calls = parts.filter(part => part.type === 'toolCall')
      .map(part => `${String(part.name ?? 'tool')} ${clip(JSON.stringify(part.arguments ?? part.input ?? {}), 90)}`)
    if (calls.length) messages.push(...calls.map(call => ({ role: call.split(' ')[0]!, text: call.slice(call.indexOf(' ') + 1) })))
    if (text.trim()) messages.push({ role: message.role === 'assistant' ? 'assistant' : message.role, text: text.trim() })
  }
  return messages
}
