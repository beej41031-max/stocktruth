# 0017 — Adequacy is decision-specific

## Decision

StockTruth does not collapse evidence into a generic confidence percentage.
When an exact current position is unavailable but uncertainty is bounded, the product may expose a range and separate decision guidance.

For example, a known 27,600 count plus an ambiguous +8,400 receipt around the count can support:

```text
physical range        27,600–36,000
allocate / promise    up to 27,600
purchase              hold and verify
financial position    blocked
```

The reconciliation result remains `INCOMPLETE`. The operational layer does not rewrite truth; it translates bounded evidence into policy.

## Why

The cost of being wrong is asymmetric.
Overstating stock is dangerous for customer promises. Understating it can trigger an unnecessary purchase. Financial reporting requires a different evidence threshold again.
One universal "safe number" hides those differences.

## Consequences

- exact truth and operational guidance remain separate outputs;
- omitted-stock and phantom-stock exposure are directional;
- conservative lower bounds can support some shop-floor actions without being promoted to exact inventory;
- finance is never given a bounded operational estimate as if it were an exact position.
