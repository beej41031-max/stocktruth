# StockTruth

**Your stock system tells you how many you've got. StockTruth tells you whether you should believe it.**

StockTruth is a small inventory integrity layer. It sits beside an existing stock system, reads the evidence underneath the headline quantity, and decides what can actually be defended.

It is not another ERP. Nobody needs that sort of excitement.

If the evidence supports one answer, StockTruth states it. If it does not, the quantity is withheld, the conflicting records are named, and the operator gets a practical way to settle it.

## The awkward example

A book export says there are **19,200** cans.

A person physically counts **27,600** at 12:02.

Later that afternoon a delivery record arrives for **8,400** cans. The goods physically arrived at 11:02, before the count, but the paperwork was not entered until after it.

Did the counter include that pallet?

The records do not say.

Adding 8,400 may double-count it. Ignoring 8,400 may miss it. So StockTruth does neither:

```text
Book says          19,200
Counted             27,600
On the shelf now    CANNOT BE STATED

Why
Delivery M000004 arrived before count C000005 but was recorded afterwards.
The data cannot tell whether it was already included in the physical count.

Clear it by
Confirm whether the delivery was present during the count, or count the item again.
```

The useful bit is the refusal. Printing a number is easy.

## Two timelines

Stock records have two different clocks:

- **when something happened** — goods arrived, stock was counted, an issue occurred
- **when the system learned about it** — a file was imported, somebody keyed the delivery, an API event landed

StockTruth keeps those separate.

That means the same item can honestly have been:

```text
15:01   PROVISIONAL   27,600
15:02   INCOMPLETE    cannot be stated
```

Nothing mystical happened to the stock at 15:02. New evidence arrived and showed that the earlier answer was less certain than it looked.

Historical inventory evidence can be queried by knowledge time. Current source-feed health is deliberately not pushed backwards into historical answers because this demo schema does not keep a full history of feed-status changes. Better a stated limit than a fake time machine.

## How it plugs into a real system

The engine does not know about Supabase, table names, Shopify, an ERP, somebody's heroic spreadsheet, or anything else upstream.

```text
existing stock system
        |
        v
     adapter
        |
        v
 StockTruth engine
        |
        +--> quantity or refusal
        +--> state
        +--> reasons
        +--> evidence used
        +--> what would clear the problem
```

An adapter translates the customer's records into a few plain evidence shapes: items, book snapshots, physical counts, movements and source health.

That keeps the bespoke work at the edge. A different customer gets a different adapter; the reconciliation rules stay put.

`packages/engine` has no database dependency. The Postgres adapter lives in `apps/web/lib/adapters/postgres.ts`, and the test suite also drives the same engine with an in-memory adapter made from arrays.

## What it refuses to guess

A few rules are deliberately boring:

- `0` is a real count. It is not blank and it is not missing.
- Unknown is not zero.
- A physical count is evidence; a book quantity is a claim from another system.
- A unit mismatch is not quietly converted without an agreed conversion rule.
- Duplicate-looking movements are not silently merged.
- Fuzzy item matches may raise a question but never attach stock automatically.
- Corrections and reversals keep the original record visible.
- The expected quantity is withheld during a blind count.
- A blocking reason means no derived quantity. No exceptions hidden in the UI.

## States

| State | Meaning |
|---|---|
| `VERIFIED` | The available evidence supports a current position. |
| `PROVISIONAL` | A position can be derived, but there is a non-blocking caveat. |
| `STALE` | The last physical evidence is too old for policy. |
| `INCOMPLETE` | Something needed to produce one defensible answer is missing. |
| `CONFLICT` | The evidence contradicts itself or the item's identity is unsafe. |
| `UNVERIFIED` | Nobody has physically counted it yet. |

Stock status and evidence quality are separate ideas. A green-looking dashboard should not be able to turn missing evidence into confidence by CSS.

## Repository

```text
packages/engine/       database-free reconciliation engine
apps/web/              Next.js demo app
apps/web/lib/adapters/ Postgres implementation of the engine port
supabase/migrations/   schema and RLS
supabase/seed.sql      invented brewery data with deliberate faults
docs/decisions/        short notes on the decisions that are easy to get wrong
```

The seed company, **Northgate Brewing Co.**, is entirely fictional. The bad data is intentional.

## Run it

Requirements: Node.js 22+ and a blank Supabase project.

```bash
npm install
npm test
npm run typecheck
```

Apply the SQL migrations in order, then `supabase/seed.sql`.

Copy `apps/web/.env.example` to `apps/web/.env.local`, then set:

```text
DATABASE_URL=...
DEMO_USER_ID=11111111-1111-4111-8111-000000000001
```

For local development, copy the **Session pooler** URI from Supabase. For Vercel, use the **Transaction pooler** URI and add `sslmode=require`. Do not invent the pooler hostname; copy the whole URI from Supabase's Connect panel.

Then:

```bash
npm run dev
```

The useful CLI checks are:

```bash
npm run reconcile
npm run explain -- PKG-CAN-440
```

`explain.ts` shows the late-delivery example from the actual database records, including the answer a minute before the late evidence arrived.

## Tests

There are 53 engine tests covering the boring cases that usually become expensive later: zero counts, stale evidence, late-arriving movements, duplicate suspicion, reversals, corrections, unit conflicts, historical knowledge queries, deterministic explanations and the rule that every refusal must have a blocking reason.

The engine package also has an isolation test which fails if executable engine code starts importing host/database concerns.

## Deliberate limits in v0.1.1

This is a portfolio/demo build, not a finished inventory product.

It does not yet include real Supabase Auth, offline counts, photo evidence, a staged import UI, multi-site operations or billing. Catalogue/configuration edits are not fully versioned historically. Source-feed freshness is therefore evaluated only for current reconciliation, not historical knowledge queries.

Those are missing features. They are not silently pretended to exist.
