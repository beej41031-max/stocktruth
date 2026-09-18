# 1. Book, physical and derived are separate records

## Decision

`book_snapshots`, `count_lines`, `movements` and `reconciliation_results` are
four tables. There is no `items.quantity`.

## Why

A book figure is a claim by a source system. A count is an observation. A
movement is an event. A position is a conclusion drawn from the other three.
They are true at different moments, they go stale at different rates, and they
are wrong for different reasons.

One mutable `quantity` field has to pick one of those and throw the rest away.
It also makes "why does it say 358" unanswerable, because the previous value is
gone.

## Rejected

A single quantity column updated by triggers. Faster to read, and it destroys
the only thing this product sells.

## Consequence

Every read of "what have we got" is a join or a stored result. Worth it.
