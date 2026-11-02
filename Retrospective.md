# Retrospective

## 2026-11-02 — Basalt dashboard rewrite

Importing Basalt controls did not make the old dashboard a Basalt application: it lacked the complete rail/header/island composition, used repeated JSON cards, and duplicated spacing ownership. The rewrite follows the installed 3.2.1 contract and the sibling repository's application templates, not an imagined API. Root exports, avatar sizing and the removal of Lucide brand icons still required checking the actual declarations.

Two template mistakes were caught in the browser: `ResourceList` already owns a PageHeader, and `--basalt-space-96` is a geometry-scale token that produced 384px, not a 96px empty state. Use component-owned headings and natural-height state panels. Native disabled propagation also matters: disabling ChatComposer disables its toolbar fieldset, so the channel selector must live outside it. JSX table cells need explicit sortable primitives, and a count rendered as text must still sort numerically.

Editor versions are monotonic within an instance. A confirmed save must reject an older polling snapshot before updating either the draft or the displayed remote revision; protecting only the draft still creates false conflicts. Real-browser checks now include channel selection/sending, per-channel drafts, focus restoration, both themes, pending saves and real search matches, rather than only screenshots of static pages. External template paths must include their repository prefix; otherwise the documentation integrity test correctly treats them as missing local source files.

## 2026-11-02 — restoring CLI-first supervision

The final review caught an incorrect Pi boundary assumption: `agent_before_settle.context.canContinue` describes the context before an extension appends its entries. A final assistant message makes it false; the reminder's custom message is what makes continuation possible. Both handlers now let Pi validate the updated context, and tests use the real prose-only terminal state (`canContinue: false`). Poll-safe editors also need request-safe drafts: prompt and configuration editors are disabled while their save is pending so a late response cannot overwrite newer typing.

A real startup race exposed that a CLI "read" opened the normal Store constructor, reran schema setup, and took a write transaction. Concurrent status polling could make the owner fail with `database is locked`. Read commands now use SQLite's actual read-only connection mode and never initialize the schema; a regression test opens one while the owner holds `BEGIN IMMEDIATE`. A native bounded busy timeout covers short writer transitions rather than hiding the problem behind CLI retries.

The live model also repeatedly corrupted long event IDs while correcting a tool call. Agent tools now share the CLI's unique-prefix resolver and display eight-character IDs. An invalid long ID is still rejected; it is never fuzzily matched to a nearby request.

The first integration passed its tests but review found gaps the tests did not model: polling overwrote unsaved prompt drafts, configuration drafts borrowed a newer revision and bypassed conflict detection, and the panel read a different search shape than the CLI returned. Tests of a successful bridge call do not prove an interactive editing workflow. Keep draft data and its base revision together, and verify polling, conflicting edits, search, and ended-task filters in the browser.

The inherited policy hash omitted receiver configuration. Disabling a Source therefore left an old evaluation eligible to accept work. The human gate also relied on intake having checked the receiving scope. Policy versions now conservatively include Source configuration, and the gate checks scope again when events are replayed. A disabled receiver must not gain authority through a different entry point.

Pi's tool allowlist and persistent tool closures also require explicit tests: registered tools are not necessarily active, and a session reused for a second candidate must not retain the first candidate's evaluation identity. Runtime tests now exercise these boundaries instead of only asserting prompt strings.

Tooling lessons: inspect exact replacement text before batching edits; an approximate replacement is rejected atomically. Do not infer terminal key syntax from a displayed shortcut: Herdr rejected `ctrl+end`, while its ordinary history reader recovered the report without injecting keys. A registry metadata miss was resolved by using the permitted alternate mirror, without relaxing supply-chain checks.

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

One person's message produced two tickets and the same fix was applied in two directories. This was first recorded here
as **unexplained**, with two failed reproductions behind it. That conclusion was wrong, and the way it was corrected is
the lesson.

**What actually happened**, from the trigger's own disposition record:

```json
{ "fanout": ["39c657e4…"],
  "handbacks": [{ "ticketId": "39c657e4…", "reason": "beyond this ticket", "at": "05:54:21.092Z" }] }
```

| Time | Event |
| --- | --- |
| 05:52:27 | ticket A created; assignment 1 starts |
| 05:53:04 | assignment 1 reports `ready`; ticket A ends |
| 05:54:14 | a second, unrelated request arrives in the same channel |
| 05:54:14 | the trigger fans out to ticket A, which resumes |
| 05:54:21 | ticket A's worker **hands the message back** with the `handback` tool |
| 05:54:34 | with no owner left, the trigger is assessed and ticket B is created |
| 05:54:53 | ticket A reports `ready` — having fixed the same thing ticket B was created for |

Every step is what the design says should happen. A message outside a ticket's mandate is handed back, and the domain
gives it its own mandate. The defect is one level down, in the worker: it handed the message back **and then did the
work anyway**, which is why two directories gained the same fix.

So the fix is in the tools and the prompt, not in the domain: `handback` now answers *stop working on this message,
change nothing for it*, and `prompts/work.md` says to hand back **before** starting rather than after.

**Why the reproductions failed.** Both used fake Executor and Assessor ports, so nothing ever called `handback`. The
behaviour under test did not exist in the harness. Reproducing a production symptom means reproducing the parts of
production that cause it, not the parts that are convenient to stub.

**Why guessing was worse than looking.** Two plausible causes were nominated — a race with the two-second pass loop and
a duplicate ingest — and both were disproved. Neither could have been fixed by reasoning about the code; the fact that
settled it was a single line in a stored record, visible only because `intake` was made to print its decision:

```
[trace] intake 9bc88d7e human=true fanout=39c657e4 owners=39c657e4
```

`owners` was the ticket at intake, and the hand-back came seconds later. One instrumented run beat three hypotheses.

**Lesson:** when a symptom is intermittent, instrument the failing path before reproducing it. A reproduction is a
theory about what matters; a trace is a fact.

### What the run did get right

- The defect was found in one place: `monthOf` in the report now reads the month at the timestamp's own offset.
- The worker ran the target's own tests — 12 before its change, 15 after — before reporting `ready`.
- The result reached the channel, so the person who asked saw the answer without opening a terminal.
- The refund defect was left alone, because it had not been reported. Acting only on what was asked is the behaviour
  the whole authorization layer exists to produce.
