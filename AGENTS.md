# Pi Superagent

A CLI-first general-purpose multi-task agent with persistent Pi coordination (`lib/`) and a local management panel (`web/`). Human overview: [README.md](README.md). Historical mistakes: [Retrospective.md](Retrospective.md).

## Invariants

- Install dependencies with `pnpm install --frozen-lockfile`.
- Keep tests isolated in temporary directories (`tests/`); do not run live probes (`pnpm test:live`) or external API calls in CI.
- `web/` uses `@nocoo/basalt` (`^3.5.1`); follow `system1-design-basalt` Everyday UI rules when modifying UI components.
- Do not publish or alter branch protection without explicit authorization.

## Commands

Run in the repository root with Node 24+ and pnpm 11.6.0.

```sh
pnpm typecheck     # tsc --noEmit && tsc -p web/tsconfig.json
pnpm build         # tsc -p tsconfig.build.json && vite build
pnpm test          # pnpm build && vitest run
pnpm check         # pnpm typecheck && pnpm test
git diff --check
```

## Quality Slots

System1 quality definitions come from `system1-quality` (v1.3.0); CI runs in native mode via `.github/workflows/ci.yml` → `./.github/workflows/quality-slots.yml` with `nocoo/base-ci` composite actions pinned to `v2026.15` (`777bbe4f9bacab8a91d8c01974480a6ee23d28e0`). Branch protection (`main quality gate`) requires `quality / Z1: Gate`.

| Slot | Stage | Command and Scope | Status |
| --- | --- | --- | --- |
| S1 Types | CI, local | `pnpm typecheck` (`tsc --noEmit && tsc -p web/tsconfig.json`) | enforced |
| S2 Lint | — | no linter/formatter configured | na |
| S3 Workflow | CI | `actionlint` + 40-char SHA pin verification across `.github/workflows/*.yml` | enforced |
| G1 Secrets | CI | `gitleaks` redacted checkout scan | enforced |
| G2 Dependencies | CI | `osv-scanner scan --lockfile=pnpm-lock.yaml` | enforced |
| B1 Build | CI, local | `pnpm build` (`tsc -p tsconfig.build.json && vite build`) | enforced |
| L1 Unit | CI, local | `pnpm test` (`vitest run` across `tests/*.spec.ts`) | enforced |
| L2 Runtime | — | Node CLI and local HTTP panel; no platform runtime binding | na |
| L3 Integration | — | CLI and web tests are currently run in L1 Vitest | na |
| L4 E2E | — | no CI browser E2E suite configured | na |
| P1 Package | — | private package; nothing published to npm | na |
| Z1 Gate | CI | `z1-gate` validator in `quality-slots.yml` requiring all `impl` slots on matching `github.sha` and `na` slots skipped | enforced |
