import { useCallback, useEffect, useRef, useState } from 'react'

export type JsonRecord = Record<string, unknown>

export class CliRequestError extends Error {
  constructor(message: string, readonly code = 'request_failed', readonly status = 0) {
    super(message)
  }
}

export interface CliEnvelope<T = unknown> {
  ok: boolean
  command: string
  result?: T
  error?: { code: string; message: string }
}

export async function runCli<T = unknown>(args: string[], input?: string): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api/cli', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args, ...(input === undefined ? {} : { input }) }),
    })
  } catch {
    throw new CliRequestError('无法连接本机 Web 服务', 'offline')
  }
  let envelope: CliEnvelope<T>
  try { envelope = await response.json() as CliEnvelope<T> }
  catch { throw new CliRequestError(`服务器返回了无效响应 (${response.status})`, 'invalid_response', response.status) }
  if (!response.ok || !envelope.ok) {
    throw new CliRequestError(envelope.error?.message ?? `CLI 请求失败 (${response.status})`,
      envelope.error?.code ?? 'cli_failed', response.status)
  }
  return envelope.result as T
}

export interface CliState<T> {
  data?: T
  loading: boolean
  error?: Error
  reload: () => void
}

export function useCli<T>(args: string[], intervalMs = 0, enabled = true): CliState<T> {
  const key = JSON.stringify(args)
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: Error }>({ loading: true })
  const reloadRef = useRef<() => void>(() => {})

  const reload = useCallback(() => { reloadRef.current() }, [])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let busy = false
    let reloadRequested = false
    let generation = 0

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }

    if (!enabled) {
      setState({ loading: false })
      reloadRef.current = () => {}
      return () => { disposed = true; clearTimer() }
    }

    const load = async () => {
      if (disposed) return
      if (busy) {
        reloadRequested = true
        return
      }
      busy = true
      reloadRequested = false
      clearTimer()
      const requestGeneration = ++generation

      try {
        const value = await runCli<T>(args)
        if (!disposed && requestGeneration === generation) {
          setState({ data: value, loading: false })
        }
      } catch (error) {
        if (!disposed && requestGeneration === generation) {
          setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error : new Error(String(error)) }))
        }
      } finally {
        busy = false
        if (disposed) return
        if (reloadRequested) {
          reloadRequested = false
          void load()
          return
        }
        if (intervalMs > 0) {
          clearTimer()
          timer = setTimeout(() => { void load() }, document.hidden ? intervalMs * 6 : intervalMs)
        }
      }
    }

    reloadRef.current = () => {
      if (disposed) return
      ++generation
      clearTimer()
      void load()
    }
    setState(previous => ({ ...previous, loading: previous.data === undefined }))
    void load()

    return () => {
      disposed = true
      reloadRef.current = () => {}
      clearTimer()
    }
  }, [key, intervalMs, enabled])

  return { ...state, reload }
}

export interface MutationState<T> {
  execute: <R = T>(args: string[], input?: string) => Promise<R>
  busy: boolean
  error?: Error
  clearError: () => void
}

export function useMutation<T = unknown>(): MutationState<T> {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const execute = useCallback(async <R = T>(args: string[], input?: string): Promise<R> => {
    setBusy(true)
    setError(undefined)
    try { return await runCli<R>(args, input) }
    catch (failure) { const next = failure instanceof Error ? failure : new Error(String(failure)); setError(next); throw next }
    finally { setBusy(false) }
  }, [])
  return { execute, busy, error, clearError: () => setError(undefined) }
}

export function useHashRoute() {
  const read = () => window.location.hash.slice(1) || '/'
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const change = () => setRoute(read())
    window.addEventListener('hashchange', change)
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const navigate = useCallback((path: string) => { window.location.hash = path }, [])
  return { route, navigate }
}

export function resultRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : { value }
}

export function entries(value: unknown): [string, unknown][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as JsonRecord)
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(formatValue).join(', ') || '—'
  return JSON.stringify(value, null, 2)
}

export function arrays(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function searchResultItems(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as JsonRecord
  return [...arrays(record.triggers), ...arrays(record.threads), ...arrays(record.tickets)]
}
