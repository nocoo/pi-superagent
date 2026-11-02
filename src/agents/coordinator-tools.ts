import { Type, type Static } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { EngineForMainSession, EngineForPeople, Trigger, Ticket } from '../core/index.ts'
import { threadKey } from '../core/index.ts'
import { assessmentOutcome, type Assessment, type Settings } from '../policy.ts'
import type { Store } from '../store/store.ts'
import type { Deployment } from '../config.ts'
import { readGithubThread, readRepositoryPath, resolveTrigger, resolveTicket, textPage, threadPage, triggerContext } from './context.ts'
import type { Prompts } from '../runtime/prompts.ts'
import type { PiSessions } from './sessions.ts'
import { KV } from '../kv.ts'

export const COORDINATOR_TOOL_NAMES = [
  'orchestrator_read', 'orchestrator_route', 'orchestrator_reply',
  'orchestrator_ticket_retry', 'orchestrator_ticket_request_status',
  'orchestrator_ticket_note', 'orchestrator_thread_unsubscribe',
  'orchestrator_trigger_requeue', 'orchestrator_eval',
  'orchestrator_eval_read', 'orchestrator_eval_decide',
  'orchestrator_settings_read', 'orchestrator_settings_save',
  'orchestrator_prompts_read', 'orchestrator_prompts_save', 'orchestrator_prompts_restore',
] as const

export interface CoordinatorToolHost {
  engine: EngineForMainSession & EngineForPeople
  store: Store
  deployment: Deployment
  paused(): boolean
  configure?: (value: unknown, baseRevision: number) => unknown | Promise<unknown>
  prompts?: Prompts
  sessions?: PiSessions
}

const Decision = Type.Object({
  decision: Type.Unsafe<'accept' | 'ignore'>({ type: 'string', enum: ['accept', 'ignore'] }),
  rule_assessments: Type.Array(Type.Object({
    rule_id: Type.String(),
    matched: Type.Boolean(),
    reason: Type.String({ maxLength: 500 }),
  })),
  direction: Type.Object({
    implementation_requested: Type.Boolean(),
    target_basis: Type.Unsafe<'specified' | 'existing-standard' | 'undetermined'>({ type: 'string', enum: ['specified', 'existing-standard', 'undetermined'] }),
    requires_design_decision: Type.Boolean(),
    evidence: Type.String({ maxLength: 700 }),
  }),
  title: Type.String({ maxLength: 160 }),
  worktree_name: Type.Optional(Type.String({ maxLength: 32 })),
  scope: Type.String({ maxLength: 1500 }),
  intent_evidence: Type.Optional(Type.String({ maxLength: 700 })),
  acknowledgement: Type.Optional(Type.String({ maxLength: 500 })),
  reason: Type.String({ maxLength: 500 }),
}, { additionalProperties: false })

function toolResult(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text' as const, text }], details: value }
}

function ticketCard(ticket: Ticket) {
  return { id: ticket.id.slice(0, 8), title: ticket.title, scope: ticket.mandate.scope, ended: !!ticket.ended,
    state: ticket.attention ? 'attention' : ticket.assignments.at(-1)?.report?.state ?? 'new' }
}

export function coordinatorTools(host: CoordinatorToolHost): ToolDefinition[] {
  const triggerId = (id: string) => resolveTrigger(host.store, id).id
  const ticketId = (id: string) => resolveTicket(host.store, id).id
  const read = defineTool({
    name: 'orchestrator_read',
    label: 'Read coordinator resources',
    description: 'Read bounded tasks, triggers, threads and ticket resources.',
    parameters: Type.Object({
      resource: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8000 })),
    }, { additionalProperties: false }),
    execute: async (_id, params, signal) => {
      const offset = params.offset ?? 0
      const limit = params.limit ?? 4000
      if (params.resource === 'tasks' || params.resource === 'tickets') {
        const items = host.store.tickets.open()
        return toolResult(textPage(params.resource, JSON.stringify(items.map(ticketCard)), offset, limit))
      }
      if (params.resource === 'triggers') {
        const size = Math.min(params.limit ?? 12, 100)
        const items = host.store.read.recentTriggers(offset, size + 1)
        return toolResult({ items: items.slice(0, size), offset, next_offset: items.length > size ? offset + size : undefined })
      }
      if (params.resource.startsWith('thread/') || params.resource.startsWith('threads/')) {
        const key = params.resource.replace(/^threads?\//, '')
        if (key.startsWith('github:')) {
          const number = Number(key.slice('github:'.length))
          if (Number.isInteger(number) && number > 0) {
            return toolResult(await readGithubThread(host.deployment, number, offset, Math.min(params.limit ?? 12, 100), signal))
          }
        }
        return toolResult(threadPage(host.store, key, offset, Math.min(params.limit ?? 12, 100)))
      }
      if (params.resource.startsWith('trigger/')) {
        const id = params.resource.slice('trigger/'.length)
        const ctx = triggerContext(host.store, triggerId(id))
        return toolResult(textPage(params.resource, JSON.stringify(ctx), offset, limit))
      }
      if (params.resource.startsWith('ticket/')) {
        const id = params.resource.slice('ticket/'.length)
        const ticket = resolveTicket(host.store, id)
        return toolResult(textPage(params.resource, JSON.stringify(ticket), offset, limit))
      }
      if (params.resource.startsWith('github/file/') || params.resource.startsWith('github/directory/')) {
        const directory = params.resource.startsWith('github/directory/')
        const path = params.resource.slice(directory ? 'github/directory/'.length : 'github/file/'.length)
        const body = await readRepositoryPath(host.deployment, path, directory ? 'directory' : 'file', signal)
        return toolResult(textPage(params.resource, typeof body === 'string' ? body : JSON.stringify(body), offset, limit))
      }
      throw new Error(`Unknown resource: ${params.resource}`)
    },
  })

  const route = defineTool({
    name: 'orchestrator_route',
    label: 'Route work',
    description: 'Route explicit decisions: accept, attach, stop or ignore.',
    parameters: Type.Object({
      decisions: Type.Array(Type.Object({
        kind: Type.Unsafe<'accept' | 'attach' | 'stop' | 'ignore'>({ type: 'string', enum: ['accept', 'attach', 'stop', 'ignore'] }),
        trigger_id: Type.String(),
        ticket_id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        scope: Type.Optional(Type.String({ maxLength: 1500 })),
        worktree_name: Type.Optional(Type.String({ maxLength: 32 })),
        acknowledgement: Type.Optional(Type.String({ maxLength: 500 })),
        note: Type.Optional(Type.String({ maxLength: 500 })),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const results = params.decisions.map(item => {
        try {
          if (item.kind === 'accept') {
            if (!item.title) throw new Error('accept needs title')
            if (!item.scope) throw new Error('accept needs scope')
            const decision = host.engine.decide(triggerId(item.trigger_id), {
              kind: 'accept', title: item.title, scope: item.scope, reason: item.reason || 'Explicitly routed',
              ...(item.acknowledgement ? { acknowledgement: item.acknowledgement } : {}),
              ...(item.worktree_name ? { name: item.worktree_name } : {}),
              ...(item.note ? { note: item.note } : {}),
            })
            return { trigger_id: item.trigger_id, kind: item.kind, decision: decision.kind,
              ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}) }
          }
          if (item.kind === 'attach') {
            if (!item.ticket_id) throw new Error('attach needs ticket_id')
            const ticket = host.engine.attach(ticketId(item.ticket_id), triggerId(item.trigger_id), item.note)
            return { trigger_id: item.trigger_id, kind: item.kind, ticket_id: ticket.id }
          }
          if (item.kind === 'stop') {
            if (!item.ticket_id) throw new Error('stop needs ticket_id')
            const decision = host.engine.decide(triggerId(item.trigger_id), { kind: 'stop', ticketId: ticketId(item.ticket_id), reason: item.reason || 'Explicitly stopped' })
            return { trigger_id: item.trigger_id, kind: item.kind, decision: decision.kind, ticket_id: item.ticket_id }
          }
          const decision = host.engine.decide(triggerId(item.trigger_id), { kind: 'ignore', reason: item.reason || 'No work requested' })
          return { trigger_id: item.trigger_id, kind: item.kind, decision: decision.kind }
        } catch (error) {
          return { trigger_id: item.trigger_id, kind: item.kind, refused: error instanceof Error ? error.message : String(error) }
        }
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ results }) }], details: { results } }
    },
  })

  const reply = defineTool({
    name: 'orchestrator_reply', label: 'Reply', description: 'Send an answer, result or attention question to the correct conversation.',
    parameters: Type.Object({
      purpose: Type.Unsafe<'answer' | 'result' | 'attention'>({ type: 'string', enum: ['answer', 'result', 'attention'] }),
      trigger_id: Type.Optional(Type.String()),
      ticket_id: Type.Optional(Type.String()),
      human_action: Type.Optional(Type.String()),
      text: Type.String({ minLength: 1, maxLength: 20000 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const reply = host.engine.reply({ purpose: params.purpose, text: params.text,
        ...(params.trigger_id ? { triggerId: triggerId(params.trigger_id) } : {}),
        ...(params.ticket_id ? { ticketId: ticketId(params.ticket_id) } : {}),
        ...(params.human_action ? { question: params.human_action } : {}) })
      return { content: [{ type: 'text' as const, text: JSON.stringify(reply) }], details: reply }
    },
  })

  const retry = defineTool({
    name: 'orchestrator_ticket_retry', label: 'Retry ticket', description: 'Start a retry assignment for a retryable ticket.',
    parameters: Type.Object({ ticket_id: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const ticket = host.engine.retryTicket(ticketId(params.ticket_id))
      return { content: [{ type: 'text' as const, text: JSON.stringify(ticketCard(ticket)) }], details: ticketCard(ticket) }
    },
  })

  const status = defineTool({
    name: 'orchestrator_ticket_request_status', label: 'Request status', description: 'Ask an idle waiting ticket for a status report.',
    parameters: Type.Object({ ticket_id: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const asked = host.engine.requestStatus(ticketId(params.ticket_id))
      return { content: [{ type: 'text' as const, text: asked ? 'Asked for status.' : 'No status was sent.' }], details: { asked } }
    },
  })

  const note = defineTool({
    name: 'orchestrator_ticket_note', label: 'Note ticket', description: 'Send a fact to an open ticket as context, without authority.',
    parameters: Type.Object({ ticket_id: Type.String(), text: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const ticket = host.engine.note(ticketId(params.ticket_id), params.text)
      return { content: [{ type: 'text' as const, text: 'Noted.' }], details: ticketCard(ticket) }
    },
  })

  const unsubscribe = defineTool({
    name: 'orchestrator_thread_unsubscribe', label: 'Unsubscribe thread', description: 'Drop every ticket subscription to a thread.',
    parameters: Type.Object({ thread: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const removed = host.engine.unsubscribe(params.thread)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ removed, thread: params.thread }) }], details: { removed } }
    },
  })

  const reevaluate = defineTool({
    name: 'orchestrator_trigger_requeue', label: 'Reevaluate trigger', description: 'Queue a trigger for a fresh evaluation.',
    parameters: Type.Object({ trigger_id: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const queued = host.engine.reevaluate(triggerId(params.trigger_id))
      return { content: [{ type: 'text' as const, text: JSON.stringify({ queued }) }], details: { queued } }
    },
  })

  const evalContext = defineTool({
    name: 'orchestrator_eval', label: 'Read candidate', description: 'Load bounded context for a candidate trigger.',
    parameters: Type.Object({ trigger_id: Type.String() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const trigger = resolveTrigger(host.store, params.trigger_id)
      const candidate = host.engine.candidate(trigger.id)
      if (!candidate) throw new Error('No assessment is in progress for this trigger')
      return toolResult({ trigger_id: trigger.id.slice(0, 8), eval_id: candidate.evalId.slice(0, 8), strength: candidate.strength,
        thread: candidate.thread.key, text: trigger.text, meta: trigger.meta, tickets: candidate.tickets.map(ticketCard),
        read: `trigger/${trigger.id.slice(0, 8)}` })
    },
  })

  const evalRead = defineTool({
    name: 'orchestrator_eval_read', label: 'Read candidate context', description: 'Page a candidate message, thread or repository resource.',
    parameters: Type.Object({
      trigger_id: Type.String(),
      resource: Type.Unsafe<'message' | 'root' | 'parent' | 'thread' | 'file' | 'directory'>({ type: 'string', enum: ['message', 'root', 'parent', 'thread', 'file', 'directory'] }),
      path: Type.Optional(Type.String()),
      message_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 8000 })),
    }, { additionalProperties: false }),
    execute: async (_id, params, signal) => {
      const ctx = triggerContext(host.store, triggerId(params.trigger_id))
      const trigger = ctx.trigger
      const offset = params.offset ?? 0
      const limit = params.limit ?? 4000
      let body: string
      if (params.resource === 'message') body = resolveTrigger(host.store, params.message_id || trigger.id).text
      else if (params.resource === 'root') body = ctx.root?.text || ''
      else if (params.resource === 'parent') body = ctx.parent?.text || ''
      else if (params.resource === 'thread') {
        if (trigger.source === 'github' && typeof trigger.meta.number === 'number') {
          return toolResult(await readGithubThread(host.deployment, trigger.meta.number, offset, Math.min(params.limit ?? 12, 100), signal))
        }
        return toolResult(threadPage(host.store, ctx.key, offset, limit))
      }
      else {
        if (!params.path) throw new Error('path is required')
        const result = await readRepositoryPath(host.deployment, params.path, params.resource, signal)
        body = typeof result === 'string' ? result : JSON.stringify(result)
      }
      return toolResult(textPage(params.resource, body, offset, limit))
    },
  })

  const settingsRead = defineTool({
    name: 'orchestrator_settings_read', label: 'Read settings', description: 'Read the current settings snapshot for an explicit human configuration request.',
    parameters: Type.Object({ confirmed_human_request: Type.Boolean() }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (!params.confirmed_human_request) throw new Error('Settings reads require explicit human confirmation')
      return toolResult({ settings: host.store.settings(), revision: host.store.get(KV.settings.revision) ?? 0 })
    },
  })

  const settingsSave = defineTool({
    name: 'orchestrator_settings_save', label: 'Save settings', description: 'Save settings only for an explicit human request.',
    parameters: Type.Object({ confirmed_human_request: Type.Boolean(), value: Type.Unknown(), base_revision: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (!params.confirmed_human_request) throw new Error('Settings changes require explicit human confirmation')
      if (!host.configure) throw new Error('Settings configuration is not available')
      const saved = await host.configure(params.value, params.base_revision)
      const settings = host.store.settings()
      if (host.sessions && settings.eval.model) {
        await host.sessions.applyProfile('coordinator', {
          cwd: process.cwd(),
          model: `${settings.eval.model.provider}/${settings.eval.model.model}`,
          thinkingLevel: settings.eval.model.reasoningEffort as never,
        })
      }
      return toolResult(saved)
    },
  })

  const promptsRead = defineTool({
    name: 'orchestrator_prompts_read', label: 'Read prompts', description: 'Read prompt revisions for an explicit human configuration request.',
    parameters: Type.Object({ confirmed_human_request: Type.Boolean(), revision: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (!params.confirmed_human_request) throw new Error('Prompt reads require explicit human confirmation')
      if (!host.prompts) throw new Error('Prompt configuration is not available')
      return toolResult(params.revision === undefined ? host.prompts.current() : host.prompts.get(params.revision))
    },
  })

  const promptsSave = defineTool({
    name: 'orchestrator_prompts_save', label: 'Save prompts', description: 'Save prompt configuration only for an explicit human request.',
    parameters: Type.Object({ confirmed_human_request: Type.Boolean(), value: Type.Unknown(), base_revision: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (!params.confirmed_human_request) throw new Error('Prompt changes require explicit human confirmation')
      if (!host.prompts) throw new Error('Prompt configuration is not available')
      return toolResult(host.prompts.save(params.value, params.base_revision))
    },
  })

  const promptsRestore = defineTool({
    name: 'orchestrator_prompts_restore', label: 'Restore prompts', description: 'Restore a prompt revision only for an explicit human request.',
    parameters: Type.Object({ confirmed_human_request: Type.Boolean(), revision: Type.Number({ minimum: 0 }), base_revision: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      if (!params.confirmed_human_request) throw new Error('Prompt restores require explicit human confirmation')
      if (!host.prompts) throw new Error('Prompt configuration is not available')
      return toolResult(host.prompts.restore(params.revision, params.base_revision))
    },
  })

  const evalDecide = defineTool({
    name: 'orchestrator_eval_decide', label: 'Decide candidate', description: 'Record a candidate decision after reading its context.',
    parameters: Type.Object({ trigger_id: Type.String(), eval_id: Type.String(), ...Decision.properties }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const resolved = triggerId(params.trigger_id)
      const candidate = host.engine.candidate(resolved)
      if (!candidate) throw new Error('No assessment is in progress for this trigger')
      if (candidate.evalId !== params.eval_id && !(params.eval_id.length >= 8 && candidate.evalId.startsWith(params.eval_id))) {
        throw new Error(`Assessment eval_id mismatch: expected ${candidate.evalId.slice(0, 8)}`)
      }
      if (candidate.strength === 'explicit') throw new Error('Explicit requests use orchestrator_route and do not require a proactive rule')
      const { trigger_id, eval_id, ...raw } = params
      const settings = host.store.settings()
      const assessment = raw as unknown as Assessment
      const outcome = assessmentOutcome(assessment, settings, candidate.strength)
      const decision = host.engine.decide(resolved, { ...outcome, evalId: candidate.evalId })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ decision: decision.kind, ticket_id: decision.ticketId }) }], details: decision }
    },
  })

  return [read, route, reply, retry, status, note, unsubscribe, reevaluate, evalContext, evalRead, evalDecide,
    settingsRead, settingsSave, promptsRead, promptsSave, promptsRestore]
}
