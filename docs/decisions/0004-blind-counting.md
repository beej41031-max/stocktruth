# 4. Counting is blind by default

## Decision

The expected quantity is not sent to the browser until a count has been saved.
Policy-controlled per site, defaulting to on.

## Why

Showing someone the number before they count it produces agreement, not
evidence. They see 40, they find roughly 40, they write 40. The count then
looks like confirmation of a figure that nobody actually checked, which is
worse than not counting at all because it raises confidence without raising
accuracy.

The first version of the count screen got this wrong and showed the book figure
up front.

## Note on implementation

Withheld at the server, not hidden with CSS or a collapsed panel. A number in
the page source is a number somebody can read.

## Rejected

Always blind, no policy. Two-person verification counts genuinely want the
expected figure visible, and refusing that would push people back to paper.
