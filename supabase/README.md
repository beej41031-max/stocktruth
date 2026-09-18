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
