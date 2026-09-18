# 6. Tenancy is enforced by the database

## Decision

Every user-facing query runs through `withUser()`, which opens a transaction,
sets `request.jwt.claim.sub`, and switches to the `authenticated` role. Row
level security then applies exactly as it would through PostgREST.

`withService()` exists for the engine and the import committer, and is used in
two places.

## Why

An organisation id from the browser is a request, not a permission. If tenancy
lives in `where` clauses, one forgotten clause leaks another customer's stock
and nothing catches it.

Verified by test: a user who belongs to no organisation, asking for a known
site by id, gets zero rows from the database itself.

## Consequence

Queries in `lib/queries` do not filter by organisation. A query there that
mentions `organisation_id` in a `where` clause is a sign somebody has stopped
trusting the policies, and is worth a second look in review.
