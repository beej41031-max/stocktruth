# v0.5.2 — positioning cleanup, no functional change

Docs and framing pass only, no code or test changes. The product's own
description had drifted toward one narrow scenario ("a manufacturer that does
not record issues to production") left over from an earlier stage of the
project, before the Shopify/3PL direction existed. Reworded in the README and
in decision 0015 to describe the underlying measurement problem directly,
without anchoring it to one kind of business. The engine and adapters are
unchanged; all 180 tests still pass.

---

# v0.5.1 — Shopify adapter fixes from the dev-store validation

The 24 September dev-store validation checked the adapter's assumptions
against a real store. The engine needed no change. The adapter needed four:

- **Transfers are read.** Shipped units are a TRANSFER_OUT at the origin;
  accepted units a TRANSFER_IN at the destination; rejected units a finding;
  drafts and ready-to-ship holds nothing. Before this, every transfer out of
  the 3PL showed as an unexplained gap.
- **3PL comparison basis.** Shopify's on-hand includes damaged and
  quality-control stock; many 3PL reports do not. `threePlBasis: 'sellable'`
  compares on sellable stock, and an on-hand comparison flags likely mismatches.
- **Fulfilment-service locations.** Locations are read with `includeLegacy`.
- **Setup docs:** the transfer scopes, and protected customer data (lowest tier).

- **Receipt timing is tested, not just argued.** Shopify dates only a
  shipment's first receipt. A partial receipt in one batch (the validation's
  step 8) reconciles exactly; a receipt in two batches either side of the 3PL
  report is refused with the gap reported, never stated as agreement.

Adapter tests: 46/46. Engine unchanged at 128/128.

---

# v0.5.0 — Shopify, and the book is not always older than the count

## Engine

- **Fixed:** a book newer than the count was compared to it across time, so
  movements between them read as variance. Against a live platform this
  reported a day's net sales as a VERIFIED discrepancy. The count is now carried
  forward to the book's moment first (decision 0025). The original behaviour is
  reproduced in `test/newer-book.test.ts`.
- **New:** `movementFeedComplete` on a scope. False adds `MOVEMENT_FEED_PARTIAL`
  (caveat) and, when a newer book disagrees with the evidence,
  `BOOK_GAP_UNATTRIBUTABLE` (blocks, gap still reported).
- `ADJUSTMENT_IN_INTERVAL` now names the adjustments in its resolution.
- Short record references handle path-style ids (`gid://shopify/Thing/123`).

## Shopify adapter

New package `packages/adapter-shopify`: read-only GraphQL client (mutations
refused in code, throttle-aware, page size halves on cost errors, Dev Dashboard
client credentials or a legacy token), snapshot fetcher, 3PL report parser,
and the mapping from Shopify records to evidence. Demo store and 34 tests.

## Verification

In the packaging environment: engine 128/128, CSV adapter 6/6, Shopify adapter
34/34, typecheck clean across all workspaces, all three demos run.

The Shopify adapter has been tested against recorded and scripted responses,
not yet against a live store.

---

# v0.4.6 — duplicate evidence cannot become material loss

The AdventureWorks manufacturing run exposed one remaining correctness gap: a duplicated receipt could be counted twice as inbound stock and later appear as missing material while the interval still said `CLOSED`. v0.4.6 moves duplicate detection into shared movement-evidence logic and makes duplicate ambiguity a hard boundary wherever exact arithmetic depends on it.

## Fixed

- duplicate detection is now shared by reconciliation and material variance rather than being a private reconciliation heuristic
- candidate grouping is exact on movement type + unit + non-zero quantity within a five-minute event-time window; source is intentionally not part of the signature so cross-connector duplicates are still visible
- grouping is shape-based rather than adjacency-based, so an unrelated movement interleaved between two duplicate candidates cannot hide them
- valid reversal chains are normalised before duplicate detection and therefore never become false duplicate warnings
- a suspected duplicate affecting the post-count window makes the current position `INCOMPLETE` with no derived quantity or movement net
- the operational decision layer treats duplicate evidence as unbounded and refuses allocation/purchase/finance guidance rather than laundering it into a range
- a suspected duplicate touching `(opening count, closing count]` makes material variance `INCOMPLETE`; actual consumption, theory, variance quantity and variance cost remain null
- duplicate detection is run against the full evidence set before interval selection, so a duplicate pair straddling a count boundary still blocks the interval
- duplicate-looking rows wholly outside the relevant arithmetic window do not poison that result; a later physical count can legitimately absorb earlier ledger ambiguity
- duplicate ambiguity wholly before the latest physical count does not block the current position, but it explicitly suppresses the historical book-to-count variance with `BOOK_WINDOW_DUPLICATE_MOVEMENT`
- zero-quantity duplicate rows do not block because they cannot change stock
- variance evidence now records the suspected duplicate movement ids for review
- the stress harness contains an explicit duplicate-receipt probe so phantom inbound stock can never regress into a closed material loss unnoticed

## Schema

No database migration is added. The schema remains at migration 0014.

## Verification

The v0.4.6 engine suite contains **118 tests**. In the packaging environment, all **118/118** passed (including the nine source/isolation assertions) using Node's type-stripping test harness, and strict TypeScript checking of the pure engine source passed. The full workspace gate still belongs on the target machine because this environment could not complete the locked npm install.

Run the normal release gate:

```powershell
npm ci
npm run verify
```

The v0.4.5 baseline was independently validated with 109/109 engine tests, 6/6 CSV tests, strict typecheck, both demos and a clean Next build after removal of packaging-only generated JavaScript.

---

# v0.4.5 — input boundary hardened

v0.4.4 completed the evidence/closure model. v0.4.5 does not change that model; it closes three places where malformed or semantically ambiguous source rows could still be turned into confident-looking stock numbers.

## Fixed

- **Negative movement quantities are invalid evidence.** Quantity is magnitude; movement type carries direction. `reconcile` now returns `CONFLICT`, no derived quantity and `MOVEMENT_QUANTITY_INVALID` for any negative or non-finite movement. The operational-range layer refuses the same evidence. The CSV adapter rejects negative movement quantity at import. Postgres already enforced `quantity >= 0`.
- **Bare `ADJUST` no longer means plus.** An adjustment after the physical count now raises `ADJUSTMENT_IN_INTERVAL`, is excluded from arithmetic and makes the current position `INCOMPLETE`. The operational layer also refuses an ambiguous spanning adjustment. Material variance already had the same refusal rule.
- **Duplicate CSV SKUs now become identity ambiguity.** Every active output scope whose code has another owner is marked `identityAmbiguous`, producing `AMBIGUOUS_ITEM_IDENTITY`/`CONFLICT` rather than two plausible numbers under one business code. Matching is case-insensitive after trimming.
- **Site-wide unmatched-movement work is de-duplicated.** The engine still carries the site-health caveat on results, but the persistent issue queue stores one site-wide `UNMATCHED_MOVEMENTS_AT_SITE` row rather than repeating it for every item/location.

## Regression coverage

The engine suite is now **109 tests** in the normal release gate: the prior 105 plus four input-boundary/operational regressions. The CSV suite is now **6 tests**: the prior three plus negative movement rejection, duplicate-SKU ambiguity and an explicit stale/inactive-output case.

The completed v0.4.5 release was subsequently validated on the target machine. An initial packaging-only failure exposed 11 generated CommonJS `.js` files beside the TypeScript engine sources; those files were removed and `packages/engine/src/*.js` is now ignored so the harness cannot contaminate a release again. With that packaging defect removed, `npm ci` and `npm run verify` passed cleanly with **109/109 engine tests**, **6/6 CSV tests**, strict typecheck, both demos and a successful Next.js production build. The negative-movement, bare-adjustment and ambiguous-identity probes also produced the intended refusal states.

The previous v0.4.4 release was fully validated on the target machine: `npm ci` and `npm run verify` passed with **105/105 engine tests**, **3/3 CSV tests**, strict typecheck, both demos and a clean Next build; all 14 migrations plus seed also applied cleanly on PostgreSQL 16.

For a fresh deployment, the normal gate remains:

```powershell
npm ci
npm run verify
```

No database migration is added in v0.4.5. The schema remains at migration 0014.

---

# v0.4.4 — late evidence can be reviewed without rewriting history

v0.4.3 made late evidence permanently visible. v0.4.4 adds the missing operational recovery path: an owner/manager can inspect a late automated correction and re-close the affected repeat-count interval while preserving the source's original bad completeness claim and the material-variance result on both sides of the review.

## Added

- append-only `automated_evidence_reviews`, scoped to one closing count line, evidence kind and automated source
- owner/manager review RPCs; the review table has no direct authenticated write policy
- review records original watermark/claim, accepted import-time cutoff, reviewer, note and evidence count
- pre-review and post-review `material_variance_runs` are linked to the review so the margin figure before and after remains in history
- the variance UI surfaces late automated evidence as an explicit review/re-close action
- future evidence imported after the reviewed cutoff reopens the interval again
- authenticated count-line inserts have `received_at` overwritten by Postgres `now()`, closing the handset clock-skew bypass
- `count_lines_insert` now qualifies target-table columns so its RLS expression means what it says
- regression coverage for reviewed closure and re-opening after a second late arrival

## Deliberate conservative choice

A configured automated source that has never delivered a movement/production row at the site is not automatically treated as a required stream. `source_systems` does not currently declare which evidence domains a connector owns, so requiring every configured connector for every stream would create false permanent provisional states. Once a source delivers that evidence kind, it becomes part of the required closure set.

## Verification record

The v0.4.3 baseline was independently run through the complete target-machine gate: `npm ci` and `npm run verify` passed with **102/102 engine tests**, **3/3 CSV tests**, strict typecheck, both demos and a clean Next build. All 13 v0.4.3 migrations plus seed also applied cleanly on PostgreSQL 16, and direct counter attacks against attestation and completed count evidence were refused.

This v0.4.4 package adds migration `0014_automated_evidence_review.sql` and 3 engine regressions, bringing the normal engine suite to **105 tests**. The completed release was subsequently run through the full target-machine gate: `npm ci` and `npm run verify` both passed cleanly with **105/105 engine tests**, **3/3 CSV tests**, strict typecheck, both demos and a clean Next.js build. All **14 migrations plus seed** also applied cleanly on PostgreSQL 16. Direct database checks confirmed that client-supplied `received_at` is overwritten by Postgres, signed-in users cannot forge `automated_evidence_reviews` around the review RPC, and the review flow preserves the pre-review variance run, links the post-review run, and reopens again when later evidence arrives. `npm run verify:db` remains the live Supabase/RLS deployment gate for an environment with the migrations applied.

---

# v0.4.3 — history cannot be rewritten by the next sync

This release closes the remaining loopholes in the v0.4.2 closure model. The governing rule is now: **a completeness claim is historical evidence, not mutable connector state.**

## Release blockers fixed

- **Backdated imports reopen closure.** `imported_at` is the StockTruth knowledge clock for movement and production evidence. A source row dated earlier but imported after a completeness claim is late evidence; source `recorded_at` remains provenance, not a way to backdate what StockTruth knew.
- **Automated watermark claims are append-only.** `source_watermark_history` records every connector completeness claim. Historical intervals use the *first* claim that crossed their closing cutoff, so the next sync cannot quietly make a previously late row timely again.
- **Attestation security lives in Postgres.** Counters cannot write attestation fields, pre-seed attestation on a fresh session, create already-completed sessions, delete count sessions, append to completed sessions, or rewrite count quantities/timestamps through direct API access. Completed count lines are immutable; an open-session line update may only flip `superseded` from false to true.

## Additional hardening

- initial connector watermarks receive a real claim timestamp and history row immediately rather than waiting for the first advance
- manual attestation uses the latest server `received_at` as the trusted evidence cutoff; the device `counted_at` remains the physical observation time and is shown separately
- owner/manager attestation timestamps and actor IDs are normalised by a database trigger, not trusted from client-supplied columns
- the regression suite now locks the valid case where a reversal inside an interval cancels an original movement before the opening count
- historical location allocation remains conservative: an old second-location observation can still keep theory `ACTUAL_ONLY` until allocation history is modelled explicitly
- promptly uploaded count lines whose device clock exceeds the site `max_clock_skew_minutes` policy now refuse a material-variance interval; genuinely offline uploads remain valid
- standalone `seed.sql` now follows the guarded lifecycle (`open` → count lines → `completed`) so it remains usable after all migrations are applied

## Schema migration

Apply `supabase/migrations/0013_historical_closure_and_db_guards.sql` after 0012. It creates the append-only watermark history and database mutation guards. Fresh demo installs include the same migration in `supabase/demo-setup.sql`.

## Verification in this packaging environment

The engine compiles under strict TypeScript. An independent CommonJS harness executes **93/93 non-isolation engine tests successfully**; the normal engine suite now contains **102 tests total**, with the remaining nine being the existing ESM/source-isolation assertions. The release still requires the normal target-machine gate before deployment:

```bash
npm ci
npm run verify
npm run verify:db
```

---

# v0.4.2 — closure has to be earned

This release hardens the evidence-closure model after adversarial review of v0.4.1. The core rule is stricter now: **closing the physical count is not the same thing as proving the paperwork has caught up.**

## Release blockers fixed

- **Count closure and evidence attestation are separate workflows.** A counter closes the physical session only. A later owner/manager action can certify manual movements and/or production records through the frozen physical count cutoff; it never certifies through `now()`.
- **Human attestation cannot outrun an automated feed.** Manual confirmation satisfies only the manual side of a stream. Automated sources retain their own event-time watermarks, and mixed-source closure uses the earliest required event-time cutoff.
- **Reversal chains are parity-safe.** Original → reversal cancels; reversal-of-reversal reinstates the original. Orphan, malformed, branching/double-reversal and cyclic graphs refuse the interval instead of silently deleting evidence.
- **Late evidence reopens history.** Completeness now carries a knowledge timestamp. A movement or production row learned after the closure assertion makes the affected interval non-closed again.

## Additional hardening

- operational lower bounds are clamped at zero, so guidance can never recommend allocating a negative quantity
- priced and unpriced verification candidates are ranked in separate domains; known £ exposure ranks ahead of raw unit counts
- the verification score now names unsettled material variance explicitly instead of disguising it as generic uncertainty
- closed count sessions refuse additional count lines, keeping the physical cutoff stable after closure
- automated watermark knowledge time is stamped by the database whenever a connector advances its event-time watermark
- the v0.4.1 target-machine verification record is corrected below: the complete gate subsequently passed cleanly

## Evidence-closure semantics

For each evidence stream StockTruth tracks two different dates:

```text
through       how far through physical/event time the source claims completeness
claimed_at    when StockTruth learned that completeness claim
```

For mixed automated + manual evidence, both must close. `through` resolves to the earlier required cutoff; the combined claim does not exist until the last required claim has arrived. Evidence whose knowledge time is later than that closure assertion reopens the interval.

## Verification

The completed v0.4.2 release was subsequently run through the full target-machine gate: `npm ci` and `npm run verify` both passed cleanly with **93/93 engine tests**, **3/3 CSV tests**, strict typecheck, both demos and the optimised Next.js build.

`npm run verify:db` remains the live database/RLS gate for an environment with the migrations applied.

The material-variance headline remains deliberately conservative: if physical cutoff, movement closure, production closure, reversal structure, unit compatibility or location allocation cannot be defended, StockTruth withholds the margin claim.

### Known conservative edge

`theoryScopeComplete` still derives location ambiguity from historical observed scopes. An old stray movement at a second location can therefore keep an item `ACTUAL_ONLY` until location-allocation history is modelled explicitly. This release prefers that false refusal to duplicated site-wide BOM theory.

---

# v0.4.1 — safety before margin

This is the hardening release for the material-variance turn introduced in v0.4.0. The product rule is now explicit: **a plausible number is not allowed to outrank incomplete evidence.**

## Release blockers fixed

- **Independent operational bounds.** Opposing spanning movements no longer net to a false exact result. Each positive ambiguity expands the upper bound; each negative ambiguity expands the lower bound.
- **Reversal-safe variance.** A valid movement and its linked `reversalOfId` correction are removed as a pair before interval arithmetic. Missing or malformed reversal pairs block the interval instead of being guessed away.
- **Separate production closure.** Production output has its own watermark. Actual physical use can still be shown when production is unsettled, but theoretical use, variance and £ impact remain null and the interval cannot be `CLOSED`.
- **No duplicated theory across locations.** Site-wide production is never charged once per storage location. Until a defensible allocation exists, multi-location material intervals are `ACTUAL_ONLY` rather than confidently wrong.
- **Manual shops can close honestly.** Finishing a count session can explicitly attest that external movements and/or production output are complete through the cutoff. These are independent, audited assertions; no configured sync is required and no missing feed is treated as proof.
- **Production output units are checked.** Output in cases cannot silently hit a BOM expressed per each; theory is withheld on mismatch.
- **Privileged web reads are controlled.** The old page-level raw-pool drift is replaced by `withSiteService()`, which proves site access under RLS before entering the privileged engine/adapter path.

## Additional hardening

- latest count intervals must come from distinct count sessions
- uncosted materials remain eligible for verification priority rather than disappearing at score zero
- provisional variance is no longer mislabeled as quantity uncertainty
- interval cutoff is explicitly documented as `(opening, closing]`
- missing `recorded_at` falls back to `imported_at` for knowledge-time/late-event checks
- the variance UI separates quantified provisional exposure from unquantified intervals; unavailable theory never renders as £0 loss
- the stress harness now probes `assessOperationalPosition()` and `analyseMaterialVariance()` as well as the base reconciler
- autoprefixer warning fixed by using `flex-end`

## Verification

The packaging environment could not run the normal npm workspace gate, but the completed v0.4.1 release was subsequently verified on the target machine: `npm ci` and `npm run verify` both passed cleanly with **81/81 engine tests**, **3/3 CSV tests**, strict typecheck, both demos and the optimised Next.js build. The prior autoprefixer warning was also gone.

`npm run verify:db` remains the database/RLS deployment gate for an environment with Supabase available.

The release remains intentionally conservative: if a production feed, unit, reversal, location allocation or cutoff cannot be defended, the margin figure is withheld.

---

# v0.4.0 — the second count is the product

This release turns StockTruth from a stock-integrity reference implementation into a repeat-count material-variance system for small manufacturers.

## Product shift

A physical count is no longer treated mainly as an opening balance to carry forward. Two successive counts of the same item/location close a measurement interval:

```text
actual use = count₁ + receipts + transfers in + returns in - transfers out - count₂
```

Production output × the BOM version effective at completion time gives theoretical use. The difference is preserved as material variance and, where unit cost exists, translated into money.

A later ledger adjustment may fix today's balance. It does not erase the historical variance event.

## Added

- deterministic `analyseMaterialVariance()` engine
- repeat-count interval states: `CLOSED`, `PROVISIONAL`, `ACTUAL_ONLY`, `INCOMPLETE`, `CONFLICT`
- event-time source watermark separate from connector `last_success_at`
- effective-dated products, BOM versions and BOM lines
- production-output evidence with occurrence and knowledge time
- standard unit cost and per-item target count cadence
- append-only material-variance run/result schema
- `/variance` owner view: actual use, theoretical use, quantity variance, percentage and cost
- economic-exposure verification queue
- deterministic operational layer for bounded uncertainty
- directional omitted-stock vs phantom-stock exposure
- decision guidance for allocation, customer promise, production, purchasing and finance
- operational-range panel on item pages
- canonical late-receipt demo now shows a safe bounded operating range without weakening the underlying `INCOMPLETE` truth state
- ADRs documenting repeat-count intervals, event watermarks and decision-specific adequacy

## Demo interval

The synthetic brewery now contains a second packaging count, a production output and an effective BOM. The demo therefore proves the new chain end-to-end rather than presenting a mocked variance card.

## Verification in this packaging environment

- engine source compiled cleanly with TypeScript 5.8.3
- all 69 engine tests passed: reconciliation, explanation, material variance, operational guidance and the 9 pre-existing isolation assertions
- all 3 CSV adapter regression tests passed against the same 0.4.0 engine
- changed web/server files passed a strict TypeScript check using local dependency stubs because a fresh npm registry install was unavailable in the packaging environment
- new pure-engine smoke cases produced:
  - `10,310` actual consumption
  - `9,740` theoretical consumption
  - `570` adverse quantity variance
  - `£2,451` adverse value at £4.30/unit
  - bounded late-receipt range `27,600–36,000`, with allocation limited to `27,600`

Run the normal target-machine release gate before deployment:

```bash
npm ci
npm run verify
npm run verify:db
```

# v0.3.1 — audit RLS hotfix

Fixes user-driven issue resolution being rolled back when its append-only audit record was rejected by row-level security.

The new policy permits an authenticated user to INSERT an audit row only when:
- `actor_type = 'user'`;
- `actor_user_id = auth.uid()`;
- the user belongs to the organisation;
- any supplied site belongs to that organisation and is accessible to the user.

UPDATE and DELETE remain forbidden by the append-only audit triggers.

`npm run verify:db` tests this exact authenticated audit-insert path inside a transaction and rolls it back.
