# @stocktruth/adapter-csv

A second, real `EvidenceSource`. Deliberately small, but not toy input handling: four flat CSV files, the kind a small shop exports from
whatever spreadsheet it already runs on. No database, no live connection, no
history.

```
npx tsx examples/run.ts
```

## Why this exists

The Postgres adapter is one data point. One adapter proves the port compiles
against one shape of database; it does not prove the boundary holds against
something that is not a database at all. This is the second data point, and
it is a different business on purpose — an office stationer, not a brewery —
so nothing here can be accused of fitting the port because it was built
alongside it.

The adapter stays narrow. The real work required to plug a new source into this engine is answering five questions: what items exist, what does the record
claim, what did someone observe, what moved, and how healthy is whatever fed
you this.

## Honesty this adapter is forced into

`supportsKnownAt = false`. A CSV export is one snapshot, taken once — it has
no concept of when a row arrived versus when it happened. Rather than fake an
answer to "what did we know last Tuesday," this adapter declares up front
that it cannot answer that question, and `asOfKnowledge()` refuses it cleanly
rather than silently answering with today's file.

`possiblyRelatedUnlinkedCount` always returns 0. This adapter does not
attempt fuzzy code matching on rows it could not attach to an item. The
port's own contract allows exactly this: return 0, and positions get stated a
little more freely than they strictly should be, honestly, rather than
pretending a sophistication this file does not have.

## What the example data proves

`examples/*.csv` is a small stationer: paper, envelopes, ink, laminating
pouches, staples. One item is blocked (two different supplier boxes were
relabelled under the same code). One book figure has no date. One item has
never been counted. One movement cannot be matched to any item. And one
movement — a stock issue, not a receipt this time — happened five minutes
before a count but was not recorded until four hours after it, which is the
exact defect class the brewery demo is built around, in a different shape,
from a different file format, proving the reasoning is not brewery-specific:

```
ENV-C5-WHT     INCOMPLETE   CANNOT BE STATED
  UNMATCHED_MOVEMENTS_AT_SITE, MOVEMENT_SPANS_COUNT, BOOK_STALE
```

The parser handles UTF-8 BOMs, CRLF, quoted commas/newlines and escaped quotes. It rejects malformed numbers, negative movement quantities, bad booleans/dates/types, and marks duplicate SKUs as ambiguous before any of them can become a stock figure.
