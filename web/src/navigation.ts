export const navigation = [
  { path: '/', label: '概览', group: '工作空间', icon: 'dashboard' },
  { path: '/tasks', label: '任务', group: '工作空间', icon: 'tasks' },
  { path: '/threads', label: '线程与事件', group: '工作空间', icon: 'threads' },
  { path: '/decisions', label: '决策', group: '工作空间', icon: 'decisions' },
  { path: '/sources', label: '来源', group: '工作空间', icon: 'sources' },
  { path: '/chat', label: '本地 Chat', group: '协作', icon: 'chat' },
  { path: '/coordinator', label: '主协调会话', group: '协作', icon: 'coordinator' },
  { path: '/config', label: '配置', group: '管理', icon: 'settings' },
  { path: '/prompts', label: 'Prompt', group: '管理', icon: 'prompts' },
] as const

export const navigationGroups = ['工作空间', '协作', '管理'] as const
export type NavigationItem = typeof navigation[number]

export function activeRoute(route: string, path: string): boolean {
  return path === '/' ? route === '/' : route === path || route.startsWith(`${path}/`)
}

export function routeInfo(route: string): { title: string; breadcrumbs: { href?: string; label: string }[]; known: boolean } {
  const parent = navigation.find(item => activeRoute(route, item.path))
  if (route === '/search') return { title: '搜索', breadcrumbs: [{ href: '/', label: '工作空间' }], known: true }
  if (!parent) return { title: '页面不存在', breadcrumbs: [{ href: '/', label: '工作空间' }], known: false }
  const breadcrumbs = parent.path === '/' ? [] : [{ href: '/', label: '工作空间' }]
  if (route === parent.path) return { title: parent.label, breadcrumbs, known: true }
  if (parent.path !== '/tasks' && parent.path !== '/threads') return { title: '页面不存在', breadcrumbs, known: false }
  const id = route.slice(parent.path.length + 1)
  try { if (!id || id.includes('/') || !decodeURIComponent(id)) throw new Error('Invalid route') }
  catch { return { title: '页面不存在', breadcrumbs, known: false } }
  return { title: parent.path === '/tasks' ? '任务详情' : '线程详情', breadcrumbs: [...breadcrumbs, { href: parent.path, label: parent.label }], known: true }
}

export function appHref(href: string): string {
  return href.startsWith('/') && !href.startsWith('//') ? `#${href}` : href
}
