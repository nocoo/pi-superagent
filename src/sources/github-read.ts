/** CI check inspection for the GitHub Source: a snapshot of a commit's checks, and the facts a Thread publishes from it. */
import { z } from 'zod'
import type { ThreadFact } from '../core/index.ts'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'

const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() })
type Check = Pick<z.infer<typeof CheckSchema>, 'name' | 'status' | 'conclusion'>
type Status = Pick<z.infer<typeof StatusSchema>, 'context' | 'state'>

/** A commit's checks and statuses as GitHub reports them; `head` is the commit the snapshot belongs to. */
export interface CiSnapshot { head: string; checks: Check[]; statuses: Status[] }
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped` and `stale` do not. */
const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'])

/** Counts the failed and still-running results of a snapshot. */
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const statuses = snapshot.statuses ?? []
  return {
    failed: snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).length + statuses.filter(status => FAILING.has(status.state)).length,
    running: snapshot.checks.filter(check => check.status !== 'completed').length + statuses.filter(status => status.state === 'pending').length,
  }
}

/** One line a worker reads: how many results failed or are running, which ones, and where to read them all. */
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const checks = snapshot.checks.map(check => ({ name: check.name, failed: FAILING.has(check.conclusion ?? ''), running: check.status !== 'completed' }))
  const statuses = (snapshot.statuses ?? []).map(status => ({ name: status.context, failed: FAILING.has(status.state), running: status.state === 'pending' }))
  const results = [...checks, ...statuses]
  const failed = results.filter(result => result.failed).map(result => result.name)
  const running = results.filter(result => result.running).map(result => result.name)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`
  const still = running.length ? `; ${running.length} still running` : ''
  const line = failed.length ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `CI passed ${results.length}/${results.length} ${at}`
  return `${line}\nRead ${read} for every check.`
}

/** The failing result names, sorted, so two snapshots compare as a set rather than as a list. */
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [...snapshot.checks.filter(check => FAILING.has(check.conclusion ?? '')).map(check => check.name),
    ...(snapshot.statuses ?? []).filter(status => FAILING.has(status.state)).map(status => status.context)].sort()
}

/** The fact a Thread publishes about its CI. */
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  if (counts.running) return { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) }
  return { label: 'CI', value: { zh: '通过', en: 'passed' } }
}

/** Reads a commit's check runs and the latest state of each commit status. */
export async function pullChecks(commands: Commands, head: string, tally?: Tally): Promise<CiSnapshot> {
  const page = z.looseObject({ check_runs: z.array(z.unknown()) })
  const pages = await commands.api(z.array(page), `commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp')
  const runs = validItems(CheckSchema, pages.flatMap(page => page.check_runs), tally)
  const statuses = await commands.pages(StatusSchema, `commits/${head}/statuses?per_page=100`, tally)
  const latest = new Map<string, string>()
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state)
  const checks = runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))
  return { head, checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((a, b) => a.context.localeCompare(b.context)) }
}
