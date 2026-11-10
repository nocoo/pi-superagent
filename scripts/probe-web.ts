import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium, expect, type Browser, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test'
import * as assert from 'node:assert/strict'

const defaultUrl = 'https://superagent.dev.hexly.ai'
const baseUrl = (process.env.WEB_PROBE_URL || defaultUrl).replace(/\/$/, '')
const screenshotDir = resolve(process.env.WEB_PROBE_DIR || '.local/browser')
const reportPath = resolve(screenshotDir, 'probe-report.json')

interface ProbeReport {
  baseUrl: string
  startedAt: string
  finishedAt?: string
  browser: string
  screenshots: string[]
  bridgeRequests: { args: unknown; method: string; url: string }[]
  consoleErrors: { text: string; location?: string }[]
  pageErrors: string[]
  failedRequests: { url: string; error: string }[]
  observations: Record<string, unknown>
  fatal?: string
}

const report: ProbeReport = {
  baseUrl,
  startedAt: new Date().toISOString(),
  browser: '',
  screenshots: [],
  bridgeRequests: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  observations: {},
}

async function chooseBrowser(): Promise<{ browser: Browser; name: string }> {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const candidates = [systemChrome, chromium.executablePath()]
  for (const executablePath of candidates) {
    if (!executablePath || !existsSync(executablePath)) continue
    try {
      const browser = await chromium.launch({
        headless: true,
        executablePath,
      })
      return { browser, name: executablePath }
    } catch (error) {
      report.observations.launchFallback = String(error instanceof Error ? error.message : error)
    }
  }
  throw new Error(`No usable Chromium: tried ${candidates.filter(Boolean).join(', ')}`)
}

async function screenshot(page: Page, name: string): Promise<void> {
  const file = resolve(screenshotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  report.screenshots.push(file)
}

async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate(path => { window.location.hash = path }, hash)
  await page.waitForTimeout(350)
}

async function clickText(page: Page, text: string, exact = true): Promise<boolean> {
  const locator = page.getByText(text, { exact })
  if (await locator.count() === 0) return false
  await locator.first().click()
  await page.waitForTimeout(350)
  return true
}

async function clickRole(page: Page, role: 'tab' | 'button', name: string): Promise<boolean> {
  const locator = page.getByRole(role, { name, exact: true })
  if (await locator.count() === 0) return false
  await locator.first().click()
  await page.waitForTimeout(350)
  return true
}

async function verifyRoot(page: Page): Promise<boolean> {
  await page.waitForSelector('#root', { timeout: 15_000 })
  const body = await page.locator('body').innerText().catch(() => '')
  return body.trim().length > 0
}

async function apiArgs(page: Page, args: string[], input?: string): Promise<{ status: number; envelope: Record<string, unknown> }> {
  return page.evaluate(async ({ args, input }) => {
    const response = await fetch('/api/cli', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args, ...(input === undefined ? {} : { input }) }),
    })
    return { status: response.status, envelope: await response.json() as Record<string, unknown> }
  }, { args, input })
}

async function verifyFrame(page: Page): Promise<void> {
  const sidebar = page.getByTestId('desktop-sidebar')
  const mark = sidebar.getByTestId('brand-mark')
  await expect(sidebar).toBeVisible()
  const before = await mark.boundingBox()
  assert.ok(before)
  await page.getByRole('button', { name: '收起导航', exact: true }).click()
  await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(68)
  const collapsed = await mark.boundingBox()
  assert.ok(collapsed)
  assert.ok(Math.abs((before.x + before.width / 2) - (collapsed.x + collapsed.width / 2)) <= 1, 'Brand axis must stay stable')
  await sidebar.getByRole('button', { name: '任务', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toContainText('任务')
  await screenshot(page, '00-collapsed-navigation')
  await page.getByRole('button', { name: '展开导航', exact: true }).click()
  await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(260)
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('textbox', { name: '搜索', exact: true })).toBeFocused()
  const hash = await page.evaluate(() => location.hash)
  await page.getByRole('link', { name: '跳到内容', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()
  assert.equal(await page.evaluate(() => location.hash), hash, 'Skip link must not change the hash route')
  await go(page, '/')
  report.observations.frame = { collapsedWidth: 68, expandedWidth: 260, stableBrandAxis: true, searchShortcut: true, skipLink: true }
}

async function verifyPendingEditor(page: Page, editor: Locator, group: string, command: string, submit: () => Promise<void>): Promise<void> {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const matches = (body: { args?: string[] }) => body.args?.[0] === group && body.args[1] === command
  const handler = async (route: Route) => {
    if (matches(route.request().postDataJSON() as { args?: string[] })) await gate
    await route.continue()
  }
  await page.route('**/api/cli', handler)
  const request = page.waitForRequest(request => request.url().endsWith('/api/cli') && request.method() === 'POST'
    && matches(request.postDataJSON() as { args?: string[] }), { timeout: 5000 })
  const response = page.waitForResponse(response => response.url().endsWith('/api/cli') && response.request().method() === 'POST'
    && matches(response.request().postDataJSON() as { args?: string[] }), { timeout: 15000 })
  void request.catch(() => {})
  void response.catch(() => {})
  try {
    await submit()
    await request
    await expect(editor).toBeDisabled()
    release()
    assert.equal((await response).status(), 200, 'Pending editor save must succeed')
    await expect(editor).toBeEnabled()
  } finally { release(); await page.unroute('**/api/cli', handler) }
}

async function main(): Promise<void> {
  await mkdir(screenshotDir, { recursive: true })
  let browser: Browser | undefined
  let context: BrowserContext | undefined

  try {
    const chosen = await chooseBrowser()
    browser = chosen.browser
    report.browser = chosen.name

    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()

    page.on('console', message => {
      if (message.type() === 'error') {
        report.consoleErrors.push({ text: message.text(), location: message.location().url || undefined })
      }
    })
    page.on('pageerror', error => report.pageErrors.push(error.message))
    page.on('requestfailed', request => {
      report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText || 'failed' })
    })
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cli') {
        try {
          const body = request.postDataJSON() as { args?: unknown }
          report.bridgeRequests.push({ args: body.args, method: request.method(), url: request.url() })
        } catch {
          report.bridgeRequests.push({ args: null, method: request.method(), url: request.url() })
        }
      }
    })

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(1500)
    if (!await verifyRoot(page)) throw new Error('Root did not render')
    await screenshot(page, '01-overview')
    report.observations.overview = {
      title: await page.title(),
      hash: await page.evaluate(() => window.location.hash),
      bodyTextPresent: (await page.locator('body').innerText()).length > 0,
    }

    await verifyFrame(page)
    await go(page, '/tasks')
    await page.waitForTimeout(1200)
    await screenshot(page, '02-tasks')
    await page.getByRole('combobox', { name: '任务阶段', exact: true }).click()
    await page.getByRole('option', { name: '已结束', exact: true }).click()
    await page.waitForTimeout(900)
    await screenshot(page, '02b-tasks-ended')
    report.observations.endedFilter = { activated: true }
    await page.getByRole('combobox', { name: '任务阶段', exact: true }).click()
    await page.getByRole('option', { name: '全部', exact: true }).click()
    await page.waitForTimeout(800)
    const detailButton = page.getByRole('button', { name: '查看', exact: true })
    assert.ok(await detailButton.count() > 0, 'At least one real task detail must exist')
    await detailButton.first().click()
    await page.waitForTimeout(1200)
    await screenshot(page, '03-task-detail')
    await page.getByText('工作会话', { exact: true }).waitFor({ timeout: 15_000 })
    report.observations.taskDetail = { foundRealTicket: true, hash: await page.evaluate(() => window.location.hash) }

    for (const [hash, name] of [
      ['/threads', '04-threads'], ['/decisions', '05-decisions'], ['/sources', '06-sources'],
      ['/chat', '08-chat'], ['/coordinator', '09-coordinator'],
    ] as const) {
      await go(page, hash)
      await page.waitForTimeout(900)
      await screenshot(page, name)
    }

    await go(page, '/chat')
    const channelInput = page.getByRole('textbox', { name: 'channel', exact: true })
    await expect(channelInput).toBeEnabled()
    const channel = `ui-basalt-${Date.now().toString(36)}`
    await channelInput.fill(channel)
    await page.getByRole('textbox', { name: '发送者', exact: true }).fill('ui-check')
    const composer = page.getByRole('textbox', { name: '消息', exact: true })
    await composer.fill('Draft for the first channel')
    await channelInput.fill(`${channel}-other`)
    await expect(composer).toHaveValue('')
    await composer.fill('Draft for the other channel')
    await channelInput.fill(channel)
    await expect(composer).toHaveValue('Draft for the first channel')
    const chatMessage = `Basalt interface check ${Date.now()}`
    await composer.fill(chatMessage)
    const sent = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/cli') || response.request().method() !== 'POST') return false
      const body = response.request().postDataJSON() as { args?: string[] }
      return body.args?.[0] === 'chat' && body.args.includes('--send')
    })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    assert.equal((await sent).status(), 200, 'Chat send must reach the real CLI')
    await expect(page.locator('.sa-chat-feed')).toContainText(chatMessage)
    await expect(composer).toHaveValue('')
    report.observations.chat = { sent: true, channel, independentDrafts: true }
    await screenshot(page, '08-chat-sent')

    await go(page, '/search')
    await page.waitForTimeout(700)
    const seed = await apiArgs(page, ['search', ''])
    assert.equal(seed.status, 200, 'Real search seed request must succeed')
    const seedResult = seed.envelope.result as { triggers?: { text?: string }[] } | undefined
    const knownText = seedResult?.triggers?.find(trigger => typeof trigger.text === 'string' && trigger.text.trim().length > 0)?.text
    assert.ok(knownText, 'Live instance must expose at least one real Trigger message for search')
    const knownToken = knownText!.match(/[A-Za-z0-9\u4e00-\u9fff_-]{4,}/)?.[0]
    assert.ok(knownToken, 'Real Trigger message must contain a searchable token')

    const searchBox = page.getByRole('textbox', { name: '搜索', exact: true })
    assert.ok(await searchBox.count() > 0, 'Search input must render')
    await searchBox.first().fill(knownToken!)
    const searchResponse = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/cli') || response.request().method() !== 'POST') return false
      try {
        const body = response.request().postDataJSON() as { args?: string[] }
        return body.args?.[0] === 'search' && body.args[1] === knownToken
      } catch { return false }
    })
    await searchBox.first().press('Enter')
    const searchHttp = await searchResponse
    const searchEnvelope = await searchHttp.json() as Record<string, unknown>
    assert.equal(searchHttp.status(), 200, 'UI search bridge request must succeed')
    const searchResult = searchEnvelope.result as { triggers?: { text?: string }[]; threads?: unknown[]; tickets?: unknown[] }
    assert.ok(searchResult && (searchResult.triggers?.length || searchResult.threads?.length || searchResult.tickets?.length), 'Real search must return at least one result')
    assert.ok(searchResult.triggers?.some(trigger => trigger.text?.toLowerCase().includes(knownToken!.toLowerCase()))
      || searchResult.threads?.length || searchResult.tickets?.length, 'Search results must correspond to the known real token')
    await page.waitForTimeout(900)
    assert.ok((await page.locator('body').innerText()).includes(knownToken!), 'Known real message token must be visible in the results')
    await screenshot(page, '07-search')
    report.observations.search = { submitted: true, knownToken, triggerMatches: searchResult.triggers?.length ?? 0 }

    await go(page, '/config')
    await page.waitForTimeout(900)
    const configEditor = page.getByRole('textbox', { name: '完整 settings JSON', exact: true })
    assert.ok(await configEditor.count() > 0, 'Config JSON editor must render')
    const loadedJson = await configEditor.first().inputValue()
    assert.ok(loadedJson.trim() !== '{\n}' && loadedJson.includes('{'), 'Config editor must load real settings JSON')

    await verifyPendingEditor(page, configEditor.first(), 'config', 'import', async () => {
      await page.getByRole('button', { name: '导入配置', exact: true }).click()
      await page.getByRole('button', { name: '确认', exact: true }).click()
    })
    report.observations.pendingConfigEditorLocked = true
    const beforeConfig = await apiArgs(page, ['config', 'show'])
    assert.equal(beforeConfig.status, 200, 'Config show must succeed')
    const beforeResult = beforeConfig.envelope.result as { revision?: number; settings?: unknown }
    assert.equal(typeof beforeResult.revision, 'number', 'Config show must expose revision')
    const staleConfigRevision = (beforeResult.revision ?? 0) + 1
    const stale = await apiArgs(page,
      ['config', 'import', '--base-revision', String(staleConfigRevision), '--file', '-'],
      JSON.stringify(beforeResult.settings))
    assert.equal(stale.status, 409, 'Old/future config baseRevision must conflict')
    const staleConfigEnvelope = stale.envelope as { error?: { code?: string } }
    assert.equal(staleConfigEnvelope.error?.code, 'conflict', 'Config conflict must be explicit')

    const afterConfig = await apiArgs(page, ['config', 'show'])
    assert.equal(afterConfig.status, 200, 'Config show after conflict must succeed')
    const afterResult = afterConfig.envelope.result as { settings?: unknown }
    assert.deepEqual(afterResult.settings, beforeResult.settings, 'Rejected stale config import must not overwrite server settings')

    await configEditor.first().fill('{')
    assert.equal(await clickRole(page, 'button', '导入配置'), true, 'Config import confirmation must open')
    const invalidImportResponse = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/cli') || response.request().method() !== 'POST') return false
      try {
        const body = response.request().postDataJSON() as { args?: string[] }
        return body.args?.[0] === 'config' && body.args[1] === 'import'
      } catch { return false }
    })
    await clickRole(page, 'button', '确认')
    const invalidImportHttp = await invalidImportResponse
    assert.equal(invalidImportHttp.status(), 400, 'Invalid UI config import must be rejected')
    await page.getByRole('alert').filter({ hasText: /json|invalid|配置/i }).waitFor({ timeout: 5000 })
    report.observations.config = { loaded: true, length: loadedJson.length, staleRevision: staleConfigRevision, conflictVerified: true, serverUnchanged: true, uiErrorVisible: true }
    await screenshot(page, '10-config')

    await go(page, '/prompts')
    await page.waitForTimeout(900)
    await clickRole(page, 'tab', '编辑')
    await page.waitForTimeout(900)
    await screenshot(page, '11-prompts-edit')

    const textareas = page.locator('textarea')
    const promptObservation: Record<string, unknown> = {
      textareaCount: await textareas.count(),
      bridgePreviewReady: false,
      historyLoaded: false,
      staleConflictVerified: false,
    }
    report.observations.prompt = promptObservation
    assert.ok(await textareas.count() > 0, 'Prompt editor must render real textarea content')

    const promptShowBefore = await apiArgs(page, ['prompt', 'show'])
    assert.equal(promptShowBefore.status, 200, 'Prompt show must succeed')
    const promptBefore = promptShowBefore.envelope.result as { revision?: number; config?: Record<string, string> }
    assert.equal(typeof promptBefore.revision, 'number', 'Prompt show must expose revision')
    assert.ok(promptBefore.config, 'Prompt show must return the real editable configuration')

    const first = textareas.first()
    await verifyPendingEditor(page, first, 'prompt', 'set', async () => {
      await page.getByRole('button', { name: '保存新版本', exact: true }).click()
    })
    promptObservation.pendingEditorLocked = true
    const value = await first.inputValue()
    const marker = '\n<!-- web probe dirty draft; no save -->'
    await first.fill(value.includes(marker) ? value : `${value}${marker}`)
    await page.waitForTimeout(3500)
    const preserved = (await first.inputValue()).includes(marker)
    assert.equal(preserved, true, 'Prompt dirty draft must survive polling')
    promptObservation.dirtyDraftPreserved = preserved
    promptObservation.dirtyDraftValueLength = (await first.inputValue()).length

    await clickRole(page, 'tab', '预览')
    await page.waitForTimeout(350)
    const previewButton = page.getByText('生成预览', { exact: false })
    assert.ok(await previewButton.count() > 0, 'Prompt preview action must render')
    const previewResponse = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/cli') || response.request().method() !== 'POST') return false
      try {
        const body = response.request().postDataJSON() as { args?: string[] }
        return body.args?.[0] === 'prompt' && body.args[1] === 'preview'
      } catch { return false }
    })
    await previewButton.first().click()
    const previewHttp = await previewResponse
    const previewEnvelope = await previewHttp.json() as { ok?: boolean; result?: { prompts?: Record<string, string> } }
    assert.equal(previewHttp.status(), 200, 'Prompt preview bridge request must succeed')
    assert.equal(previewEnvelope.ok, true, 'Prompt preview bridge response must be successful')
    assert.ok(previewEnvelope.result?.prompts?.orchestrator, 'Prompt preview must contain orchestrator text')
    await page.waitForTimeout(900)
    const previewPanels = await page.locator('.sa-json').allInnerTexts()
    assert.ok(previewPanels.some(text => text.includes(previewEnvelope.result!.prompts!.orchestrator!)),
      'Prompt preview response text must render in the page')
    await screenshot(page, '12-prompts-preview')
    promptObservation.bridgePreviewReady = true

    await clickRole(page, 'tab', '历史与恢复')
    await page.waitForTimeout(900)
    const historyResponse = await apiArgs(page, ['prompt', 'history'])
    assert.equal(historyResponse.status, 200, 'Prompt history request must succeed')
    const historyResult = historyResponse.envelope.result as { versions?: { revision?: number }[] }
    assert.ok(historyResult.versions?.length, 'Prompt history bridge must return real versions')
    const historyVersions = page.getByText(/^版本 /)
    assert.ok(await historyVersions.count() > 0, 'Prompt history must render real versions')
    const latestRevision = historyResult.versions[0]?.revision
    assert.ok(latestRevision !== undefined && (await page.locator('body').innerText()).includes(`版本 ${latestRevision}`),
      'A real revision returned by the bridge must appear in history UI')
    await screenshot(page, '13-prompts-history')
    promptObservation.historyLoaded = true

    const stalePromptRevision = (promptBefore.revision ?? 0) + 1
    const stalePrompt = await apiArgs(page,
      ['prompt', 'set', '--base-revision', String(stalePromptRevision), '--file', '-'],
      JSON.stringify(promptBefore.config))
    assert.equal(stalePrompt.status, 409, 'Old/future Prompt baseRevision must conflict')
    const stalePromptEnvelope = stalePrompt.envelope as { error?: { code?: string } }
    assert.equal(stalePromptEnvelope.error?.code, 'conflict', 'Prompt conflict must be explicit')
    const promptShowAfter = await apiArgs(page, ['prompt', 'show'])
    assert.equal(promptShowAfter.status, 200, 'Prompt show after conflict must succeed')
    assert.deepEqual((promptShowAfter.envelope.result as { config?: unknown }).config, promptBefore.config,
      'Rejected stale Prompt set must not overwrite server config')
    promptObservation.staleConflictVerified = true

    await go(page, '/')
    await page.waitForTimeout(500)
    const themeBefore = await page.locator('html').getAttribute('data-mode')
    assert.equal(await clickRole(page, 'button', '切换主题'), true, 'Theme toggle must render')
    await page.waitForTimeout(500)
    let themeAfter = await page.locator('html').getAttribute('data-mode')
    if (themeAfter === themeBefore) {
      assert.equal(await clickRole(page, 'button', '切换主题'), true, 'Second theme toggle step must render')
      await page.waitForTimeout(500)
      themeAfter = await page.locator('html').getAttribute('data-mode')
    }
    await screenshot(page, '14-theme-dark-or-light')
    assert.ok(themeAfter && themeAfter !== themeBefore, 'Theme toggle must change the real data-mode')
    report.observations.theme = {
      htmlDataMode: themeAfter,
      htmlClass: await page.locator('html').getAttribute('class'),
    }

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    const menuButton = page.getByRole('button', { name: '打开导航', exact: true })
    assert.ok(await menuButton.count() > 0, 'Narrow viewport must render navigation opener')
    await menuButton.first().click()
    await page.waitForTimeout(500)
    report.observations.narrow = { menuOpened: true }
    await screenshot(page, '15-narrow-navigation')
    await page.getByTestId('mobile-sidebar').getByRole('button', { name: '任务', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(menuButton).toBeFocused()
    assert.equal(await page.getByTestId('desktop-sidebar').count(), 0, 'Mobile must not duplicate desktop navigation')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, 'Narrow layouts must not overflow the viewport')
    report.observations.mobileFocusRestored = true

    const uniqueBridgeArgs = report.bridgeRequests.map(item => JSON.stringify(item.args)).filter((value, index, all) => all.indexOf(value) === index)
    report.observations.bridgeRequestCount = report.bridgeRequests.length
    report.observations.bridgeUniqueArgs = uniqueBridgeArgs
    report.observations.rootRendered = await verifyRoot(page)
    assert.equal(report.pageErrors.length, 0, `No page errors allowed: ${report.pageErrors.join('; ')}`)
    assert.ok(report.consoleErrors.every(error => !/unhandled|uncaught/i.test(error.text)),
      `Unhandled console error found: ${report.consoleErrors.map(error => error.text).join('; ')}`)
  } catch (error) {
    report.fatal = error instanceof Error ? error.message : String(error)
  } finally {
    if (report.pageErrors.length && !report.fatal) report.fatal = `Page errors: ${report.pageErrors.join('; ')}`
    if (report.consoleErrors.some(error => /unhandled|uncaught/i.test(error.text)) && !report.fatal) {
      report.fatal = `Unhandled console errors: ${report.consoleErrors.map(error => error.text).join('; ')}`
    }
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    report.finishedAt = new Date().toISOString()
    await writeFile(reportPath, JSON.stringify(report, null, 2))
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }

  if (report.fatal) process.exitCode = 1
}

await main()
