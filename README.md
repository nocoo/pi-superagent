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

## Status

Minimal MVP: GitHub only, one closed loop from trigger to pull request. Not yet ported: the web
panel, Feishu, speculative execution, compute/storage separation, the watchdog, and A2A between
replicas.

## Setup

```sh
pnpm install
pnpm check
```

## License

MIT. `src/core/`, `src/policy.ts`, `src/admission.ts`, `src/runtime/`, `src/store/` and
`src/sources/` derive from dsh-superagent, Copyright (c) 2026 DeepSeek Harness Team.
