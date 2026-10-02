# ADR 0026 — a source can vouch for its own event ids, and a person can answer what an API cannot see

## Two decisions, one release

### 1. `uniqueIdGuaranteed`

Decision 0024 treats two movements of the same type, unit and quantity within
five minutes as a suspected double posting, and refuses exact arithmetic. That is
right for a hand-keyed ledger. It is wrong for Shopify, where every fulfilment,
refund line and transfer shipment has its own immutable id, and two orders of two
units a minute apart are simply two shipments. Run against a busy demo store the
rule refused most fast-moving SKUs for no reason.

A movement may now carry `uniqueIdGuaranteed: true`. The duplicate detector skips
a pair only when both rows carry it and both come from the same, named source.
The guarantee does not reach across sources, does not apply to a row without it,
and does not apply to a source with no id. Clustering was rewritten as
union-find over linked pairs, so a chain a, b, c still groups as one.

The Shopify adapter sets the flag and throws if any movement id appears twice in
a snapshot, because overlapping pages would make the guarantee false.

### 2. Answers are evidence, marked as such

`BOOK_GAP_UNATTRIBUTABLE` and `ADJUSTMENT_IN_INTERVAL` are refusals a person can
often clear: they can read an inventory history, or ask the warehouse. The drop-in
accepts three answers (nothing was changed; N units were added or removed; this
adjustment went in, out, or nowhere).

An answer never edits a result. It changes the input: a location's feed is
declared complete, a reported change is passed in as an interval adjustment, or an
adjustment's direction is set or the row removed. The engine then runs again, so
every consequence follows from the rules already in force.

### 3. A change with no time is not given one

"Fourteen units were added by hand" is a fact about an interval, not an instant.
A first version put such an answer into the movement list at the midpoint between
the count and the book. The arithmetic came out the same, but the timeline then
showed "your answer" at a time nobody had said, and a fabricated movement could
also be mistaken for a duplicate of a real one of the same size.

`ReconciliationInput.intervalAdjustments` carries a signed quantity and an id and
nothing else. When the book is newer than the count it is added to the derived
position and to the gap, and is listed in `evidence.intervalAdjustmentIds`, not in
`movementIds`. It never enters movement or duplicate logic. With no newer book
there is no interval for it to belong to, so it blocks
(`INTERVAL_ADJUSTMENT_UNPLACEABLE`); zero and non-finite values block the same way.
The drop-in draws it as a span over the interval with a dashed step off the end of
the line, and the evidence pack says "exact time unknown; known to have occurred
within the comparison interval". A "no changes" answer
clears only the blocker it addresses; a refusal with another cause stays refused
(tested).

Every row an answer touched is marked "on your word". The evidence pack lists the
answers with the note given, and says they were entered by the person preparing
it and not verified.

## Why

Refusal is only useful if it can be resolved by the person who can resolve it.
Making the answer an explicit, attributable, reversible input keeps the engine's
rule intact: it never states a number the evidence does not support, and the
evidence now includes what somebody has said.

## Limits

An answer is a claim. A wrong "nothing was changed" turns a refused gap into a
stated one. The marking and the pack are the safeguard; the engine cannot check
the claim.
