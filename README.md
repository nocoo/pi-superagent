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

[docs/architecture.md](docs/architecture.md) has the layer map and the port boundary.
`pnpm check` runs the typecheck, the tests and the build.

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
