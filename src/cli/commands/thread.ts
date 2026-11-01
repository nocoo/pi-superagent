/** `thread`: the list of Threads, and one Thread's Triggers in time order with what became of each. */
import type { Thread, Trigger, TriggerDisposition } from '../../core/index.ts'
import { reasonText } from '../../core/index.ts'
import { CliError } from '../errors.ts'
import { openForRead } from '../context.ts'
import { age, clip, count, emit, line, short, table, type Cli } from '../output.ts'
import type { Store } from '../../store/store.ts'

/** What became of a Trigger, in one line: the fact a supervisor most needs when a request seems to vanish. */
export function dispositionOf(store: Store, trigger: Trigger): string {
  const disposition = store.triggers.disposition(trigger.id)
  if (!disposition) return 'stored'
  return describe(disposition, store)
}

function describe(disposition: TriggerDisposition, store: Store): string {
  if (disposition.filtered) return `filtered — ${reasonText(disposition.filtered)}`
  if (disposition.decisionId) {
    const decision = store.decisions.get(disposition.decisionId)
    return decision ? `decided ${decision.kind}` : 'decided'
  }
  if (disposition.requeued) return 'queued for Eval'
  if (disposition.handbacks?.length) {
    return `handed back by ${disposition.handbacks.map(item => short(item.ticketId)).join(', ')} — ${disposition.handbacks.at(-1)!.reason}`
  }
  if (disposition.acked?.length) return `taken up by ${disposition.acked.map(short).join(', ')}`
  return fanout(disposition)
}

/** A Trigger that reached Tickets: the ones it is work for, and the ones that follow it only for context. */
function fanout(disposition: TriggerDisposition): string {
  const context = disposition.context ?? []
  const own = disposition.fanout.filter(id => !context.includes(id))
  return [own.length ? `fanned out to ${own.map(short).join(', ')}` : '',
    context.length ? `context only for ${context.map(short).join(', ')}` : ''].filter(Boolean).join(' · ') || 'stored'
}

const label = (thread: Thread): string => {
  const name = thread.meta.label ?? thread.meta.title
  return typeof name === 'string' ? name : thread.key
}

export function threadList(cli: Cli, options: { source?: string; subscribed?: boolean; limit: number }): void {
  const store = openForRead(cli)
  try {
    const threads = (options.subscribed ? store.read.subscribedThreads(options.source) : store.threads.list())
      .filter(thread => !options.source || thread.ref.source === options.source)
    const counts = store.read.triggerCounts()
    const rows = threads.slice(0, options.limit)

    emit(cli, 'thread list', { threads: rows.map(thread => ({
      key: thread.key, label: label(thread), triggers: counts[thread.key] ?? 0, lastAt: thread.lastAt,
      subscribed: thread.subscriptions.length, evaluating: !!thread.evaluating,
    })) }, () => {
      if (!rows.length) { line('no threads'); return }
      table([['THREAD', 'TRIGGERS', 'LAST', 'SUBSCRIBED', 'EVALUATING'],
        ...rows.map(thread => [thread.key, String(counts[thread.key] ?? 0), age(thread.lastAt),
          thread.subscriptions.length ? count(thread.subscriptions.length, 'ticket') : '—', thread.evaluating ? 'yes' : 'no'])])
    })
  } finally { store.close() }
}

export function threadShow(cli: Cli, key: string, options: { limit: number }): void {
  const store = openForRead(cli)
  try {
    const thread = store.threads.get(key)
    if (!thread) throw new CliError('not_found', `no thread ${key}`, 'list them with: pi-superagent thread list')
    const triggers = store.read.threadTriggers(key, options.limit)
    const decisions = store.decisions.byThread(key)

    emit(cli, 'thread show', { thread, triggers, decisions }, () => {
      line(`${label(thread)}${label(thread) === thread.key ? '' : `  ${thread.key}`}`)
      const subscribed = thread.subscriptions.length ? `subscribed by ${thread.subscriptions.map(short).join(', ')}` : 'no subscriptions'
      line(`${subscribed} · ${thread.evaluating ? 'evaluating' : 'nothing evaluating'}`)
      if (!triggers.length) { line(); line('no triggers'); return }
      line()
      for (const trigger of triggers) {
        const who = trigger.human ? trigger.actor.id : `${trigger.actor.id || 'system'} (machine)`
        const addressed = trigger.addressed ? ` · addressed ${trigger.addressed}` : ''
        line(`  ${time(trigger.at)}  ${who.padEnd(12)} ${clip(oneLine(trigger.text), 90)}`)
        line(`            → ${dispositionOf(store, trigger)}${addressed}`)
      }
    })
  } finally { store.close() }
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const time = (iso: string): string => {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(11, 19) : iso
}
