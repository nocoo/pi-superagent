import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annual, monthsOf, monthOf, report } from '../src/report.ts'
import type { Transaction } from '../src/parse.ts'

const spend = (at: string, amount: number, category = 'food'): Transaction => ({ at, amount, category, kind: 'spend', note: '' })

test('reads the month from the timestamp', () => {
  assert.equal(monthOf('2026-01-05T12:00:00+00:00'), '2026-01')
  assert.equal(monthOf('2026-12-31T23:00:00+00:00'), '2026-12')
})

test('totals a month and counts its transactions', () => {
  const transactions = [
    spend('2026-01-05T12:00:00+00:00', 1200),
    spend('2026-01-09T12:00:00+00:00', 800, 'transport'),
    spend('2026-02-01T12:00:00+00:00', 5000),
  ]
  const january = report(transactions, '2026-01')
  assert.equal(january.total, 2000)
  assert.equal(january.count, 2)
  assert.deepEqual(january.byCategory, { food: 1200, transport: 800 })
})

test('reports a month with no transactions as empty', () => {
  assert.deepEqual(report([], '2026-04'), { month: '2026-04', total: 0, byCategory: {}, count: 0 })
})

test('lists the months that appear in the file, oldest first', () => {
  const transactions = [spend('2026-03-01T12:00:00+00:00', 100), spend('2026-01-01T12:00:00+00:00', 100)]
  assert.deepEqual(monthsOf(transactions), ['2026-01', '2026-03'])
})

test('totals a year by month', () => {
  const transactions = [spend('2026-01-05T12:00:00+00:00', 1200), spend('2026-02-05T12:00:00+00:00', 800),
    spend('2025-12-31T12:00:00+00:00', 999)]
  assert.deepEqual(annual(transactions, '2026'), { year: '2026', total: 2000, byMonth: { '2026-01': 1200, '2026-02': 800 } })
})
