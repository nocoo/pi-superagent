/** `source`: whether each Source runs, what is arriving, and what it has dropped. */
import { openForRead, locked } from '../context.ts'
import { emit, age, count, line, table, type Cli } from '../output.ts'
import { KV } from '../../kv.ts'

const HOUR = 3_600_000

/** The observations a Source's configuration switches on, in the words a person reads. */
const OBSERVES: [string, string][] = [
  ['observeIssues', 'issues'], ['observePulls', 'pull requests'], ['observeComments', 'comments'], ['observeCi', 'CI'],
]

export function source(cli: Cli): void {
  const store = openForRead(cli)
  try {
    const settings = store.settings()
    const now = Date.now()
    const since = new Date(now - 24 * HOUR).toISOString()
    const stats = store.read.triggerStats(since)
    const account = store.get(KV.runtime.account)
    const running = locked(cli.stateDir)

    const rows = Object.entries(settings.sources).map(([name, stored]) => {
      const config = stored.config as Record<string, unknown>
      const seen = stats[name]
      const state = !stored.enabled ? 'off' : !running ? 'stopped' : seen?.lastAt ? 'ready' : 'idle'
      return {
        source: name,
        enabled: stored.enabled,
        state,
        received: seen?.received ?? 0,
        filtered: seen?.filtered ?? 0,
        lastAt: seen?.lastAt,
        repository: typeof config.repository === 'string' ? config.repository : undefined,
        observes: OBSERVES.filter(([key]) => config[key] === true).map(([, label]) => label),
        cursor: config,
      }
    })
    const dropped = store.read.droppedSince(since)

    emit(cli, 'source', { sources: rows, dropped, account: account?.login, running }, () => {
      if (!rows.length) { line('no Sources configured'); return }
      for (const row of rows) {
        line(`${row.source.padEnd(8)} ${(row.enabled ? 'enabled' : 'off').padEnd(8)} ${row.state.padEnd(8)} `
          + `${count(row.received, 'trigger')} / 24h · last ${age(row.lastAt, now)}`)
        const identity = [row.repository, account?.login ? `as @${account.login}` : ''].filter(Boolean).join(' ')
        const observes = row.observes.length ? `observes ${row.observes.join(', ')}` : 'observes only what addresses it'
        line(`${' '.repeat(9)}${[identity, observes].filter(Boolean).join(' · ')}`)
        if (row.filtered || dropped) line(`${' '.repeat(9)}filtered ${row.filtered} · dropped ${dropped}`)
      }
    })
  } finally { store.close() }
}
