import { createServer, createConnection, type Server } from 'node:net'
import { chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { LookupError } from '../infra/identifiers.ts'

const MAX_BYTES = 1_048_576
const TIMEOUT_MS = 15_000
const RequestSchema = z.object({ action: z.string().min(1), payload: z.unknown().optional() }).strict()
export type ControlRequest = z.infer<typeof RequestSchema>
export interface ControlFailure { code: string; message: string }
export type ControlResponse = { result: unknown } | { error: ControlFailure }
export const controlPath = (stateDir: string): string => join(stateDir, 'control.sock')

export class ControlError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export async function serveControl(stateDir: string, execute: (request: ControlRequest) => unknown | Promise<unknown>): Promise<Server> {
  const path = controlPath(stateDir)
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  const server = createServer(socket => {
    let input = Buffer.alloc(0)
    let handled = false
    const answer = (value: ControlResponse): void => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`) }
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('data', chunk => {
      if (handled) return
      input = Buffer.concat([input, chunk])
      if (input.length > MAX_BYTES) { handled = true; answer({ error: { code: 'usage', message: 'Management request is too large' } }); return }
      const end = input.indexOf(10)
      if (end < 0) return
      handled = true
      void (async () => {
        try {
          const request = RequestSchema.parse(JSON.parse(input.subarray(0, end).toString('utf8')))
          answer({ result: await execute(request) })
        } catch (error) {
          const code = error instanceof ControlError || error instanceof LookupError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'usage' : 'failed'
          answer({ error: { code, message: error instanceof Error ? error.message : String(error) } })
        }
      })()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  await chmod(path, 0o600)
  return server
}

export async function closeControl(server: Server, stateDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await unlink(controlPath(stateDir)).catch(error => { if (error.code !== 'ENOENT') throw error })
}

export function requestControl(stateDir: string, request: ControlRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath(stateDir))
    let input = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    socket.setTimeout(TIMEOUT_MS, () => finish(new ControlError('timeout', 'Management response timed out; inspect state before retrying the command')))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('error', error => finish(new ControlError('not_running', `Cannot reach the running instance: ${error.message}`)))
    socket.on('end', () => { if (!settled) finish(new ControlError('failed', 'Management connection closed without a response; inspect state before retrying')) })
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk])
      if (input.length > MAX_BYTES * 8) { finish(new ControlError('failed', 'Management response is too large')); return }
      const end = input.indexOf(10)
      if (end < 0) return
      try {
        const response = JSON.parse(input.subarray(0, end).toString('utf8')) as ControlResponse
        if ('error' in response) finish(new ControlError(response.error.code, response.error.message))
        else if ('result' in response) finish(undefined, response.result)
        else finish(new ControlError('failed', 'Invalid management response'))
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  })
}
