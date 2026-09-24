# ADR 0022 — Late automated evidence is reviewed, not forgotten

Status: accepted in v0.4.4.

## Context

An automated source can honestly claim that it is complete through a physical cutoff and later deliver a correction whose event time belongs before that cutoff. v0.4.3 correctly reopened the historical material-variance interval, but it had no way to close it again: the first watermark claim is immutable by design, so every later evaluation continued to see the correction as late.

A mutable "latest watermark" is not the answer. It would erase the fact that the first completeness claim was wrong. Nor should a human edit the source's claim.

## Decision

Automated recovery is a second, append-only fact: an owner or manager reviews the late evidence for one repeat-count interval and source.

The original source watermark claim remains unchanged. The review records:

- the exact closing count line and interval;
- evidence kind and automated source;
- the source's original watermark/claim that had been breached;
- the latest StockTruth `imported_at` actually reviewed;
- evidence count, reviewer, review time and note;
- append-only material-variance run IDs immediately before and after re-closing.

The engine then uses the reviewed import cutoff as the accepted knowledge boundary for that source on that interval. Evidence already reviewed is no longer "late". Any later import beyond that reviewed cutoff reopens the interval again.

## Security boundary

The review table has no direct authenticated write policy. A SECURITY DEFINER RPC derives scope, cutoff, actor and reviewed evidence from the database and requires owner/manager access. The UI is only a convenience surface.

## Consequence

Closure can recover after legitimate late corrections without rewriting history. Both statements remain true:

1. the connector once claimed completeness too early; and
2. a named person later inspected the correction and accepted the revised interval.

That distinction is the audit trail.
