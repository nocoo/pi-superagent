/** Reading the transaction file. */

/** One line of the CSV. `amount` is in whole cents; a refund is negative. */
export interface Transaction {
  /** An ISO 8601 timestamp with an explicit offset, such as `2026-03-01T00:30:00+08:00`. */
  at: string
  amount: number
  category: string
  kind: 'spend' | 'refund'
  note: string
}

const COLUMNS = ['at', 'amount', 'category', 'kind', 'note'] as const

/** Splits one CSV line, honouring double quotes around a field. */
export function splitLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { cells.push(cell); cell = '' }
    else cell += char
  }
  cells.push(cell)
  return cells
}

/** Parses the CSV body into transactions, in file order. */
export function parse(text: string): Transaction[] {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  if (!lines.length) return []
  const header = splitLine(lines[0]!).map(name => name.trim())
  for (const column of COLUMNS) {
    if (!header.includes(column)) throw new Error(`the file has no ${column} column`)
  }
  const index = Object.fromEntries(COLUMNS.map(column => [column, header.indexOf(column)])) as Record<typeof COLUMNS[number], number>

  const transactions: Transaction[] = []
  for (const [offset, line] of lines.slice(1).entries()) {
    const cells = splitLine(line)
    const value = (column: typeof COLUMNS[number]): string => (cells[index[column]] ?? '').trim()
    const amount = Number(value('amount'))
    if (!Number.isFinite(amount)) throw new Error(`line ${offset + 2}: amount ${value('amount')} is not a number`)
    const kind = value('kind')
    if (kind !== 'spend' && kind !== 'refund') throw new Error(`line ${offset + 2}: kind ${kind} is not spend or refund`)
    transactions.push({ at: value('at'), amount, category: value('category'), kind, note: value('note') })
  }
  return transactions
}
