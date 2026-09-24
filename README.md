# StockTruth 0.5.2

**A count is an observation. The second count closes the interval. The gap is margin.**

StockTruth is an event-driven inventory evidence and material-variance engine.
It is designed to sit beside existing ERP, WMS, spreadsheet or SaaS software
rather than replace it.

It now answers two separate questions:

> **What stock position does the evidence support right now?**
>
> **Between two physical observations, how much material did the operation
> actually consume, how much should production have consumed, and what did the
> unexplained gap cost?**

The first question protects operations from confident-looking bad stock numbers.
The second turns repeat counting from inventory admin into a margin-control loop.
Both stay deterministic and auditable: event time and knowledge time remain
separate, null is a legitimate answer, and every conclusion points back to the
evidence that earned it.

## The case it was built around

```text
Can 440ml unprinted                                  PKG-CAN-440

book claim                19,200
physical count            27,600        14 Sep 12:02
receipt occurred          +8,400        14 Sep 11:02
receipt recorded                        14 Sep 15:02

current position          CANNOT BE STATED
```

Applying the receipt risks counting it twice if it was already on the shelf
when the counter looked. Ignoring it risks missing it if it was not. Arithmetic
is not the hard part; chronology is.

Before the late receipt became known, 27,600 was defensible. After the receipt
arrived, confidence went backwards. That is expected: new evidence can reveal
ambiguity that was present all along.

## The second count is the product

Where material consumption is not recorded as it happens, only received and
counted, two physical counts close a measurement interval:

```text
actual material use
  = count₁
  + receipts
  + transfers in
  + returns in
  - transfers out
  - count₂
```

Production output multiplied by the BOM version effective when each run
completed gives theoretical consumption:

```text
material variance = actual use - theoretical use
variance value    = material variance × unit cost
```

The opening count is the cost of entry. The second count produces information
the business did not have before. A later ledger adjustment may correct today's
balance, but it never erases the measured interval.

`/variance` shows the latest defensible interval per material/location, costed closed variance,
separate movement and production closure state, and a verification queue that prioritises economic
exposure rather than simply counting the oldest item first. When production theory is unavailable,
the UI says the exposure is unquantified rather than printing a reassuring £0.

## The reusable boundary

```text
ERP / WMS / SaaS ─┐
Postgres ─────────┼── adapter ── canonical evidence ── reasoning engine
CSV / Sheets ─────┤                                      │
JSON / CLI ───────┘                                      ▼
                                            assert / qualify / refuse
                                                       + why
```

The engine has no database, network or host schema. Hosts implement
`EvidenceSource` and translate their own records into plain evidence shapes.

This repository contains three independent routes into the same reasoning:

- `apps/web/lib/adapters/postgres.ts` — the Supabase/Postgres host used by the UI
- `packages/adapter-csv` — a flat-file snapshot adapter for a different business
- `packages/cli` — JSON in, explanation out, with no database or web framework
- `packages/adapter-shopify` — a live Shopify store checked against a 3PL's stock report, read-only

The CSV adapter deliberately declares `supportsKnownAt = false`: a snapshot
export cannot honestly reconstruct what the business knew last Tuesday. The
boundary records that limitation instead of faking the answer.


## v0.5.0 Shopify, and a book newer than the count

```text
SKU          SHOPIFY  EVIDENCE   GAP   POSITION          STATE
TEE-BLK-M         90        90     0   90                PROVISIONAL
TEE-BLK-L         68        54   -14   CANNOT BE STATED  INCOMPLETE
```

`packages/adapter-shopify` reads a store (read-only, enforced in code) and checks
each variant's on-hand figure against the 3PL's morning stock report, carried
forward through everything Shopify shipped and took back since. `npm run
demo:shopify` runs it against a demo store with one planted problem per SKU.

Building it exposed an engine bug. v0.4.6 assumed the book was older than the
count. A live platform's figure is always newer, and the engine compared the
two across time: a day's net sales of 10 came back as a **VERIFIED** 10-unit
variance. The count is now carried forward to the book's moment before the two
are compared.

Shopify's API also cannot show manual stock adjustments, so an adapter can now
declare its movement feed incomplete. The engine then still reports the size of
a gap but refuses to say which side is wrong: an unseen receipt and real loss
look the same. See `docs/decisions/0025`.

## v0.4.6 duplicate-evidence safety

Duplicate movements are now one shared evidence concern across reconciliation, operational guidance and material variance. StockTruth never auto-merges a suspected duplicate, but it also never lets both rows quietly manufacture an exact number. Duplicate candidates that affect the post-count window block the current position; candidates that touch a count-to-count interval block actual consumption and therefore block CLOSED variance. Valid reversal chains are normalised first, duplicate groups can straddle count boundaries, interleaved rows cannot hide a pair, and zero-quantity no-ops do not block. A later physical count can absorb older duplicate ambiguity for the current position, while the historical book-to-count variance is explicitly withheld.

## v0.4.5 input-boundary safety

The reasoning engine now refuses three kinds of source data that previously looked
plausible enough to calculate through:

- movement quantity is magnitude only. A negative `RECEIVE`, `ISSUE`, transfer,
  return or waste row is invalid evidence and raises `MOVEMENT_QUANTITY_INVALID`;
  the CSV adapter rejects it before the engine and the engine independently
  repeats the check for every adapter
- a bare `ADJUST` has no defensible physical direction. Reconciliation raises
  `ADJUSTMENT_IN_INTERVAL` and withholds the current position rather than treating
  the adjustment as an increase
- duplicate CSV SKUs are marked `identityAmbiguous` on every owning item, so the
  engine returns `AMBIGUOUS_ITEM_IDENTITY` instead of printing separate numbers
  against a business code that cannot identify one product

`UNMATCHED_MOVEMENTS_AT_SITE` remains a site-health caveat in the reasoning, but
the persistent work queue now groups it into one site-wide issue instead of one
copy per stock scope. CSV regression coverage also proves both a real `STALE`
result and the deliberate omission of inactive items from snapshot output.

## v0.4.4 safety boundary

Margin numbers are harder to earn than stock arithmetic. A repeat-count interval
is only allowed to become `CLOSED` when both external-stock movement evidence and
production-output evidence are settled through the closing observation.

The safety rules are deliberate:

- opposing ambiguous movements widen the operating range independently; they are
  never netted into false certainty
- reversal chains are parity-safe: one reversal cancels an event and a reversal
  of that reversal reinstates it; orphan, malformed, branching or cyclic reversal
  graphs refuse the interval
- automated movement and production feeds keep **append-only watermark claim history**; historical intervals use the first claim that crossed their cutoff, so a later sync cannot rewrite an earlier promise
- `imported_at` is StockTruth knowledge time for imported movement/production rows; a backdated source `recorded_at` cannot hide late evidence
- closing a physical count never certifies the paperwork; an owner/manager later
  attests manual evidence through a trusted server-receive cutoff, while the device observation time remains visible separately
- promptly uploaded counts whose device clock exceeds the site skew policy refuse material-variance closure; genuinely offline uploads are not mislabeled as clock skew
- manual attestation can satisfy only manual evidence; it cannot outrun a lagging
  automated connector, and mixed-source closure uses the earliest required cutoff
- evidence imported after the first relevant closure assertion reopens the affected interval; later automated syncs do not silently close it again
- an owner/manager can explicitly review late automated evidence and re-close that exact interval without rewriting the original watermark claim; the pre/post variance runs are retained, and any later correction reopens it again
- Postgres forbids pre-attested/completed count-session inserts, post-close count-line mutation, and counter-written attestation fields even when the app is bypassed
- authenticated count-line inserts cannot choose `received_at`; Postgres stamps server time, so a handset cannot fake an offline delay to evade clock-skew checks
- site-wide production theory is not duplicated across multiple storage
  locations; ambiguous location allocation stays `ACTUAL_ONLY`
- production output units must match the effective BOM output unit
- repeat counts from the same count session are not treated as a measurement
  interval
- interval boundaries are `(opening, closing]`: events at the opening observation
  are embodied in it; events at the closing timestamp belong to the interval
- only `CLOSED` intervals contribute to headline material-variance money
- automated sources become required for a stream once that source has actually delivered evidence at the site; a configured-but-never-seen connector is not assumed to carry movements or production merely from its existence

A ledger adjustment can repair today's record. It cannot erase the historical
physical interval or retroactively turn incomplete evidence into a closed claim.

## What the engine reasons about

- physical observations versus book claims
- `occurred_at` versus source `recorded_at` versus StockTruth `imported_at` knowledge time
- movement ordering around observations
- stale evidence and silent feeds
- duplicate-looking movements without auto-merging them
- reversals without deleting the original event
- ambiguous identities
- unknown or mismatched units
- impossible negative derived positions
- historical **as-known-at** reconstruction where the adapter supports it
- repeat-count interval closure and actual material consumption
- time-effective BOM selection against production output
- independent event-time watermarks for late-arriving movements and production output
- costed material variance that survives later ledger corrections and is reported only when closed
- bounded operational ranges with decision-specific guidance

Six output states are intentionally explicit:

| State | Meaning |
|---|---|
| `VERIFIED` | evidence supports the current position |
| `PROVISIONAL` | derivable, with a non-blocking caveat |
| `STALE` | the observation is older than policy allows |
| `INCOMPLETE` | required evidence is missing |
| `CONFLICT` | evidence contradicts itself |
| `UNVERIFIED` | no physical observation anchors the position |

A blocking state cannot expose a derived quantity. Zero is never used as a
stand-in for unknown.

## Proof, not architecture theatre

`npm run verify` runs the release gate:

1. 109 engine tests, including historical watermark closure, late-evidence review/reopening, backdated-import reopening, reversal-chain safety, count-clock integrity, negative-movement refusal, adjustment refusal, separate production closure, repeat-count variance and decision-adequacy rules
2. 6 CSV adapter tests, including quoted CSV, malformed/negative numeric input, duplicate-SKU ambiguity, stale counts and inactive-item omission
3. strict TypeScript checks for engine, CSV adapter, CLI and web app
4. the CSV demo through the real engine
5. the JSON CLI demo through the real engine
6. an optimised Next.js production build

The stress harness exercises 10,000+ deliberately awkward stock scopes through the production Postgres adapter and also probes the higher decision layers: independent operational bounds, reversal-safe material variance, and refusal to close variance when production evidence is unsettled. `/stress` renders the evidence.

`/system` explains the reusable kernel visually inside the portfolio app.

## Repository

```text
packages/engine/         deterministic reasoning; no database or network
packages/adapter-csv/    second EvidenceSource, flat files only
packages/cli/            portable JSON → assertion interface
apps/web/                Next.js reference application
  lib/adapters/          Postgres EvidenceSource
supabase/migrations/     schema, RLS and append-only audit rules
docs/decisions/          the reasoning behind the awkward choices
```

## Local verification

Requires Node 22.11+.

```bash
npm ci
npm run verify
```

The web app needs:

```text
DATABASE_URL=...
DEMO_USER_ID=11111111-1111-4111-8111-000000000001
```

For a local Supabase connection, the Session pooler on port 5432 is often the
least surprising option. For Vercel, use the Transaction pooler on port 6543.
Do not grant the app direct read access to Supabase's private `auth.users`
table; public UI actor labels are derived from app-owned data instead.

## Fresh Supabase setup

Apply migrations in numeric order, then the synthetic portfolio seed:

```bash
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f supabase/seed.sql
```

Then reconcile once:

```bash
cd apps/web
npx tsx scripts/reconcile.ts
npm run variance
npx tsx scripts/explain.ts PKG-CAN-440
```

Standalone scripts need the environment loaded by the shell; unlike Next.js,
`tsx` does not automatically read `.env.local`.

## Vercel

Import the Git repository as a monorepo project and set the web application as
the project root (`apps/web`). Keep the repository workspace intact — the app
imports `@stocktruth/engine` from `packages/engine` and the Next config traces
from the repository root for server output.

Set these Production environment variables:

```text
DATABASE_URL     Supabase Transaction pooler URL, port 6543
DEMO_USER_ID     11111111-1111-4111-8111-000000000001
```

Before deploying a release, run `npm run verify` at repository root. With the
Supabase environment loaded, also run `npm run verify:db`; it exercises the RLS
entry path and the exact `/reconcile` enum-typed mutation inside a transaction
and rolls it back.

## Deliberate non-features

This is not an ERP and is not trying to become one. It does not implement
purchasing, picking, billing, generic workflow automation or a dashboard
builder. Those belong to the SaaS products around it.

The reusable product is the reasoning boundary plus the repeat-count measurement loop:

> events are claims about change; observations anchor reality; repeat observations
> close measurement intervals; assertions and operating guidance are conclusions the
> evidence earns.

StockTruth is the first concrete proof of that model.
