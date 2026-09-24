# 8. The engine is a package with no database

## Decision

`packages/engine` has no dependencies, no imports outside itself, and no
knowledge of any schema. It takes plain shapes and returns a conclusion.

Hosts implement `EvidenceSource` from `ports.ts`. `apps/web/lib/adapters/postgres.ts`
is one such adapter; `packages/engine/test/inmemory.ts` is another, made of
arrays.

## Why

The reasoning about evidence is the valuable part and the part worth reusing.
The moment a table name appears inside it, it stops being an engine and becomes
this application's internals with an optimistic folder name.

Adapters are allowed to be ugly and specific. Every host's records are a mess
in their own particular way, and that mess belongs on one side of the line.

## Enforced, not intended

`isolation.test.ts` reads every file in `src/`, strips comments, and fails if
any of them imports something outside the package or contains a host's
vocabulary in executable code.

The in-memory adapter is the other half of the proof: if the engine can be
driven to all six states by eighty lines of arrays, nothing in it depends on
where the data lives.

## Consequence

The engine cannot fetch anything it was not given. Every adapter has to do the
assembling, including the awkward parts like working out which unmatched
movements might belong to which item. That is more work per adapter and it is
the right place for it.
