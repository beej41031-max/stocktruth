# @stocktruth/cli

The reasoning engine, with nothing else attached.

```
npx tsx src/index.ts examples/pallet.json
cat evidence.json | npx tsx src/index.ts
npx tsx src/index.ts examples/clean.json --json
```

No database, no Next.js, no server. One dependency: `@stocktruth/engine`.

## Why this exists

The Postgres adapter and the web app prove the engine can be reached from a
real system. They do not prove it is *easy* to reach from anywhere else. This
does: evidence in as plain JSON, a conclusion out as text or JSON, one
command.

## The evidence shape

`examples/pallet.json` is the canonical case — same numbers as the web demo,
portable, no database attached. `examples/clean.json` is a contrasting case
that comes back `VERIFIED`, so both directions are shown.

The shape is `ReconciliationInput` with dates as ISO strings instead of
`Date` objects, since JSON has no date type. That conversion is the only
thing this file does. All the reasoning is the engine's.

```
npx tsx src/index.ts examples/pallet.json
```
```
PKG-CAN-440
state: INCOMPLETE
position: CANNOT BE STATED

Blocked by:

  MOVEMENT_SPANS_COUNT
  M184, 8400 each, arrived 2026-09-14T11:02:00.000Z but was not recorded
  until 4 hours later. Count C92 was taken at 2026-09-14T12:02:00.000Z, in
  between. Ask whoever received the delivery or whoever counted, and record
  the answer as a correcting movement. Or count PKG-CAN-440 again now, which
  settles it without anyone having to remember.

If cleared: 27,600
  assuming: the 8400 from movement M184 was already on the shelf when counted
```

Malformed dates, non-finite quantities and unsupported movement types are rejected at the boundary before the engine runs.
