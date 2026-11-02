import { Component, Suspense, lazy, type ReactNode } from 'react'
import { Button, LayerCard } from '@nocoo/basalt'
import { Empty } from '@nocoo/basalt/components/empty'
import { Loader } from '@nocoo/basalt/components/loader'
import { PageHeader } from '@nocoo/basalt/components/page-header'
import { activeRoute, routeInfo } from './navigation'
import './page-styles.css'

export interface RoutePageProps { route: string; navigate: (path: string) => void }

const OverviewPage = lazy(() => import('./pages/overview').then(module => ({ default: module.OverviewPage })))
const TasksPage = lazy(() => import('./pages/tasks').then(module => ({ default: module.TasksPage })))
const ThreadsPage = lazy(() => import('./pages/threads').then(module => ({ default: module.ThreadsPage })))
const DecisionsPage = lazy(() => import('./pages/decisions').then(module => ({ default: module.DecisionsPage })))
const SourcesPage = lazy(() => import('./pages/sources').then(module => ({ default: module.SourcesPage })))
const SearchPage = lazy(() => import('./pages/search').then(module => ({ default: module.SearchPage })))
const ConfigPage = lazy(() => import('./pages/config').then(module => ({ default: module.ConfigPage })))
const PromptsPage = lazy(() => import('./pages/prompts').then(module => ({ default: module.PromptsPage })))
const ChatPage = lazy(() => import('./pages/chat').then(module => ({ default: module.ChatPage })))
const CoordinatorPage = lazy(() => import('./pages/coordinator').then(module => ({ default: module.CoordinatorPage })))

class PageBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {}
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) } }
  override render() {
    if (this.state.error) return <LayerCard><Empty title="页面加载失败" description={this.state.error.message}
      action={<Button onClick={() => window.location.reload()}>刷新页面</Button>} /></LayerCard>
    return this.props.children
  }
}

function Page({ route, navigate }: RoutePageProps) {
  if (!routeInfo(route).known) return <>
    <PageHeader title="页面不存在" description="这个地址没有对应的工作区页面。" />
    <LayerCard><Empty title="找不到此页面" action={<Button onClick={() => navigate('/')}>返回概览</Button>} /></LayerCard>
  </>
  if (route === '/') return <OverviewPage />
  if (activeRoute(route, '/tasks')) return <TasksPage route={route} navigate={navigate} />
  if (activeRoute(route, '/threads')) return <ThreadsPage route={route} navigate={navigate} />
  if (route === '/decisions') return <DecisionsPage />
  if (route === '/sources') return <SourcesPage />
  if (route === '/search') return <SearchPage />
  if (route === '/config') return <ConfigPage />
  if (route === '/prompts') return <PromptsPage />
  if (route === '/chat') return <ChatPage />
  return <CoordinatorPage />
}

export function RouteView(props: RoutePageProps) {
  return <PageBoundary key={props.route}>
    <Suspense fallback={<LayerCard><Loader label="正在加载页面…" /></LayerCard>}><Page {...props} /></Suspense>
  </PageBoundary>
}
