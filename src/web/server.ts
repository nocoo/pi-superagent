import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface CliBridgeOptions {
  cliPath: string
  stateDir: string
  timeoutMs?: number
  maxArgs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
}

export const WEB_PORT = 7062
export const WEB_HOST = '127.0.0.1'
export const WEB_PUBLIC_HOST = 'superagent.dev.hexly.ai'

export interface CliBridgeResponse {
  ok: boolean
  command: string
  result?: unknown
  error?: { code: string; message: string }
  exitCode: number
}

export class CliBridgeError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
  }
}

const rootCommands = new Set([
  'status', 'source', 'thread', 'trigger', 'decision', 'ticket', 'config', 'chat',
  'search', 'coordinator', 'prompt',
])

type OptionSpec = Readonly<Record<string, 'flag' | 'value'>>

function parseOptions(args: readonly string[], start: number, spec: OptionSpec): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (let index = start; index < args.length;) {
    const name = args[index]!
    if (!name.startsWith('--')) throw new CliBridgeError(400, 'usage', `unexpected argument: ${name}`)
    const kind = spec[name]
    if (!kind) throw new CliBridgeError(400, 'usage', `unknown option: ${name}`)
    if (Object.hasOwn(result, name)) throw new CliBridgeError(400, 'usage', `duplicate option: ${name}`)
    if (kind === 'flag') {
      result[name] = true
      index++
      continue
    }
    if (index + 1 >= args.length) throw new CliBridgeError(400, 'usage', `option ${name} requires a value`)
    const value = args[++index]!
    result[name] = value
    index++
  }
  return result
}

function exactPositional(args: readonly string[], start: number, count: number, label: string): void {
  if (args.length - start !== count) throw new CliBridgeError(400, 'usage', `${label} requires ${count} positional argument${count === 1 ? '' : 's'}`)
}

function integerOption(options: Record<string, string | boolean>, name: string, label: string, minimum = 0): number | undefined {
  if (!Object.hasOwn(options, name)) return undefined
  const value = options[name]
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new CliBridgeError(400, 'usage', `${label} must be a whole number`)
  const parsed = Number(value)
  if (parsed < minimum) throw new CliBridgeError(400, 'usage', `${label} must be at least ${minimum}`)
  return parsed
}

function validateArgs(args: readonly string[]): string {
  if (!args.length) throw new CliBridgeError(400, 'usage', 'args is required')
  if (args.length > 64) throw new CliBridgeError(400, 'usage', 'too many arguments')
  const command = args[0]!
  if (!rootCommands.has(command)) throw new CliBridgeError(400, 'usage', `forbidden command: ${command}`)

  if (command === 'status') {
    if (args.length === 1) {
      // no options
    } else if (args.length === 2 && args[1] === '--check') {
      parseOptions(args, 1, { '--check': 'flag' })
    } else throw new CliBridgeError(400, 'usage', 'status accepts only --check')
  } else if (command === 'source') {
    exactPositional(args, 1, 0, 'source')
  } else if (command === 'thread') {
    const sub = args[1]
    if (sub === 'list') {
      parseOptions(args, 2, { '--source': 'value', '--subscribed': 'flag', '--limit': 'value' })
      integerOption(parseOptions(args, 2, { '--source': 'value', '--subscribed': 'flag', '--limit': 'value' }), '--limit', '--limit', 1)
    } else if (sub === 'show') {
      if (!args[2]) throw new CliBridgeError(400, 'usage', 'thread show requires a key')
      const tail = parseOptions(args, 3, { '--limit': 'value' })
      integerOption(tail, '--limit', '--limit', 1)
    } else if (sub === 'unsubscribe') {
      exactPositional(args, 2, 1, 'thread unsubscribe')
    } else throw new CliBridgeError(400, 'usage', 'unknown thread command')
  } else if (command === 'trigger') {
    if (args[1] === 'show' || args[1] === 'reevaluate') exactPositional(args, 2, 1, `trigger ${args[1]}`)
    else throw new CliBridgeError(400, 'usage', 'unknown trigger command')
  } else if (command === 'decision') {
    const sub = args[1]
    if (sub === 'list') {
      const tail = parseOptions(args, 2, { '--kind': 'value', '--since': 'value', '--limit': 'value' })
      integerOption(tail, '--limit', '--limit', 1)
    } else if (sub === 'show' || sub === 'dismiss') exactPositional(args, 2, 1, `decision ${sub}`)
    else throw new CliBridgeError(400, 'usage', 'unknown decision command')
  } else if (command === 'ticket') {
    const sub = args[1]
    if (sub === 'list') {
      const tail = parseOptions(args, 2, { '--stage': 'value', '--all': 'flag', '--limit': 'value' })
      const stage = tail['--stage']
      if (stage !== undefined && !['person', 'working', 'idle', 'ended'].includes(String(stage))) throw new CliBridgeError(400, 'usage', 'invalid ticket stage')
      integerOption(tail, '--limit', '--limit', 1)
    } else if (sub === 'show') {
      exactPositional(args, 2, 1, 'ticket show')
    } else if (sub === 'read') {
      if (!args[2]) throw new CliBridgeError(400, 'usage', 'ticket read requires an id')
      integerOption(parseOptions(args, 3, { '--lines': 'value' }), '--lines', '--lines', 1)
    } else if (sub === 'stop') {
      if (!args[2]) throw new CliBridgeError(400, 'usage', 'ticket stop requires an id')
      parseOptions(args, 3, { '--reason': 'value' })
    } else if (['retry', 'request-status'].includes(sub ?? '')) {
      exactPositional(args, 2, 1, `ticket ${sub}`)
    } else if (sub === 'note' || sub === 'answer') {
      if (!args[2]) throw new CliBridgeError(400, 'usage', `ticket ${sub} requires an id`)
      const tail = parseOptions(args, 3, { '--text': 'value' })
      if (typeof tail['--text'] !== 'string' || !tail['--text'].trim()) throw new CliBridgeError(400, 'usage', `ticket ${sub} requires --text`)
    } else if (sub === 'attach') {
      if (!args[2]) throw new CliBridgeError(400, 'usage', 'ticket attach requires an id')
      const tail = parseOptions(args, 3, { '--trigger': 'value', '--note': 'value' })
      if (typeof tail['--trigger'] !== 'string') throw new CliBridgeError(400, 'usage', 'ticket attach requires --trigger')
    } else throw new CliBridgeError(400, 'usage', 'unknown ticket command')
  } else if (command === 'config') {
    const sub = args[1]
    if (sub === 'show' || sub === 'history') exactPositional(args, 1, 1, `config ${sub}`)
    else if (sub === 'import') {
      const tail = parseOptions(args, 2, { '--base-revision': 'value', '--file': 'value' })
      integerOption(tail, '--base-revision', '--base-revision', 0)
      if (!Object.hasOwn(tail, '--base-revision') || typeof tail['--file'] !== 'string') throw new CliBridgeError(400, 'usage', 'config import requires --base-revision N --file PATH_OR_-')
    } else throw new CliBridgeError(400, 'usage', 'unknown config command')
  } else if (command === 'chat') {
    if (!args[1] || args[1].startsWith('--')) throw new CliBridgeError(400, 'usage', 'chat requires a channel')
    const tail = parseOptions(args, 2, { '--send': 'value', '--as': 'value', '--reply-to': 'value', '--lines': 'value' })
    integerOption(tail, '--lines', '--lines', 1)
  } else if (command === 'search') {
    if (args.length !== 2) throw new CliBridgeError(400, 'usage', 'search requires exactly one query argument')
  } else if (command === 'coordinator') {
    if (args[1] === 'show') exactPositional(args, 1, 1, 'coordinator show')
    else if (args[1] === 'read') {
      integerOption(parseOptions(args, 2, { '--lines': 'value' }), '--lines', '--lines', 1)
    } else throw new CliBridgeError(400, 'usage', 'unknown coordinator command')
  } else if (command === 'prompt') {
    const sub = args[1]
    if (sub === 'show') {
      const tail = parseOptions(args, 2, { '--revision': 'value' })
      integerOption(tail, '--revision', '--revision', 0)
    } else if (sub === 'history') exactPositional(args, 1, 1, 'prompt history')
    else if (sub === 'preview') {
      const tail = parseOptions(args, 2, { '--file': 'value' })
      if (typeof tail['--file'] !== 'string') throw new CliBridgeError(400, 'usage', 'prompt preview requires --file PATH_OR_-')
    } else if (sub === 'set') {
      const tail = parseOptions(args, 2, { '--base-revision': 'value', '--file': 'value' })
      integerOption(tail, '--base-revision', '--base-revision', 0)
      if (!Object.hasOwn(tail, '--base-revision') || typeof tail['--file'] !== 'string') throw new CliBridgeError(400, 'usage', 'prompt set requires --base-revision N --file PATH_OR_-')
    } else if (sub === 'restore') {
      if (!args[2] || !/^\d+$/.test(args[2]!)) throw new CliBridgeError(400, 'usage', 'prompt restore revision must be a whole number')
      const tail = parseOptions(args, 3, { '--base-revision': 'value' })
      integerOption(tail, '--base-revision', '--base-revision', 0)
      if (!Object.hasOwn(tail, '--base-revision')) throw new CliBridgeError(400, 'usage', 'prompt restore requires --base-revision N')
    } else throw new CliBridgeError(400, 'usage', 'unknown prompt command')
  }

  return `${args[0]} ${args[1] ?? ''}`.trim()
}

export function createCliBridge(options: CliBridgeOptions) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxArgs = options.maxArgs ?? 64
  const maxInputBytes = options.maxInputBytes ?? 1024 * 1024

  return async (args: readonly string[], input?: string): Promise<CliBridgeResponse> => {
    if (args.length > maxArgs) throw new CliBridgeError(400, 'usage', 'too many arguments')
    validateArgs(args)
    if (input !== undefined) {
      const bytes = Buffer.byteLength(input)
      if (bytes > maxInputBytes) throw new CliBridgeError(413, 'payload_too_large', 'input exceeds 1 MB')
    }
    if (input !== undefined) {
      const fileIndex = args.indexOf('--file')
      if (fileIndex < 0 || args[fileIndex + 1] !== '-') {
        throw new CliBridgeError(400, 'usage', 'stdin input requires --file -')
      }
    }

    const cliArgs = ['--state-dir', options.stateDir, '--json', ...args]
    const command = args.join(' ')
    const child = spawn(process.execPath, [options.cliPath, ...cliArgs], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputTooLarge = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const bytes = Buffer.byteLength(chunk)
      stdoutBytes += bytes
      if (stdoutBytes > maxOutputBytes) outputTooLarge = true
      else stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      const bytes = Buffer.byteLength(chunk)
      stderrBytes += bytes
      if (stderrBytes > maxOutputBytes) outputTooLarge = true
      else stderr += chunk
    })

    if (input !== undefined) {
      try { child.stdin.end(input) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error
      }
    } else child.stdin.end()

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
      let settled = false
      let timedOut = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        resolve({ ...value, timedOut })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1000)
        killTimer.unref?.()
      }, timeoutMs)
      timer.unref?.()
      child.once('error', error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        reject(error)
      })
      child.once('close', (code, signal) => finish({ code, signal }))
      child.stdin.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && !settled) {
          settled = true
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          child.kill('SIGKILL')
          reject(error)
        }
      })
    })

    if (outputTooLarge) throw new CliBridgeError(502, 'output_too_large', 'CLI output exceeded the response limit')

    if (result.timedOut) throw new CliBridgeError(504, 'timeout', `CLI timed out after ${timeoutMs} ms`)
    if (result.signal) throw new CliBridgeError(504, 'timeout', `CLI terminated: ${result.signal}`)
    let envelope: { command?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    try { envelope = JSON.parse(stdout.trim() || stderr.trim()) as typeof envelope }
    catch {
      throw new CliBridgeError(result.code === 0 ? 502 : 500, 'cli_output', stderr.trim() || stdout.trim() || 'CLI returned no JSON')
    }

    if (result.code !== 0 || envelope.error) {
      const error = envelope.error
      const code = typeof error?.code === 'string' ? error.code : 'cli_failed'
      const status = code === 'usage' ? 400 : code === 'no_instance' ? 404 : code === 'not_found' ? 404
        : code === 'conflict' || code === 'locked' ? 409 : code === 'timeout' ? 504 : result.code === 2 ? 400 : 500
      throw new CliBridgeError(status, code,
        typeof error?.message === 'string' ? error.message : stderr.trim() || 'CLI command failed')
    }
    return { ok: true, command: typeof envelope.command === 'string' ? envelope.command : command,
      result: envelope.result, exitCode: result.code ?? 0 }
  }
}

const publicHost = WEB_PUBLIC_HOST

function loopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sourceAllowed(req: IncomingMessage, actualPort: number): boolean {
  const host = req.headers.host
  const loopbackHosts = new Set([
    '127.0.0.1', 'localhost', '[::1]',
    `127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`,
  ])
  if (!host || (!loopbackHosts.has(host) && host !== publicHost)) return false
  if (!loopbackAddress(req.socket.remoteAddress)) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    const allowedOrigins = new Set([
      `https://${publicHost}`, `http://${publicHost}`,
      `http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, `http://[::1]:${actualPort}`,
    ])
    if (!allowedOrigins.has(origin)) return false
  }
  return true
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ args: string[]; input?: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new CliBridgeError(413, 'payload_too_large', 'request body exceeds 1 MB')
    chunks.push(bytes)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new CliBridgeError(400, 'invalid_json', 'request body must be JSON') }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { args?: unknown }).args)) {
    throw new CliBridgeError(400, 'usage', 'body must contain args:string[]')
  }
  const args = (value as { args: unknown[] }).args
  if (!args.every(arg => typeof arg === 'string')) throw new CliBridgeError(400, 'usage', 'every args item must be a string')
  const input = (value as { input?: unknown }).input
  if (input !== undefined && typeof input !== 'string') throw new CliBridgeError(400, 'usage', 'input must be a string')
  return { args: args as string[], ...(input === undefined ? {} : { input }) }
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
}

async function serveStatic(res: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  const decoded = (() => { try { return decodeURIComponent(pathname) } catch { return '' } })()
  const root = resolve(staticDir)
  const file = resolve(root, `.${decoded}`)
  if (file !== root && !file.startsWith(`${root}${sep}`)) { res.writeHead(403); res.end('Forbidden'); return }
  let found = file
  try { if (!(await stat(found)).isFile()) found = resolve(root, 'index.html') }
  catch { found = resolve(root, 'index.html') }
  try {
    const bytes = await readFile(found)
    res.writeHead(200, { 'content-type': mime[extname(found)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(bytes)
  } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found') }
}

export interface WebServerOptions {
  cliPath: string
  stateDir: string
  staticDir: string
  port?: number
  host?: '127.0.0.1'
  timeoutMs?: number
}

export function createWebServer(options: WebServerOptions) {
  const port = options.port ?? 7062
  const host = options.host ?? '127.0.0.1'
  const bridge = createCliBridge({ cliPath: options.cliPath, stateDir: options.stateDir, timeoutMs: options.timeoutMs })
  let actualPort = port
  const server = createServer(async (req, res) => {
    if (!sourceAllowed(req, actualPort)) { json(res, 403, { ok: false, error: { code: 'forbidden_origin', message: 'source host or origin is not allowed' } }); return }
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') }
    catch { json(res, 400, { ok: false, error: { code: 'invalid_url', message: 'request URL is invalid' } }); return }
    if (req.method === 'POST' && url.pathname === '/api/cli') {
      try {
        const body = await readJsonBody(req, 1024 * 1024)
        const response = await bridge(body.args, body.input)
        json(res, 200, response)
      } catch (error) {
        if (error instanceof CliBridgeError) json(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        else json(res, 500, { ok: false, error: { code: 'cli_failed', message: error instanceof Error ? error.message : 'CLI failed' } })
      }
      return
    }
    if (url.pathname.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
      json(res, 404, { ok: false, error: { code: 'not_found', message: 'route not found' } })
      return
    }
    await serveStatic(res, options.staticDir, url.pathname)
  })
  return { server, bridge, listen: () => new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      if (address && typeof address === 'object') actualPort = address.port
      resolve()
    })
  }), close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

export async function startWebServer(options: WebServerOptions): Promise<() => Promise<void>> {
  const web = createWebServer(options)
  await web.listen()
  return web.close
}
