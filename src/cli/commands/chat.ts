/**
 * `chat`: the only way into the local IM. Opening a channel prints its history and then talks; `--send` writes one
 * message and exits, which is what a script or a test uses.
 *
 * This command is deliberately the sole entry point: the channel files are an implementation detail, so nothing else —
 * no socket, no HTTP route, no exported writer — may bypass it.
 */
import { createInterface } from 'node:readline'
import { ImStore, checkChannel, messageId, type ImMessage } from '../../im/store.ts'
import { CliError } from '../errors.ts'
import { clip, emit, line, type Cli } from '../output.ts'

const POLL_MS = 1_000

/** The name a message is sent as: `--as`, else the OS user, so a person does not have to say who they are. */
const senderOf = (as?: string): string => {
  const name = as ?? process.env.USER ?? process.env.LOGNAME
  if (!name) throw new CliError('usage', 'cannot tell who is sending', 'pass --as name')
  return name
}

const time = (iso: string): string => {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(11, 19) : iso
}

/** Prints one message the way a terminal chat would: who, when, and what. */
function show(message: ImMessage): void {
  const body = message.text.split('\n').filter(partText => !/^<!-- .+ -->$/.test(partText)).join('\n').trimEnd()
  line(`${time(message.at)}  ${message.from.padEnd(10)} ${clip(body.replace(/\n/g, `\n${' '.repeat(23)}`), 400)}`)
}

export async function chat(cli: Cli, channelName: string, options: {
  send?: string; as?: string; replyTo?: string; lines?: number
}): Promise<void> {
  const channel = checkChannel(channelName)
  const store = new ImStore(`${cli.stateDir}/im`)
  const from = senderOf(options.as)

  /** Appends one message and returns it. */
  const post = (text: string): ImMessage => {
    const message: ImMessage = { id: messageId(), channel, from, at: new Date().toISOString(), text,
      ...options.replyTo ? { replyTo: options.replyTo } : {} }
    store.append(message)
    return message
  }

  if (options.send !== undefined) {
    const text = options.send.trim()
    if (!text) throw new CliError('usage', '--send needs a message')
    const message = post(text)
    emit(cli, 'chat send', { message }, () => line(`${message.id}  ${channel}`))
    return
  }

  const history = store.messages(channel)
  const shown = new Set(history.map(message => message.id))
  if (!cli.json) {
    const recent = history.slice(-(options.lines ?? 20))
    for (const message of recent) show(message)
    line(`— ${channel} · ${from}${recent.length < history.length ? ` · ${history.length - recent.length} earlier` : ''} —`)
  } else {
    process.stdout.write(`${JSON.stringify({ command: 'chat', result: { channel, messages: history } })}\n`)
  }

  // Without a terminal, or when the caller asked for JSON, this is a readable history command rather than a chat.
  if (cli.json || process.stdin.isTTY !== true) return

  await new Promise<void>(resolve => {
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: '' })

    /** Prints messages this client has not shown yet, so the agent's replies appear while the person types. */
    const poll = (): void => {
      for (const message of store.messages(channel)) {
        if (shown.has(message.id)) continue
        shown.add(message.id)
        reader.pause()
        line()
        show(message)
        reader.prompt()
        reader.resume()
      }
    }
    const timer = setInterval(poll, POLL_MS)

    reader.on('line', input => {
      const text = input.trim()
      if (!text) { reader.prompt(); return }
      if (text === '.exit' || text === '.quit') { reader.close(); return }
      const message = post(text)
      shown.add(message.id)
      reader.pause()
      line()
      show(message)
      reader.prompt()
      reader.resume()
    })
    reader.on('close', () => { clearInterval(timer); line(); resolve() })
    reader.prompt()
  })
}
