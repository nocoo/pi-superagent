import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCliBridge, createWebServer, CliBridgeError } from '../src/web/server.ts'
import { textLines } from '../web/src/diff.ts'
import { searchResultItems } from '../web/src/models.ts'
import { request as httpRequest } from 'node:http'

const temporary: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-superagent-web-'))
  temporary.push(directory)
  return directory
}

async function fakeCli(directory: string): Promise<string> {
  const file = join(directory, 'fake-cli.cjs')
  await writeFile(file, `const argv = process.argv.slice(2);\nif (process.env.FAKE_CLI_ERROR === '1') { process.stderr.write(JSON.stringify({command:'fake',error:{code:'failed',message:'fake failure'}})); process.exit(2); }\nif (process.env.FAKE_CLI_TIMEOUT === '1') { setTimeout(() => {}, 5000); }\nelse if (process.env.FAKE_CLI_OUTPUT === '1') { process.stdout.write('x'.repeat(1024 * 1024)); process.exit(0); }\nelse process.stdout.write(JSON.stringify({command:argv.join(' '),result:{argv}}));\n`)
  return file
}

afterEach(async () => {
  delete process.env.FAKE_CLI_ERROR
  delete process.env.FAKE_CLI_TIMEOUT
  delete process.env.FAKE_CLI_OUTPUT
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('CLI bridge', () => {
  it('forces --state-dir and --json and calls the CLI with argv', async () => {
    const directory = await tempDir()
    const cli = await fakeCli(directory)
    const bridge = createCliBridge({ cliPath: cli, stateDir: join(directory, 'state') })
    const response = await bridge(['ticket', 'show', 'abc123'])
    const result = response.result as { argv: string[] }
    expect(result.argv.slice(0, 4)).toEqual(['--state-dir', join(directory, 'state'), '--json', 'ticket'])
    expect(result.argv).toEqual(['--state-dir', join(directory, 'state'), '--json', 'ticket', 'show', 'abc123'])
  })

  it('rejects run, web, editor, wait, and unbounded wait commands', async () => {
    const directory = await tempDir()
    const bridge = createCliBridge({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state') })
    for (const args of [['run'], ['web'], ['config', 'edit'], ['ticket', 'wait', 'abc123']]) {
      await expect(bridge(args)).rejects.toBeInstanceOf(CliBridgeError)
    }
  })

  it('allows the documented read and mutation shapes', async () => {
    const directory = await tempDir()
    const bridge = createCliBridge({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state') })
    await expect(bridge(['ticket', 'stop', 'abc123', '--reason', 'operator'])).resolves.toMatchObject({ ok: true })
    await expect(bridge(['ticket', 'read', 'abc123', '--lines', '20'])).resolves.toMatchObject({ ok: true })
    await expect(bridge(['chat', 'general', '--send', 'run web', '--as', 'operator'])).resolves.toMatchObject({ ok: true })
    await expect(bridge(['thread', 'unsubscribe', 'github:6'])).resolves.toMatchObject({ ok: true })
    await expect(bridge(['prompt', 'set', '--base-revision', '4', '--file', '-'], '{}')).resolves.toMatchObject({ ok: true })
  })

  it('keeps message text separate from forbidden command names', async () => {
    const directory = await tempDir()
    const bridge = createCliBridge({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state') })
    await expect(bridge(['ticket', 'answer', 'abc123', '--text', 'run web from the operator'])).resolves.toMatchObject({ ok: true })
    await expect(bridge(['chat', 'general', '--send', '--json'])).resolves.toMatchObject({ ok: true })
    await expect(bridge(['prompt', 'preview', '--file', '/tmp/config.json'])).resolves.toMatchObject({ ok: true })
  })

  it('rejects unknown options and forbidden top-level commands', async () => {
    const directory = await tempDir()
    const bridge = createCliBridge({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state') })
    await expect(bridge(['ticket', 'show', 'abc123', '--wait'])).rejects.toBeInstanceOf(CliBridgeError)
    await expect(bridge(['config', 'edit'])).rejects.toBeInstanceOf(CliBridgeError)
    await expect(bridge(['ticket', 'wait', 'abc123'])).rejects.toBeInstanceOf(CliBridgeError)
  })

  it('terminates timed out children and limits output', async () => {
    const directory = await tempDir()
    const cli = await fakeCli(directory)
    process.env.FAKE_CLI_TIMEOUT = '1'
    await expect(createCliBridge({ cliPath: cli, stateDir: join(directory, 'state'), timeoutMs: 50 })(['status']))
      .rejects.toMatchObject({ status: 504, code: 'timeout' })
    delete process.env.FAKE_CLI_TIMEOUT

    process.env.FAKE_CLI_OUTPUT = '1'
    await expect(createCliBridge({ cliPath: cli, stateDir: join(directory, 'state'), maxOutputBytes: 1024 })(['status']))
      .rejects.toMatchObject({ status: 502, code: 'output_too_large' })
    delete process.env.FAKE_CLI_OUTPUT
  })

  it('runs the built CLI and maps no_instance to a read error', async () => {
    const directory = await tempDir()
    const bridge = createCliBridge({ cliPath: join(process.cwd(), 'lib', 'cli.js'), stateDir: join(directory, 'missing') })
    await expect(bridge(['status'])).rejects.toMatchObject({ status: 404, code: 'no_instance' })
  })

  it('returns CLI JSON errors instead of discarding stderr', async () => {
    const directory = await tempDir()
    process.env.FAKE_CLI_ERROR = '1'
    const bridge = createCliBridge({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state') })
    await expect(bridge(['status'])).rejects.toMatchObject({ code: 'failed', message: 'fake failure' })
  })
})

describe('native web server', () => {
  it('uses the actual ephemeral loopback port for host and origin checks', async () => {
    const directory = await tempDir()
    const staticDir = join(directory, 'static')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Superagent</title>')
    const web = createWebServer({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state'), staticDir, port: 0 })
    await web.listen()
    try {
      const address = web.server.address()
      if (!address || typeof address === 'string') throw new Error('server has no TCP address')
      const base = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${base}/`, { headers: { host: `127.0.0.1:${address.port}`, origin: base } })
      expect(response.status).toBe(200)
    } finally {
      await web.close()
    }
  })

  it('returns 400 for a malformed URL without exiting the process', async () => {
    const directory = await tempDir()
    const staticDir = join(directory, 'static')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<!doctype html>')
    const web = createWebServer({ cliPath: await fakeCli(directory), stateDir: join(directory, 'state'), staticDir, port: 0 })
    await web.listen()
    try {
      const address = web.server.address()
      if (!address || typeof address === 'string') throw new Error('server has no TCP address')
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '//[', method: 'GET', headers: { host: `127.0.0.1:${address.port}` } }, response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        })
        request.on('error', reject)
        request.end()
      })
      expect(status).toBe(400)
    } finally {
      await web.close()
    }
  })

  it('serves loopback and exact local hosts, bridges POST JSON, and rejects forbidden origins', async () => {
    const directory = await tempDir()
    const staticDir = join(directory, 'static')
    await writeFile(join(directory, 'placeholder'), '')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(staticDir)
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Superagent</title>')
    const cli = await fakeCli(directory)
    const web = createWebServer({ cliPath: cli, stateDir: join(directory, 'state'), staticDir, port: 0 })
    await web.listen()
    try {
      const address = web.server.address()
      if (!address || typeof address === 'string') throw new Error('server has no TCP address')
      const base = `http://127.0.0.1:${address.port}`
      const loopbackHost = `127.0.0.1:${address.port}`
      const index = await fetch(`${base}/`, { headers: { host: loopbackHost } })
      expect(index.status).toBe(200)

      const forbiddenOrigin = await fetch(`${base}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: loopbackHost },
        body: JSON.stringify({ args: ['status'] }),
      })
      expect(forbiddenOrigin.status).toBe(403)

      const bridge = await fetch(`${base}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, host: loopbackHost },
        body: JSON.stringify({ args: ['ticket', 'show', 'abc123'] }),
      })
      expect(bridge.status).toBe(200)
      expect(await bridge.json()).toMatchObject({ ok: true })

      const forbiddenCommand = await fetch(`${base}/api/cli`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, host: loopbackHost },
        body: JSON.stringify({ args: ['run'] }),
      })
      expect(forbiddenCommand.status).toBe(400)

      const namedHost = await fetch(`${base}/`, {
        headers: { host: 'superagent.dev.hexly.ai', origin: 'https://superagent.dev.hexly.ai' },
      })
      expect(namedHost.status).toBe(200)
    } finally {
      await web.close()
    }
  })
})

describe('UI pure model', () => {
  it('reads CLI search triggers instead of a nonexistent items field', () => {
    expect(searchResultItems({ triggers: [{ id: 'trigger-1' }], threads: [{ key: 'thread:1' }], tickets: [{ id: 'ticket-1' }] }))
      .toEqual([{ id: 'trigger-1' }, { key: 'thread:1' }, { id: 'ticket-1' }])
  })
  it('builds a line diff with additions and removals', () => {
    expect(textLines('a\nb', 'a\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'c' },
    ])
  })
})
