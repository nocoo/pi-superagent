/** Execution environment: the variables a worker's prompt and a ticket's prepare command receive. */
import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Ticket, Trigger } from '../core/index.ts'

const exec = promisify(execFile)
const PREPARE_TIMEOUT_MS = 10 * 60_000

export interface Variable { key: string; value: string; description: string }

/** Where ticket directories live: the configured absolute root, else `<stateDir>/work`. */
export const executionRoot = (configured: string, stateDir: string): string => configured || join(stateDir, 'work')

/** Variables for `ticket`, from its execution record and its originating Trigger. */
export function executionVariables(ticket: Ticket, trigger: Trigger | undefined, repository: string): Variable[] {
  const directory = ticket.execution?.directory ?? ticket.id
  return [
    { key: 'PI_SUPERAGENT_DIR', value: directory, description: 'This ticket\'s directory; work only inside it.' },
    { key: 'PI_SUPERAGENT_NAME', value: ticket.execution?.name ?? ticket.id, description: 'This ticket\'s short name.' },
    { key: 'PI_SUPERAGENT_TICKET', value: ticket.id, description: 'This ticket\'s id.' },
    { key: 'PI_SUPERAGENT_GITHUB_REPOSITORY', value: repository, description: 'The repository this agent works on, as owner/name.' },
    ...typeof trigger?.meta.number === 'number'
      ? [{ key: 'PI_SUPERAGENT_GITHUB_NUMBER', value: String(trigger.meta.number), description: 'The Issue or pull request that started this ticket.' }]
      : [],
  ]
}

/** Renders variables for the prepare command's environment. */
export const environmentOf = (variables: Variable[]): Record<string, string> =>
  Object.fromEntries(variables.map(({ key, value }) => [key, value]))

/**
 * Runs `command` once with `sh` in `root` when `directory` does not exist yet; a directory that already exists counts as
 * prepared, so a failed command is never retried over its leftovers.
 * @throws with the command's output when it fails.
 */
export async function prepare(directory: string, root: string, command: string, environment: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true })
  if (await stat(directory).then(() => true, () => false)) return
  if (!command.trim()) { await mkdir(directory, { recursive: true }); return }
  try {
    await exec('sh', ['-c', command], { cwd: root, timeout: PREPARE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...environment } })
  } catch (error) {
    const output = (error as { stderr?: string; stdout?: string }).stderr ?? (error as { stdout?: string }).stdout ?? String(error)
    throw new Error(`The prepare command failed: ${output.slice(0, 2000)}`)
  }
  await mkdir(directory, { recursive: true })
}
