import type { Engine } from '../core/index.ts'
import { KV } from '../kv.ts'
import { policyEffects, policyVersion, SettingsSchema, type Settings } from '../policy.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Store } from '../store/store.ts'
import { ControlError } from './control.ts'

export function saveSettings(store: Store, sources: SourceRegistry, value: unknown, baseRevision: number,
  engine?: Pick<Engine, 'policyChanged'>): { settings: Settings; revision: number; policyVersion: string; notified: string[] } {
  const settings = SettingsSchema.parse(value)
  for (const [id, source] of Object.entries(settings.sources)) sources.validate(id, source)
  return store.atomic(() => {
    const revision = store.get(KV.settings.revision) ?? 0
    if (revision !== baseRevision) throw new ControlError('conflict', `Settings revision is ${revision}, not ${baseRevision}; reload before saving`)
    const old = store.settings()
    const before = policyVersion(old), after = policyVersion(settings)
    if (JSON.stringify(old) === JSON.stringify(settings)) return { settings: old, revision, policyVersion: after, notified: [] }
    const scope = (version: Settings) => ({ scope: (input: { source: string; meta: Record<string, unknown> }) => sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, settings, scope)
    const notified = engine ? [...effects.keys()] : []
    store.saveSettings(settings, { source: 'internal', block: 'policy', policyVersion: after, policyChanged: before !== after, notified })
    if (before !== after) engine?.policyChanged(before, after, effects)
    if (engine) store.set(KV.runtime.appliedSettings, settings)
    return { settings, revision: store.get(KV.settings.revision)!, policyVersion: after, notified }
  })
}
