# ADR 0024 — suspected duplicate evidence cannot close exact arithmetic

## Decision

StockTruth never auto-merges two movements merely because they look alike. It also never lets a suspected duplicate participate in an exact current position or a CLOSED material-variance interval.

Duplicate candidates are detected centrally after valid reversal normalisation. Movements are candidates when they have the same movement type, unit and non-zero quantity and their event times are within the configured five-minute evidence window. Source system is deliberately not part of the signature because the same physical event can be duplicated across integrations as well as inside one source.

The detector returns evidence groups; it does not delete rows. Resolution remains an evidence correction: void/correct the duplicate at source, or provide source evidence that makes the events distinguishable.

## Scope rules

A physical count remains an anchor. Therefore duplicate-looking movements wholly before the count do not invalidate a current position: the later count has already observed the physical world after them.

A duplicate group that touches the post-count movement window blocks the current position. A duplicate group that touches a repeat-count interval blocks actual consumption and therefore blocks theoretical comparison, variance quantity and variance cost. The check is made against the full movement set, so a pair straddling an opening/closing boundary cannot hide by landing on opposite sides of the interval filter.

Valid reversal chains are removed before duplicate detection. Zero-quantity rows are ignored because duplicating a no-op cannot alter stock or variance.

## Why

Applying both duplicate candidates can manufacture phantom stock and later turn it into an apparent material loss. Dropping one automatically is equally unsafe because two identical deliveries can be real. The only defensible answer is to expose the ambiguity and refuse exact arithmetic until the evidence is resolved.
