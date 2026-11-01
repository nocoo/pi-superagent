/**
 * The exit codes and error vocabulary of the command line. A script must be able to tell a wrong invocation from a
 * valid invocation whose answer is no, so usage errors have their own status and every failure carries a stable code.
 */

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const

/** Machine-readable failure kinds; [005](../../docs/005-cli.md#errors) lists what each one means. */
export type ErrorCode =
  /** The invocation itself is wrong: an unknown flag, a missing argument. */
  | 'usage'
  /** There is no instance at the state directory. A read command never creates one. */
  | 'no_instance'
  /** The instance exists but has no deployment configured. */
  | 'not_configured'
  /** No such thread, trigger, decision, ticket or channel. */
  | 'not_found'
  /** An identifier prefix matches more than one record. */
  | 'ambiguous_id'
  /** Another process holds the state directory. */
  | 'locked'
  /** The instance is running and the command needs it to be. */
  | 'not_running'
  /** Anything the command could not do, with its own message. */
  | 'failed'

/** A failure the command line reports in its own words, with an optional hint naming the command that fixes it. */
export class CliError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly hint?: string) { super(message) }
}

/** A usage error, which exits 2 rather than 1. */
export class UsageError extends Error {}
