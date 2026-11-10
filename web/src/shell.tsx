import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { Button, LinkProvider, ThemeProvider, ThemeToggle, Toaster,
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@nocoo/basalt'
import { AppHeader } from '@nocoo/basalt/components/app-header'
import { AvatarInitials } from '@nocoo/basalt/components/avatar'
import { AccentProvider } from '@nocoo/basalt/providers/accent'
import { Github } from './github-icon'
import { AppMain, AppShell, AppSkipLink } from '@nocoo/basalt/components/app-shell'
import { LinkButton } from '@nocoo/basalt/components/button'
import { Sheet, SheetContent, SheetTitle } from '@nocoo/basalt/components/sheet'
import { ContentIsland, Sidebar, SidebarFooter, SidebarHeader, SidebarIconItem, SidebarItem, SidebarNav,
  SidebarPartition, SidebarSearch, SidebarUser } from '@nocoo/basalt/components/sidebar'
import { Bot, FileText, GitBranch, Inbox, LayoutDashboard, ListTodo, Menu, MessageSquare,
  MessagesSquare, Monitor, Network, PanelLeftClose, PanelLeftOpen, Search, Settings, X } from 'lucide-react'
import pkg from '../../package.json'
import { RouteView } from './App'
import { useHashRoute } from './models'
import { activeRoute, appHref, navigation, navigationGroups, routeInfo } from './navigation'

const icons = { dashboard: LayoutDashboard, tasks: ListTodo, threads: MessagesSquare, decisions: GitBranch,
  sources: Inbox, chat: MessageSquare, coordinator: Network, settings: Settings, prompts: FileText }

function AppLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} href={appHref(href)} />
}

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent side="right">{label}</TooltipContent></Tooltip>
}

function AppSidebar({ route, navigate, collapsed, onToggle, drawer = false }: {
  route: string; navigate: (path: string) => void; collapsed: boolean; onToggle: () => void; drawer?: boolean
}) {
  const search = () => navigate('/search')
  return <Sidebar collapsed={collapsed} aria-label="工作区侧栏" data-testid={drawer ? 'mobile-sidebar' : 'desktop-sidebar'}>
    <SidebarHeader>
      {collapsed && !drawer ? <Bot className="h-5 w-5 shrink-0" strokeWidth={1.5} data-testid="brand-mark" aria-label="Superagent" />
        : <div className="flex w-full min-w-0 items-center justify-between gap-basalt-space-sm">
          <div className="flex min-w-0 items-center gap-basalt-space-lg">
            <Bot className="h-5 w-5 shrink-0" strokeWidth={1.5} data-testid="brand-mark" aria-hidden="true" />
            <span className="truncate text-lg font-semibold text-basalt-foreground md:text-xl">Superagent</span>
            <span className="shrink-0 rounded-md bg-basalt-secondary px-basalt-space-md py-basalt-space-xs text-basalt-xs font-medium leading-none text-basalt-muted-foreground">
              v{pkg.version}
            </span>
          </div>
          <Button size="icon" variant="ghost" onClick={onToggle} aria-label={drawer ? '关闭导航' : '收起导航'}>
            {drawer ? <X aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          </Button>
        </div>}
    </SidebarHeader>
    {collapsed && !drawer && <Hint label="展开导航">
      <Button className="mb-basalt-space-sm self-center" size="icon" variant="ghost" aria-label="展开导航" onClick={onToggle}>
        <PanelLeftOpen aria-hidden="true" />
      </Button>
    </Hint>}
    {!collapsed && <div className="px-basalt-nav-inset">
      <SidebarSearch onClick={search} aria-label="搜索记录" shortcut="⌘K">搜索记录</SidebarSearch>
    </div>}
    <SidebarNav aria-label="Superagent 管理导航">
      {collapsed && <Hint label="搜索记录 · ⌘K"><SidebarIconItem aria-label="搜索记录" active={route === '/search'} onClick={search}>
        <Search className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      </SidebarIconItem></Hint>}
      {navigationGroups.map(group => <div key={group} className="sa-nav-group">
        {!collapsed && <SidebarPartition>{group}</SidebarPartition>}
        {navigation.filter(item => item.group === group).map(item => {
          const Icon = icons[item.icon]
          return collapsed ? <Hint key={item.path} label={item.label}>
            <SidebarIconItem active={activeRoute(route, item.path)} aria-label={item.label}
              aria-current={activeRoute(route, item.path) ? 'page' : undefined} onClick={() => navigate(item.path)}>
              <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            </SidebarIconItem>
          </Hint> : <SidebarItem key={item.path} active={activeRoute(route, item.path)}
            aria-current={activeRoute(route, item.path) ? 'page' : undefined} onClick={() => navigate(item.path)}>
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" /><span>{item.label}</span>
          </SidebarItem>
        })}
      </div>)}
    </SidebarNav>
    <SidebarFooter>
      {collapsed ? <Hint label="本地工作区 · 实例配置">
        <Button size="icon" variant="ghost" aria-label="实例配置" onClick={() => navigate('/config')}><Monitor aria-hidden="true" /></Button>
      </Hint> : <SidebarUser name="本地工作区" email="CLI 驱动 · 仅限本机"
        avatar={<AvatarInitials name="本地工作区" initials="L" size="sm" />}
        action={<Button size="icon" variant="ghost" aria-label="实例配置" onClick={() => navigate('/config')}><Settings aria-hidden="true" /></Button>} />}
    </SidebarFooter>
  </Sidebar>
}

function Workspace() {
  const { route, navigate } = useHashRoute()
  const [collapsed, setCollapsed] = useState(false)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 767px)').matches)
  const [mobileOpen, setMobileOpen] = useState(false)
  const menu = useRef<HTMLButtonElement>(null)
  const info = routeInfo(route)
  const go = (path: string) => { navigate(path); setMobileOpen(false) }
  useEffect(() => {
    const media = matchMedia('(max-width: 767px)')
    const update = () => { setMobile(media.matches); if (!media.matches) setMobileOpen(false) }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    setMobileOpen(false)
    document.title = `${info.title} · Superagent`
    document.getElementById('workspace-content')?.scrollTo({ top: 0 })
  }, [route, info.title])
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        navigate('/search')
        setMobileOpen(false)
        document.querySelector<HTMLInputElement>('input[aria-label="搜索"]')?.focus()
      }
    }
    window.addEventListener('keydown', search)
    return () => window.removeEventListener('keydown', search)
  }, [navigate])
  return <AppShell layout="workspace" data-dashboard-shell>
    <AppSkipLink onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>跳到内容</AppSkipLink>
    {!mobile && <AppSidebar route={route} navigate={go} collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} />}
    {mobile && <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
      <SheetContent side="left" className="sa-mobile-sheet" onCloseAutoFocus={event => {
        event.preventDefault()
        if (menu.current?.isConnected) menu.current.focus()
        else document.getElementById('main-content')?.focus()
      }}>
        <SheetTitle className="sa-visually-hidden">Superagent 导航</SheetTitle>
        <AppSidebar route={route} navigate={go} collapsed={false} drawer onToggle={() => setMobileOpen(false)} />
      </SheetContent>
    </Sheet>}
    <AppMain>
      <AppHeader title={info.title} breadcrumbs={info.breadcrumbs} density="compact"
        leading={mobile ? <Button ref={menu} size="icon" variant="ghost" aria-label="打开导航" onClick={event => {
          event.currentTarget.focus(); setMobileOpen(true)
        }}><Menu aria-hidden="true" /></Button> : undefined}
        actions={<>
          <Hint label="GitHub 仓库"><LinkButton href="https://github.com/nocoo/pi-superagent" target="_blank" rel="noopener noreferrer"
            variant="ghost" size="icon" aria-label="GitHub 仓库"><Github aria-hidden="true" /></LinkButton></Hint>
          <ThemeToggle aria-label="切换主题" />
        </>} />
      <div className="sa-island-wrap"><ContentIsland id="workspace-content">
        <div className="sa-page-frame"><RouteView route={route} navigate={go} /></div>
      </ContentIsland></div>
    </AppMain>
  </AppShell>
}

export function Dashboard() {
  return <ThemeProvider><AccentProvider defaultAccent="primary"><LinkProvider render={AppLink}><TooltipProvider>
    <Toaster /><Workspace />
  </TooltipProvider></LinkProvider></AccentProvider></ThemeProvider>
}
