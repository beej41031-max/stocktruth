# StockTruth 0.3.0

**A total is not a fact. It is a conclusion drawn from evidence.**

StockTruth is the inventory reference implementation of a small event-driven
operational truth engine. It is designed to sit around existing software rather
than replace it.

An ERP, WMS, spreadsheet or SaaS product can keep recording movements and
showing operational screens. StockTruth asks the harder question:

> Given everything currently known — including when it happened, when it was
> recorded, what was physically observed and what evidence is missing — what
> can we actually defend?

Sometimes the answer is a number. Sometimes the honest result is **cannot be
stated**. In either case the engine returns the evidence and reason.

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

The CSV adapter deliberately declares `supportsKnownAt = false`: a snapshot
export cannot honestly reconstruct what the business knew last Tuesday. The
boundary records that limitation instead of faking the answer.

## What the engine reasons about

- physical observations versus book claims
- `occurred_at` versus `recorded_at`
- movement ordering around observations
- stale evidence and silent feeds
- duplicate-looking movements without auto-merging them
- reversals without deleting the original event
- ambiguous identities
- unknown or mismatched units
- impossible negative derived positions
- historical **as-known-at** reconstruction where the adapter supports it

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

1. 53 focused engine tests
2. CSV adapter tests, including quoted CSV and malformed numeric input
3. strict TypeScript checks for engine, CSV adapter, CLI and web app
4. the CSV demo through the real engine
5. the JSON CLI demo through the real engine
6. an optimised Next.js production build

The committed stress report exercises 10,000+ deliberately awkward stock scopes
through the production Postgres adapter and checks the refusal invariant on
every result. `/stress` renders the evidence.

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

The reusable product is the reasoning boundary:

> events are claims about change; observations anchor reality; assertions are
> conclusions the evidence earns.

StockTruth is the first concrete proof of that model.
