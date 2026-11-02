import { describe, expect, it } from 'vitest'
import { activeRoute, appHref, navigation, routeInfo } from '../web/src/navigation.ts'

describe('dashboard navigation', () => {
  it('resolves every navigation destination without duplicating the current breadcrumb', () => {
    for (const item of navigation) {
      const page = routeInfo(item.path)
      expect(page.known).toBe(true)
      expect(page.title).toBe(item.label)
      expect(page.breadcrumbs.some(crumb => crumb.href === item.path)).toBe(false)
    }
  })
  it('keeps task and thread ancestors as real destinations', () => {
    expect(routeInfo('/tasks/abcdef12')).toMatchObject({ title: '任务详情', known: true,
      breadcrumbs: [{ href: '/', label: '工作空间' }, { href: '/tasks', label: '任务' }] })
    expect(routeInfo('/threads/im%3Ageneral')).toMatchObject({ title: '线程详情', known: true })
  })
  it('rejects malformed or unknown routes without throwing', () => {
    for (const path of ['/tasksmith', '/tasks/%', '/tasks/a/b', '/settings', '/config/other']) expect(routeInfo(path).known).toBe(false)
    expect(activeRoute('/tasks/a', '/tasks')).toBe(true)
    expect(activeRoute('/tasks', '/')).toBe(false)
    expect(activeRoute('/tasks-other', '/tasks')).toBe(false)
  })
  it('uses the hash router without rewriting external or anchor links', () => {
    expect(appHref('/tasks')).toBe('#/tasks')
    for (const href of ['https://github.com/nocoo/pi-superagent', 'mailto:test@example.com', '#main-content', '//example.com']) {
      expect(appHref(href)).toBe(href)
    }
  })
})
