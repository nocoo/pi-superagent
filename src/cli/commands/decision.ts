/** `decision`: what an Eval concluded, and the two judgements behind it — rule matches and direction. */
import { reasonText, type Decision } from '../../core/index.ts'
import { CliError } from '../errors.ts'
import { openForRead } from '../context.ts'
import { age, clip, count, emit, line, short, table, type Cli } from '../output.ts'
import { findTrigger } from './trigger.ts'

const DURATIONS: [RegExp, number][] = [[/^(\d+)h$/, 3_600_000], [/^(\d+)d$/, 86_400_000], [/^(\d+)m$/, 60_000]]

/** Parses `24h`, `7d`, `30m` into a moment `ms` before now. */
export function since(duration: string, now = Date.now()): string {
  for (const [pattern, size] of DURATIONS) {
    const match = pattern.exec(duration)
    if (match) return new Date(now - Number(match[1]) * size).toISOString()
  }
  throw new CliError('usage', `--since ${duration} is not a duration`, 'write it as 30m, 24h or 7d')
}

const audit = (decision: Decision): Record<string, unknown> => decision.audit ?? {}

/** The assessments the model recorded, one per enabled rule; a negative one carries the reason it did not match. */
function ruleLines(decision: Decision): string[] {
  const assessments = (audit(decision).rule_assessments ?? []) as { rule_id?: string; matched?: boolean; reason?: string }[]
  return assessments.map(item => `${item.matched ? '✓' : '✗'} ${item.rule_id ?? '?'}  ${item.reason ?? ''}`)
}

function directionLines(decision: Decision): string[] {
  const direction = audit(decision).direction as Record<string, unknown> | undefined
  if (!direction) return []
  return [
    ['implementation requested', String(direction.implementation_requested)],
    ['target', String(direction.target_basis)],
    ['open decision', String(direction.requires_design_decision)],
    ['evidence', clip(String(direction.evidence ?? '—'), 100)],
  ].map(([name, value]) => `${(name ?? '').padEnd(24)} ${value}`)
}

export function decisionList(cli: Cli, options: { kind?: string[]; since: string; limit: string }): void {
  const store = openForRead(cli)
  try {
    const from = since(options.since)
    const page = store.read.decisions({ kinds: options.kind ?? [], since: from }, 0, Number(options.limit))
    emit(cli, 'decision list', { decisions: page.items, more: page.more }, () => {
      if (!page.items.length) { line(`no decisions in the last ${options.since}`); return }
      table([['WHEN', 'THREAD', 'KIND', 'WHY'],
        ...page.items.map(decision => [age(decision.at), decision.threadKey, decision.kind.padEnd(11),
          clip(reasonText(decision.reason), 70)])])
      if (page.more) line(`… more than ${options.limit}; raise --limit`)
    })
  } finally { store.close() }
}

/** A decision by its own id, or by the Trigger it judged — the id a person is more likely to have. */
function find(store: ReturnType<typeof openForRead>, id: string): Decision {
  const byDecision = store.read.recentDecisions(0, 500).filter(item => item.id.startsWith(id))
  if (byDecision.length === 1) return byDecision[0]!
  if (byDecision.length > 1) {
    throw new CliError('ambiguous_id', `${byDecision.length} decisions match ${id}: ${byDecision.slice(0, 5).map(item => item.id.slice(0, 12)).join(', ')}`)
  }
  // Not a decision id: the person may be holding a Trigger id from `thread show`.
  const trigger = store.read.triggersByPrefix(id, 5)
  if (trigger.length === 1) {
    const decided = store.triggers.disposition(trigger[0]!.id)?.decisionId
    const decision = decided ? store.decisions.get(decided) : undefined
    if (decision) return decision
    throw new CliError('not_found', `trigger ${id} has no decision`, 'it may be waiting for an Eval; see: pi-superagent thread show')
  }
  if (trigger.length > 1) throw new CliError('ambiguous_id', `${trigger.length} triggers match ${id}`)
  throw new CliError('not_found', `no decision or trigger matches ${id}`)
}

export function decisionShow(cli: Cli, id: string): void {
  const store = openForRead(cli)
  try {
    const decision = find(store, id)
    const ticket = decision.ticketId ? store.tickets.get(decision.ticketId) : undefined

    emit(cli, 'decision show', { decision, ticket }, () => {
      line(`${decision.kind} · ${decision.strength} · policy ${decision.policyVersion.slice(0, 8)}`)
      line(`thread ${decision.threadKey}${ticket ? ` · ticket ${short(ticket.id)}` : ''}`)
      line()
      line(`why      ${reasonText(decision.reason)}`)
      const would = audit(decision).would_accept
      if (would) line('would    accept (recorded in observe mode, nothing was created)')
      const rules = ruleLines(decision)
      if (rules.length) { line('rules'); for (const rule of rules) line(`         ${rule}`) }
      const direction = directionLines(decision)
      if (direction.length) { line(); line('direction'); for (const item of direction) line(`         ${item}`) }
      if (ticket) {
        line()
        line(`ticket   ${short(ticket.id)}  ${ticket.title}`)
        line(`         scope — ${ticket.mandate.scope}`)
      }
    })
  } finally { store.close() }
}
