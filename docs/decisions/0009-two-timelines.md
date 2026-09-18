# 9. Occurrence time and knowledge time are different questions

## Decision

Every piece of evidence carries when it happened and when this system learned
it, and they are never collapsed.

- `occurred_at`, `counted_at`, `as_of` — when the thing happened
- `imported_at`, `created_at`, `received_at` — when we found out

`asOfKnowledge()` answers "what did we think we had at this moment" by
filtering on the second, never the first.

## Why

A delivery arrives at 11:02 and is keyed in at 15:02. Between those two times
the system honestly did not know about it, and a report run at 14:00 that
includes it is not history, it is a reconstruction with hindsight smuggled in.

The specific failure this prevents: somebody reviews a decision made on
Tuesday, the system shows them Tuesday with today's evidence, the numbers look
fine, and the late-arriving delivery note that actually caused the problem is
invisible because it now sits neatly in the past.

## Consequence

Knowledge can get worse. An item can be `PROVISIONAL 27,600` at 15:59 and
`INCOMPLETE, cannot be stated` at 16:00, because a delivery note arrived that
could not be placed relative to the count.

That is correct. More evidence does not always mean more certainty; sometimes
it reveals an ambiguity that was there all along and nobody could see.

## Adapters that cannot do this

Must set `supportsKnownAt = false`. `asOfKnowledge()` then refuses the question
and says why, rather than answering it with today's evidence. A confident wrong
answer to a historical question is worse than no answer, because nobody
re-checks a number that looked fine.
