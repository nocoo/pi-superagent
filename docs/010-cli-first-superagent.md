# CLI-first general-purpose superagent

## Accepted scope

Restore the prototype's coordination and supervision capabilities without DeepSeek Harness or Feishu. Tasks may originate in IM, GitHub, or another ticketing system. A repository, worktree, code change, and pull request are optional, not domain requirements.

The CLI is the single management and query interface. The local web panel executes that CLI and renders its JSON results; it never imports the Store, Engine, or agent runtime. Both people and automation must be able to complete the same workflows without the panel.

Reuse Pi's supported SDK, session persistence, resource discovery, and extensions. Investigate the durable harness before selecting an integration. Do not invent a background-job supervisor or subagent framework to imitate unavailable Pi capabilities. Do not restore the prototype's command shims or credential isolation.

## Boundaries

- **Domain:** keep Ticket, Thread, Trigger, Mandate, Assignment, and their existing invariants. A structured report can complete a non-coding task without a PR.
- **Runtime:** one process owns a state directory. Stateful management commands reach that process through local IPC so Engine effects, running sessions, and configuration notifications agree. Read commands remain useful while it is stopped.
- **Coordination:** a persistent main session routes explicit requests, investigates inferred candidates, receives worker reports, and performs cross-ticket coordination. Model text is not a state transition: typed tools call the Engine.
- **Workers:** Pi supplies ordinary tools and extension resources. Structured collaboration tools expose reporting, questions/answers, acknowledgements, context subscriptions, and handback independently of GitHub.
- **Sources:** adapters translate native events and replies through SourceKind. GitHub and local IM remain built-in. Source capabilities supply additional context without placing provider-specific assumptions in the domain.
- **Prompts:** versioned text is stored in the instance and managed through the CLI. Runtime application boundaries and the revision used by each session must be observable. Pi's extension mechanism supplies dynamic instructions rather than a second agent loop.
- **Panel:** React/Basalt views and view models consume CLI JSON. A loopback-only server serves assets and a bounded CLI bridge. It does not expose arbitrary shell execution.

## Management contract

Existing read commands retain their `{ command, result }` JSON envelope. Failures use `{ command, error: { code, message } }` and a nonzero exit status.

The restored management surface includes:

- `ticket stop`, `retry`, `note`, `answer`, `attach`, `request-status`;
- `thread unsubscribe`, `trigger reevaluate`, `decision dismiss`;
- `search`, coordinator status/transcript inspection;
- non-interactive configuration import plus history;
- prompt list/show/set/preview/history/restore;
- existing chat input, source/thread/trigger/decision/ticket inspection and waits.

The web bridge passes an argv array, never a shell command string. The instance is selected by the server, not browser-supplied paths. Interactive and unbounded CLI invocations are not exposed through the bridge.

## Incremental delivery

1. Restore live management, configuration effects, and operator intervention through the CLI; retain a working existing agent loop.
2. Restore the persistent coordinator, investigation tools, generic worker collaboration, and versioned prompts using Pi.
3. Add the local panel over the verified CLI contract, including intervention and prompt/configuration management.
4. Exercise the full system through local CLI-driven fixtures and real model requests; verify restart, steering, routing, questions, and general-purpose results. Review and fix bounded findings before completion.

Each increment is verified and committed atomically on `main`. No push, release, or external deployment is part of this work.

## Local acceptance

- Existing baseline: `pnpm check`, 189 tests passed before implementation.
- Real model endpoint authorized by the owner: `http://127.0.0.1:3425`, model `group/coding`.
- Model runs use isolated local fixtures, never real GitHub issues/PRs or external deployments.
- Panel domain: `https://superagent.dev.hexly.ai`, loopback upstream port 7062; isolated test ports 17062/27062.
- Port 7062 was absent from both active/versioned Caddy configurations and successfully bind-checked. The local memory service at port 14242 was unavailable during reservation lookup; recording the reservation there remains pending.
- Use existing wildcard TLS files. No certificate regeneration or Keychain operation is required.
