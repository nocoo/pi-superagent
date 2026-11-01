/** The composition root: it locks its state directory, wires the domain to the Pi adapters, and releases everything. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Host, prepareTicket } from '../src/runtime/host.ts'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-superagent-'))
  dirs.push(dir)
  return join(dir, 'state')
}
const deployment = { repository: 'nocoo/pi-superagent', github: { cli: 'gh', login: 'nocoo', noreply: 'nocoo@users.noreply.github.com' } }
const hosts: Host[] = []
function host(dir = stateDir()): Host {
  const created = new Host({ stateDir: dir, deployment })
  hosts.push(created)
  return created
}
afterEach(async () => {
  for (const created of hosts.splice(0)) await created.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the host', () => {
  it('constructs every component and reads default settings before anything runs', () => {
    const root = host()
    expect(root.settings().eval.mode).toBe('observe')
    expect(root.store.settings().policy.rules).toHaveLength(2)
    expect(root.sources.instances()).toEqual([])
  })

  it('refuses a second host on a state directory it already holds', () => {
    const dir = stateDir()
    host(dir)
    expect(() => new Host({ stateDir: dir, deployment })).toThrow()
  })

  it('starts the coordination loop and releases the lock on stop', async () => {
    const dir = stateDir()
    const first = host(dir)
    first.start()
    await first.stop()
    // The lock is free again, so the same directory opens cleanly.
    const second = host(dir)
    expect(second.settings().eval.mode).toBe('observe')
  })

  it('exposes the settings a source reads, and reports only the health entries a kind declared', async () => {
    const root = host()
    root.store.saveSettings({ sources: { github: { enabled: true, config: { pollSeconds: 120 } } } },
      { source: 'internal', block: 'policy', policyVersion: 'v', policyChanged: false, notified: [] })
    let started = 0
    root.register({ kind: 'github', health: ['github'], schema: z.object({ pollSeconds: z.number() }),
      start: () => { started += 1; return () => {} } } as never)
    expect(started).toBe(1)
    const context = root.context({ kind: 'github', health: ['github'] })
    expect(context.config<{ pollSeconds: number }>('github')?.pollSeconds).toBe(120)
    expect(context.deployment.repository).toBe('nocoo/pi-superagent')
    expect(() => context.report('github', { state: 'ready', detail: 'ok' })).not.toThrow()
    expect(() => context.report('nope', { state: 'ready', detail: 'ok' })).toThrow(/does not declare/)
  })

  it('refuses to configure a kind it has not registered, so a stale setting cannot start polling', () => {
    const root = host()
    expect(root.sources.instance('github')).toBeUndefined()
  })
})

describe('prepareTicket', () => {
  const settings = SettingsSchema.parse({ executor: { directory: '' }, policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix typos.' }] } })
  const ticket = { id: 't-0123456789abcdef', mandate: { strength: 'inferred', basis: { via: 'admission', cell: 'listedUnaddressed', rules: ['copy'] } } } as unknown as Ticket

  it('gives a ticket its directory and the assignment text its worker reads', () => {
    const prepared = prepareTicket(ticket, { kind: 'accept', title: 'Fix a typo', scope: 'one string', reason: 'asked', name: 'fix-typo' } as never, settings, '/state')
    expect(prepared.execution?.name).toBe('fix-typo-t-0123456789')
    expect(prepared.execution?.directory).toBe('/state/work/fix-typo-t-0123456789')
    expect(prepared.execution?.assignment).toContain('Copy fixes (copy): Fix typos.')
  })

  it('keeps a routing note separate from the source request', () => {
    const prepared = prepareTicket(ticket, { kind: 'accept', title: 't', scope: 's', reason: 'r', name: 'work', note: 'the reviewer asked too' } as never, settings, '/state')
    expect(prepared.execution?.assignment).toContain('Routing note (not the source request): the reviewer asked too')
  })
})

describe('the agent account', () => {
  it('builds the no-reply commit address GitHub attributes to the account', async () => {
    const { noreplyEmail } = await import('../src/config.ts')
    expect(noreplyEmail('nocoo', 42)).toBe('42+nocoo@users.noreply.github.com')
    expect(noreplyEmail('nocoo')).toBe('nocoo@users.noreply.github.com')
  })
})
