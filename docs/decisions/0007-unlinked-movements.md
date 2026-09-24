# 7. Unmatched movements caveat the site, block only their own item

## Decision

A movement that could not be attached to any item raises
`UNMATCHED_MOVEMENTS_AT_SITE` on every position, which downgrades to
PROVISIONAL. It blocks a position outright only when the unmatched row's own
source code normalises to a label that item answers to.

## Why

The first version treated any unmatched row as poisoning everything at the
site. Running it against seed data produced zero verified positions out of
twenty-six, which is technically defensible and useless. One stray hop receipt
does not make the malt count untrustworthy.

Saying "I don't know" about everything is its own kind of dishonest.

## Note

Code matching normalises case and punctuation, so `HOP-CAS-5` and `HOPCAS5`
are the same code. This is only ever used to raise a question. Nothing is ever
linked automatically on a fuzzy match.
