/** Deployment identity: the repository the agent works on and the GitHub account it acts as. */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface Deployment {
  /** `owner/name` of the repository the agent works on. */
  repository: string
  github: { cli: string; login: string; noreply: string }
}

/** Commands a worker may not have blocked, because its own work depends on them. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git']

/** Resolve a command name or absolute path to an executable file. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && dir !== exclude).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

/** GitHub's no-reply commit address for `login`, so the agent's commits are attributable to its own account. */
export const noreplyEmail = (login: string, id?: number): string =>
  id === undefined ? `${login}@users.noreply.github.com` : `${id}+${login}@users.noreply.github.com`

/**
 * Resolves the account the agent's `gh` is signed in to. The Sources need this before anything is polled: it is how they
 * recognise the agent's own messages. Without it, an agent acting as account X reads X's acknowledgement as a person's
 * message and wakes the ticket it just answered.
 * @throws when the `gh` named by `cli` is not signed in.
 */
export async function resolveAccount(cli: string): Promise<{ login: string; id?: number; noreply: string }> {
  let parsed: { login?: string; id?: number }
  try {
    parsed = JSON.parse((await exec(cli, ['api', 'user', '--jq', '{login: .login, id: .id}'], { timeout: 30_000 })).stdout) as typeof parsed
  } catch (error) {
    throw new Error(`Cannot read the account ${cli} is signed in to: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed.login) throw new Error(`${cli} is not signed in to GitHub`)
  return { login: parsed.login, ...parsed.id === undefined ? {} : { id: parsed.id }, noreply: noreplyEmail(parsed.login, parsed.id) }
}
