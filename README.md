# StockTruth

**Know what stock you have. Know why you believe it.**

A stock verification system for businesses that already have records and do not
fully trust them. Not an ERP, and not an inventory spreadsheet with a nicer
dashboard.

One rule, everywhere: **never turn incomplete evidence into false certainty.**
When the system cannot justify a number it says so, says why, names the records
involved, and says what would settle it.

---

## The case it was built for

```
Can 440ml unprinted                                          PKG-CAN-440

  Book says            19,200     as at 22 Aug
  Somebody counted     27,600     14 Sep, 12:02, packaging bay
  On the shelf now     cannot be stated

  Why:
    M000004, 8400 each, arrived 2026-09-14T11:02Z but was not recorded
    until 4 hours later. Count C000005 was taken at 12:02Z, in between.
    So that delivery may or may not have been on the shelf when the
    counter looked, and applying it would double-count while ignoring it
    would undercount.

    Ask whoever received the delivery or whoever counted, and record the
    answer as a correcting movement. Or count PKG-CAN-440 again now,
    which settles it without anyone having to remember.
```

Most inventory software prints 36,000 here and is confidently wrong by 8,400.

## Knowledge can go backwards

Ask the same item what was known before that delivery note arrived:

```
As known at 2026-09-14T15:01Z    PROVISIONAL       27,600
As known now                     cannot be stated
```

At 15:01 the count stood on its own and 27,600 was defensible. At 15:02 a
delivery note arrived that could not be placed relative to the count, and the
number had to be withdrawn.

More evidence does not always mean more certainty. Sometimes it reveals an
ambiguity that was there all along and nobody could see. A system that only
ever gets more confident is not modelling knowledge, it is modelling optimism.

---

## Shape

```
packages/engine/       the reasoning. No database, no schema, no dependencies
apps/web/              Next.js on Vercel, Supabase Postgres
  lib/adapters/        the Postgres adapter, one implementation of the port
supabase/migrations/   schema, one concern per file, append-only
docs/decisions/        why the awkward choices are the way they are
```

The engine is a package. It takes plain evidence shapes and returns a
conclusion. Hosts implement `EvidenceSource` from `packages/engine/src/ports.ts`,
so a different company's inventory system can be fed through an adapter without
touching any of the reasoning.

That separation is enforced rather than intended: a test reads every file in the
engine and fails if one imports anything outside the package or mentions a
host's vocabulary in executable code. A second adapter made entirely of arrays
drives the engine through all six states with no database involved, which is the
cleanest proof the boundary is real.

## The stress test

`npm run stress -- --items=10000 --movements=8` generates a seeded adversarial
warehouse, loads it through the real Postgres adapter, reconciles every scope
with the real engine, and checks the refusal invariant on each one. Last real
run: 18,562 scopes, 74,801 evidence rows, **zero invariant failures**,
43,969 scopes per second. `/stress` renders the committed result.

The 53 unit tests isolate one defect each. This throws every defect class the
engine knows about at once, in combinations nobody chose, at a scale nobody is
going to hand-check.

## Running it

```bash
npm install

# schema, then demo data
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
psql "$DATABASE_URL" -f supabase/seed.sql

npm test                                       # 53 engine tests
cd apps/web
npx tsx scripts/reconcile.ts                   # run the engine over a site
npx tsx scripts/explain.ts PKG-CAN-440         # prove a refusal from the records
npm run dev
```

`DATABASE_URL` is required. `DEMO_USER_ID` stands in for auth locally.

## The engine

Six states:

| | |
|---|---|
| `VERIFIED` | evidence supports a current position |
| `PROVISIONAL` | derivable, with something non-critical noted |
| `STALE` | the count is older than policy allows |
| `INCOMPLETE` | required evidence missing, no position claimed |
| `CONFLICT` | evidence contradicts itself |
| `UNVERIFIED` | never physically counted |

Two numbers, separately answerable and both nullable:

- **derived quantity** — what is on the shelf now, anchored on the count
- **variance at count** — how wrong the records were when somebody last looked,
  computed only when the book can be carried forward without assuming anything

A position is refused **if and only if** a blocking reason is present.
`explain()` asserts that in both directions on every call and throws if it ever
stops holding, so the rule cannot rot quietly.

## Things it deliberately does not do

It does not convert units. A book figure in litres against an item held in
drums is refused, because guessing that a case is twenty-four is how a wrong
number gets an authoritative-looking source.

It does not merge duplicate movements. Two identical receipts minutes apart are
usually one delivery keyed twice and occasionally two real deliveries. Merging
the second case loses stock silently, so both are kept and a person is asked.

It does not link movements on a fuzzy code match. Close codes raise a question;
nothing is attached automatically.

It does not show the expected quantity before a count is entered. A count that
was shown the answer is agreement, not evidence. Withheld at the server, not
hidden in the UI.

It does not call a difference a discrepancy. At the rack nobody knows whether a
gap is shrinkage, a late delivery or a bad book figure.

It does not delete. Corrections supersede, movements are reversed by linked
movements, and the audit table refuses updates and deletes at the database.

## Status

V0.1. Schema, engine, adapter port, reconciliation, blind counting, six screens,
audit trail, bitemporal reconstruction.

Not built: the staged CSV import UI (`import_runs` and `import_rows` exist and
are seeded, the screens do not), offline counting, photo evidence, multi-site,
billing.
