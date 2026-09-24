# 10. A refusal is derivable, not asserted

## Decision

A position is refused **if and only if** at least one reason with
`blocks: true` is present. `explain()` asserts that relationship on every call
and throws if it does not hold.

Every reason declares `blocks` and `remedy`. Every blocker produces a
`resolution` naming the actual records involved.

## Why

"Cannot be stated" is only worth anything if it can be defended. If a refusal
is a pile of hand-written warnings wrapped around a fuzzy calculation, then
somebody eventually reads the calculation, decides the warnings are noise, and
wraps the whole thing in a coalesce. The design dies in one commit and nobody
notices until a customer acts on a number that was never real.

So the refusal is defined exactly, checked in both directions, and the check
runs every time anyone asks why.

## What this buys

The system can answer two questions deterministically rather than
conversationally:

**Why can this not be stated?**

> M000004, 8400 each, arrived 2026-09-14T11:02Z but was not recorded until 4
> hours later. Count C000005 was taken at 12:02Z, in between. So that delivery
> may or may not have been on the shelf when the counter looked, and applying
> it would double-count while ignoring it would undercount.

**What would make it stateable?**

> Ask whoever received the delivery or whoever counted, and record the answer
> as a correcting movement. Or count PKG-CAN-440 again now, which settles it
> without anyone having to remember.

## The hypothetical

`ifCleared` reports what the number would be if every blocker resolved the most
favourable way, with its assumptions attached. It is never stored and never
shown as the answer. A caller that shows the quantity and drops the assumptions
has reintroduced exactly the problem this product exists to prevent, and there
is no way to stop them beyond making it awkward.
