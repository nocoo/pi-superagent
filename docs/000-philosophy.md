# 000 Philosophy

`pi-superagent` is a framework, and also a way of working with an agent. Its core principle is inherited unchanged
from [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype):

**Take as little human attention as possible, and give as much value as possible.**

Every part of the project is judged by the attention it costs. A message, a notification, a question, a setting, a
command-line line of output and a paragraph of documentation each cost someone's attention, and each has to give more
value than that, or it is removed.

## What follows for the agent

- **It acts only when asked, or when a written rule allows it.** A request counts only when it addresses the agent
  directly and comes from a person the team allowed: one on an allowed list, or anyone in a scope the team opened.
  Work nobody asked for needs a rule the team wrote, and starts in a mode that only records what the agent would have
  done.
- **It speaks only when a person must act or can use a result.** It confirms a request once and names what it will do.
  It stays quiet while it works. It writes again when a result is ready, when it needs a decision, or when it cannot
  finish. Messages are short and go to the conversation where the request was made.
- **A correction costs one message, not a wait.** A person can talk to the agent while it works, and the agent takes
  the correction at its next step rather than finishing the wrong thing first. This is why execution runs on a live
  session and not on a one-shot command; see [003 Execution](003-execution.md).
- **It asks one concrete question at a time.** A question is a ticket field, not a paragraph inside a report, so it
  reaches the person instead of staying inside a long message.
- **It stops by impact, not by effort.** A local change goes as far as a reviewable result. A change that needs a
  design decision stops with a clear question.
- **It reports honestly.** A draft is marked unfinished, a failure is reported as a failure, and a limit is never
  bypassed to avoid asking. A worker that finds nothing to do says so rather than inventing a change.

## What follows for the design

- **Few concepts.** The design has only its domain concepts, such as a Source, and their concrete implementations, such
  as GitHub. A business need becomes an attribute of one of them, or a prompt the agent follows. The design does not add
  a concept for it. [001 Domain model](001-domain.md) keeps a table of concepts that were considered and rejected.
- **Few settings.** A default replaces a setting when one value suits almost every team. Behaviour that a team describes
  in words is prompt text, not a setting.
- **Prompts are text.** Agent instructions and the assessment policy live in `prompts/*.md`, so a team can change how
  the agent behaves without touching code, and can read what it was told.
- **The surfaces show only what needs a person.** Today the only surface is the command line
  ([005 CLI](005-cli.md)). It lists first what waits for a person, a healthy state takes one line, and every command
  answers a question an operator actually has rather than exposing an internal structure.
- **Documents read in order.** Each numbered document builds only on the ones before it, so a reader never needs a
  concept that has not been introduced yet.

## Responsibility

The agent comments, opens pull requests and messages people under an account your team sees every day. Every message it
sends costs your colleagues' attention, and you are responsible for it. The more the agent can do, the more care its
operator owes the team:

- **Start narrow.** Begin with a short allowed list and with proactive work only recorded. Widen both once what the
  agent would have done looks right.
- **Use a dedicated account.** The agent must not act as the operator's own identity. Two reasons: everything it writes
  then appears as the operator, and a Source cannot tell the agent's messages from the operator's, so the agent reads
  its own acknowledgements back as new requests. The second failure is silent and looks like a harmless extra turn.
  See [006 Deployment](006-deployment.md#the-agent-account).
- **Tune for less noise.** When the agent is noisy, make its prompts shorter and stricter, or pause it. Do not add more
  messages to explain the noise.
- **Do not use it to produce volume.** Mass pull requests, broadcast messages and busywork cost the team more than they
  give.
- **Own what it says.** Read what the agent posts in your name, and correct it in the prompts when it is wrong.

The goal is the right help at the right time, and nothing at any other time.
