# Database

Migrations are numbered and append-only. Once a file is in here it is not
edited, even before release: 0007 and 0008 both exist because running the thing
found gaps in 0004, and that history is more useful than a tidy first file.

Apply in order. `0006_rls.sql` must run before any customer data is loaded.

`seed.sql` is demo data for Northgate Brewing Co., a brewery that does not
exist. The mess in it is deliberate and documented at the top of the file:
an undated book figure, a receipt keyed in after the count it preceded,
movements with no item attached, one code covering two hop harvests, a barcode
printed on two labels, a book figure in litres against an item held in drums,
a receipt entered twice, counts that have gone out of date, and items nobody has
ever counted.

Every one of those makes the engine return a different answer. That is the point
of the seed: a demo where everything reconciles proves nothing.

## Local testing

`test/_shim.sql` creates `auth.users` and `auth.uid()` so the migrations can run
against plain Postgres. Supabase provides both, so the shim is never applied to
a real project.

## v0.4.3 closure guards

Migration `0013_historical_closure_and_db_guards.sql` adds append-only automated watermark history and makes completed physical count evidence immutable at the database boundary. New count sessions must begin `draft`/`open`; attestation cannot be supplied on insert and is a separate owner/manager action after physical completion.

`seed.sql` therefore seeds historical sessions through the same guarded lifecycle: create open session, insert count lines, then complete it. `demo-setup.sql` is the one-shot fresh-project bundle and includes the same 0013 guards.

## v0.4.4 automated late-evidence review

Migration `0014_automated_evidence_review.sql` adds an append-only review path for automated sources that deliver corrections after their first completeness claim. The original watermark history is never rewritten. An owner or manager reviews the exact late rows for one closing count line and one source; the review records the accepted import-time cutoff plus before/after material-variance run ids. Any still-later import reopens the interval again.

The same migration makes `count_lines.received_at` server-authored for authenticated/API inserts and qualifies the count-line RLS scope checks explicitly. Service-role seed/backfill paths may still preserve historical receive timestamps.

Source discovery is intentionally evidence-led in this release: an automated source becomes required for a site/evidence kind once it has actually delivered that kind of evidence there. A configured connector that has never delivered any relevant row is not inferred to own that evidence domain, because `source_systems` does not yet declare movement-vs-production ownership.
