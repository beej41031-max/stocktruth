# 0015 — The second count closes a measurement interval

## Decision

A physical count is not an opening balance that the product carries forward indefinitely.
Two successive counts of the same item/location define a measurement interval.

Where material consumption is not recorded as it happens, only received and counted:

```text
actual material use
  = opening count
  + receipts
  + transfers in
  + returns in
  - transfers out
  - closing count
```

Production output multiplied by the BOM version effective at completion time gives theoretical use.
The difference is material variance.

## Why

The opening count answers a low-value administrative question: what was physically present at one instant?
The second count answers a higher-value operating question: how much material disappeared during the period?
When production is known, that difference can be translated into scrap, overuse, shrinkage, rework or BOM error.

A ledger adjustment may repair today's balance. It must never erase the measured interval that created it.

## Consequences

- repeat counts are first-class product behaviour;
- count cadence belongs on the item;
- BOM versions are time-effective rather than overwritten;
- production output is evidence, not a derived dashboard metric;
- interval conclusions are append-only snapshots;
- variance can be costed and trended independently of current inventory accuracy.
