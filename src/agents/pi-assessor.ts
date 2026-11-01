/**
 * The Assessor port on Pi. A candidate is judged by one short Pi session that reads the candidate's thread and the
 * enabled rules, then records its decision through a tool. It holds no state between candidates, so a Policy change
 * cannot leave a stale judgement behind.
 */
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type { Assessor, AssessmentOutcome, Candidate, EngineForMainSession, Thread } from '../core/index.ts'
import { assessmentOutcome, type Assessment, type Settings } from '../policy.ts'
import type { Store } from '../store/store.ts'
import type { Effects } from '../runtime/effects.ts'
import { Later } from '../runtime/effects.ts'
import type { Deployment } from '../config.ts'
import type { ResolvedModel } from './sessions.ts'
import { prompt } from '../prompts.ts'

/** Host dependencies used by `PiAssessor`. */
export interface AssessorHost {
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered' | 'decide'>
  readonly store: Pick<Store, 'settings' | 'read'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly deployment: Deployment
  paused(): boolean
}

/** Oldest triggers of the candidate's thread included in the assessment prompt, newest kept. */
const WINDOW = 12
/** Characters of one trigger text carried into the prompt. */
const TRIGGER_CHARS = 2000

const RULES = Type.Array(Type.Object({
  rule_id: Type.String(),
  matched: Type.Boolean({ description: 'True only when this trigger asks for the kind of work the rule describes.' }),
  reason: Type.String({ maxLength: 500, description: 'The factual evidence from the discussion for or against.' }),
}), { description: 'Exactly one entry for every enabled rule, including the ones that do not match.' })

const DIRECTION = Type.Object({
  implementation_requested: Type.Boolean({ description: 'The participants ask for a specific change to this project.' }),
  target_basis: Type.Unsafe<'specified' | 'existing-standard' | 'undetermined'>({ type: 'string', enum: ['specified', 'existing-standard', 'undetermined'] }),
  requires_design_decision: Type.Boolean({ description: 'A product, design or interaction decision is still open.' }),
  evidence: Type.String({ maxLength: 700, description: 'The statements that establish these facts.' }),
})

export class PiAssessor implements Assessor {
  private readonly runtime = ModelRuntime.create()
  constructor(private readonly host: AssessorHost) {
    host.effects.handle('assessment', ({ triggerId }) => this.assess(triggerId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }

  /** Queues an assessment of `candidate`; the outcome returns through `Engine.decide`. */
  request(candidate: Candidate): void {
    this.host.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]!.id })
  }

  release(_evalId: string): void { /* Each assessment is one session that ends with it; nothing is retained. */ }

  private async assess(triggerId: string): Promise<void> {
    if (this.host.paused()) throw new Later('Processing is paused')
    const candidate = this.host.engine.candidate(triggerId)
    if (!candidate) return
    const settings = this.host.store.settings()
    this.host.engine.candidateDelivered(candidate.evalId)
    let outcome: AssessmentOutcome
    let recorded: Assessment | undefined
    try {
      recorded = await this.run(candidate, settings)
      outcome = assessmentOutcome(recorded, settings, candidate.strength)
    } catch (error) {
      this.host.engine.decide(triggerId, { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error), evalId: candidate.evalId })
      return
    }
    this.host.engine.decide(triggerId, { ...outcome, evalId: candidate.evalId })
  }

  /** Runs one assessment session and returns what it recorded. */
  private async run(candidate: Candidate, settings: Settings): Promise<Assessment> {
    let recorded: Assessment | undefined
    let last = ''
    const tool = defineTool({
      name: 'decide',
      label: 'Decide',
      description: 'Record the decision on this candidate. Call it exactly once, when you have read enough.',
      parameters: Type.Object({
        decision: Type.Unsafe<'accept' | 'ignore'>({ type: 'string', enum: ['accept', 'ignore'] }),
        rule_assessments: RULES,
        direction: DIRECTION,
        title: Type.String({ maxLength: 160, description: 'The ticket title, in the source language.' }),
        worktree_name: Type.Optional(Type.String({ maxLength: 32, description: 'Meaningful short English kebab-case name, 1-4 words.' })),
        scope: Type.String({ maxLength: 1500, description: 'What the ticket may change.' }),
        intent_evidence: Type.Optional(Type.String({ maxLength: 700, description: 'Required for accept: the quotes that establish the three facts.' })),
        acknowledgement: Type.Optional(Type.String({ maxLength: 500, description: 'For accept: one short sentence posted as a reply, in the source language.' })),
        reason: Type.String({ maxLength: 500 }),
      }, { additionalProperties: false }),
      execute: async (_id, params) => {
        recorded = params as unknown as Assessment
        return { content: [{ type: 'text' as const, text: 'Recorded.' }], details: {} }
      },
    })
    const modelRuntime = await this.runtime
    const agentDir = getAgentDir()
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir,
      systemPromptOverride: () => prompt('assess'),
      appendSystemPromptOverride: () => [],
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd: process.cwd(),
      agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      // Built-in tools stay off so an assessment cannot act; the `decide` tool is a custom tool and remains enabled.
      noTools: 'builtin',
      customTools: [tool],
      ...settings.eval.model ? { model: resolveRoute(modelRuntime, settings.eval.model) } : {},
    })
    const timeout = setTimeout(() => { void session.abort() }, settings.eval.timeoutSeconds * 1000)
    try {
      await session.prompt(this.candidatePrompt(candidate, settings)).finally(() => { last = session.getLastAssistantText() ?? '' })
    } finally {
      clearTimeout(timeout)
      session.dispose()
    }
    if (!recorded) {
      const said = last.trim()
      throw new Error(`The assessment ended without a decision${said ? `: ${said.slice(0, 500)}` : ''}`)
    }
    return recorded
  }

  /** The prompt: the candidate's recent thread, then the enabled rules and the work already ticketed. */
  private candidatePrompt(candidate: Candidate, settings: Settings): string {
    const window = this.host.store.read.threadTriggers(candidate.thread.key, WINDOW)
    const lines = window.map(trigger => {
      const who = trigger.human ? trigger.actor.id : `${trigger.actor.id} (a machine)`
      const text = trigger.text.length > TRIGGER_CHARS ? `${trigger.text.slice(0, TRIGGER_CHARS)}… (${trigger.text.length} characters)` : trigger.text
      return `- [${trigger.id}] ${who} at ${trigger.at}:\n${indent(text)}`
    })
    const focus = candidate.triggers.map(trigger => trigger.id).join(', ')
    const tickets = candidate.tickets.map(ticket => `- ${ticket.id} "${ticket.title}"${ticket.ended ? ' (ended)' : ''}`).join('\n')
    const rules = settings.policy.rules.filter(rule => rule.enabled)
      .map(rule => `### ${rule.name} (${rule.id})\n${rule.instruction}`).join('\n\n')
    return [
      `# Candidate`,
      `Batch strength: ${candidate.strength}. Policy version: ${candidate.policyVersion}.`,
      `Judge these triggers: ${focus}.`,
      '',
      `## Thread ${this.label(candidate.thread)}`,
      lines.join('\n'),
      '',
      tickets ? `## Work already ticketed on this thread\n${tickets}` : '',
      '',
      `## Enabled rules`,
      rules,
    ].filter(Boolean).join('\n')
  }

  private label(thread: Thread): string {
    const label = thread.meta.label
    return typeof label === 'string' ? `${thread.key} (${label})` : thread.key
  }
}

const indent = (text: string): string => text.split('\n').map(line => `  ${line}`).join('\n')

/** Resolves a configured `provider/model` route through the runtime. */
function resolveRoute(runtime: ModelRuntime, route: { provider: string; model: string }): ResolvedModel {
  const model = runtime.getModel(route.provider, route.model)
  if (!model) throw new Error(`Unknown model route ${route.provider}/${route.model}`)
  return model
}
