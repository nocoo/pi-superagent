# Architecture

The repository is split along the line the original already drew: everything that decides **whether** work may happen
is harness-free, and everything that actually **thinks and acts** sits behind two ports.

```
┌───────────────────────────────────────────────────────────────┐
│  domain (no I/O, no model, no clock it did not receive)        │
│  src/core/          model, ports, Engine, five command parts   │
│  src/policy.ts      gate, strength, Mandate, revalidation      │
│  src/admission.ts   the admission matrix                       │
├───────────────────────────────────────────────────────────────┤
│  coordination (no model)                                      │
│  src/runtime/passes.ts    one pass every two seconds           │
│  src/runtime/effects.ts   durable effect queue, backoff         │
│  src/runtime/outbox.ts    message receipts and delivery         │
│  src/store/               SQLite: aggregates, KV, effects       │
│  src/sources/             Source kinds: GitHub, and the context │
│                           a Source exposes to an assessment     │
├───────────────────────────────────────────────────────────────┤
│  cognition (the replaced half)                                │
│  src/agents/sessions.ts    Pi sessions, one per ticket          │
│  src/agents/pi-executor.ts Executor: launch, steer, report      │
│  src/agents/pi-assessor.ts Assessor: one session per candidate  │
├───────────────────────────────────────────────────────────────┤
│  src/runtime/host.ts   composition root, holds nothing itself   │
└───────────────────────────────────────────────────────────────┘
```

## Where the line is

`src/core/ports.ts` reduces the outside world to six interfaces. Only two of them are cognitive:

```ts
interface Executor {
  start(ticket: Ticket, assignment: Assignment): void
  deliver(ticket: Ticket, assignment: Assignment): void
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
}
interface Assessor {
  request(candidate: Candidate): void
  release?(evalId: string): void
}
```

Both are fire-and-forget: they queue work and report facts back through the Engine inside the Engine's own transaction.
That is why replacing them did not touch the domain. `src/core/` still imports nothing but `node:crypto`, and the
original test suite for it runs unmodified.

The other four ports are not cognitive and were kept: `Repositories` (SQLite), `Policy` (rules and gate), `SourceScope`
(does this Source listen to this thread), and `Outbox` (a message queue).

## What the Executor does with Pi

| Concern | How |
| --- | --- |
| One conversation per ticket | Session id `worker-<ticketId>`, file at `<stateDir>/sessions/worker-<ticketId>.jsonl`, resumed on the next launch |
| Its own working copy | A directory per ticket under `executor.directory`, created by the `prepare` command |
| Mid-turn correction | `session.steer()` while the run is streaming, `session.prompt()` when idle |
| Reporting | A custom `report` tool; the ticket's state comes from that tool and never from prose |
| End of turn | `agent_settled`, which means Pi will not continue on its own |
| Concurrency | Slots against `executor.maxWorkers`, plus one extra for a person's message |

Steering is the reason a Pi session is used rather than a one-shot CLI: `steer` enters after the current assistant turn
and its tool calls, before the next model request. A follow-up would wait for the whole run to settle, which is the
wrong behaviour for a correction and would cost a person the wait.

## What the Assessor does with Pi

One in-memory session per candidate, with no tools except `decide`. It reads a bounded window of the candidate's thread
plus the enabled rules, then records a decision. `policy.ts` validates that decision: every enabled rule judged exactly
once, a settled direction, at least one match, and `intent_evidence` for an accept. A verdict the Policy cannot accept
throws rather than silently passing.

The session holds no state between candidates, so a Policy change cannot leave a stale judgement behind.

## Two loops, one clock

`Passes` runs a pass every two seconds and on demand. A pass drains due effects, then lets the Engine advance every
evaluation that is due. Sources call `receive`, which stores the trigger and requests a pass; they never run the
Engine themselves. Everything the Engine changes is written inside one SQLite transaction, and mechanisms that must
survive a crash are effects rather than in-memory promises.

## Deliberate omissions

See the Status section of the README. In particular this MVP keeps `Engine` synchronous and single-writer, which is
exactly what makes a second replica on the same state directory impossible; a multi-replica design has to choose
between shared storage and an event-only protocol between replicas.
