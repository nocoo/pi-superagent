/** Where the instance is, how to open it, and how a prefix names one record. */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store/store.ts'
import { CliError } from './errors.ts'
import type { Cli } from './output.ts'

/** The instance used when neither `--state-dir` nor the environment names one. */
export const defaultStateDir = (): string => join(homedir(), '.pi-superagent', 'state')

/** `--state-dir` > `$PI_SUPERAGENT_STATE_DIR` > `~/.pi-superagent/state`. */
export const stateDirPath = (flag?: string): string => flag ?? process.env.PI_SUPERAGENT_STATE_DIR ?? defaultStateDir()

/** Opens an existing instance for reading. A read command never creates one: plausible defaults for a typo are worse. */
export function openForRead(cli: Cli): Store {
  const file = join(cli.stateDir, 'superagent.sqlite')
  if (!existsSync(file)) {
    throw new CliError('no_instance', `no instance at ${cli.stateDir}`, 'start one with: pi-superagent run')
  }
  return new Store(file)
}

/** Opens the instance, creating the directory and database if needed; used only by commands that write. */
export function openForWrite(cli: Cli): Store {
  mkdirSync(cli.stateDir, { recursive: true, mode: 0o700 })
  return new Store(join(cli.stateDir, 'superagent.sqlite'))
}

/**
 * Resolves a prefix to exactly one record, as the conventions of [005](../../docs/005-cli.md#identifiers) promise:
 * at least four characters, and unambiguous. A full identifier is always accepted.
 */
export function resolveId<T>(prefix: string, items: readonly T[], idOf: (item: T) => string, what: string): T {
  if (prefix.length < 4) throw new CliError('usage', `${what} ${prefix} is too short to identify anything`, 'use at least four characters, or run the matching list command')
  const exact = items.find(item => idOf(item) === prefix)
  if (exact) return exact
  const found = items.filter(item => idOf(item).startsWith(prefix))
  if (found.length === 1) return found[0]!
  if (!found.length) throw new CliError('not_found', `no ${what} matches ${prefix}`)
  throw new CliError('ambiguous_id', `${found.length} ${what}s match ${prefix}: ${found.slice(0, 5).map(item => idOf(item).slice(0, 12)).join(', ')}${found.length > 5 ? ', and more' : ''}`)
}

/** Whether a process currently holds the instance's directory. */
export function locked(stateDir: string): boolean {
  return existsSync(`${stateDir}.lock`)
}
