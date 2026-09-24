# ADR 0025 — a book newer than the count is carried to, and a partial feed cannot assign blame

## Decision

**A book newer than the count is compared at the book's moment.** When the host's
figure was taken after the physical observation, the count is carried forward
through the movements between the two, and the variance is

```text
variance = count + net(counted_at, book_as_of] − book
```

using the same sign convention as the older-book case: physical evidence minus
the book, at one shared instant. The window must meet the same conditions as
before (no undated, spanning, possibly-related, duplicate or bare-adjustment
movements), plus one more: no movement may have happened before the book's
moment but been recorded after it, because the book may or may not include it.

**An adapter can declare that its movement feed is incomplete.** Setting
`movementFeedComplete: false` on a scope adds `MOVEMENT_FEED_PARTIAL`, a soft
caveat, so the scope can never be `VERIFIED`. If, in addition, a newer book
disagrees with the carried-forward count, the engine adds
`BOOK_GAP_UNATTRIBUTABLE`, which blocks. The size of the gap is still reported
as `varianceAtCount`; only the current position is withheld.

## Why

The engine was written for hosts whose book is a periodic snapshot older than
the count. A live commerce platform inverts that: its on-hand figure is "now",
and the warehouse report was this morning. v0.4.6 compared the two directly,
so every unit sold between the report and the evening was reported as a
variance, with state `VERIFIED`. A day's net sales of 10 became a verified
10-unit discrepancy. Nothing crashed; it was simply confidently wrong, which is
the failure this product exists to prevent.

The partial-feed rule exists because Shopify's Admin API exposes orders,
fulfilments and refunds but has no query for the history of manual inventory
adjustments. A receipt entered by hand, a cycle-count correction or a change
made by another app is invisible to any reader. When the platform's figure and
the evidence disagree, an unseen receipt and real loss produce the same gap.
Reporting the gap is useful; saying which side is wrong would be a guess.

When the two agree, the result stays `PROVISIONAL`, not `VERIFIED`: unseen
changes that happen to net to zero cannot be ruled out, only made unlikely.

## Consequences

- Hosts with complete feeds are unaffected. The flag defaults to true, and a
  newer book with a complete feed produces a `VERIFIED` position with the
  book's error reported, exactly as an older book always did.
- `BOOK_GAP_UNATTRIBUTABLE` is cleared by identifying the unseen change or by
  a count taken after the latest platform update. Its resolution names the
  count, the book and the gap.
- The engine does not try to guess at invisible movements, and adapters must
  not synthesise them. A future feed that can see adjustments (webhooks
  recorded as they arrive, or an API that exposes them) should set the flag to
  true rather than work around it.
