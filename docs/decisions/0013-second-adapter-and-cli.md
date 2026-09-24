# 13. The boundary is proven by a second adapter and a database-free CLI

## Decision

`packages/cli` runs the engine against a plain JSON evidence file, no
database, no Next.js, one dependency.

`packages/adapter-csv` implements `EvidenceSource` against four flat CSV
files for a different business (an office stationer, not a brewery), with
no code shared with the Postgres adapter beyond the engine package.

## Why

One adapter is a data point, not a proof. `apps/web/lib/adapters/postgres.ts`
shows the port compiles against one specific schema. It does not show the
boundary holds against something that is not a database at all, and it does
not show the reasoning generalises to a business it was not built next to.

Both gaps were named directly in review, and both are now closed by
something that runs, not by an argument that it would.

## What each one is forced to be honest about

The CLI can only do the conversion JSON itself cannot do — ISO strings to
`Date` objects — and nothing else. If it did more than that, it would be
smuggling reasoning outside the engine.

The CSV adapter has to declare `supportsKnownAt = false`, because a flat file
export is one snapshot with no record of when a row arrived versus when it
happened. Rather than fake an answer to a historical question, `asOfKnowledge`
refuses it, structurally, the same way it would for any adapter that admits
the same limit.

## What the CSV example proves, specifically

The same defect class as the brewery's canonical case — a movement that
happened before a count but was recorded after it — appears in the stationer
data as a stock *issue* rather than a *receipt*, and the engine catches it the
same way:

```
ENV-C5-WHT     INCOMPLETE   CANNOT BE STATED
  UNMATCHED_MOVEMENTS_AT_SITE, MOVEMENT_SPANS_COUNT, BOOK_STALE
```

That is the claim "the reasoning generalises" made checkable rather than
asserted.

## A latent bug this pass surfaced

`tsx` transpiles without type-checking, so `npm test` had been green for
several sessions while `packages/engine/test/inmemory.ts` had a real type
error — it imported `ReconciliationPolicy` from `ports.ts`, which used the
type but never re-exported it. Only running `tsc --noEmit` directly, prompted
by wiring up the new packages, caught it. Fixed by having `ports.ts`
re-export the type it appears in, since anyone implementing an adapter needs
it from the same place they get `EvidenceSource`.

Also fixed: the CSS module declaration lived in `next-env.d.ts`, which
Next.js silently regenerates and discards edits to on every build. It had
been quietly re-breaking typecheck each time the project was rebuilt from
this repository. Moved to `types/css.d.ts`, which nothing auto-generates.
