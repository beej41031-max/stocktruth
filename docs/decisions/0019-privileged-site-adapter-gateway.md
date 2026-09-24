# 0019 · One privileged gateway for user-facing engine reads

## Status
Accepted in v0.4.1.

The Postgres adapter needs a `pg.Pool`, while ordinary pages should remain under
row-level security. Exporting `rawPool()` let new pages quietly create another
privileged access path.

User-facing engine work now goes through `withSiteService(userId, siteId, fn)`.
It first proves the signed-in user can see the site under RLS, then invokes the
adapter on the privileged pool. The adapter still scopes every query to that
site. Pages do not receive or import a raw pool directly.

Background reconciliation/import work may use `withService()` because it has no
request user, but that remains a separate deliberate path.
