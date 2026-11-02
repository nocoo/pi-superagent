import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'
import { Prompts, composePrompts } from '../src/runtime/prompts.ts'

const config = { orchestrator: 'Route requests', assess: 'Investigate', work: 'Perform the task', shared: 'Be concise' }
const stores: { store: Store; directory: string }[] = []
function fixture(): { store: Store; prompts: Prompts; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'prompts-'))
  const store = new Store(join(directory, 'state.sqlite'))
  stores.push({ store, directory })
  return { store, directory, prompts: new Prompts(store, () => config) }
}
afterEach(() => { for (const { store, directory } of stores.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }) } })

describe('versioned prompts', () => {
  it('reads defaults without creating a revision', () => {
    const { prompts } = fixture()
    expect(prompts.current()).toEqual({ revision: 0, savedAt: '', config })
    expect(prompts.read('work')).toEqual({ revision: 0, text: 'Perform the task\n\nBe concise' })
  })
  it('saves immutable revisions, rejects stale writes, and ignores no-op saves', () => {
    const { prompts } = fixture()
    const next = { ...config, work: 'Analyze the data' }
    expect(prompts.save(next, 0).revision).toBe(1)
    expect(prompts.save(next, 1).revision).toBe(1)
    expect(() => prompts.save(config, 0)).toThrow('reload before saving')
    expect(prompts.get(0).config).toEqual(config)
    expect(prompts.history().map(version => version.revision)).toEqual([1, 0])
  })
  it('restores by creating a new revision and persists across store instances', () => {
    const { prompts, directory } = fixture()
    prompts.save({ ...config, work: 'New instructions' }, 0)
    expect(prompts.restore(0, 1)).toMatchObject({ revision: 2, restoredFrom: 0, config })
    const reader = new Store(join(directory, 'state.sqlite'))
    try { expect(new Prompts(reader, () => config).current().revision).toBe(2) } finally { reader.close() }
  })
  it('validates complete prompt configurations before saving', () => {
    const { prompts } = fixture()
    expect(() => prompts.save({ ...config, work: '' }, 0)).toThrow()
    expect(() => prompts.save({ ...config, unknown: true }, 0)).toThrow()
    expect(() => prompts.get(99)).toThrow('No prompt revision')
    expect(prompts.current().revision).toBe(0)
  })
  it('previews the same composition a runtime reads without saving', () => {
    const { prompts } = fixture()
    expect(composePrompts(config)).toEqual({ orchestrator: 'Route requests\n\nBe concise', assess: 'Investigate\n\nBe concise', work: 'Perform the task\n\nBe concise' })
    expect(prompts.current().revision).toBe(0)
  })
})
