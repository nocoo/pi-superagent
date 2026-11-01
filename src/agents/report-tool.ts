/**
 * The worker-facing `report` tool. A worker states what became of its assignment through this one structured call,
 * which is what the Ticket records; free text in the conversation never changes a ticket's state.
 */
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { ReportState, WorkerReport } from '../core/index.ts'

const STATES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] as const

/**
 * Builds the report tool for one ticket. `submit` receives a validated report; `askedBy` names the person's trigger
 * whose request raised the question, so the question reaches the conversation it came from.
 */
export function reportTool(submit: (report: WorkerReport) => void, askedBy: () => string | undefined) {
  return defineTool({
    name: 'report',
    label: 'Report',
    description: `Report what became of this ticket. Call it when the state of your work changes, and always before you stop working.
- progress: work is under way
- waiting: you have nothing left to do until a new message arrives on this thread
- ready: a result is ready for a person to review
- blocked: a person must act before you can continue
- failed: you could not finish
- dropped: there is nothing to do after all
Set question to ask a person one concrete thing; the ticket then waits for their answer instead of you guessing.`,
    parameters: Type.Object({
      state: Type.Unsafe<ReportState>({ type: 'string', enum: [...STATES] }),
      summary: Type.String({ minLength: 1, maxLength: 4000, description: 'What you did or found, in the source language of the request.' }),
      question: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'One concrete question for a person. Use only with blocked, or instead of a ready result when you need a decision.' })),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const report: WorkerReport = {
        state: params.state,
        summary: params.summary,
        ...params.question ? { question: params.question } : {},
        ...params.question && askedBy() ? { askedBy: askedBy() } : {},
      }
      submit(report)
      return { content: [{ type: 'text' as const, text: `Recorded ${report.state}.` }], details: {} }
    },
  })
}

/**
 * The worker-facing `handback` tool: a message reached this ticket but asks for work the ticket's mandate does not
 * cover. Handing it back queues it for a fresh Eval, which is how a second request in the same channel becomes a ticket
 * of its own instead of being absorbed by the first.
 */
export function handbackTool(submit: (triggerId: string) => boolean) {
  return defineTool({
    name: 'handback',
    label: 'Hand back',
    description: `Hand a message back because it asks for work outside this ticket's scope. Use it when a message in this conversation
is a different request rather than part of this ticket's work. It then becomes a candidate for a ticket of its own, and this
ticket stops receiving it.

Hand back *instead of* working on it, not after: once you have handed a message back, stop. Do not change files, run tests or
report on that request — another ticket will own it, and anything you do for it here is work nobody asked this ticket for.
Do not use it for a message that is within scope.`,
    parameters: Type.Object({
      trigger_id: Type.String({ minLength: 1, description: 'The id shown as [trigger <id>] above the message.' }),
      reason: Type.String({ minLength: 1, maxLength: 300, description: 'Why it is beyond this ticket, in one short sentence.' }),
    }, { additionalProperties: false }),
    execute: async (_id, params) => {
      const queued = submit(params.trigger_id)
      return { content: [{ type: 'text' as const, text: queued
        ? 'Handed back. This message is no longer this ticket\'s: stop working on it, change nothing for it, and report only what you did for this ticket.'
        : 'Handed back. Stop working on this message.' }], details: {} }
    },
  })
}
