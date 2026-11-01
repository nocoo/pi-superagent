/** Turning a report into text for a terminal. */
import type { MonthReport } from './report.ts'

/** Whole cents as a signed amount with two decimals. */
export const money = (cents: number): string => `${cents < 0 ? '-' : ''}${(Math.abs(cents) / 100).toFixed(2)}`

/** A month's report as an aligned table, largest category first. */
export function format(report: MonthReport): string {
  const lines = [`${report.month}  ${report.count} transactions  total ${money(report.total)}`, '']
  const rows = Object.entries(report.byCategory).sort((a, b) => b[1] - a[1])
  const width = Math.max(0, ...Object.keys(report.byCategory).map(name => name.length))
  for (const [category, amount] of rows) lines.push(`  ${category.padEnd(width)}  ${money(amount).padStart(10)}`)
  return lines.join('\n')
}
