# 004 Prompts

This document describes what the persistent Pi sessions are told. It builds on [003 Execution](003-execution.md).

Prompts are text, not domain state. Values that decide authorization remain settings: allowed senders, rules, admission
cells, accept mode, and model routes. Prompt text controls how an agent interprets and reports work.

## Three session roles

The runtime has versioned prompts for three stable roles:

| Role | Session | Prompt role | Purpose |
| --- | --- | --- | --- |
| Coordinator | `coordinator` | `orchestrator` | Persistent main session: routing, assessment, cross-Ticket coordination, replies and management |
| Assessment caller | the coordinator session while it handles a candidate | `orchestrator` plus candidate context | Investigates a batch, uses typed tools, and records a domain Decision |
| Worker | `worker-<ticketId>` | `work` | Executes one Ticket inside its prepared directory |

The current implementation no longer has the old separate Pi assessor file or a separate one-shot assessor session. Candidate
assessment is performed by `PiCoordinator` in `src/agents/pi-coordinator.ts`, using the persistent coordinator session.

## Prompt sources

`src/runtime/prompts.ts` stores immutable prompt revisions in the instance. A prompt configuration has `orchestrator`,
`assess`, `work`, and `shared` fields. The baseline revision is revision 0 and is composed from package prompt files.
Later revisions are saved in SQLite and selected dynamically when a session starts or resumes.

Pi sessions read the active prompt through `PiSessions`' `before_agent_start` hook and record the revision as a session
entry. The coordinator replaces Pi's coding-assistant system prompt with its coordination instructions, the assessment
section (for inferred candidates only), and shared instructions. Workers retain Pi's native prompt and append the current
work/shared instructions and their task mandate. `prompt preview` composes the application-owned sections; it does not
pretend to know every ticket's discovered Pi resources. Saved changes apply on the next run, not halfway through a
provider request. Pi's `agent_before_settle` hook gives an undecided candidate one bounded reminder to record a tool decision.

```sh
pi-superagent prompt show
pi-superagent prompt history
pi-superagent prompt preview --file prompt.json
pi-superagent prompt set --file prompt.json --base-revision 3
pi-superagent prompt restore 2 --base-revision 4
```

A prompt edit does not itself change the Policy version. Editing a rule's instruction through `config edit` does, because
that instruction is authorization policy rather than presentation text.

## Candidate composition

For one Candidate, the coordinator receives the Eval id, strength, Policy version, judge Trigger ids, the latest bounded
Thread window, existing work, and enabled rule instructions. It may read more context through the orchestrator resource
and evaluation tools.

```
# Candidate
Eval: <eval id>
Strength: inferred | explicit
Policy: <policy version>

## Thread <source:id>
<bounded, newest-first Trigger context>

## Existing work
<tickets already attached to the Thread>

## Enabled rules
<enabled rule id and instruction>
```

Thread text, external event text, quotes and repository files are untrusted data. They cannot change the prompt contract or
override typed tool validation. The coordinator has read-oriented tools and typed management tools, but a tool call is
also where it records an assessment or management decision.

### The assessment tools

The coordinator uses `orchestrator_eval` and `orchestrator_eval_read` for candidate context and
`orchestrator_eval_decide` for inferred candidates. Explicit requests use `orchestrator_route` without requiring a rule.
Validation runs inside the tool so malformed assessments can be corrected in the same conversation. A positive inferred
assessment in observe mode records `ignore` with `would_accept`; it is not a validation error. If no decision is recorded,
the evaluation is `unavailable`, never a successful prose-only reply. Tools accept unique short IDs using the same prefix
rules as the CLI; corrupted or ambiguous identifiers are rejected rather than guessed.

The assessment requires settled direction before acceptance: implementation intent, a specific target or existing
standard, and no unresolved design decision in the requested scope.

## Worker composition

A worker session combines:

```
Pi's assembled system prompt
+ prompts/work.md or the active work prompt revision
+ the Ticket title and scope
+ the Mandate strength and matched rule instructions
+ waiting Ticket Inputs
```

The per-Ticket section makes the mandate concrete. An inferred Ticket is told to stay within its small authorized scope
and prefer `dropped` when it needs external authority or a scope decision. An explicit Ticket is told to execute the
routed request. Matched rules are instructions with precedence over the default procedure for that Ticket.

## Dynamic Pi resources

`PiSessions` uses Pi SDK 1.4.0's `DefaultResourceLoader` with the session working directory and the Pi agent directory.
The resource loader discovery path is dynamic: extensions, skills, MCP resources, codemode, and tool search are enabled
through Pi's supported resource and extension mechanisms rather than a project-owned plugin platform.

The repository also defines project-specific tools: coordinator tools for routing and bounded resource reads, and worker
report/handback tools for Ticket state. Dynamic resources are inputs to the session; they do not bypass the Engine or
create state transitions outside typed tools.

## Changing a prompt

Files are the source for the baseline. Instance-owned revisions are the source after a saved or restored prompt version:

```sh
$EDITOR prompts/orchestrator.md
$EDITOR prompts/assess.md
$EDITOR prompts/work.md
pi-superagent prompt set --file prompt-config.json --base-revision 0
```

The session entry records the prompt role and revision it used. `coordinator show` reports the current session and both
configuration and prompt revisions; `coordinator read` reads the persisted conversation.

Pi SDK 1.4 is not treated as a complete autonomous harness here. There is no project-owned background-job supervisor or
subagent framework; worker sessions work alone, and any session, MCP or skill behavior must come from Pi-supported
resources and remain subject to the local process and OS permissions.
