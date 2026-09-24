# 0018 · Variance safety boundaries

## Status
Accepted in v0.4.1.

**Superseded in part by ADR 0020:** evidence completeness is no longer attested when the counter closes a session; manual evidence closure is a separate later office/owner action.

## Context
Material variance is more commercially useful than inventory accuracy only if a
number labelled `CLOSED` is harder to make wrong than it is to make blank.
Several superficially reasonable shortcuts violated that rule: netting opposing
ambiguous movements into a zero-width range, treating corrective reversals as
physical flow, assuming missing production meant zero production, allocating a
site-wide BOM theory independently to every storage location, and treating a
manual source with no sync clock as permanently unknowable.

## Decision

1. **Ambiguous movements are bounded independently.** Positive spanning flow
   expands the upper bound; negative spanning flow expands the lower bound.
   Opposite signs do not cancel uncertainty.
2. **Linked reversal pairs are corrections, not consumption.** Both halves are
   removed before material-flow arithmetic. An orphan reversal blocks the
   interval because its physical meaning is incomplete.
3. **Movement and production completeness are independent timelines.** A closed
   movement feed cannot prove that production output is complete. Theory is not
   stated until the production watermark reaches the closing observation.
4. **Manual evidence can close only by explicit attestation.** Closing a count
   session can separately confirm external movements and production output
   complete through that cutoff. The assertion is stored and audited.
5. **Site-wide production is never duplicated across locations.** Until the
   model can allocate production use to storage locations, a material observed
   in more than one location is `ACTUAL_ONLY` at location level; no costed
   variance is put in the owner headline.
6. **Production output units must match the product output unit.** Case-versus-
   each mismatches refuse theory rather than silently scaling it.
7. **Intervals use `(opening, closing]`.** An event exactly at opening is assumed
   embodied in the opening observation; an event exactly at close is included
   immediately before the closing observation.
8. **Two counts from the same count session do not form a variance interval.**
   The loader pairs the latest observations from distinct sessions.

## Consequence
A missing conclusion is acceptable. A plausible but unjustified margin-loss
number is not. The owner dashboard only totals `CLOSED` intervals.
