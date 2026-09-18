# Plugging StockTruth into another inventory system

The short version: **translate the evidence, do not rewrite the engine.**

A customer's database will have its own names for everything. One system has `stock_on_hand`, another has `qty_current`, another has a Google Sheet called `FINAL FINAL stock v8` because life is cruel.

The adapter is where that mess belongs.

## What the engine needs

For each item/location it needs five things:

1. **Item identity** — the stable item and its stock unit.
2. **Book snapshot** — what the host system claimed, and when that claim was true.
3. **Physical count** — what a person actually observed, and when.
4. **Movements** — what came in/out, when it happened, and when it became known.
5. **Source health** — whether an automated feed is still alive, where the host can provide that reliably.

The adapter maps the host records into those shapes and implements `EvidenceSource` from `packages/engine/src/ports.ts`.

## Example

A customer's schema might say:

```text
products.product_code
warehouse_balance.qty
stocktake_line.checked_qty
goods_events.created_time
goods_events.received_time
```

The adapter decides which one means item identity, book quantity, physical observation, occurrence time and knowledge time.

The engine never learns those column names.

That is deliberate. Customer-specific logic stays in one file instead of slowly infecting the reconciliation rules.

## First integration pass

A sensible integration is small:

- map one item and one location
- load one book snapshot
- load one physical count
- load the movements around that count
- compare StockTruth's answer with the business's expected result
- only then widen the adapter to the whole catalogue

If the source data cannot distinguish two things StockTruth needs to distinguish, the adapter should surface that limitation. Making up a timestamp because the target type wants one is exactly the sort of helpful shortcut this project is trying to avoid.
