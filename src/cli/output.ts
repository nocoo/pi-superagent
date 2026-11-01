/** Output conventions: data on stdout, everything else on stderr, and one stable JSON shape when `--json` is given. */

/** What every command receives: where the instance is, and whether to print data or prose. */
export interface Cli {
  readonly stateDir: string
  readonly json: boolean
}

/**
 * Prints a command's result. Human output goes through `human`; with `--json` the result is printed as
 * `{"command": …, "result": …}` so a caller can pipe it without redirecting anything.
 */
export function emit(cli: Cli, command: string, result: unknown, human: () => void): void {
  if (cli.json) process.stdout.write(`${JSON.stringify({ command, result })}\n`)
  else human()
}

/** Writes one line of human output to stdout. */
export const line = (text = ''): void => { process.stdout.write(`${text}\n`) }

/** Renders rows as aligned columns. A one-cell row is a heading and keeps its own text. */
export function table(rows: string[][], gap = 2): void {
  const widths = new Map<number, number>()
  for (const row of rows) {
    if (row.length === 1) continue
    row.forEach((cell, index) => { widths.set(index, Math.max(widths.get(index) ?? 0, cell.length)) })
  }
  for (const row of rows) {
    if (row.length === 1) { line(row[0]); continue }
    line(row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths.get(index) ?? 0)).join(' '.repeat(gap)).trimEnd())
  }
}

/** Formats a moment as a short age: `41s ago`, `3 minutes ago`, `2 days ago`. */
export function age(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return iso
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  const text = (value: number, unit: string): string => {
    const rounded = Math.round(value)
    return `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`
  }
  if (seconds < 60) return text(seconds, 'second')
  if (seconds < 3_600) return text(seconds / 60, 'minute')
  if (seconds < 86_400) return text(seconds / 3_600, 'hour')
  return text(seconds / 86_400, 'day')
}

/** Shortens an identifier for human output; `--json` always prints the whole one. */
export const short = (id: string): string => id.slice(0, 8)

/** Pluralizes `count` with `one`/`many`, as in `1 ticket` / `3 tickets`. */
export const count = (value: number, one: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many}`

/** Truncates `text` to `width` characters, marking that it was cut. */
export const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
