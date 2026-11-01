#!/usr/bin/env node
/** `ledger report --month 2026-03` prints a month; `ledger check` looks for inconsistencies in the file. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, type Transaction } from './parse.ts'
import { annual, monthsOf, report } from './report.ts'
import { format, money } from './format.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DATA = join(root, 'data/transactions.csv')

/** Reads `--flag value` pairs, with an optional positional command. */
function argv(args: string[]): { command?: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {}
  let command: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith('--')) { flags[arg.slice(2)] = args[++index] ?? ''; continue }
    command ??= arg
  }
  return { command, flags }
}

const load = (path: string): Transaction[] => parse(readFileSync(path, 'utf8'))

/**
 * Looks for inconsistencies: for each month, the categories must add up to that month's total.
 * @returns one line per problem; an empty array means the file is consistent.
 */
export function check(transactions: Transaction[]): string[] {
  const problems: string[] = []
  for (const month of monthsOf(transactions)) {
    const monthReport = report(transactions, month)
    const sum = Object.values(monthReport.byCategory).reduce((total, amount) => total + amount, 0)
    if (sum !== monthReport.total) {
      problems.push(`${month}: the categories add up to ${money(sum)} but the total is ${money(monthReport.total)}`)
    }
  }
  return problems
}

const { command, flags } = argv(process.argv.slice(2))
const data = flags.data ?? DEFAULT_DATA

if (command === 'report') {
  if (!flags.month) { console.error('ledger report needs --month YYYY-MM'); process.exit(2) }
  console.log(format(report(load(data), flags.month)))
} else if (command === 'annual') {
  if (!flags.year) { console.error('ledger annual needs --year YYYY'); process.exit(2) }
  const totals = annual(load(data), flags.year)
  console.log(`${totals.year}  total ${money(totals.total)}`)
  for (const [month, amount] of Object.entries(totals.byMonth).sort()) console.log(`  ${month}  ${money(amount).padStart(10)}`)
} else if (command === 'check') {
  const problems = check(load(data))
  if (problems.length) { for (const problem of problems) console.error(problem); process.exit(1) }
  console.log('no inconsistencies found')
} else {
  console.log('usage: ledger report --month YYYY-MM [--data PATH]')
  console.log('       ledger annual --year YYYY [--data PATH]')
  console.log('       ledger check [--data PATH]')
}
