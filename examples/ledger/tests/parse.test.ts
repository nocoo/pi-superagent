import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, splitLine } from '../src/parse.ts'

test('splits a quoted field that contains a comma', () => {
  assert.deepEqual(splitLine('a,"b,c",d'), ['a', 'b,c', 'd'])
})

test('treats a doubled quote as one quote', () => {
  assert.deepEqual(splitLine('"he said ""hi""",x'), ['he said "hi"', 'x'])
})

test('parses the header in any column order', () => {
  const transactions = parse('note,amount,at,category,kind\nlunch,1200,2026-01-05T12:00:00+00:00,food,spend\n')
  assert.deepEqual(transactions, [{ at: '2026-01-05T12:00:00+00:00', amount: 1200, category: 'food', kind: 'spend', note: 'lunch' }])
})

test('keeps a refund negative', () => {
  const [refund] = parse('at,amount,category,kind,note\n2026-01-05T12:00:00+00:00,-1200,food,refund,returned\n')
  assert.equal(refund?.amount, -1200)
  assert.equal(refund?.kind, 'refund')
})

test('refuses an amount that is not a number', () => {
  assert.throws(() => parse('at,amount,category,kind,note\n2026-01-05T12:00:00+00:00,abc,food,spend,x\n'), /not a number/)
})

test('refuses an unknown kind', () => {
  assert.throws(() => parse('at,amount,category,kind,note\n2026-01-05T12:00:00+00:00,100,food,gift,x\n'), /not spend or refund/)
})

test('refuses a file without the amount column', () => {
  assert.throws(() => parse('at,category,kind,note\n2026-01-05T12:00:00+00:00,food,spend,x\n'), /no amount column/)
})
