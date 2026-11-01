# ledger

A small expense ledger. It reads a CSV of transactions and reports a month.

```sh
node src/cli.ts report --month 2026-03
node src/cli.ts annual --year 2026
node src/cli.ts check
node tests/all.test.ts
```

Amounts are in whole cents. A refund is a negative amount with `kind` set to `refund`.

## The file

`data/transactions.csv` has the columns `at, amount, category, kind, note`. `at` is an ISO 8601 timestamp with an
explicit UTC offset, because the person who wrote it travels and wants each entry counted where it happened.

`check` looks for inconsistencies between the totals and the category breakdown.
