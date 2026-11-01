# 006 Deployment

This document covers installing and operating one instance: the accounts it needs, where it keeps state, the command
that prepares a Ticket's directory, how to keep it running, and what to check when it stops doing what you expect. It
builds on [005 CLI](005-cli.md).

## Two ways to drive it

The agent works one repository. What wakes it up is a Source, and this build has two:

| Source | Needs | Use |
| --- | --- | --- |
| `github` | a repository and an agent account | the product: issues, pull requests, CI |
| `im` | nothing but this machine | working on a target without GitHub; see [009](009-bootstrap.md) |

Both may run at once. A deployment with only `im` needs no GitHub account at all, which is what makes it usable as a
workbench.

## Prerequisites

| Needs | Why |
| --- | --- |
| Node.js 22.19 or newer | `node:sqlite` and the TypeScript build target |
| `gh` 2.48 or newer | every GitHub read and write goes through it |
| `git` | the `prepare` command creates worktrees |
| Pi 1.4 with a configured model | the Executor and Assessor run on Pi sessions |

```sh
pnpm install
pnpm build
node lib/cli.js --version
```

## The agent account

**The agent must act as its own GitHub account, never the operator's.** This is not a preference. A Source recognises
the agent's own messages by comparing their author with the account it acts as; if the two are the same, nothing is
filtered, and:

- the agent reads its own acknowledgement as a person's message and resumes the Ticket it just answered;
- its own pull request comments arrive as new requests;
- every reply it posts becomes inbound work.

The failure is silent. It looks like an extra turn, not an error, which is why it is documented here rather than left
to the reader.

Create a dedicated account and sign `gh` in to it under its own config directory, then point the agent at a wrapper:

```sh
# once, by hand
export GH_CONFIG_DIR="$HOME/.config/pi-superagent-gh"
gh auth login
unset GH_CONFIG_DIR

# the wrapper the agent uses, on PATH or named by --github-cli
cat > ~/.local/bin/pi-gh <<'EOF'
#!/bin/sh
GH_CONFIG_DIR="$HOME/.config/pi-superagent-gh" exec gh "$@"
EOF
chmod +x ~/.local/bin/pi-gh
```

`run` resolves the account from `--github-cli` at start and prints it:

```
pi-superagent is watching nocoo/pi-superagent as @pi-agent; state in ~/.pi-superagent/state
```

If that line names the operator's own login, stop and fix it before letting the agent run.

The account needs push access to the repository. Everything the agent writes appears under this name, and its commits
use the account's `users.noreply.github.com` address so they are attributable.

## Model routes

Pi resolves models from its own configuration. Nothing about providers lives in this repository.

```jsonc
// ~/.pi/agent/models.json
{
  "providers": {
    "magpie": {
      "baseUrl": "http://127.0.0.1:3425/v1",
      "api": "openai-completions",
      "apiKey": "$MAGPIE_API_KEY",
      "models": [{ "id": "group/coding" }]
    }
  }
}
```

A route is written `provider/model`, and it is the **first** slash that separates the two — so `magpie/group/coding` is
provider `magpie`, model `group/coding`.

Two roles have models:

| Role | Setting | Default |
| --- | --- | --- |
| Assessment | `eval.model` | Pi's configured default |
| Worker | `executor.model` | Pi's configured default |

Assessments are short and frequent; workers are long and rare. Pointing them at different models is the normal
arrangement.

## Configure

```sh
pi-superagent config set \
  --repository owner/name \
  --allowed your-login \
  --model magpie/group/coding \
  --prepare 'git -C /srv/repo fetch --quiet origin main && git -C /srv/repo worktree add "$PI_SUPERAGENT_DIR" -b "agent/$PI_SUPERAGENT_NAME" origin/main'
```

`--allowed` is the whole list, so naming one login removes the others; `config set` lists what it would remove and needs
`--yes` before it does. Use `--add-allowed` to widen.

Then review the rules. **An explicit request must match a rule** in this build
([002](002-authorization.md#the-one-difference-from-the-original)), so a deployment whose team asks for something no
rule covers gets `ignore` with reason `noRuleMatched`. Ship at least one rule per kind of work the team will ask for:

```sh
pi-superagent config show --json | jq '.policy.rules'
pi-superagent config edit
```

Leave the accept mode at `observe` until `decision list` shows you agree with what it would have accepted. `observe`
does not hold back requests a listed person made; it holds back proactive work.

## The state directory

```
~/.pi-superagent/state/            the state directory
  superagent.sqlite                aggregates, settings, effect queue, receipts
  superagent.sqlite-wal            SQLite write-ahead log
  sessions/worker-<ticketId>.jsonl one Pi session per Ticket, resumed across restarts
  work/<name>-<id>/                Ticket directories, unless executor.directory says otherwise
~/.pi-superagent/state.lock/       held while a process is running
```

One instance owns one state directory: the lock is how it refuses a second. Two instances on one machine need two state
directories, and that is also the only safe way to run two repositories.

The database holds everything that is not a worker's conversation. Copy `state/` and you have copied the instance.

## The prepare command

Runs once per Ticket, with `sh`, in the execution root, before the worker's first turn. It receives the variables of
[003](003-execution.md#execution-variables) and has ten minutes.

A directory that already exists counts as prepared, so a failed command is never retried over whatever it left behind.
Keep the command idempotent-safe: create the directory only as the last step, as `git worktree add` does.

Without a prepare command the worker starts in an empty directory — useful for probing, useless for code.

## Run it

```sh
pi-superagent run                     # logs to stderr, runs until signalled
pi-superagent run --verbose           # adds every domain event
```

Then, in another shell:

```sh
pi-superagent status
pi-superagent status --check          # exits 1 when work needs a person
```

### Keep it running

macOS, `~/Library/LaunchAgents/dev.pi-superagent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.pi-superagent</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>pi-superagent</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/pi-superagent.log</string>
</dict></plist>
```

Linux, `~/.config/systemd/user/pi-superagent.service`:

```ini
[Unit]
Description=pi-superagent
After=network-online.target

[Service]
ExecStart=/usr/local/bin/pi-superagent run
Restart=always
RestartSec=5
StandardError=journal

[Install]
WantedBy=default.target
```

Both need `gh` and `git` on `PATH`. A service inherits neither your shell's aliases nor its environment, which is the
most common reason a service starts and then reports a Source as failing.

## Upgrade

```sh
git pull && pnpm install && pnpm check && pnpm build
pi-superagent status                 # the running process is still the old one
# restart the service, then:
pi-superagent status
```

The database migrates on open. A version newer than the build refuses to open rather than risk the data, so upgrade the
binary before the state directory is written by a newer one.

## Troubleshooting

| Symptom | Look at | Usually |
| --- | --- | --- |
| `no_instance` | `ls ~/.pi-superagent` | `--state-dir` typo, or the agent never ran |
| `locked` | `ps aux \| grep pi-superagent` | two services, or a service plus a foreground `run` |
| nothing arrives | `pi-superagent source` | `gh` not on the service's `PATH`, wrong account, or the receive-all switches are off |
| a candidate is `unavailable` | `pi-superagent decision show <id>` | the assessment failed; the message carries the model's last words |
| a Ticket sits in `working` | `pi-superagent ticket read <id>` | the worker is running; if it is not, `ticket show` names the failed delivery or report |
| the agent answers itself | the `as @…` line in `run`'s output | it is acting as the operator's account |
| `ignore`, reason `noRuleMatched` | `pi-superagent decision show <id>` | no rule covers that kind of work; add one |
| accepted but did nothing | `pi-superagent ticket show <id>` | `prepare` failed, or the worker reported `dropped` with its evidence |

`--verbose` on `run` prints every domain event as one line, which is the fastest way to see whether a Trigger was
received, filtered, assessed or fanned out. `PI_SUPERAGENT_TRACE=1` adds the intake decision — which tickets a Trigger
reached and which of them owns it — which is what distinguishes "it never arrived" from "a worker handed it back".

## What this build does not do

It runs one repository, on one machine, as one user, with GitHub as its only Source. There is no panel, no second
Source, and no way for two instances to talk to each other. [001](001-domain.md#what-this-repository-does-not-have-yet)
keeps the list.
