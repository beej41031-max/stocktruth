# StockTruth 0.3.0 — portfolio final

This release turns the original inventory reconciliation demo into a concrete
reference implementation of an event-driven operational truth kernel.

## Added

- CSV `EvidenceSource` for a second, non-database host
- JSON/CLI route into the same engine
- `/system` portfolio page explaining the kernel and movement/total model
- RFC4180-style CSV parsing with BOM/quoted-field handling and boundary checks
- CSV adapter tests
- non-destructive live database release smoke (`npm run verify:db`)
- GitHub Actions release gate
- one-file fresh Supabase demo setup

## Production fixes carried forward

- no application query reads Supabase `auth.users`
- Vercel/Supabase DB pool limited to one connection per instance
- `/reconcile` enum parameters explicitly cast (`issue_status`, `issue_resolution`)
- monorepo output tracing and `@stocktruth/engine` transpilation restored
- TypeScript pinned to 5.7.3; Node 22.11+ declared
- malformed archive directories removed
- `.next` remains disposable/ignored

## Verification performed while packaging

- all 53 engine tests exercised successfully
- CSV adapter tests passed (quoted fields, real engine path, malformed number refusal)
- engine, CSV adapter and CLI strict TypeScript checks passed
- CLI pallet refusal and clean VERIFIED JSON case executed successfully
- JSON/package manifests parsed successfully
- static production guards checked: zero `auth.users` reads, typed reconcile SQL,
  DB pool max 1, `/system` route present, no malformed brace directories

The packaging environment could not complete a fresh npm registry install within
its execution window, so the included deployment runner repeats `npm ci`, all
workspace checks, demos, a production Next build and the live DB smoke on the
target machine before it is allowed to commit or push.
