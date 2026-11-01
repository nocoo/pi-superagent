# 003 Execution

This document follows an accepted Ticket through execution and recovery. It builds on
[001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

Execution is the half this fork replaced. Everything below the `Executor` port is Pi; everything above it is the domain
carried over from [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype). See
[007 Architecture](007-architecture.md) for the boundary itself.

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first
matching row wins. `src/core/stage.ts` implements exactly this.

| Stage | Condition | CLI label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor session failed; retried until a success, a new Assignment or the Ticket's end clears it | input undelivered |
| person / answer | It has an Attention | awaiting answer |
| person / review | The latest Report is `ready` | awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | blocked · failed |
| working / queued | No Assignment, or a pending one | queued |
| idle | The latest Report is `waiting`, or the Assignment ended | waiting for a trigger |
| working | Everything else | working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or
`failed` Ticket to its Executor.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

`src/agents/pi-executor.ts` implements the domain's `Executor` port: three methods that queue work and report facts back
through the Engine.

| Method | Does |
| --- | --- |
| `start(ticket, assignment)` | Queues a `launch` effect that prepares the directory, opens the session and hands over the work |
| `deliver(ticket, assignment)` | Queues a `delivery` effect that hands the Ticket's waiting Inputs to the running session |
| `stop(ticket, assignment, reason)` | Aborts the session's turn and closes it, after the domain already ended the Assignment |

Each Ticket gets a Pi session whose id is `worker-<ticketId>` and a directory named from the Ticket's short name.
The session is written to `<stateDir>/sessions/worker-<ticketId>.jsonl`, so a relaunch **resumes the conversation**
rather than starting a new one. That is a property of this adapter, not of the domain: `Ticket` state does not follow
the session ([001](001-domain.md)).

### Steering

The original promises that a person can talk to the agent while it works, and that the correction costs one message
rather than a wait for the agent to finish being wrong. That promise is why execution runs on a live session and not on
a one-shot command.

When the Ticket's session is streaming, `deliver` calls `session.steer()`. A steering message enters after the current
assistant turn and its tool calls, **before the next model request**. When the session is idle, `deliver` calls
`session.prompt()`, which starts a turn.

This was measured rather than assumed. `scripts/probe-steer.ts` starts a worker on a six-step task and corrects it while
it works; the session file shows where the message landed:

```
… assistant[bash] | toolResult | assistant[bash] | toolResult | assistant[bash] | toolResult
| user <<< CORRECTION
| assistant[bash] | toolResult | assistant[report] | …
```

The correction sits inside the running turn, between tool calls. The worker stopped early and only the files the
correction allowed exist. A `followUp` would have waited for the whole run to settle, which is the wrong behaviour for a
correction and would cost the person the wait.

### Reporting

A worker states what became of its Ticket through one structured tool, `report`, not through prose. The conversation
changes nothing about a Ticket; only the tool call does. `src/agents/report-tool.ts` builds it per Ticket.

| Report | Meaning |
| --- | --- |
| `progress` | Work is under way |
| `waiting` | Nothing left to do until a new message arrives on this thread |
| `ready` | A result is ready for a person to review |
| `blocked` | A person must act before the worker can continue |
| `failed` | The worker could not finish |
| `dropped` | There is nothing to do after all |

`blocked` and `ready` may carry one question for a person, which becomes the Ticket's Attention and routes to the
conversation the request came from. A worker that finds nothing to do reports `dropped` rather than inventing a change.

### End of turn

`agent_settled` marks the end of a turn for the Ticket's purposes: Pi will not continue on its own. That is when the
Engine records `turnEnded`, which is what makes `idle` observable and what lets the Ticket's end count an unread
message as released.

## Preparing a Ticket directory

Before the first Assignment, if the Ticket's directory does not exist, the `prepare` command runs once with `sh` in the
execution root, with ten minutes to finish. Without a prepare command the worker starts in an empty directory.

A typical command creates a worktree:

```sh
git -C /srv/repo fetch --quiet origin main
git -C /srv/repo worktree add "$PI_SUPERAGENT_DIR" -b "agent/$PI_SUPERAGENT_NAME" origin/main
```

A directory that already exists counts as prepared, so a failed command is never retried over whatever it left behind.
A failed command fails the Ticket and records its output. See [006 Deployment](006-deployment.md#the-prepare-command).

## Concurrency

A Ticket holds a worker slot from the start of its launch and throughout a running turn. The configured limit is
`executor.maxWorkers` (default 3). New work waits in `working / queued` until a slot is free; a launch that finds none
is retried with backoff rather than dropped.

A person's message needs **no slot of its own**: it steers the session that already holds one, so a correction never
waits behind new work. This is a consequence of steering rather than an extra mechanism.

## Execution variables

The prepare command and the worker's instructions receive the same variables. None contains a credential.

| Variable | Value |
| --- | --- |
| `PI_SUPERAGENT_DIR` | The Ticket's directory |
| `PI_SUPERAGENT_NAME` | The Ticket's short name, as used for its branch |
| `PI_SUPERAGENT_TICKET` | The Ticket's id |
| `PI_SUPERAGENT_GITHUB_REPOSITORY` | The repository, `owner/name` |
| `PI_SUPERAGENT_GITHUB_NUMBER` | The Issue or pull request that started the Ticket, when it came from GitHub |

These are defaults, not a security boundary: a worker runs with the operator's OS permissions and can still reach
anything that user can. Isolation requires running the process as a different user or in a container.

## Recovery

A `launch` or `delivery` that fails is retried from the durable effect queue with exponential backoff, so a crash or a
transient model error does not lose work.

On startup the host reports every Assignment that was mid-flight through `Engine.assignmentInterrupted`, which restarts
it with a recovery note: *the host restarted during this ticket; inspect the worktree, git history and GitHub state
before continuing, and do not repeat an already completed external operation*. An Assignment whose latest report is
`waiting`, `ready`, `blocked` or `failed` keeps its state and takes the Inputs waiting for it instead, because that
report already tells a person something.

## What this fork does not have

The original's Executor carried four behaviours that this one does not. They are listed because each is a real
difference in what the agent does, not a cosmetic gap.

| Missing | Consequence |
| --- | --- |
| Background jobs | The original moved a foreground shell command to a background job after five seconds, so a long command did not hold back the worker's next step. Here a command blocks the turn until it finishes. Steering still works, because the correction lands at the next model request, but the agent cannot act while a command runs. |
| Handoff of background work | The original let shell jobs outlive a handoff without holding the slot, waking the worker with their result later — which is what let a worker offer a running server for review. There are no jobs to hand off here. |
| Retry of transient model failures | The original classified provider errors (408, 429, 5xx, socket resets) and resumed the turn after a backoff. Here a failed turn surfaces as a failed Ticket, and the effect queue retries only the launch. |
| Subagents | The original let a worker spawn subagents under a narrower preset. Pi supports nested sessions, but this adapter does not expose a tool for it, so a worker works alone. |

Speculative execution — starting work before it is known to be wanted — was never implemented in the original either
and is not implemented here. It belongs to [002](002-authorization.md)'s accept modes, not to the Executor.
