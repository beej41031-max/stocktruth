# 0016 — Event-time watermarks close history

## Decision

Processing success and event-time completeness are separate facts.
A source may have imported successfully at 15:00 while containing an event that physically happened at 11:00.
StockTruth stores an event watermark for sources that can provide one.

A repeat-count interval is `CLOSED` only when the movement watermark has advanced through the closing count.
Without that, the arithmetic may be shown as `PROVISIONAL`, but the interval is still open to late evidence.

## Why

A late receipt can legitimately change the measured consumption for a period that already ended.
`last_success_at` says when the connector ran. It does not say how far through physical event time the feed is complete.
Conflating the two makes historical variance look final when it is not.

## Consequences

- `source_systems.event_watermark_at` is distinct from `last_success_at`;
- late-recorded events are assigned by `occurred_at`, not by entry time;
- a currently stale feed can still support a closed historical interval if its watermark passed that interval's end;
- sources that cannot provide a watermark produce provisional, not falsely final, interval results.
