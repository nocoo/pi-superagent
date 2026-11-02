import { z } from 'zod'
import { family, record } from '../kv.ts'
import { prompt } from '../prompts.ts'
import type { Store } from '../store/store.ts'
import { Versions } from '../store/versions.ts'
import { ControlError } from './control.ts'

export const PROMPT_ROLES = ['orchestrator', 'assess', 'work'] as const
export type PromptRole = typeof PROMPT_ROLES[number]
const text = z.string().trim().min(1).max(100_000)
export const PromptConfigSchema = z.object({ orchestrator: text, assess: text, work: text, shared: z.string().max(100_000) }).strict()
export type PromptConfig = z.infer<typeof PromptConfigSchema>
export interface PromptVersion { revision: number; savedAt: string; config: PromptConfig; restoredFrom?: number }
const pointer = record<number>('prompts-revision')
const snapshots = family<PromptVersion, [number]>('prompts-version:')
export const defaultPrompts = (): PromptConfig => ({ orchestrator: prompt('orchestrator'), assess: prompt('assess'), work: prompt('work'), shared: '' })
export const composePrompts = (config: PromptConfig): Record<PromptRole, string> => Object.fromEntries(
  PROMPT_ROLES.map(role => [role, [config[role], config.shared].filter(value => value.trim()).join('\n\n')]),
) as Record<PromptRole, string>

export class Prompts {
  private readonly versions: Versions<PromptVersion>
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, private readonly defaults = defaultPrompts) {
    this.versions = new Versions(store, pointer, snapshots)
  }
  current(): PromptVersion { return this.versions.current() ?? this.baseline() }
  get(revision: number): PromptVersion {
    const version = this.versions.get(revision) ?? (revision === 0 ? this.baseline() : undefined)
    if (!version) throw new ControlError('not_found', `No prompt revision ${revision}`)
    return version
  }
  history(): PromptVersion[] {
    const versions = this.versions.list()
    return versions.length ? versions : [this.baseline()]
  }
  read(role: PromptRole): { revision: number; text: string } {
    const version = this.current()
    return { revision: version.revision, text: composePrompts(version.config)[role] }
  }
  save(value: unknown, baseRevision: number, restoredFrom?: number): PromptVersion {
    const config = PromptConfigSchema.parse(value)
    return this.store.atomic(() => {
      const current = this.current()
      if (current.revision !== baseRevision) throw new ControlError('conflict', `Prompt revision is ${current.revision}, not ${baseRevision}; reload before saving`)
      if (JSON.stringify(config) === JSON.stringify(current.config) && restoredFrom === undefined) return current
      if (!this.versions.get(0)) this.versions.keep(this.baseline())
      return this.versions.save(revision => ({ revision, savedAt: new Date().toISOString(), config,
        ...restoredFrom === undefined ? {} : { restoredFrom } }))
    })
  }
  restore(revision: number, baseRevision: number): PromptVersion { return this.save(this.get(revision).config, baseRevision, revision) }
  private baseline(): PromptVersion { return { revision: 0, savedAt: '', config: this.defaults() } }
}
