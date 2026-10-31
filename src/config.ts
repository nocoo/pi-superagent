/** Deployment identity: the repository the agent works on and the GitHub account it acts as. */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

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
