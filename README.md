# pi-superagent

A local, policy-governed coding and task agent built on the Pi SDK.

`pi-superagent` keeps its domain model and authorization rules independent of the runtime. One process owns a state directory, receives events from Sources, evaluates work, runs persistent Pi sessions for Tickets, and reports results through Channels. It is not a DSH runtime and does not depend on `@deepseek-ai/*` packages.

## Runtime

| Part | Implementation |
| --- | --- |
| Domain model, Tickets, Evals, Mandates | `src/core/` |
| Authorization and policy versioning | `src/policy.ts`, `src/admission.ts` |
| Coordination and routing | persistent `PiCoordinator` in `src/agents/pi-coordinator.ts` |
| Ticket execution | persistent Pi worker sessions in `src/agents/pi-executor.ts` |
| Storage and durable effect queue | `src/store/`, `src/runtime/` |
| Sources | GitHub, local IM, and generic Inbox in `src/sources/` |
| CLI and management | `src/cli.ts`, `src/cli/commands/`, `src/runtime/management.ts` |
| Web panel | CLI management bridge only, served by `pi-superagent web` |

The persistent coordinator is the main session. It can route explicit requests, assess inferred candidates, read domain resources, reply, attach or stop work, and coordinate Tickets. Workers are persistent sessions per Ticket. Typed tools call the Engine; model text is not a state transition.

## Sources

- **GitHub** is available as a Source. It is optional; a deployment can run without a repository or `gh` account.
- **IM** is a local channel Source for scripts and interactive work.
- **Inbox** is a generic external-event Source. It accepts standard JSON events for IMs, issue trackers, or other adapters, and stores adapter replies in JSONL for the external script to retrieve. It has no network loop.

GitHub polling and writes use `gh`. Inbox and IM do not add a network service or a plugin platform.

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

## CLI and management

CLI commands cover status, Sources, Threads, Triggers, Decisions, Tickets, configuration, the coordinator, prompts, Inbox, chat, and running the agent.

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

Configuration and prompt changes can reach a running instance through local IPC. Prompt revisions are stored as immutable versions and can be hot-applied to the next agent session turn; `config set` and prompt changes send a next-run notification to the persistent coordinator.

The web command is only a loopback CLI bridge for the React management panel. The public origin is `https://superagent.dev.hexly.ai`, forwarding to `127.0.0.1:7062` in the normal deployment.

## Pi resources

The implementation uses Pi SDK 1.4.0 and persistent session files. Session setup loads Pi resources dynamically from the working directory and Pi agent directory, including MCP, skills, extensions, codemode, and tool search where Pi discovers them. Prompt text is supplied dynamically from instance-owned prompt revisions.

Pi 1.4's SDK capabilities do not make durable jobs or subagents built into this project. This repository does not implement a background-job supervisor or subagent framework.

## Steering and work

A worker can be steered mid-turn: `session.steer()` enters after the current assistant turn and its tool calls, before the next model request. A Ticket keeps its own state and can resume a persistent worker session across restarts.

The execution policy is not limited to coding. The Inbox and IM Sources, coordinator tools, and generic worker prompts support support questions, operations, issue handling, and other non-coding tasks when a deployment authorizes them.

## Run

```sh
pnpm install
pnpm build
pi-superagent run
```

Configuration is changed with `pi-superagent config set`, `config edit`, or `config import`; `run` has no repository or allowed-login initialization flags. GitHub is configured through `config set --repository` and `--allowed`, while Inbox is configured through `--inbox`, `--inbox-allowed`, and `--inbox-observed`.

## Historical validation

The following are historical experiments, not a current test count or a claim that every feature has been re-run:

- Mid-turn steering was measured with `scripts/probe-steer.ts`: a correction appeared between tool calls in the session file and stopped the remaining work.
- An earlier bootstrap run against this repository produced a worktree, worker session, one-line fix, and pull request.
- Ledger, GitHub, and steering probes are retained as evidence and reproducible scripts where applicable.

A real live probe is maintained at `scripts/probe-system.ts` and invoked with `pnpm test:live`. It uses the locally configured `magpie/group/coding` model on `127.0.0.1:3425` only when the operator chooses to run it.

## Documents

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 CLI](docs/005-cli.md)
- [006 Deployment](docs/006-deployment.md)
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md)
- [009 Bootstrap](docs/009-bootstrap.md)

`pnpm check` runs typechecking, the build, and the test suites. When other agents are changing the repository, `pnpm exec vitest run tests/docs.spec.ts` is the bounded documentation-link check.

## License

MIT. `src/core/`, `src/policy.ts`, `src/admission.ts`, `src/runtime/`, `src/store/`, and `src/sources/` carry their original governance and Source lineage.
