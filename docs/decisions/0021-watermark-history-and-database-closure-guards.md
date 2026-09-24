# ADR 0021 — closure claims are historical evidence

Accepted in v0.4.3. This supersedes the mutable-watermark knowledge model in ADR 0020 while preserving its separation of physical count closure from office evidence attestation.

## Context

Two loopholes remained after v0.4.2.

First, source `recorded_at` can be backdated. A row keyed on Monday but uploaded to StockTruth on Thursday was not known on Tuesday, regardless of the date inside the file.

Second, a single `event_watermark_updated_at` is mutable. If a source first claimed completeness through a count cutoff, then delivered a late row, the next normal sync advanced the timestamp and could make that violation disappear from historical evaluation.

The application also cannot be the authority for attestation permissions: a counter using the database API directly must not be able to forge owner/manager evidence closure or rewrite completed count evidence.

## Decision

1. **`imported_at` is StockTruth knowledge time for imported operational evidence.** `recorded_at` remains the source's own bookkeeping timestamp and cannot backdate what StockTruth knew.
2. **Automated completeness claims are append-only.** Every non-null source watermark creation/advance writes `(source, watermark_at, claimed_at)` to `source_watermark_history`.
3. **Historical intervals use the first crossing claim.** For a closing cutoff `C`, each automated source is judged against the earliest claim in knowledge time whose `watermark_at >= C`. Later syncs cannot replace it.
4. **Manual and automated closure remain independent.** Manual attestation never substitutes for an automated source. Every required automated source must have crossed the cutoff itself.
5. **The database owns count immutability.** Postgres rejects count lines inserted into completed sessions, rejects completed-line mutation, and permits an open count-line update only to set `superseded` from false to true.
6. **The database owns attestation authority.** Authenticated attestation-column changes require owner/manager role and a completed session. The trigger stamps actor/time and uses the latest server `received_at` as the trusted evidence cutoff.
7. **Count sessions are not deletable through the authenticated RLS path.** Physical observations are audit evidence, not disposable UI state.
8. **Attestation cannot be smuggled through session creation.** A new session must begin `draft`/`open`, with no completion or attestation fields populated. Closure is always a later transition.
9. **Clock quality gates material variance.** For promptly uploaded counts, device/server skew beyond the site policy makes the interval conflict. Offline uploads remain supported because a long receive delay is not treated as clock skew by itself.

## Consequences

A late import can make confidence go backwards and a later connector sync cannot silently restore it. Re-closing such a historical exception will require an explicit future resolution mechanism rather than passage of time.

Offline counts remain supported. Using server receive time for manual evidence closure is conservative when an offline handset uploads late, and a fast handset clock cannot push the certified evidence cutoff into the future.
