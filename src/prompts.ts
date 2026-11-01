/**
 * Prompt files. Following the original design, behaviour a team describes in words is prompt text rather than a setting,
 * so the prompts are markdown in the package and can be edited without touching code.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let root: string | undefined
/** Package root, from either the source tree or the compiled `lib/` output. */
export function packageRoot(): string {
  if (root) return root
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name === 'pi-superagent') return root = directory
    } catch { /* A missing or foreign package.json on the way up is not this package. */ }
    directory = dirname(directory)
  }
  throw new Error('pi-superagent package root not found')
}

const cache = new Map<string, string>()
/** Reads a prompt file by name, without its extension; the content is cached for the process. */
export function prompt(name: 'assess' | 'work'): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const text = readFileSync(join(packageRoot(), 'prompts', `${name}.md`), 'utf8').trim()
  cache.set(name, text)
  return text
}
