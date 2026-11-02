# 008 Cookbook

This document adds a Source to a working instance. It builds on [001 Domain model](001-domain.md) and
[007 Architecture](007-architecture.md).

A Source is the only way events enter the system, so it carries four responsibilities that no other part can take over:

1. **Recognise its own output.** An agent acting as `@bot` must not read `@bot`'s own replies back as new requests.
2. **Give every Trigger a deterministic id.** The same underlying event must produce the same id every time it is read,
   so a restart or an overlapping poll cannot create a second Ticket.
3. **Hold a read position.** A restart resumes; it does not replay.
4. **Say what it listens to.** The gate asks the Source whether it receives a given event at all, and whether it
   receives everything in that scope or only what addresses the agent.

Everything else — authorization, deduplication, ticket creation, execution, replies — is already handled downstream.

## The contract

`src/sources/kind.ts`:

```ts
interface SourceKind<C> {
  kind: string
  title: Localized
  description: Localized
  schema: z.ZodType<C>                    // validates the stored configuration
  health: string[]                        // the health entries this kind alone may write
  scope?(input: { meta }, config: C): ScopeResult
  channel?: SourceChannel<C>              // how a reply leaves
  policy?: SourcePolicyPart               // what a `sources.<kind>` policy part must look like
  start(host: SourceHost, instance: SourceInstance<C>): () => void
}
```

| Member | Omit when | What it decides |
| --- | --- | --- |
| `scope` | the kind listens to everything it produces and observes nothing | whether an event enters at all, and whether unaddressed messages reach the admission table |
| `channel` | the kind produces no replies | how an acknowledgement or a result leaves, and whether an address can still receive one |
| `policy` | senders have no identity of their own | that `allowed` and `bots` in this Source's policy part are well formed |

`start` returns a stop function. The Host calls it on shutdown before it closes the store, so it must be safe to call
once and must not throw. A Source with an external push or CLI ingress and no background loop can report ready and return
a no-op stop function.

## The generic Inbox

`src/sources/inbox.ts` is the minimal external-event entry. `InboxEventSchema` accepts a strict `{system,id,thread,actor,text,
human?,addressed?,url?,meta?}` shape. `inboxTrigger` maps it to a `Trigger` with stable `key('inbox', system, id)`, namespaced
threads and actors, protected metadata keys, and a Channel address containing `system`, `thread`, and `event`.

```sh
pi-superagent config set --inbox --inbox-allowed 'linear:alice@example.com' --inbox-observed linear
pi-superagent source receive --file event.json
pi-superagent source replies --system linear --limit 20
```

Inbox does not open a network server or poll. External scripts call runtime IPC through `source receive`; replies are
appended locally to `<stateDir>/inbox/replies.jsonl` and read by `source replies`. Its directory and JSONL file use
private permissions, and every outbound message is deduplicated by message id.

## A worked example: a drop directory

A directory where a person writes a request as a Markdown file, and the agent answers by appending to a sibling file.
It is fully local, which makes it the smallest Source that exercises all four responsibilities.

```ts
// src/sources/drops.ts
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { SourceHost } from './host.ts'
import type { SourceKind } from './kind.ts'

const SOURCE = 'drops'
const ConfigSchema = z.object({
  directory: z.string().startsWith('/').describe('An absolute path to the inbox directory.'),
  intervalSeconds: z.number().int().min(1).max(3600).default(5),
}).strict()
type Config = z.infer<typeof ConfigSchema>

export const dropsKind: SourceKind<Config> = {
  kind: SOURCE,
  title: { zh: '投递目录', en: 'Drop directory' },
  description: { zh: '一个人把请求写成文件放进目录，智能体把答复追加到同名文件。', en: 'A person drops a request as a file; the agent appends its answer to a sibling file.' },
  schema: ConfigSchema,
  health: ['drops'],
  // Everything in the inbox is received; nothing else is. The row names the admission-table row this scope uses.
  scope: () => ({ listened: true, observed: false, row: 'inbox' }),
  policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string() })).default([]) }).strict() },
  channel: {
    // A reply appends to `<name>.reply`; the id makes a retried send a no-op instead of a duplicate line.
    send: async (_host, message) => {
      const file = join(message.channel.address.directory!, `${message.channel.address.name!}.reply`)
      const marker = `<!-- pi-superagent:${message.id} -->`
      const existing = await readFile(file, 'utf8').catch(() => '')
      if (existing.includes(marker)) return 'sent'
      await appendFile(file, `\n---\n${message.text}\n${marker}\n`)
      return 'sent'
    },
  },
  start(host: SourceHost, instance) {
    const ctx = host.context(dropsKind)
    const directory = instance.config.directory
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const pass = async (): Promise<void> => {
      if (stopped) return
      const seen = ctx.state.get(KV.drops.seen) ?? []
      const known = new Set(seen)
      try {
        await mkdir(directory, { recursive: true })
        for (const name of (await readdir(directory)).sort()) {
          if (stopped) return
          if (!name.endsWith('.md') || known.has(name)) continue
          const text = await readFile(join(directory, name), 'utf8')
          await ctx.receive(trigger(name, text, directory))
        }
        ctx.report('drops', { state: 'ready', detail: `${[...known].length} request(s) seen`, at: new Date().toISOString() })
      } catch (error) {
        ctx.report('drops', { state: 'error', detail: String(error), at: new Date().toISOString() })
      }
      if (!stopped) timer = setTimeout(() => void pass(), instance.config.intervalSeconds * 1000)
    }
    void pass()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  },
}
```

Two pieces are left out of the listing above but are part of the contract:

**The Trigger id must be deterministic.** Derive it from the Source's own identity of the event, never from a timestamp
or a counter:

```ts
/** The same file always produces the same Trigger id, so re-reading it cannot open a second Ticket. */
const trigger = (name: string, text: string, directory: string): Trigger => ({
  id: key(SOURCE, name),
  source: SOURCE,
  threads: [{ source: SOURCE, id: name }],
  actor: { source: SOURCE, id: 'operator' },
  human: true,
  at: new Date().toISOString(),
  text,
  channel: { source: SOURCE, thread: name, address: { name, directory } },
  meta: {},
})
```

**The read position must survive a restart.** It lives in the instance's key-value store, reached through
`ctx.state`; record the names you have consumed after `receive` resolves:

```ts
ctx.state.set(KV.drops.seen, [...known, name])
```

Add the key family to `src/kv.ts` beside the others, so the key is spelled once:

```ts
drops: { seen: record<string[]>('drops-seen') },
```

and import it in the Source with `import { KV } from '../kv.ts'`.

Finally, register the kind in the CLI next to `githubKind`:

```ts
host.register(dropsKind)
```

## What to check before shipping a Source

| Question | Wrong answer looks like |
| --- | --- |
| Is the Trigger id derived from the event, not from the read? | Every poll creates a new Ticket for the same message |
| Are the agent's own messages dropped? | The agent answers itself in a loop — the failure is silent, see [006](006-deployment.md#the-agent-account) |
| Does `receive` finish before the read position advances? | A crash between the two loses the event, or replays it |
| Does `scope` return `observed: true` only where the Source really receives unaddressed messages? | The admission table admits chatter as candidates, or ignores real requests |
| Does the reply send deduplicate by message id? | A retried send posts twice |
| Does the stop function stop the loop *and* its timers? | Shutdown hangs until the next poll finishes |
| Does the health entry name belong to this kind alone? | `SourceRegistry.register` throws at startup, which is the good outcome |

## Testing a Source

A Source is ordinary code with an ordinary interface, so test it without a network and without a model. The parts worth
asserting are the four responsibilities, not the parsing:

```ts
it('gives the same file the same Trigger id', () => {
  expect(trigger('a.md', 'text', '/tmp').id).toBe(trigger('a.md', 'text', '/tmp').id)
})

it('moves the read position only after receive resolves', async () => { … })
```

For the integration, `src/core/memory.ts` provides `MemoryRepositories`: build an `Engine` with a fake `Executor` and
`Assessor`, call `SourceContext.receive`, and assert the Trigger was stored once and that a second pass stores nothing.
`tests/core-engine.spec.ts` shows the harness.

## What a Source must not do

- **Must not authorize.** The gate decides who may originate work; a Source reports facts (`human`, `addressed`, the
  actor) and lets [002](002-authorization.md) decide.
- **Must not run the Engine directly.** It calls `receive`; `Passes` runs the Engine.
- **Must not hold domain state.** Tickets, Threads and Decisions live in the store; a Source holds only its read
  position and its own caches.
- **Must not add a variable for the worker.** The variables in
  [003](003-execution.md#execution-variables) are computed in `src/agents/environment.ts`; extend it there when a new
  Source needs one, rather than adding a hook to the contract.
