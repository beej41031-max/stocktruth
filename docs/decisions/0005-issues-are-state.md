# 5. Issues outlive the run that raised them

## Decision

`reconciliation_issues` is not rewritten by each engine run. Still present
updates `last_seen_at`; newly present opens; gone resolves with the engine
named as the actor.

Closing one requires both a resolution and a note, enforced by a check
constraint rather than by a form.

## Why

An issue is a unit of work somebody picks up. Regenerating the list every run
would discard a part-written investigation every night.

"Resolved" with no reason turns an audit trail into a list of timestamps. The
constraint is in the database because the form is not the only way rows get
written.

## Consequence

`recount` and `investigating` leave the issue open. Deciding that work needs
doing is not the same as doing it, and a queue that empties when people write
notes in it is a queue that lies.
