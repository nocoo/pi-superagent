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

/** Normalized message returned by thread context readers; `bot` marks a non-human sender whose message can never authorize work on its own. */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }

/** Bounded thread context reader used by assessments to inspect messages around a trigger. */
export interface ThreadContext<C> {
  /** The ID of the Trigger's own message among the messages of its Thread. */
  messageId(trigger: Trigger): string
  /** Reads a page of thread messages (`thread`, first page when `cursor` is omitted), the topic root (`root`), or the replied-to message (`parent`). */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
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
  /** Bounded context reader for assessments; assessments of a kind without `threadContext` read none. */
  threadContext?: ThreadContext<C>
  /** Policy section for kinds whose senders have their own identity. */
  policy?: SourcePolicyPart
  /** Variables the kind registers with the execution environment and how their values are computed. */
  environment?: { variables: readonly VariableSpec[]; values(input: { config: C; trigger?: Trigger }): Record<string, string> }
  /** Runs the kind's loops against `host` until the returned stop function is called. */
  start(host: SourceHost, instance: SourceInstance<C>): () => void
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
