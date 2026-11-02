import { Type } from 'typebox'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { reached, type EngineForExecutor, type Ticket } from '../core/index.ts'
import type { Store } from '../store/store.ts'
import { resolveTrigger, textPage, threadPage } from './context.ts'

export interface WorkerToolHost {
  engine: EngineForExecutor
  ticket: Ticket
  store: Pick<Store, 'tickets' | 'threads' | 'triggers' | 'read'>
}

export function workerTools(host: WorkerToolHost): ToolDefinition[] {
  const read = defineTool({
    name: 'orchestrator_read', label: 'Read task context',
    description: 'Read this ticket, a followed thread/<source:id> by message offset, or a reached trigger/<id> by character offset. Follow next_offset to read more.',
    parameters: Type.Object({ resource: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })) }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const current = host.store.tickets.get(host.ticket.id)
      if (!current) throw new Error('Task not found')
      let value: unknown
      if (params.resource === 'ticket' || params.resource === `ticket/${current.id}`) {
        value = textPage('ticket', JSON.stringify(current), params.offset ?? 0, params.limit)
      } else if (params.resource.startsWith('thread/')) {
        const key = params.resource.slice(7)
        if (!host.store.threads.get(key)?.subscriptions.includes(current.id)) throw new Error('This task does not follow that thread')
        value = threadPage(host.store, key, params.offset ?? 0, Math.min(params.limit ?? 12, 100))
      } else if (params.resource.startsWith('trigger/')) {
        const trigger = resolveTrigger(host.store, params.resource.slice(8))
        if (!trigger || !reached(current, trigger, key => host.store.threads.get(key))) throw new Error('This event did not reach the task')
        value = textPage(params.resource, JSON.stringify(trigger), params.offset ?? 0, params.limit)
      } else throw new Error('Use ticket, thread/<source:id> or trigger/<id>')
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value }
    },
  })
  const ack = defineTool({
    name: 'orchestrator_ack',
    label: 'Acknowledge',
    description: 'Acknowledge one human request before substantial work.',
    parameters: Type.Object({
      trigger_id: Type.String(),
      text: Type.String({ minLength: 1, maxLength: 1000 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId: host.ticket.id, triggerId: resolveTrigger(host.store, params.trigger_id).id, text: params.text })
      return { content: [{ type: 'text' as const, text: JSON.stringify(reply) }], details: reply }
    },
  })

  const follow = defineTool({
    name: 'orchestrator_thread_follow',
    label: 'Follow thread',
    description: 'Follow a related thread for read-only context.',
    parameters: Type.Object({
      thread: Type.String(),
      reason: Type.String({ minLength: 1, maxLength: 300 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const at = params.thread.indexOf(':')
      if (at < 1 || at === params.thread.length - 1) throw new Error('A thread key is <source>:<id>')
      const followed = host.engine.followForContext(host.ticket.id, { source: params.thread.slice(0, at), id: params.thread.slice(at + 1) })
      return { content: [{ type: 'text' as const, text: JSON.stringify({ followed, thread: params.thread, reason: params.reason }) }], details: { followed } }
    },
  })

  const unrelated = defineTool({
    name: 'orchestrator_thread_unrelated',
    label: 'Unfollow unrelated thread',
    description: 'Stop following an attached thread that is unrelated to this ticket.',
    parameters: Type.Object({
      thread: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1, maxLength: 300 }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      host.engine.markUnrelated(host.ticket.id, params.thread, params.reason)
      return { content: [{ type: 'text' as const, text: 'Removed thread subscription.' }], details: { thread: params.thread } }
    },
  })

  return [read, ack, follow, unrelated]
}
