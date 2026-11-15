# Basalt dashboard

## Scope and sources

The management UI uses the installed `@nocoo/basalt` **3.3.6** package. The dependency is pinned exactly.

The composition follows the sibling Basalt checkout at `18368f83`, especially `../basalt/src/components/DashboardLayout.tsx`, `../basalt/src/components/AppSidebar.tsx`, the dashboard examples, and the installed package's `ai/RECIPES.md`, `ai/INTEGRATION.md`, `ai/DESIGN.md`, registry and declarations. Released package APIs take precedence over a repository example. The GitHub glyph follows the template's retained ISC-licensed Lucide icon; no new product artwork was generated.

## Composition

- `web/src/shell.tsx` owns Theme/Accent/Link/Tooltip providers, the single Toaster, AppShell, the 260/68 sidebar, grouped icon navigation, search shortcut, local-instance footer, breadcrumbs, project link and theme toggle. The rail is the native `SidebarProvider` tree: one `SidebarBrand` with the mark, name and version badge, `SidebarToggle` in the brand action slot, one `SidebarSearch` that the provider switches between the filled row and the collapsed icon form, and a `SidebarUser` footer. The mobile navigation is the native `SidebarDrawer` with a dismiss `SidebarToggle`, and the header uses `AppHeaderMenuButton` and `ProjectLinks`. The ⌘K/Ctrl+K shortcut focuses the search input again when the panel already sits on the search page; `web/src/search-focus.ts` owns that resolution.
- `web/src/navigation.ts` owns destinations and route metadata. The existing hash URLs are preserved. The skip link focuses the main landmark without changing the route.
- `web/src/App.tsx` loads each page through React lazy/Suspense with a recoverable rendering-error boundary. The first client chunk is approximately 326 KB minified; chat and resource controls load separately.
- `web/src/pages/` contains the page containers. `presentation.ts` supplies pure record projections and `models.ts` owns the CLI transport and request/mutation state. No page imports the Store, Engine or server runtime. The task stage filter is the native `SegmentControl`; it drives the same CLI stage arguments as the previous select.
- The Tailwind CSS v4 contract is used with the Basalt import and package source scan. Sidebar, ContentIsland, card slots, tables and controls own their dimensions and surfaces.

The dashboard shows real task counts, actionable human requests, compact health rows and recent work. Task and event pages use tables and readable fields. Current questions and answers precede secondary task data. Native ChatMessage, ChatMarkdown, ChatComposer and tool disclosures render intentional conversation/trace data, never hidden reasoning or invented progress. Complete raw records remain available in advanced disclosures.

Configuration and prompt editors preserve optimistic revisions, dirty drafts and pending-operation locks. Older query snapshots cannot overwrite a confirmed save or manufacture a false conflict. Channel drafts remain separate when switching local conversations.

## Unchanged boundaries

The web layer still executes the same CLI JSON interface. Authorization, lifecycle rules, persistence, agent execution, Source handling, model configuration and local-only HTTP access remain unchanged. No login, mock analytics, chart series or new administrative backend was added.

The normal local URL remains `https://superagent.dev.hexly.ai`; the existing Caddy mapping and development-server tab are reused.

## Verification

```sh
pnpm check
WEB_PROBE_DIR=.local/basalt-3.3.6 node scripts/probe-web.ts
```

The browser probe uses normal TLS validation in system Chrome. It covers the desktop rail, its stable brand axis, search shortcut, skip link, breadcrumbs and page navigation; task/filter records, search matches, actual local Chat submission, per-channel drafts; prompt preview/history, dirty drafts, stale-revision rejection and pending save locks; themes and mobile menu focus restoration. The task stage filter is read through the native `SegmentControl` radio roles, and the probe asserts the CLI arguments of both the ended and the unfiltered stage request. The search shortcut is asserted twice: once for the first navigation to the search page and once for a repeated shortcut on the already open search page, which must focus the search input again. `tests/search-focus.spec.ts` covers the same shortcut and focus resolution without a browser.

The 3.3.6 evidence in `.local/basalt-3.3.6/` was captured against a local panel instance on `127.0.0.1:7062` whose state directory had no running coordinator, so the probe verified the rail, the search shortcut and its repeated focus, the skip link, the stage filter request arguments and the rendered pages, then stopped at the first data-dependent assertion, `At least one real task detail must exist`. The chat submission, prompt preview/history and dirty-draft evidence quoted below belongs to the earlier 3.2.1 run against the live demonstration instance and was not repeated, because this machine has no reachable model-backed instance.

The earlier browser evidence recorded under `.local/basalt-3.2.1/` covered dark routes, 200% root text, one content heading per page, no document overflow, and a real browser-created task whose answer produced `result.txt`. It belongs to the 3.2.1 run against the live demonstration instance and was not repeated for 3.3.6. Backend/model requests used only the already-authorized local demonstration instance. Basalt's native library controls own motion; no application-level motion implementation was added.

Physical iPhone/Safari keyboard and toolbar behavior was not verified. These checks are not a whole-6DQ certification. The local memory service was unavailable, so design evidence is retained with this implementation and local artifacts rather than claiming a saved memory report.
