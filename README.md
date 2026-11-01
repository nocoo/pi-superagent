# pi-superagent

A proactive multi-task agent for one repository.

`pi-superagent` takes the domain core of
[dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) and runs it on
[Pi](https://github.com/earendil-works/pi) instead of DeepSeek Harness. No `@deepseek-ai/*`
package is imported at runtime.

## What is kept, what is replaced

The valuable half of the original is the **governance** layer: who may originate work, how
strong the basis is, what a ticket is authorized to do, how later discussion reaches it, and
how a policy change is delivered instead of revoking. None of that depends on a harness, and
all of it is carried over unchanged:

| Kept | Module |
| --- | --- |
| Domain model and its invariants | `src/core/` |
| Authorization: gate, strength, Mandate, admission table | `src/policy.ts`, `src/admission.ts` |
| Coordination loop and durable effect queue | `src/runtime/` |
| Persistence (SQLite) | `src/store/` |
| Source abstraction | `src/sources/` |

The half that is replaced is the **cognitive** runtime: the agent loop, prompt assembly, tool
dispatch, context compaction, model access and session storage. The original delegates all of
it to DeepSeek Harness; here Pi provides it.

| Replaced | Was | Now |
| --- | --- | --- |
| Executor | `worker-<ticketId>` DSH Session | `src/agents/pi-executor.ts` on a Pi `AgentSession` |
| Assessor | main DSH Session | `src/agents/pi-assessor.ts` on a one-shot Pi session |
| Coordination host | cordis `Runtime` | `src/runtime/host.ts` |

## Why this split is possible

The original already draws the line. `src/core/` imports nothing but `node:crypto`, and
`src/core/ports.ts` reduces everything outside the domain to six interfaces:

```ts
interface Executor { start(ticket, assignment); deliver(ticket, assignment); stop(ticket, assignment, reason) }
interface Assessor { request(candidate); release?(evalId) }
```

`pi-superagent` implements those six and nothing above the line changes. In particular
`Ticket` state does not follow the agent session: a ticket can be handed off, resumed, and run
by several executors, so a session is an implementation detail of `Executor`, not a domain
concept.

## Steering

The original promises that a person can talk to the agent while it works, and that this costs
the team as little attention as possible. That promise rests on mid-turn steering, so the Pi
executor uses Pi's `session.steer()` rather than queueing a follow-up for the next run:

- `steer` enters after the current assistant turn and its tool calls, before the next model
  request.
- A follow-up would wait for the whole run to settle, which is the wrong behaviour for a
  correction.

## Run it

```sh
pnpm install
pnpm build

# First run writes settings; later runs reuse them.
node lib/cli.js run \
  --state-dir ~/.pi-superagent/state \
  --repository owner/name \
  --allowed your-github-login \
  --prepare 'git worktree add "$PI_SUPERAGENT_DIR" -b "agent/$PI_SUPERAGENT_NAME" origin/main'

node lib/cli.js status --state-dir ~/.pi-superagent/state
```

`run` starts with `eval.mode: observe`, which assesses proactive candidates and records what it
would have accepted without accepting anything. Explicit requests — a listed login mentioning the
agent — work in every mode. Switch to `auto` once the recorded decisions look right.

The agent acts as the `gh` it is given; it never uses your own credentials unless you pass your
own `gh` as `--github-cli`.

## Architecture

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 CLI](docs/005-cli.md)
- [006 Deployment](docs/006-deployment.md)
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Bootstrap](docs/009-bootstrap.md): improving the agent by running it on a target

`pnpm check` runs the typecheck, the tests and the build.

## Bootstrap evidence

This agent was first run against its own repository, which is the cheapest end-to-end test there is.

| What | Result |
| --- | --- |
| Polling, ingest, gate | Two unaddressed Issues arrived as `inferred` candidates |
| Assessment on a settled request | `ignore` with `would_accept: true`, rule `copy` matched, direction settled |
| Assessment on design deliberation | plain `ignore`; it read "What do you think?" as an unsettled request |
| `observe` mode | 0 tickets created |
| Explicit path in `auto` mode | ticket, worktree, Pi worker, one-line fix, `pnpm check` green, PR opened and closed |
| A worker with nothing to do | reported `dropped` with the evidence instead of inventing a change |

### Mid-turn steering, measured

`pnpm build && node scripts/probe-steer.ts` builds a ticket whose worker creates six files one at a time with a pause
between them, then corrects it while it works. The session file shows where the correction landed:

```
… assistant[bash] | toolResult | assistant[bash] | toolResult | assistant[bash] | toolResult
| user <<< CORRECTION
| assistant[bash] | toolResult | assistant[report] | …
```

The correction sits **inside the running turn, between tool calls**, not after it settles. The worker stopped creating
files and reported ready, and only `a.txt` and `b.txt` exist. That is the promise the Pi session is used for: a person's
correction costs one message, not a wait for the agent to finish being wrong.

### Defects the runs found

All fixed; [Retrospective.md](Retrospective.md) has the reasoning.

- The assessor's `decide` tool was disabled by the assessment's own tool allowlist.
- The agent read its own comments, because the CLI never resolved its account, so every acknowledgement woke its ticket.
- Every launch started a new session instead of resuming: Pi names session files after a timestamp and id, so the path
  this project expected was never the path Pi wrote.
- A verdict the Policy rejected ended the whole assessment; validation now runs inside the tool so the model can correct
  itself in the same conversation.

## Status

An MVP, not a port. One closed loop: a GitHub trigger becomes a ticket, a Pi session works in a
ticket directory, and the ticket records what it reports.

Ported unchanged from the original: the domain model and Engine, the authorization layer (gate,
strength, Mandate, revalidation, admission matrix, policy version and its effects), the SQLite
store, the effect queue, the outbox, and the GitHub source with its polling loops and CI
observation.

Replaced: DeepSeek Harness entirely. No `@deepseek-ai/*` import remains.

Not yet ported, in rough order of how much they matter:

| Missing | Was in the original |
| --- | --- |
| The web panel | `src/client/`, ~4000 lines of React over the DSH web shell |
| Feishu as a second Source | live events, history recovery, topic polling, images |
| Explicit-request routing | a routing session that decides accept, attach, stop or ignore before any assessment; this MVP accepts a listed sender's addressed request directly |
| Background jobs | a shell command moved to a background job after 5s, its end waking the worker without holding its slot |
| Speculative execution | work started in the background before it is known to be wanted |
| Compute/storage separation, the watchdog, A2A between replicas | article sections 5 and 6, never implemented in the original either |

The `Engine`, `Repositories` and `Policy` contracts are still synchronous and single-writer, so one
process owns one state directory. That is deliberate for an MVP and is the first thing a
multi-replica deployment has to change.

## License

MIT. `src/core/`, `src/policy.ts`, `src/admission.ts`, `src/runtime/`, `src/store/` and
`src/sources/` derive from dsh-superagent, Copyright (c) 2026 DeepSeek Harness Team.
