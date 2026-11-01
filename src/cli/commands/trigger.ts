/** `trigger`: one Trigger in full, with its disposition. */
import { CliError } from '../errors.ts'
import { openForRead } from '../context.ts'
import { emit, line, table, type Cli } from '../output.ts'
import { dispositionOf } from './thread.ts'

/** Finds a Trigger by any unambiguous prefix of its id, over every Trigger ever received. */
export function findTrigger(store: ReturnType<typeof openForRead>, prefix: string) {
  if (prefix.length < 4) throw new CliError('usage', `trigger ${prefix} is too short to identify anything`, 'use at least four characters, or run thread show')
  const found = store.read.triggersByPrefix(prefix)
  const exact = found.find(trigger => trigger.id === prefix)
  if (exact) return exact
  if (found.length === 1) return found[0]!
  if (!found.length) throw new CliError('not_found', `no trigger matches ${prefix}`)
  throw new CliError('ambiguous_id', `${found.length} triggers match ${prefix}: ${found.slice(0, 5).map(trigger => trigger.id.slice(0, 12)).join(', ')}`)
}

export function triggerShow(cli: Cli, id: string): void {
  const store = openForRead(cli)
  try {
    const trigger = findTrigger(store, id)
    const disposition = store.triggers.disposition(trigger.id)

    emit(cli, 'trigger show', { trigger, disposition }, () => {
      line(`${trigger.id}  ${trigger.source}`)
      line()
      table([
        ['actor', `${trigger.actor.id}${trigger.human ? '' : ' (machine)'}${trigger.addressed ? ` · addressed ${trigger.addressed}` : ''}`],
        ['at', trigger.at],
        ['threads', trigger.threads.map(thread => thread.id).join(', ')],
        ['channel', trigger.channel ? `${trigger.channel.thread} ${JSON.stringify(trigger.channel.address)}` : '—'],
        ['url', trigger.url ?? '—'],
        ['disposition', dispositionOf(store, trigger)],
      ])
      line()
      line(trigger.text.trim() || '(no text)')
      const meta = Object.keys(trigger.meta ?? {})
      if (meta.length) {
        line()
        line(`meta ${JSON.stringify(trigger.meta)}`)
      }
    })
  } finally { store.close() }
}
