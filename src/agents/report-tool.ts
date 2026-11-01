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
