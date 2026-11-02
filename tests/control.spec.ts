import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Server } from 'node:net'
import { closeControl, ControlError, controlPath, requestControl, serveControl } from '../src/runtime/control.ts'

const opened: { server: Server; dir: string }[] = []
const directories: string[] = []
const directory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-'))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  for (const { server, dir } of opened.splice(0)) await closeControl(server, dir)
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function start(execute: Parameters<typeof serveControl>[1]): Promise<string> {
  const dir = directory()
  const server = await serveControl(dir, execute)
  opened.push({ server, dir })
  return dir
}

function raw(dir: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath(dir))
    let answer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(text))
    socket.on('data', chunk => { answer += chunk.toString() })
    socket.on('end', () => resolve(JSON.parse(answer)))
  })
}

describe('local management transport', () => {
  it('executes a typed request once and returns data', async () => {
    let calls = 0
    const dir = await start(request => { calls++; return request })
    expect(await requestControl(dir, { action: 'ticket.stop', payload: { id: 'one' } }))
      .toEqual({ action: 'ticket.stop', payload: { id: 'one' } })
    expect(calls).toBe(1)
    expect(statSync(controlPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('returns domain errors without retrying mutations', async () => {
    let calls = 0
    const dir = await start(() => { calls++; throw new ControlError('conflict', 'Changed meanwhile') })
    await expect(requestControl(dir, { action: 'settings.save' })).rejects.toMatchObject({ code: 'conflict' })
    expect(calls).toBe(1)
  })

  it('rejects malformed, oversized, and extra request properties', async () => {
    const dir = await start(() => { throw new Error('Must not execute') })
    expect(await raw(dir, '{invalid}\n')).toMatchObject({ error: { code: 'usage' } })
    expect(await raw(dir, '{"action":"x","extra":true}\n')).toMatchObject({ error: { code: 'usage' } })
    expect(await raw(dir, `${'x'.repeat(1_048_577)}\n`)).toMatchObject({ error: { code: 'usage' } })
  })

  it('executes only the first frame on a connection', async () => {
    let calls = 0
    const dir = await start(() => ++calls)
    expect(await raw(dir, '{"action":"one"}\n{"action":"two"}\n')).toEqual({ result: 1 })
    expect(calls).toBe(1)
  })

  it('reports a stopped instance rather than writing around its owner', async () => {
    await expect(requestControl(directory(), { action: 'ticket.stop' })).rejects.toMatchObject({ code: 'not_running' })
  })
})
