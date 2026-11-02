/** `status`: what needs a person, then system health. Everything here is derived from stored facts, so it is honest even
 * when the process is down — which is the case where a supervisor most needs an answer. */
import { ticketStage, type Ticket, type TicketStage } from '../../core/index.ts'
import { policyVersion } from '../../policy.ts'
import { openForRead, locked } from '../context.ts'
import { age, clip, count, emit, line, short, table, type Cli } from '../output.ts'
import { requestControl } from '../../runtime/control.ts'

const HOUR = 3_600_000

/** What a waiting ticket needs, in the words of whoever has to act. */
function needs(ticket: Ticket, stage: TicketStage): string {
  if (stage.stage !== 'person') return ''
  if (stage.action === 'delivery') return ticket.delivery?.error ?? 'input undelivered'
  if (stage.action === 'answer') return ticket.attention ? `"${ticket.attention.question}"` : 'a question'
  const report = ticket.assignments.findLast(item => item.report)?.report
  return report ? report.summary.replace(/\s+/g, ' ') : 'a report'
}

interface Part { part: string; state: string; detail: string }

export async function status(cli: Cli, options: { check?: boolean }): Promise<void> {
  const store = openForRead(cli)
  try {
    const settings = store.settings()
    const now = Date.now()
    const since = new Date(now - 24 * HOUR).toISOString()
    let running = locked(cli.stateDir)
    let live: { health: Record<string, { state: string; detail: string }>; coordinator: { running: boolean; tools: string[] } } | undefined
    let runtimeError: string | undefined
    if (running) {
      try { live = await requestControl(cli.stateDir, { action: 'runtime.status' }) as typeof live }
      catch (error) { running = false; runtimeError = error instanceof Error ? error.message : String(error) }
    }

    const staged = store.tickets.open().map(ticket => ({ ticket, stage: ticketStage(ticket) }))
    const waiting = staged
      .filter(item => item.stage.stage === 'person')
      .map(item => ({
        id: item.ticket.id,
        title: item.ticket.title,
        stage: 'person' as const,
        action: (item.stage as Extract<TicketStage, { stage: 'person' }>).action,
        needs: needs(item.ticket, item.stage),
      }))

    const parts: Part[] = []
    const stats = store.read.triggerStats(since)
    for (const [source, stored] of Object.entries(settings.sources)) {
      const seen = stats[source]
      const enabled = stored.enabled
      const state = !enabled ? 'off' : !running ? 'stopped' : seen?.lastAt ? 'ready' : 'idle'
      const detail = [
        seen ? `${count(seen.received, 'trigger')} / 24h` : 'nothing / 24h',
        seen?.filtered ? `${seen.filtered} filtered` : '',
        seen?.lastAt ? `last ${age(seen.lastAt, now)}` : '',
      ].filter(Boolean).join(' · ')
      const health = enabled ? live?.health[source] : undefined
      parts.push({ part: source, state: health?.state ?? state, detail: health?.detail ? `${health.detail} · ${detail}` : detail })
    }

    const working = store.tickets.open().filter(ticket => ticketStage(ticket).stage === 'working').length
    parts.push({ part: 'coordinator', state: !running ? 'stopped' : live?.coordinator.running ? 'working' : 'ready',
      detail: live?.coordinator.running ? 'routing and coordinating work' : 'waiting for events' })
    if (runtimeError) parts.push({ part: 'runtime', state: 'error', detail: runtimeError })
    parts.push({ part: 'workers', state: !running ? 'stopped' : working >= settings.executor.maxWorkers ? 'busy' : 'ready',
      detail: `${working} working of ${settings.executor.maxWorkers}` })

    const queue = store.read.queue()
    const queued = queue.reduce((total, kind) => total + kind.waiting, 0)
    const failing = queue.filter(kind => kind.failing > 0)
    parts.push({ part: 'queue', state: failing.length ? 'error' : 'ready',
      detail: failing.length
        ? failing.map(kind => `${kind.kind} ${kind.failing} failing`).join(' · ')
        : queued ? `${count(queued, 'effect')} waiting` : 'nothing waiting' })

    const receipts = store.read.receipts()
    parts.push({ part: 'outbox', state: 'ready',
      detail: receipts.pending ? `${count(receipts.pending, 'message')} pending` : `${receipts.sent} sent · nothing pending` })

    const unavailable = store.read.unavailable(since)
    parts.push({ part: 'evals', state: unavailable.length ? 'error' : 'ready',
      detail: unavailable.length ? `${count(unavailable.length, 'decision')} unavailable` : 'nothing unavailable' })

    const policy = {
      version: policyVersion(settings),
      mode: settings.eval.mode,
      rules: settings.policy.rules.filter(rule => rule.enabled).length,
      allowed: Object.values(settings.policy.sources).reduce((total, part) => total + (part.allowed?.length ?? 0), 0),
    }

    if (options.check && (waiting.length || parts.some(part => part.state === 'error'))) process.exitCode = 1

    emit(cli, 'status', { running, needsPerson: waiting, system: parts, policy }, () => {
      if (!running) line('not running · no process holds this instance')
      if (waiting.length) {
        line(`needs a person (${waiting.length})`)
        table(waiting.map(item => [`  ${item.action!.padEnd(8)}`, short(item.id), clip(item.title, 42).padEnd(42), clip(item.needs, 44)]))
      } else line('needs a person (0)')
      line()
      line('system')
      table(parts.map(part => [`  ${part.part.padEnd(8)}`, part.state.padEnd(7), part.detail]))
      line()
      line(`policy ${policy.version.slice(0, 8)} · accept ${policy.mode} · ${count(policy.rules, 'rule')} · ${count(policy.allowed, 'allowed login')}`)
    })
  } finally { store.close() }
}
