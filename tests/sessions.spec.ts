import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSessions } from '../src/agents/sessions.ts'

const roots: string[] = []
const managers: PiSessions[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disposeAll()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sessions-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir)
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { test: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions',
    apiKey: 'not-a-real-key', models: [{ id: 'test-model' }] } } }))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'test', defaultModel: 'test-model', cacheWarming: 'off',
    enableInstallTelemetry: false, enableAnalytics: false, defaultProjectTrust: 'never' }))
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  const manager = new PiSessions(join(root, 'sessions'))
  managers.push(manager)
  return { manager, profile: { cwd: root, model: 'test/test-model', tools: ['read'], promptRole: 'orchestrator' as const } }
}

it('coalesces concurrent opens into one real Pi session', async () => {
  const { manager, profile } = fixture()
  const [first, second] = await Promise.all([manager.ensure('same', profile), manager.ensure('same', profile)])
  expect(first).toBe(second)
  expect(manager.get('same')).toBe(first)
  expect(first.systemPrompt).toContain('task coordinator')
  expect(first.systemPrompt).not.toContain('You are an expert coding assistant')
})

it('closes a session even when disposal races its initialization', async () => {
  const { manager, profile } = fixture()
  const opening = manager.ensure('starting', profile)
  const closing = manager.dispose('starting')
  await Promise.all([opening, closing])
  expect(manager.get('starting')).toBeUndefined()
})

it('prevents new sessions after manager shutdown', async () => {
  const { manager, profile } = fixture()
  await manager.disposeAll()
  await expect(manager.ensure('late', profile)).rejects.toThrow('stopping')
})
