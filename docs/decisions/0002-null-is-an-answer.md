# 2. A refused number is null, and null is rendered as words

## Decision

`reconciliation_results.derived_quantity` is nullable. When the engine cannot
support exactly one answer it writes null, and the UI prints "cannot be stated"
rather than a dash, a zero, or the book figure.

## Why

The failure mode this product exists to prevent is a confident wrong number.
Every inventory system can print something; the useful thing is knowing when
what it printed is worth acting on.

Null has to survive all the way to the screen. Coalescing it to zero in a query
would undo the whole design in one line, which is why the column is nullable
rather than defaulted.

## Consequence

Callers must handle null everywhere. That is the point: it stops being possible
to forget.
