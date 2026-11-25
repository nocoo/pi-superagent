<h1 align="center">pi-superagent</h1>

<p align="center">A local, policy-governed coding and task agent built on the Pi SDK.</p>

<p align="center"><a href="../README.md">简体中文</a></p>

## What it does

`pi-superagent` keeps its domain model and authorization rules independent of the runtime. One process owns a state directory, receives events from Sources, evaluates work, runs persistent Pi sessions for Tickets, and reports results through Channels. It is not a DSH runtime and does not depend on `@deepseek-ai/*` packages.

| Part                                   | Implementation                                                 |
| -------------------------------------- | -------------------------------------------------------------- |
| Domain model, Tickets, Evals, Mandates | `src/core/`                                                    |
| Authorization and policy versioning    | `src/policy.ts`, `src/admission.ts`                            |
| Coordination and routing               | persistent `PiCoordinator` in `src/agents/pi-coordinator.ts`   |
| Ticket execution                       | persistent Pi worker sessions in `src/agents/pi-executor.ts`   |
| Storage and durable effect queue       | `src/store/`, `src/runtime/`                                   |
| Sources                                | GitHub, local IM, and generic Inbox in `src/sources/`          |
| CLI and management                     | `src/cli.ts`, `src/cli/commands/`, `src/runtime/management.ts` |
| Web panel                              | CLI management bridge only, served by `pi-superagent web`      |

The persistent coordinator is the main session. It can route explicit requests, assess inferred candidates, read domain resources, reply, attach or stop work, and coordinate Tickets. Workers are persistent sessions per Ticket. Typed tools call the Engine; model text is not a state transition.

The implementation uses the Pi SDK (`@earendil-works/pi-coding-agent` 1.5.0) and persistent session files. Session setup loads Pi resources dynamically from the working directory and Pi agent directory, including MCP, skills, extensions, codemode, and tool search where Pi discovers them. Prompt text is supplied dynamically from instance-owned prompt revisions. This repository does not implement a background-job supervisor or subagent framework. Ordinary delegation can be enabled through Pi's maintained [subagent extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent), using its agent definitions and resource configuration; it is not enabled by default and does not provide durable child recovery.

The execution policy is not limited to coding. The Inbox and IM Sources, coordinator tools, and generic worker prompts support support questions, operations, issue handling, and other non-coding tasks when a deployment authorizes them. A worker can be steered mid-turn: `session.steer()` enters after the current assistant turn and its tool calls, before the next model request. A Ticket keeps its own state and can resume a persistent worker session across restarts.

## Features

- **Multi-Source event intake**:
  - **GitHub**: optional Source using `gh` for polling and writes; a deployment can run without a repository or `gh` account.
  - **IM**: local channel Source for scripts and interactive work.
  - **Inbox**: generic external-event Source accepting standard JSON events for IMs, issue trackers, or other adapters, storing adapter replies in JSONL for external scripts to retrieve; no network loop. Neither Inbox nor IM adds a network service or plugin platform.
- **Persistent coordination and state isolation**: coordinator and Ticket workers run as persistent sessions backed by read-only SQLite reads and a durable effect queue.
- **Hot-applied configuration and prompts**: configuration and prompt changes reach a running instance through local IPC. Prompt revisions are stored as immutable versions and can be hot-applied to the next agent session turn; `config set` and prompt changes send a next-run notification to the persistent coordinator.
- **Local Basalt management panel**: `pi-superagent web` serves a loopback CLI bridge for the React management panel; the local origin `https://superagent.dev.hexly.ai` forwards to `127.0.0.1:7062` in normal deployment.

## Usage

Enable Inbox and receive an event:

```sh
pi-superagent config set --inbox --inbox-allowed 'linear:alice@example.com' --inbox-observed linear

cat > event.json <<'EOF'
{"system":"linear","id":"evt-1","thread":"LIN-42","actor":"alice@example.com","text":"Fix the login button","human":true,"addressed":true}
EOF

pi-superagent source receive --file event.json
pi-superagent source replies --system linear --limit 20
```

`source receive --file -` reads event JSON from stdin. `source replies` reads local adapter deliveries; it does not claim that a remote system has received them.

CLI commands cover status, Sources, Threads, Triggers, Decisions, Tickets, configuration, the coordinator, prompts, Inbox, chat, and running the agent:

```sh
pi-superagent status
pi-superagent source
pi-superagent source receive --file event.json
pi-superagent source replies --system linear --limit 20
pi-superagent coordinator show
pi-superagent coordinator read --lines 40
pi-superagent config set --mode observe
pi-superagent prompt show
pi-superagent prompt set --file prompts.json --base-revision 1
pi-superagent web --port 7062
pi-superagent run --verbose
```

Configuration is changed with `pi-superagent config set`, `config edit`, or `config import`; `run` has no repository or allowed-login initialization flags. GitHub is configured through `config set --repository` and `--allowed`, while Inbox is configured through `--inbox`, `--inbox-allowed`, and `--inbox-observed`.

## Development

Requires Node >=22.19.0 (CI pins `26.12.1`) and `pnpm 11.6.0`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm dev
pi-superagent run
```

`pnpm dev` builds the project and starts the local web panel bridge (`127.0.0.1:7062`).

## Tests

```sh
pnpm test
pnpm check
pnpm exec vitest run tests/docs.spec.ts
```

- `pnpm check` runs typechecking (`pnpm typecheck`), the build (`pnpm build`), and the Vitest suites (`pnpm test`).
- `pnpm exec vitest run tests/docs.spec.ts` is the bounded documentation-link check when other changes are in flight.
- A live probe is maintained at `scripts/probe-system.ts` and invoked manually with `pnpm test:live`. It uses the locally configured `magpie/group/coding` model on `127.0.0.1:3425` only when the operator chooses to run it (never in CI).

The following are historical experiments, not a current test count or a claim that every feature has been re-run:

- Mid-turn steering was measured with `scripts/probe-steer.ts`: a correction appeared between tool calls in the session file and stopped the remaining work.
- An earlier bootstrap run against this repository produced a worktree, worker session, one-line fix, and pull request.
- Ledger, GitHub, and steering probes are retained as evidence and reproducible scripts where applicable.

## Stack

| Area          | Implementation                                                            |
| ------------- | ------------------------------------------------------------------------- |
| Runtime & CLI | Node.js (>=22.19.0), TypeScript, Commander, Zod, TypeBox, proper-lockfile |
| Agent SDK     | `@earendil-works/pi-coding-agent` (1.5.0)                                 |
| Web panel     | React 19, Vite, Tailwind CSS, `@nocoo/basalt`                             |
| Testing       | Vitest, Playwright                                                        |

## Documentation

- [000 Philosophy](000-philosophy.md)
- [001 Domain model](001-domain.md)
- [002 Authorization](002-authorization.md)
- [003 Execution](003-execution.md)
- [004 Prompts](004-prompts.md)
- [005 CLI](005-cli.md)
- [006 Deployment](006-deployment.md)
- [007 Architecture](007-architecture.md)
- [008 Cookbook](008-cookbook.md)
- [009 Bootstrap](009-bootstrap.md)
- [010 CLI-first supervision](010-cli-first-superagent.md)
- [011 Basalt dashboard](011-basalt-dashboard.md)
- [Project rules and quality gates](../AGENTS.md)
- [Retrospective](../Retrospective.md)

## License

MIT (see [LICENSE](../LICENSE)). `src/core/`, `src/policy.ts`, `src/admission.ts`, `src/runtime/`, `src/store/`, and `src/sources/` carry their original governance and Source lineage.
