import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  LinkProvider, ThemeProvider, ThemeToggle, Toaster, TooltipProvider,
  Button, Sheet,
} from '@nocoo/basalt'
import { SheetContent, SheetTitle } from '@nocoo/basalt/components/sheet'
import { AppHeader } from '@nocoo/basalt/components/app-header'
import { AppMain, AppShell, AppSkipLink } from '@nocoo/basalt/components/app-shell'
import { ContentIsland, Sidebar, SidebarHeader, SidebarItem, SidebarNav } from '@nocoo/basalt/components/sidebar'
import pkg from '../../package.json'
import {
  CoordinatorPage, ChatPage, ConfigPage, DecisionsPage, OverviewPage, PromptsPage,
  SearchPage, SourcesPage, TasksPage, ThreadsPage,
} from './App'
import { useHashRoute } from './models'
import '@nocoo/basalt/styles/standalone'
import './styles.css'

const nav = [
  ['/', '概览'], ['/tasks', '任务'], ['/threads', '线程与事件'], ['/decisions', '决策'],
  ['/sources', '来源'], ['/search', '搜索'], ['/config', '配置'], ['/prompts', 'Prompt'],
  ['/chat', '本地 Chat'], ['/coordinator', '主协调会话'],
] as const

function activeFor(route: string, path: string): boolean {
  return path === '/' ? route === '/' : route === path || route.startsWith(`${path}/`)
}

function LocalLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  if (/^(https?:|mailto:|tel:)/.test(href)) return <a href={href} {...props}>{children}</a>
  return <a href={`#${href}`} {...props}>{children}</a>
}

function ShellNavigation({ route, navigate, collapsed, onToggle }: {
  route: string; navigate: (path: string) => void; collapsed: boolean; onToggle: () => void
}) {
  return <Sidebar collapsed={collapsed}>
    <SidebarHeader>
      <div className="web-brand"><strong>Superagent</strong><span className="web-version">v{pkg.version}</span></div>
    </SidebarHeader>
    <SidebarNav aria-label="Superagent 管理导航">
      {nav.map(([path, label]) => <SidebarItem key={path} active={activeFor(route, path)} onClick={() => { navigate(path); onToggle() }}>
        {label}
      </SidebarItem>)}
    </SidebarNav>
  </Sidebar>
}

function RouteView({ route, navigate }: { route: string; navigate: (path: string) => void }) {
  if (route === '/' || route === '') return <OverviewPage />
  if (route.startsWith('/tasks')) return <TasksPage route={route} navigate={navigate} />
  if (route.startsWith('/threads')) return <ThreadsPage route={route} navigate={navigate} />
  if (route === '/decisions') return <DecisionsPage />
  if (route === '/sources') return <SourcesPage />
  if (route === '/search') return <SearchPage />
  if (route === '/config') return <ConfigPage />
  if (route === '/prompts') return <PromptsPage />
  if (route === '/chat') return <ChatPage />
  if (route === '/coordinator') return <CoordinatorPage />
  return <div className="web-state" role="alert">未知页面</div>
}

function App() {
  const { route, navigate } = useHashRoute()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => { setCompact(media.matches); if (!media.matches) setMobileOpen(false); setCollapsed(media.matches) }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const closeMobile = () => setMobileOpen(false)

  return <ThemeProvider>
    <LinkProvider render={props => <LocalLink {...props} />}>
      <TooltipProvider>
        <Toaster />
        <AppShell layout="workspace" className="h-dvh">
          <AppSkipLink href="#web-main">跳到内容</AppSkipLink>
          {!compact && <ShellNavigation route={route} navigate={navigate} collapsed={collapsed} onToggle={() => {}} />}
          {compact && <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent side="left" className="w-[260px] max-w-[260px] border-0 bg-basalt-background p-0">
              <SheetTitle className="sr-only">Superagent 导航</SheetTitle>
              <ShellNavigation route={route} navigate={navigate} collapsed={false} onToggle={closeMobile} />
            </SheetContent>
          </Sheet>}
          <AppMain id="web-main" tabIndex={-1}>
            <AppHeader title={nav.find(([path]) => activeFor(route, path))?.[1] ?? 'Superagent'} density="compact" leading={compact
              ? <Button size="icon" variant="ghost" aria-label="打开导航" onClick={() => setMobileOpen(true)}>菜单</Button>
              : undefined}
              actions={<ThemeToggle aria-label="切换主题" />} />
            <ContentIsland><div className="web-page"><RouteView route={route} navigate={navigate} /></div></ContentIsland>
          </AppMain>
        </AppShell>
      </TooltipProvider>
    </LinkProvider>
  </ThemeProvider>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
