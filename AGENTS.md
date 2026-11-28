# Pi Superagent

A CLI-first general-purpose multi-task agent with persistent Pi coordination (`lib/`) and a local Basalt management panel (`web/`).
Docs: [README.md](README.md) · [Architecture](docs/007-architecture.md) · [Basalt Dashboard](docs/011-basalt-dashboard.md) · [Retrospective](Retrospective.md)

## Commands

Run from repository root with Node >=22.19.0 (CI pins `26.12.1`) and `pnpm 11.6.0`.

```sh
pnpm install --frozen-lockfile
pnpm dev            # https://superagent.dev.hexly.ai -> 127.0.0.1:7062
pnpm typecheck      # S1: tsc --noEmit && tsc -p web/tsconfig.json
pnpm lint           # S2: Biome lint and format check
pnpm build:cli      # tsc -p tsconfig.build.json (builds lib/ for CLI tests)
pnpm build          # B1: pnpm build:cli && vite build
pnpm test           # L1: vitest run (tests/*.spec.ts; requires lib/ from build:cli)
pnpm test:coverage  # L1 (CI): vitest run --coverage
pnpm check          # pnpm typecheck && pnpm build:cli && pnpm test:coverage
git diff --check
```

## Invariants

- Install dependencies with `pnpm install --frozen-lockfile`; keep `pnpm-workspace.yaml` build restrictions and overrides intact.
- Keep `src/core/` harness-free and `web/` strictly a loopback CLI/IPC bridge that never imports `Store`, `Engine`, or server runtime ([Architecture](docs/007-architecture.md)).
- Read-only CLI commands must use SQLite read-only mode (`src/store/store-read.ts`) without schema setup so concurrent polling never locks a running instance.
- Keep tests isolated in temporary directories (`tests/`); never run live probes (`pnpm test:live`, `scripts/probe-web.ts`) or external API calls in CI.
- `web/` uses `@nocoo/basalt` (`^3.5.1`); follow `system1-design-basalt` Everyday UI rules and native controls ([Basalt Dashboard](docs/011-basalt-dashboard.md)).
- Do not publish packages or alter branch protection without explicit authorization.

## Quality & Local Gates

Follows `system1-quality`; CI slot definitions and pinned `base-ci` (`v2026.24`) revision live in `.github/workflows/quality-slots.yml` (via `.github/workflows/pipeline.yml`; `quality / Z1: Gate` required on `main` by `main quality gate`), with no CD workflow (local CLI/panel service only). Status vocabulary: `enforced`, `planned`, `manual`, `N/A`.

- **Static & packaging (`N/A`)**: `L2 Runtime` (no platform runtime binding) and `P1 Package` (private package; nothing published to npm). `S2 Lint` is `enforced` via Biome (`pnpm lint`).
- **Integration & E2E (`N/A`)**: `L3 Integration` (CLI and web tests run in `L1` Vitest) and `L4 E2E` (no CI browser suite; `scripts/probe-web.ts` is `manual`).
- **Local hooks**: none configured (`manual`); run `pnpm check` and `git diff --check` locally before committing.

## Resources & Isolation

| Lane        | Endpoint / State                                     | Boundary                                                 |
| ----------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Local panel | `https://superagent.dev.hexly.ai` → `127.0.0.1:7062` | Loopback CLI bridge to one process-owned state dir       |
| Tests       | Per-run temp dirs under `tests/`                     | Isolated fixtures; no live API or external network calls |
| Live probes | `pnpm test:live`, `scripts/probe-web.ts`             | `manual` operator runs only; never invoke in CI          |

## Retrospective

Record incident narratives in [Retrospective.md](Retrospective.md); promote recurring project constraints to `Invariants` above and enforceable safeguards to tests or hooks.
