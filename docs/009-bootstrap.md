# 009 Bootstrap

This document describes how the agent is improved by running it against a target it cannot break, and how to drive that
without GitHub. It builds on [005 CLI](005-cli.md) and [008 Cookbook](008-cookbook.md).

## Why a target instead of itself

Asking the agent to change `pi-superagent` is the most honest test there is, and the most dangerous: a wrong change
means the next start fails, and the process that would fix it is the one that cannot start. `examples/ledger` exists so
the same loop can run with nothing at stake.

| | Changing itself | Changing `examples/ledger` |
| --- | --- | --- |
| A wrong change | the agent cannot start; no one to recover it | delete the ticket directory and try again |
| Repeatable | no: the target changes every time | yes: the same defects, every run |
| Verdict | a person reads a diff | `node tests/all.test.ts` and `ledger check` |
| Isolation | needs a worktree and discipline | `rsync` into the ticket directory |
| Proves | that the agent can be trusted with its own code | that the loop works |

Self-modification is the end state. The target is how the loop earns it.

## The target

`examples/ledger` is a small expense ledger: a CSV of transactions, a monthly report, an annual report, and a `check`
command for inconsistencies. It has no dependencies, so a ticket directory runs with nothing installed.

```sh
node src/cli.ts report --month 2026-03
node src/cli.ts check
node tests/all.test.ts
```

It carries three defects, written as ordinary code rather than planted markers. Each needs a different kind of work:

| Defect | Where | What it takes | How it shows |
| --- | --- | --- | --- |
| A month is read in UTC, so a transaction at `2026-03-01T00:30:00+08:00` is counted in February | `monthOf` in `examples/ledger/src/report.ts` | reading the code and knowing what the offset means | a person says the coffee was counted in the wrong month |
| Category totals use `Math.abs`, so a refund increases its category | `report` in `examples/ledger/src/report.ts` | noticing that the breakdown does not add up to the total | `ledger check` fails, and a person notices food went up |
| An invalid date such as `2026-02-30` is silently rolled into the next month | `parse` in `examples/ledger/src/parse.ts` | deciding whether to reject it or count it | only visible if the agent reads the data |

The third one has no correct answer written down, which is the point: it should produce a question for a person, not a
silent choice.

**The defects are not listed in `examples/ledger/README.md`**, because a target whose answer is in its own documentation
tests reading, not judgement. This document is the list, and it is for the operator.

## The surfaces

The historical ledger exercise used local IM ([006](006-deployment.md) has the configuration). The command line remains
the primary surface, and Inbox can replace IM for an external script:

```sh
pi-superagent chat general                      # read the channel, and talk in it
pi-superagent chat general --send "@agent …"    # write one message
pi-superagent status                            # what needs a person
pi-superagent ticket list                       # what is being worked on
pi-superagent ticket read <id>                  # what the worker actually did
```

There is no socket, no HTTP route and no exported writer: a channel is a file, and `chat` is the only supported way to
touch it. That constraint is deliberate — the command line is the product, and a second interface would be a second
thing to keep correct.

## Configuring it

```sh
pi-superagent config set \
  --im --im-observed general --im-allowed "$USER" \
  --mode auto \
  --model magpie/group/coding \
  --prepare 'rsync -a --exclude .git /path/to/pi-superagent/examples/ledger/ "$PI_SUPERAGENT_DIR"/'
```

- `--im-observed general` makes unaddressed messages in that channel candidates, which is what lets the agent stay on a
  channel rather than waiting to be mentioned.
- `--im-allowed` names who may originate work there. Identities are per Source, so this is not the GitHub list.
- `--prepare` copies the target into each ticket's directory. `prepare` is not tied to `git worktree`: anything that
  creates the directory works.
- `--mode auto` accepts inferred candidates. Run `observe` first if the rules are new.

One rule can cover the target. The persistent coordinator routes and assesses work through the current Policy; every
accepted Ticket still needs the configured rules and a settled direction under [002](002-authorization.md):

```sh
pi-superagent config edit    # add a rule, for example
# id: ledger
# name: Fix a ledger defect
# instruction: A report that the ledger's output is wrong — a transaction counted in the wrong month,
#              a refund making a category larger, a total that does not match its breakdown, or a check
#              that misses a case. The fix belongs in src/ or tests/ of the checkout in this ticket's directory.
```

## Running the loop

```sh
pi-superagent run            # one shell
node scripts/drive-ledger.ts # another: says what a person would say
```

The historical ledger script calls `pi-superagent chat`, so it exercised the local IM surface. For a generic external
source, a script can instead call `pi-superagent source receive --file -` and read replies with
`pi-superagent source replies`. That is the supported Inbox bootstrap path, with no HTTP service required.

The ledger script says five things:

| Said | Exercises |
| --- | --- |
| "the coffee on March 1st was counted in February" | a specific, locatable defect becomes one ticket and gets fixed |
| "food went up even though I refunded twice" | a defect that needs the data read, not only the code |
| "this month felt expensive" | vague chatter is ignored: no ticket, no question |
| "could you add a web interface?" | an out-of-scope request does not expand the open ticket |
| "forget the web, check the dates" | a correction reaches a worker that is already running |

## Live system probe

`pnpm test:live` builds the project and runs `scripts/probe-system.ts`, the current opt-in real-model probe. It uses the
local `magpie/group/coding` model at `127.0.0.1:3425` when the operator has that route configured. It is a live validation
command, not a unit-test baseline.

## What a good run looks like

The first historical measured run, on the ledger target:

| Step | Result |
| --- | --- |
| Assessment | `accept`, rule `ledger`, direction settled |
| Ticket | created, one directory, one worker |
| Work | `examples/ledger/src/report.ts` changed in one place: `monthOf` reads the month at the timestamp's own offset |
| Verification | the worker ran the ledger's own tests: 12 before, 15 after |
| Outcome | March went from `852.00` to `856.00`; the ticket reported `ready` and the result reached the channel |
| Scope | the refund defect was untouched, because it had not been reported |

That last row matters as much as the others: the agent fixed what was asked and nothing else.

## The human's two moves

The loop is not closed by the agent. Two steps stay with a person, deliberately:

1. **Say what to do.** The agent acts when asked, or under a rule the team wrote. Deciding what is worth doing is the
   work being automated least.
2. **Accept the result.** The agent's report says what it changed and how it verified it; a person decides whether that
   is enough. Merging and restarting are the same decision here.

Automating the second move would mean letting the agent change the process that runs it, with no one able to recover a
bad change. Everything up to that point is automated; that point is not.

## Known limits

- **A channel is one Thread, so a live ticket receives every later message in it.** A worker must hand back what is out
  of scope (`handback` in [003](003-execution.md)) or the channel collapses into one ticket. This was measured to work,
  and it is the part of the design with the least margin for error.
- **A worker may hand a message back and then work on it anyway.** A second request in a channel reaches the live
  ticket, whose worker is expected to hand it back so it gets its own ticket. In one run the worker handed it back *and*
  fixed it, so two directories gained the same change. The domain did the right thing; the worker did not. The tool and
  [004](004-prompts.md) now say to hand back *before* starting, but nothing enforces it — watch `pi-superagent ticket
  list` after a second request lands in a channel that already has a ticket.
- **The target has no git repository**, so a worker cannot show its change as a commit or open a pull request, and says
  so in its report. Add `git init` and a first commit to the `prepare` command if a diff matters to you.
- **The target is a fixture, not a product.** Its defects are fixed once and then it is consistent. Re-running the
  script after a run reports nothing new, so a fresh copy is needed for a new comparison.
