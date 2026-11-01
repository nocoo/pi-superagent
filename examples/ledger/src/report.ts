/** Grouping transactions into months and categories. */
import type { Transaction } from './parse.ts'

/** One month's totals. Amounts are in whole cents, the same unit as the file. */
export interface MonthReport {
  month: string
  total: number
  byCategory: Record<string, number>
  count: number
}

/** The month a transaction belongs to, as `YYYY-MM`. */
export function monthOf(at: string): string {
  return new Date(at).toISOString().slice(0, 7)
}

/** Totals for one month. */
export function report(transactions: Transaction[], month: string): MonthReport {
  const inMonth = transactions.filter(transaction => monthOf(transaction.at) === month)
  const byCategory: Record<string, number> = {}
  let total = 0
  for (const transaction of inMonth) {
    total += transaction.amount
    byCategory[transaction.category] = (byCategory[transaction.category] ?? 0) + Math.abs(transaction.amount)
  }
  return { month, total, byCategory, count: inMonth.length }
}

/** Totals for one year, by month. */
export function annual(transactions: Transaction[], year: string): { year: string; total: number; byMonth: Record<string, number> } {
  const byMonth: Record<string, number> = {}
  let total = 0
  for (const transaction of transactions) {
    const month = monthOf(transaction.at)
    if (!month.startsWith(`${year}-`)) continue
    total += transaction.amount
    byMonth[month] = (byMonth[month] ?? 0) + transaction.amount
  }
  return { year, total, byMonth }
}

/** Every month that appears in the file, oldest first. */
export const monthsOf = (transactions: Transaction[]): string[] =>
  [...new Set(transactions.map(transaction => monthOf(transaction.at)))].sort()
