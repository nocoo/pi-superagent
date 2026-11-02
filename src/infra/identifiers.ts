export class LookupError extends Error {
  constructor(readonly code: 'usage' | 'not_found' | 'ambiguous_id', message: string) { super(message) }
}

export function resolveId<T>(prefix: string, items: readonly T[], idOf: (item: T) => string, what: string): T {
  if (prefix.length < 4) throw new LookupError('usage', `${what} ${prefix} is too short; use at least four characters`)
  const exact = items.find(item => idOf(item) === prefix)
  if (exact) return exact
  const found = items.filter(item => idOf(item).startsWith(prefix))
  if (found.length === 1) return found[0]!
  if (!found.length) throw new LookupError('not_found', `No ${what} matches ${prefix}`)
  throw new LookupError('ambiguous_id', `${found.length} ${what}s match ${prefix}: ${found.slice(0, 5).map(item => idOf(item).slice(0, 12)).join(', ')}`)
}
