# 11. A stress harness proves the invariant, not a benchmark

## Decision

`scripts/stress.ts` generates a large, seeded, deliberately adversarial
warehouse, loads it through the real Postgres adapter, reconciles every scope
with the real engine, and asserts the refusal invariant on each one. The
result is committed as `stress-report.json` and rendered at `/stress`.

## Why

Fifty-three hand-written tests each isolate one defect. That proves the rules
are right for the cases somebody thought to write down. It does not prove the
invariant survives a warehouse where several defects land on the same item at
once, in combinations nobody chose.

The generator does not produce clean data with noise sprinkled on top. Every
defect class the engine knows about — undated movements, movements spanning a
count, duplicate receipts, unit mismatches, blocked identities, shared
barcodes, missing book positions, unlinked movements, stale counts — is
injected on purpose, at a rate high enough that most items carry more than
one.

## What it is not

Not a performance benchmark. The timings are reported because they are true —
43,969 scopes per second on one run — not because speed is the point. A faster
engine that occasionally leaked a quantity on a refused position would be a
worse product than a slower one that never does.

## Honesty about the headline number

The first real run showed `VERIFIED: 0` across 18,562 scopes. That number is
correct and it is explained on the page rather than left to look like a bug:
every unmatched movement caveats the entire site by design (0007), and this
generator always seeds a handful, so nothing at that site can ever be
pristine. Even accounting for that, only 33 scopes were otherwise clean —
the rest carry their own reasons. A stress run that came back mostly
`VERIFIED` would mean the generator was not actually adversarial, and would be
evidence against the harness, not for the engine.
