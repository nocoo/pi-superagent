# 002 Authorization

Authorization determines who may start work and what that work may include. This document builds on
[001 Domain model](001-domain.md).

The host enforces allowed lists, rules and Mandates. Messages, comments and quoted documents are inputs to a decision;
they cannot change those permissions.

## Two paths for a Trigger

### Eval: deciding whether to start work

The Source records whether a message addresses the agent: `mention` for a mention of the bot or agent account, and
`direct` for a direct message. The gate checks the sender and the Source's Policy:

- An allowed person who addresses the agent makes an explicit request.
- A person's follow-up on a Thread with Tickets follows the rules below.
- Other human messages use the admission table for their receiving scope.
- A bot on the Source's bot list can produce an inferred candidate, never an explicit request. Other bots are not
  admitted.

The gate is deterministic code in `src/policy.ts` and never calls a model. A Trigger the gate admits becomes an Eval,
which is where a model is consulted (see [003](003-execution.md) for who runs it).

### Subscriptions: continuing existing work

Every message on a subscribed Thread reaches its subscribed Tickets as context, including messages from bots and CI.
This delivery bypasses the gate and grants no new authority. Each Ticket remains limited by its Mandate.

A person's message on a Ticket's own Thread belongs to that Ticket's Executor to decide. While an Executor owns the
message, it takes no Eval and gets no Decision. The Executor either handles the request within its Ticket's scope or
hands it back for routing elsewhere. This is the path by which a person corrects work in progress without waiting for
an assessment; see [003 Execution](003-execution.md#steering).

Ownership continues while the Ticket is live, even if a person removes its Subscription. It also covers an ended Ticket
that was not stopped by a person and has the message waiting to resume it.

### Handing back and releasing follow-ups

An Executor hands a message back once when it asks for work beyond the Ticket's scope or belongs to another Ticket. The
Ticket keeps its Subscription. A message goes to a fresh Eval only after no Ticket still owns it.

When a Ticket ends, it releases follow-ups its Executor did not read or take up. A stop ends only the stopped Ticket's
work.

### Context-only subscriptions

An Executor can follow a related Thread for context. Its messages reach the Ticket but grant no authority. Human
messages that reach no Ticket take the Eval path.

## Strength

| Strength | Cases |
| --- | --- |
| explicit | A person on the list addresses the agent, or follows up on a Thread that already has a Ticket; a cell of the admission table set to explicit request |
| inferred | A person not on the list follows up on a Thread with a Ticket, unless their cell of the admission table is explicit; a cell set to inferred candidate; a message of a bot on the Source's bot list |
| not admitted | Any other bot's message, everything the admission table ignores, and every inferred case while the accept mode is `off` |

For an unlisted person, an explicit admission cell takes precedence even on a Thread with Tickets and works in every
accept mode. Otherwise their follow-up is inferred and is not admitted in `off` mode.

## Admission

Each Source's Policy has an admission table. Its rows are receiving scopes:

- **GitHub:** new Issues, new pull requests, comments and the default branch's CI.

A row has up to three cells. Each cell decides whether a message becomes an explicit request, an inferred candidate or
nothing:

| Cell | Choices | Default |
| --- | --- | --- |
| On the list, not addressing the agent | inferred, ignore | inferred |
| Not on the list, addressing the agent | explicit, inferred, ignore | ignore |
| Not on the list, not addressing the agent | inferred, ignore | ignore |

Cells for unaddressed messages are available only where the Source receives every message, such as a GitHub scope with
its receive-all switch enabled. A CI result has no sender, so its row offers only the last cell. Bot messages use the
bot list instead of these cells.

Setting the unlisted-addressed cell to explicit lets anyone in that scope request work by mentioning the agent. This can
be useful for a dedicated support chat.

The admission table is part of the Policy version. Weakening a cell does not immediately stop open Tickets accepted
under it. It can revoke their Mandates when they are revalidated before resuming.

The table is evaluated for every Trigger. It has no controls of its own yet — no command lists its rows with their
current values — so it is edited as JSON through `pi-superagent config edit` ([005](005-cli.md#config-edit)).

### Bots and automated reviewers

The host recognizes GitHub Apps and logins ending in `[bot]` as bots. A Source can list bots such as
`dependabot[bot]` whose messages may become inferred candidates. They must either address the agent or post in a scope
that receives every message. They cannot make explicit requests or stop Tickets.

An automated reviewer using an ordinary account counts as a person to the host. Its comments reach subscribed Tickets
and generate follow-up notices. Prompt text must identify such accounts as automated reviewers.

## Accept mode and rules

The accept mode is part of the Policy:

| Mode | Effect |
| --- | --- |
| `off` | Nothing inferred becomes a candidate |
| `observe` (default) | Inferred candidates are assessed; a positive assessment is recorded as ignore marked `would_accept`, and nothing is accepted |
| `auto` | A positive assessment of an inferred candidate accepts it |

Each rule describes a kind of proactive work, and each assessment judges every enabled rule exactly once, whether it
matches or not. An accept requires at least one matching rule. The Ticket's Mandate records the matched rules, and its
Executor receives their names and instructions, which take precedence over the default procedure for that Ticket.

Two rules ship enabled:

| Rule | Covers |
| --- | --- |
| `copy` | Explicit requests to correct a typo, wording, punctuation or existing translation |
| `visual` | Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard to restore |

A team adds rules for the proactive work it wants. Rules are prompt text with an identity, not code: they are read by
the model during an assessment and recorded on the Mandate for audit.

## Coordinator routing and assessment

The persistent `PiCoordinator` is now the first route for a candidate. It has typed tools for investigation and domain
management, and it decides accept, attach, stop or ignore through the Engine rather than by directly changing state.
For inferred candidates it evaluates the enabled rules and returns an assessment outcome. For explicit requests it may
route to an existing Ticket or take an explicit Decision directly, while still recording the result in the domain.

The Policy still has the final authority: typed tool results and model judgement must pass the gate, the enabled rule
schema, the admission table, and the same revalidation rules as any other Decision. `observe` mode records and reviews
inferred work; it does not make model text a Mandate or ticket state.

Inbox identity is namespaced by system. An external event `actor: alice@example.com` in `system: linear` becomes
`linear:alice@example.com` internally, and the Inbox policy allowlist should contain that same `system:actor` identifier.
Both namespaced and email characters are valid external IDs; matching is source-specific and never maps identities across
systems.

## Policy version

Rules, accept mode, each Source's Policy and the receiver configuration form the Policy version. Receiver configuration
is included conservatively: disabling a Source or narrowing its channels must invalidate pending evaluations, including
across a restart. Changing a polling setting therefore also changes the version. Role models, worker concurrency and
the pause flag do not. The gate checks current listening scope again when an event is replayed.

Every Mandate records the version under which it was accepted. A version change discards running Evals and queues
their Triggers again. It also sends a policy-changed Input to each affected live Ticket, explaining whether a matched
rule changed, whether the requester may no longer start work, or whether proactive work is no longer accepted. The
change does not immediately revoke live Tickets' Mandates.

## Resume and stop

An ended Ticket keeps its Mandate. A person's message on one of its own Threads can resume the same work without a new
Eval or Decision. Bots and CI do not wake ended Tickets.

Only three operations change a Mandate: accept creates it, a person's stop withdraws it, and failed revalidation
revokes it. A Ticket stopped by a person stays ended and receives nothing more.

### Revalidation before resume

The Source must still listen to the original Thread. The remaining checks depend on the Mandate's basis:

- An explicit follow-up Mandate passes.
- An inferred Mandate needs `auto` mode and its matched rules still enabled.
- A Mandate admitted by a table cell must still receive at least its original strength under today's table and sender
  membership.
- A bot's Mandate requires that bot to remain on the Source's bot list.

If revalidation fails, the Ticket stays ended and takes none of its waiting messages; each goes to Eval as if it had
reached no Ticket.

- **A person saying "stop" in a Thread is an ordinary Trigger,** and Eval decides stop. An Executor cannot declare that
  a person asked it to stop.
- **A stop by an operator is an Engine command.** `Engine.stopTicket` acts on the Ticket directly and withdraws the
  Mandate. It has no command-line surface yet; the CLI reports work, it does not intervene in it
  ([005 CLI](005-cli.md#not-in-the-cli)).

## When Eval does not finish

The time limit is `eval.timeoutSeconds` (default 120 s) and starts when the candidate reaches the Assessor. An expired
Eval queues its Triggers for another attempt; after two consecutive retries the third expiry records `unavailable`. An
assessment failure also records `unavailable`; a later Trigger can start a new Eval.

The command line reports unresolved `unavailable` Decisions from the last hour in `status` ([005](005-cli.md#status)).
