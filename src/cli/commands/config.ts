/**
 * `config`: the deployment and the Policy. This is the only command that changes state, and it always says what it
 * changed — a configuration the operator cannot see is worse than one they have to type.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, policyVersion, type Settings } from '../../policy.ts'
import { KV } from '../../kv.ts'
import { CliError } from '../errors.ts'
import { openForRead, openForWrite } from '../context.ts'
import { clip, emit, line, table, type Cli } from '../output.ts'

/** A field that changed, with the values a person can compare. */
interface Change { field: string; before: string; after: string }

const show = (value: unknown): string => value === undefined || value === null || value === '' ? '—'
  : Array.isArray(value) ? value.join(', ') || '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** Splits `provider/model` into the Policy's role model shape, at the first slash. */
function roleModel(route: string, flag: string): { provider: string; model: string } {
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) throw new CliError('usage', `${flag} must be provider/model, not ${route}`)
  return { provider: route.slice(0, slash), model: route.slice(slash + 1) }
}

export function configShow(cli: Cli): void {
  const store = openForRead(cli)
  try {
    const settings = store.settings()
    const account = store.get(KV.runtime.account)
    const github = settings.sources.github?.config as { repository?: string; cli?: string } | undefined
    const enabled = settings.policy.rules.filter(rule => rule.enabled)

    emit(cli, 'config show', { settings, account, policyVersion: policyVersion(settings) }, () => {
      table([
        ['repository', github?.repository ?? '—'],
        ['account', account ? `@${account.login} via ${github?.cli ?? 'gh'}` : 'resolved when the agent starts'],
        ['state', cli.stateDir],
      ])
      line()
      table([
        ['policy', `${policyVersion(settings).slice(0, 8)} · accept ${settings.eval.mode} · ${enabled.length} rules`
          + ` · ${Object.values(settings.policy.sources).reduce((total, part) => total + (part.allowed?.length ?? 0), 0)} allowed`],
        ...enabled.map((rule, index) => [index ? '' : 'rules', `${rule.id.padEnd(10)} ${clip(rule.instruction, 80)}`]),
        ['eval', `timeout ${settings.eval.timeoutSeconds}s${settings.eval.model ? ` · model ${settings.eval.model.provider}/${settings.eval.model.model}` : ''}`],
        ['executor', `${settings.executor.model ? `model ${settings.executor.model.provider}/${settings.executor.model.model} · ` : ''}${settings.executor.maxWorkers} workers`],
        ['', settings.executor.prepare ? `prepare  ${clip(settings.executor.prepare, 80)}` : 'prepare  none — the worker starts in an empty directory'],
      ])
    })
  } finally { store.close() }
}

export function configSet(cli: Cli, options: Record<string, unknown>): void {
  const store = openForWrite(cli)
  try {
    const before = store.settings()
    const after = apply(before, options)
    const changes = diff(before, after)
    const dry = options.dryRun === true
    const removed = removedLogins(before, after)

    if (removed.length && options.yes !== true && !dry) {
      throw new CliError('usage', `--allowed would remove ${removed.join(', ')}`,
        'use --add-allowed to widen the list, or pass --yes to accept the removal')
    }
    if (!changes.length) {
      emit(cli, 'config set', { changes: [], policyVersion: policyVersion(after) }, () => line('nothing to change'))
      return
    }
    if (!dry) {
      store.saveSettings(after, { source: 'internal', block: 'policy', policyVersion: policyVersion(after),
        policyChanged: policyVersion(after) !== policyVersion(before), notified: [] })
    }

    emit(cli, 'config set', { changes, dryRun: dry, policyVersion: policyVersion(after) }, () => {
      table(changes.map(change => [change.field, show(change.before), '→', show(change.after)]))
      if (removed.length) line(`removes ${removed.join(', ')} from the allowed list`)
      if (policyVersion(after) !== policyVersion(before)) {
        line(`policy ${policyVersion(before).slice(0, 8)} → ${policyVersion(after).slice(0, 8)}`)
      }
      line(dry ? 'dry run — nothing written' : 'written')
    })
  } finally { store.close() }
}

/** Applies the flags over the stored settings, leaving every field they do not name untouched. */
function apply(settings: Settings, options: Record<string, unknown>): Settings {
  const next = structuredClone(settings)
  const github = (next.sources.github ??= { enabled: true, config: {} })
  const config = github.config as Record<string, unknown>
  github.enabled = true

  if (typeof options.repository === 'string') {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) {
      throw new CliError('usage', `--repository must be owner/name, not ${options.repository}`)
    }
    config.repository = options.repository
  }
  const part = (next.policy.sources.github ??= { allowed: [], admission: {} })
  const logins = part.allowed ?? []
  if (Array.isArray(options.allowed)) part.allowed = (options.allowed as string[]).map(id => ({ id }))
  if (Array.isArray(options.addAllowed)) {
    const added = (options.addAllowed as string[]).filter(id => !logins.some(entry => entry.id === id)).map(id => ({ id }))
    part.allowed = [...logins, ...added]
  }
  if (Array.isArray(options.removeAllowed)) {
    part.allowed = logins.filter(entry => !(options.removeAllowed as string[]).includes(entry.id))
  }
  if (typeof options.mode === 'string') {
    if (!['off', 'observe', 'auto'].includes(options.mode)) throw new CliError('usage', `--mode ${options.mode} is not off, observe or auto`)
    next.eval.mode = options.mode as Settings['eval']['mode']
  }
  if (typeof options.model === 'string') next.executor.model = { ...roleModel(options.model, '--model'), ...effort(next.executor.model) }
  if (typeof options.assessModel === 'string') next.eval.model = { ...roleModel(options.assessModel, '--assess-model'), ...effort(next.eval.model) }
  if (typeof options.maxWorkers === 'string') {
    const value = Number(options.maxWorkers)
    if (!Number.isInteger(value) || value < 1) throw new CliError('usage', `--max-workers must be a whole number of at least 1, not ${options.maxWorkers}`)
    next.executor.maxWorkers = value
  }
  if (typeof options.prepare === 'string') next.executor.prepare = options.prepare
  if (options.pause === true) next.paused = true
  if (options.resume === true) next.paused = false
  return SettingsSchema.parse(next)
}

/** Keeps a configured reasoning level when only the route changes. */
const effort = (model: Settings['eval']['model']): { reasoningEffort?: string } =>
  model?.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}

/** The fields a person would name, and only those that differ. */
function diff(before: Settings, after: Settings): Change[] {
  const changes: Change[] = []
  const compare = (field: string, was: unknown, now: unknown): void => {
    const [a, b] = [show(was), show(now)]
    if (a !== b) changes.push({ field, before: a, after: b })
  }
  const was = before.sources.github?.config as Record<string, unknown> | undefined
  const now = after.sources.github?.config as Record<string, unknown> | undefined
  compare('repository', was?.repository, now?.repository)
  compare('allowed', before.policy.sources.github?.allowed.map(entry => entry.id),
    after.policy.sources.github?.allowed.map(entry => entry.id))
  compare('mode', before.eval.mode, after.eval.mode)
  compare('model', route(before.executor.model), route(after.executor.model))
  compare('assess-model', route(before.eval.model), route(after.eval.model))
  compare('max-workers', before.executor.maxWorkers, after.executor.maxWorkers)
  compare('prepare', before.executor.prepare, after.executor.prepare)
  compare('paused', before.paused, after.paused)
  return changes
}

const route = (model: { provider: string; model: string } | null | undefined): string | undefined =>
  model ? `${model.provider}/${model.model}` : undefined

/** The logins a change would drop from the allowed list. */
const removedLogins = (before: Settings, after: Settings): string[] => {
  const was = before.policy.sources.github?.allowed.map(entry => entry.id) ?? []
  const now = new Set(after.policy.sources.github?.allowed.map(entry => entry.id) ?? [])
  return was.filter(id => !now.has(id))
}

/** Opens the settings in `$EDITOR` for the parts flags cannot express: rules, the admission table, bots. */
export function configEdit(cli: Cli): void {
  const store = openForRead(cli)
  let before: Settings
  try { before = store.settings() } finally { store.close() }

  const editor = process.env.EDITOR ?? process.env.VISUAL
  if (!editor) throw new CliError('failed', 'no editor configured', 'set $EDITOR, or use config set for the fields it supports')

  const directory = mkdtempSync(join(tmpdir(), 'pi-superagent-config-'))
  const file = join(directory, 'settings.json')
  writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`)
  try {
    const result = spawnSync(editor, [file], { stdio: 'inherit' })
    if (result.status !== 0) throw new CliError('failed', `the editor exited with ${result.status ?? 'no status'}; nothing written`)
    const edited = readFileSync(file, 'utf8')
    let parsed: unknown
    try { parsed = JSON.parse(edited) } catch (error) {
      throw new CliError('failed', `the settings are not valid JSON, nothing written: ${error instanceof Error ? error.message : String(error)}`)
    }
    const validated = SettingsSchema.safeParse(parsed)
    if (!validated.success) {
      const first = validated.error.issues[0]
      throw new CliError('failed', `the settings are not valid, nothing written: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown problem'}`)
    }
    const after = validated.data
    const changes = diff(before, after)
    if (!changes.length) { line('nothing to change'); return }
    const writer = openForWrite(cli)
    try {
      writer.saveSettings(after, { source: 'internal', block: 'policy', policyVersion: policyVersion(after),
        policyChanged: policyVersion(after) !== policyVersion(before), notified: [] })
    } finally { writer.close() }
    table(changes.map(change => [change.field, clip(change.before, 60), '→', clip(change.after, 60)]))
    line('written')
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
