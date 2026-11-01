/** Source kind contract: configuration schema, listening rule, channel adapter, thread context reader, and environment. */
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceContext, SourceHost } from './host.ts'

export interface Localized { zh: string; en: string }

export interface VariableSpec { key: string; description: Localized }

/** Outbound messaging adapter for a source kind's threads. */
export interface SourceChannel<C> {
  /** Whether a reply may still go to `address`; without it, every address may receive replies. */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the target conversation no longer accepts replies.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
}

/** Policy extension for a source kind, defining allowed senders and the admission table rows that scope them. */
export interface SourcePolicyPart {
  /** Validates the Source's part of the Policy: `allowed` (senders who may originate work) and, when the kind lists them, `bots`. */
  schema: z.ZodType<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
}

/** Pluggable source kind descriptor registered with SourceRegistry. */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable ID; a default instance with the same ID exists when none is stored. */
  kind: string
  title: Localized
  description: Localized
  /** Validates stored configuration and fills defaults. */
  schema: z.ZodType<C>
  /** Health entry names owned by this kind; no other kind or core loop may report them. */
  health: string[]
  /** Listening rule for a trigger (or recorded Mandate basis) of this kind; kinds without `scope` listen to everything they produce and observe none of it. */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** Outbound reply adapter; kinds without `channel` produce no replies or channel checks. */
  channel?: SourceChannel<C>
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: { variables: readonly VariableSpec[]; values(input: { config: C; trigger?: Trigger }): Record<string, string> }
  /** Runs the kind's loops against `host` until the returned stop function is called. */
  start(host: SourceHost, instance: SourceInstance<C>): () => void
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
