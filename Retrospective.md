# Retrospective

## 2026-11-01 — the self-bootstrap experiment

Running `pi-superagent` on its own repository found two defects that no unit test would have.

### 1. The assessor could not call its own tool

`pi-assessor.ts` passed `tools: []` together with `customTools: [tool]`. In Pi an explicit `tools` list is an
**allowlist**, so the empty array disabled every tool including `decide`. Both candidates came back `unavailable` with
`The assessment ended without a decision`, and the reason was invisible because the failure carried no model text.

Fixed by `noTools: 'builtin'` — built-ins off so an assessment cannot act, custom tools still enabled — and by putting
the last assistant text into the error.

**Lesson:** when a runtime offers both an allowlist and a denylist, the allowlist wins and the denylist's intent is
silently lost. Read the option's semantics, not its name. And a failure path that discards the model's last words
costs a debugging round trip every time.

### 2. The agent woke itself

The CLI never populated `deployment.github.login`. The GitHub source recognises its own messages with
`sameName(user.login, deployment.github.login)`, so with an empty login nothing was skipped: the agent's own
acknowledgement comment arrived as a human trigger, resumed the ticket it had just answered, and ran a second
assignment. It looked like a spurious `ticket.resumed` in the log rather than an obvious failure.

Fixed by resolving the account from the `gh` CLI at startup (`resolveAccount`).

**Lesson:** an identity used for self-filtering is a correctness input, not a cosmetic one. Leaving it empty does not
degrade gracefully; it turns every outbound message into an inbound one.

### What the experiment did get right

- A settled request was distinguished from design deliberation: `implementation_requested`, `target_basis` and
  `requires_design_decision` were judged separately, and "What do you think?" was correctly read as unsettled.
- `observe` mode held: two decisions recorded `would_accept` / plain `ignore` and created no ticket.
- A worker that found nothing to do reported `dropped` with the evidence (`git log -S` across history) instead of
  inventing a change.
- The one real defect it was given produced a correct one-line fix, verified with the repository's own
  `pnpm typecheck`, `pnpm test` and `pnpm build`, and opened as a pull request without touching anything else.

### 3. Every launch started a fresh conversation

`PiSessions.ensure` decided whether to resume by checking `existsSync(<sessionDir>/<id>.jsonl)`. Pi's
`SessionManager.create(cwd, dir)` names the file after a timestamp and a UUID, so that path never existed: every launch
created a new session and the "one persistent session per ticket" claim in the README was false. It went unnoticed
because a ticket that is accepted once and reports once looks identical either way.

Fixed with `sessionManager.setSessionFile(path)`, which pins the file. Note that `setSessionFile` writes nothing until
the conversation has messages, so a quick file-existence check right after it proves nothing — test the roundtrip.

**Lesson:** a claim about persistence is only true if a restart has been observed, not if the code looks like it reads
the right path.

### 4. The assessor could not correct itself

`assessmentOutcome` validated the model's verdict *after* the session ended, so a single mistake — judging the wrong
number of rules — threw away the whole assessment and recorded `unavailable`. The original design validates inside the
tool for exactly this reason: a tool failure is an error result the model reads and can fix.

Fixed by validating in the `decide` tool's `execute`. The first run after the change produced an accept instead of
`unavailable` on the same input.

**Lesson:** anywhere a model produces structured output against rules, validate at the point where the model can still
see the error. Post-hoc validation turns a small mistake into a lost round trip.

## 2026-11-01 — the IM bootstrap run

Driving the agent through a local channel against `examples/ledger` produced one correct result and one unexplained
duplicate.

### The follow-up was both resumed and re-ticketed

Timeline from the run's own database:

| Time | Event |
| --- | --- |
| 05:52:27 | ticket A created; assignment 1 starts |
| 05:53:04 | assignment 1 reports `ready`; the ticket ends |
| 05:54:14 | a second message arrives in the same channel |
| 05:54:14 | ticket A receives a `resumed` input and assignment 2 starts |
| 05:54:34 | an Eval judges the same trigger, decides `accept`, and creates ticket B |
| 05:54:53 | ticket B reports `ready`; ticket A ends again |

One person's message produced two Tickets and the same fix was applied in two directories. The user sees two results for
one request.

What is known:

- Only one Trigger exists for that message, so this is not a duplicate ingest.
- The domain's own suite (113 tests, carried over unchanged) passes, including follow-ups.
- Reproducing it in isolation with the real Engine on SQLite — a live subscribed ticket, and later an ended one that
  resumes — produced **no** second Eval in either case.

So the cause is in the interaction with something the production path has and the repro does not: the two-second
`Passes` loop, the IM Source's watcher firing during a pass, or the Executor's `wake` racing the owners check. It is
recorded rather than guessed: a fix based on a hypothesis that the domain already contradicts would be worse than a
known issue.

Until it is explained, `docs/009` tells an operator to watch `ticket list` after sending a second request on a channel
that already has a ticket.

**Lesson:** an in-memory or SQLite repro that passes does not clear the production path, because the production path has
concurrency the repro does not. Reproduce with the timer, not without it.

### What the run did get right

- The defect was found in one place: `monthOf` in the report now reads the month at the timestamp's own offset.
- The worker ran the target's own tests — 12 before its change, 15 after — before reporting `ready`.
- The result reached the channel, so the person who asked saw the answer without opening a terminal.
- The refund defect was left alone, because it had not been reported. Acting only on what was asked is the behaviour
  the whole authorization layer exists to produce.
