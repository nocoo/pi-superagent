import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import {
  Button,
  LinkProvider,
  ThemeProvider,
  ThemeToggle,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@nocoo/basalt";
import { AppHeader, AppHeaderMenuButton, ProjectLinks } from "@nocoo/basalt/components/app-header";
import { AvatarInitials } from "@nocoo/basalt/components/avatar";
import { AppMain, AppSkipLink, AppShell } from "@nocoo/basalt/components/app-shell";
import { AccentProvider } from "@nocoo/basalt/providers/accent";
import {
  ContentIsland,
  Sidebar,
  SidebarBrand,
  SidebarDrawer,
  SidebarFooter,
  SidebarHeader,
  SidebarIconItem,
  SidebarItem,
  SidebarNav,
  SidebarPartition,
  SidebarProvider,
  SidebarSearch,
  SidebarToggle,
  SidebarUser,
} from "@nocoo/basalt/components/sidebar";
import {
  Bot,
  LayoutDashboard,
  ListTodo,
  MessagesSquare,
  GitBranch,
  Inbox,
  MessageSquare,
  Network,
  Settings,
  FileText,
} from "@nocoo/basalt/icons";
import pkg from "../../package.json";
import { RouteView } from "./App";
import { useHashRoute } from "./models";
import { activeRoute, appHref, navigation, navigationGroups, routeInfo } from "./navigation";
import { focusSearchInputWhenReady, isSearchShortcut } from "./search-focus";

const icons = {
  dashboard: LayoutDashboard,
  tasks: ListTodo,
  threads: MessagesSquare,
  decisions: GitBranch,
  sources: Inbox,
  chat: MessageSquare,
  coordinator: Network,
  settings: Settings,
  prompts: FileText,
};

function AppLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} href={appHref(href)} />;
}

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function AppSidebar({
  route,
  navigate,
  collapsed,
  drawer = false,
  onDismissDrawer,
}: {
  route: string;
  navigate: (path: string) => void;
  collapsed: boolean;
  drawer?: boolean;
  onDismissDrawer?: () => void;
}) {
  const search = () => navigate("/search");
  return (
    <Sidebar
      resizable={!drawer}
      aria-label="工作区侧栏"
      data-testid={drawer ? "mobile-sidebar" : "desktop-sidebar"}
    >
      <SidebarHeader>
        <SidebarBrand
          logo={<Bot data-testid="brand-mark" aria-label="Superagent" strokeWidth={1.5} />}
          name="Superagent"
          version={`v${pkg.version}`}
          action={
            drawer ? (
              <SidebarToggle mode="dismiss" dismissLabel="关闭导航" onDismiss={onDismissDrawer} />
            ) : (
              <SidebarToggle collapseLabel="收起导航" expandLabel="展开导航" />
            )
          }
        />
      </SidebarHeader>
      <SidebarNav aria-label="Superagent 管理导航">
        <SidebarSearch onClick={search} aria-label="搜索记录" shortcut="⌘K">
          搜索记录
        </SidebarSearch>
        {navigationGroups.map((group) => (
          <div key={group}>
            {!collapsed && <SidebarPartition>{group}</SidebarPartition>}
            <div className="flex flex-col gap-basalt-nav-gap">
              {navigation
                .filter((item) => item.group === group)
                .map((item) => {
                  const Icon = icons[item.icon];
                  const active = activeRoute(route, item.path);
                  return collapsed && !drawer ? (
                    <Hint key={item.path} label={item.label}>
                      <SidebarIconItem
                        active={active}
                        aria-label={item.label}
                        onClick={() => navigate(item.path)}
                      >
                        <Icon aria-hidden="true" />
                      </SidebarIconItem>
                    </Hint>
                  ) : (
                    <SidebarItem
                      key={item.path}
                      active={active}
                      onClick={() => navigate(item.path)}
                    >
                      <Icon aria-hidden="true" />
                      <span className="flex-1 truncate text-left">{item.label}</span>
                    </SidebarItem>
                  );
                })}
            </div>
          </div>
        ))}
      </SidebarNav>
      <SidebarFooter>
        <SidebarUser
          name="本地工作区"
          email="CLI 驱动 · 仅限本机"
          avatar={<AvatarInitials name="本地工作区" initials="L" size="sm" />}
          action={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="实例配置"
              onClick={() => navigate("/config")}
            >
              <Settings aria-hidden="true" />
            </Button>
          }
        />
      </SidebarFooter>
    </Sidebar>
  );
}

function Workspace() {
  const { route, navigate } = useHashRoute();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const info = routeInfo(route);
  const go = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };
  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset scroll and mobile menu on route change.
  useEffect(() => {
    setMobileOpen(false);
    document.title = `${info.title} · Superagent`;
    document.getElementById("workspace-content")?.scrollTo({ top: 0 });
  }, [route, info.title]);
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      navigate("/search");
      setMobileOpen(false);
      focusSearchInputWhenReady(
        { querySelector: (selector) => document.querySelector<HTMLInputElement>(selector) },
        (callback) => requestAnimationFrame(callback),
      );
    };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, [navigate]);
  return (
    <AppShell layout="workspace" className="relative h-dvh" data-dashboard-shell>
      <AppSkipLink
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        跳到内容
      </AppSkipLink>
      {!mobile && (
        <SidebarProvider collapsed={collapsed} onCollapsedChange={setCollapsed}>
          <AppSidebar route={route} navigate={go} collapsed={collapsed} />
        </SidebarProvider>
      )}
      {mobile && (
        <SidebarDrawer
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          returnFocusRef={menu}
          id="mobile-navigation"
          title="Superagent 导航"
        >
          <AppSidebar
            route={route}
            navigate={go}
            collapsed={false}
            drawer
            onDismissDrawer={() => setMobileOpen(false)}
          />
        </SidebarDrawer>
      )}
      <AppMain>
        <AppHeader
          title={info.title}
          breadcrumbs={info.breadcrumbs}
          density="compact"
          leading={
            mobile ? (
              <AppHeaderMenuButton
                ref={menu}
                label="打开导航"
                onClick={() => setMobileOpen(true)}
              />
            ) : undefined
          }
          actions={
            <>
              <ProjectLinks github="nocoo/pi-superagent" githubLabel="GitHub 仓库" />
              <ThemeToggle aria-label="切换主题" />
            </>
          }
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-basalt-space-lg pb-basalt-space-lg md:px-basalt-layout-sm md:pb-basalt-layout-sm">
          <ContentIsland id="workspace-content" className="relative min-w-0">
            <div className="flex min-w-0 flex-col gap-basalt-layout-lg">
              <RouteView route={route} navigate={go} />
            </div>
          </ContentIsland>
        </div>
      </AppMain>
    </AppShell>
  );
}

export function Dashboard() {
  return (
    <ThemeProvider>
      <AccentProvider defaultAccent="primary">
        <LinkProvider render={AppLink}>
          <TooltipProvider>
            <Toaster />
            <Workspace />
          </TooltipProvider>
        </LinkProvider>
      </AccentProvider>
    </ThemeProvider>
  );
}
