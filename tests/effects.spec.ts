import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'
import { Effects } from '../src/runtime/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'

it('retains in-flight effects across shutdown even when the interrupted handler returns normally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'effects-'))
  const store = new Store(join(directory, 'state.sqlite'))
  try {
    const effects = new Effects(store, new HealthBoard())
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let started = false
    effects.handle('coordination', async () => { started = true; await pending })
    effects.enqueue('coordination', 'message', { text: 'A durable notice' })
    effects.start()
    await new Promise(resolve => setImmediate(resolve))
    expect(started).toBe(true)
    const draining = effects.drain()
    release()
    await draining
    expect(effects.pending('coordination', 'message')).toBe(true)

    const restarted = new Effects(store, new HealthBoard())
    let delivered = ''
    restarted.handle('coordination', async payload => { delivered = payload.text })
    restarted.start()
    await restarted.idle()
    expect(delivered).toBe('A durable notice')
    expect(restarted.pending('coordination', 'message')).toBe(false)
    await restarted.drain()
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
