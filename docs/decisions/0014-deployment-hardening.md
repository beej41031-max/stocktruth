# 0014 — Deployment hardening is part of the boundary

The portfolio app is serverless and uses Supabase through `pg`. The deployment
shape therefore has a few non-negotiable constraints:

- one database connection per warm Vercel instance (`max: 1`); Supabase's pooler
  handles concurrency outside the process
- no application query reads `auth.users`; private auth storage is not an app
  reporting table
- enum-valued mutation parameters are explicitly cast in SQL so Postgres never
  has to infer one placeholder as both text and an enum
- Next output tracing is rooted at the monorepo so `@stocktruth/engine` is
  present in server output
- generated `.next` output is never committed and must be disposable
- TypeScript is pinned for reproducible builds

These are not engine concerns and do not belong in `packages/engine`. They are
host constraints documented here so a later adapter or UI does not accidentally
reintroduce production bugs while leaving the reasoning tests green.
