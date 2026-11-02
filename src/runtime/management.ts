import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { liveTicket, type Engine, type Ticket, type Trigger } from '../core/index.ts'
import type { Store } from '../store/store.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { ControlError, type ControlRequest } from './control.ts'
import { Prompts } from './prompts.ts'
import { inboxTrigger } from '../sources/inbox.ts'

export interface ManagementHost {
  store: Store
  engine: Engine
  sources: SourceRegistry
  prompts: Prompts
  configure(value: unknown, baseRevision: number): unknown | Promise<unknown>
  notify(id: string, text: string): void
  requestPass(): void
}
const identifier = z.string().min(1)
const text = z.string().trim().min(1).max(20_000)
const idRequest = z.object({ id: identifier }).strict()
const revision = z.number().int().nonnegative()

export async function manage(host: ManagementHost, request: ControlRequest): Promise<unknown> {
  const { engine, store } = host
  const ticket = (id: string): Ticket => {
    const found = store.tickets.get(id)
    if (!found) throw new ControlError('not_found', `No ticket ${id}`)
    return found
  }
  let result: unknown
  switch (request.action) {
    case 'source.receive': {
      if (!host.sources.instance('inbox')?.enabled) throw new ControlError('not_configured', 'Enable the inbox Source before receiving external events')
      const trigger = inboxTrigger(request.payload)
      result = { received: engine.receive(trigger), trigger: trigger.id }
      break
    }
    case 'ticket.stop': {
      const args = z.object({ id: identifier, reason: text.optional() }).strict().parse(request.payload)
      result = { ticket: engine.stopTicket(args.id, args.reason) }; break
    }
    case 'ticket.retry': result = { ticket: engine.retryTicket(idRequest.parse(request.payload).id) }; break
    case 'ticket.note': {
      const args = z.object({ id: identifier, text }).strict().parse(request.payload)
      result = { ticket: engine.note(args.id, args.text) }; break
    }
    case 'ticket.answer': {
      const args = z.object({ id: identifier, text }).strict().parse(request.payload)
      const current = ticket(args.id)
      if (!liveTicket(current)) throw new ControlError('failed', 'Cannot answer an ended ticket')
      const origin = store.triggers.get(current.attention?.triggerId ?? current.origin.triggerId)
      if (!origin) throw new ControlError('not_found', 'The ticket has no originating message')
      const answer: Trigger = { id: randomUUID(), source: origin.source, threads: origin.threads,
        actor: { source: origin.source, id: 'operator' }, human: true, addressed: 'direct', at: new Date().toISOString(),
        text: args.text, meta: { ...origin.meta, operator: true }, ...origin.channel ? { channel: origin.channel } : {} }
      result = store.atomic(() => {
        store.triggers.save(answer)
        store.triggers.saveDisposition(answer.id, { fanout: [], at: answer.at })
        return { ticket: engine.attach(current.id, answer.id, 'Answer from the local operator'), trigger: answer }
      })
      break
    }
    case 'ticket.attach': {
      const args = z.object({ id: identifier, trigger: identifier, note: text.optional() }).strict().parse(request.payload)
      result = { ticket: engine.attach(args.id, args.trigger, args.note) }; break
    }
    case 'ticket.request-status': {
      const { id } = idRequest.parse(request.payload)
      result = { requested: engine.requestStatus(id), ticket: ticket(id) }; break
    }
    case 'thread.unsubscribe': {
      const { id } = idRequest.parse(request.payload)
      result = { thread: id, removed: engine.unsubscribe(id) }; break
    }
    case 'trigger.reevaluate': {
      const { id } = idRequest.parse(request.payload)
      result = { trigger: id, queued: engine.reevaluate(id) }; break
    }
    case 'decision.dismiss': result = { decision: engine.dismiss(idRequest.parse(request.payload).id) }; break
    case 'settings.save': {
      const args = z.object({ value: z.unknown(), baseRevision: revision }).strict().parse(request.payload)
      result = await host.configure(args.value, args.baseRevision); break
    }
    case 'prompts.save': {
      const args = z.object({ value: z.unknown(), baseRevision: revision }).strict().parse(request.payload)
      result = host.prompts.save(args.value, args.baseRevision)
      host.notify(`prompts:${host.prompts.current().revision}`, `Prompt configuration is now revision ${host.prompts.current().revision}.`)
      break
    }
    case 'prompts.restore': {
      const args = z.object({ revision, baseRevision: revision }).strict().parse(request.payload)
      result = host.prompts.restore(args.revision, args.baseRevision)
      host.notify(`prompts:${host.prompts.current().revision}`, `Prompt configuration restored as revision ${host.prompts.current().revision}.`)
      break
    }
    default: throw new ControlError('usage', `Unknown management action ${request.action}`)
  }
  host.requestPass()
  return result
}
