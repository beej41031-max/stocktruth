# 3. The physical count is the anchor, not the book

## Decision

`derived = count + movements strictly after the count`.

The book figure never anchors a current position. It is used only to work out
how wrong the records were at the moment of counting, and only when the
movement window between the two is complete.

## Why

A book figure is a claim nobody has checked. A count is the one piece of
independent evidence in the system. Anchoring on the claim and correcting it
with the evidence gets the dependency backwards.

## Consequence

An item that has never been counted has no position. Not zero, not the book
figure: `UNVERIFIED`. That is a large number of items on day one, which is an
honest description of a business that has never counted its stock.
