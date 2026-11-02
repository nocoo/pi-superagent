import { githubKind } from './github.ts'
import { imKind } from './im.ts'
import { inboxKind } from './inbox.ts'
import type { Settings } from '../policy.ts'
import { SourceRegistry } from './registry.ts'
import type { SourceKind } from './kind.ts'

export const sourceKinds: SourceKind[] = [githubKind, imKind, inboxKind] as SourceKind[]

export function sourceRegistry(settings: () => Settings): SourceRegistry {
  const registry = new SourceRegistry(settings)
  for (const kind of sourceKinds) registry.register(kind)
  return registry
}
