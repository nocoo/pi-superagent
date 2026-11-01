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
