# ADR 0023 — Direction belongs in movement type, and business identity must be unique

Status: accepted in v0.4.5.

## Context

A source adapter can be syntactically valid while still carrying evidence that has no safe physical interpretation. Three examples exposed the boundary: a negative receipt, a generic adjustment with no direction, and two items sharing the same SKU. Arithmetic can produce numbers for all three; that does not make those numbers defensible.

## Decision

1. Movement quantity is a non-negative magnitude. Direction is expressed only by an explicit movement type. Adapters should reject negative quantities, and the engine repeats the validation independently.
2. `ADJUST` is not assigned a physical sign by reconciliation. An adapter that knows the real direction must map the source event to an explicit receipt/issue/transfer/return/waste movement. Otherwise the position is withheld.
3. A business code used as identity must resolve to one item. Duplicate CSV SKUs mark every owner ambiguous and the engine refuses both scopes.
4. Site-wide data-health findings may affect each result while still being presented once at site level in the work queue.

## Consequence

The adapter boundary is not trusted merely because parsing succeeded. Evidence must be semantically safe before it is allowed to become stock arithmetic.
