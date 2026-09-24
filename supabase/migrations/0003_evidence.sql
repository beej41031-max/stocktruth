-- Evidence.
--
-- Four kinds of thing, kept apart on purpose:
--
--   book snapshot  - what a source system claims, at a stated time
--   count line     - what a person observed, at a stated time
--   movement       - an event that changed the quantity
--   (derived position lives in 0004, because it is a conclusion, not evidence)
--
-- Nothing in this file is ever updated in place. A correction is a new row that
-- points at the one it supersedes. That is what makes "why does it say 358?"
-- answerable six months later.

create type public.movement_type as enum (
  'RECEIVE',
  'ISSUE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADJUST',
  'WASTE',
  'RETURN'
);

create type public.import_status as enum ('staged', 'validated', 'committed', 'discarded', 'failed');
create type public.count_status  as enum ('draft', 'open', 'completed', 'abandoned');

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------

-- Nothing lands in an operational table straight from a file. It stages, it
-- validates, a human looks at it, then it commits in one transaction. Half a
-- committed import is worse than no import, because nobody can tell which half.

create table public.import_runs (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid references public.sites(id) on delete cascade,
  source_system_id  uuid references public.source_systems(id) on delete set null,
  -- 'catalogue', 'book_position', 'movements'
  import_kind       text not null,
  status            public.import_status not null default 'staged',
  source_filename   text,
  -- The locale and date format the file was read with. Stored because
  -- 03/04/2026 is two different days and the answer must not be a guess made
  -- once and forgotten.
  parse_settings    jsonb not null default '{}'::jsonb,
  row_count         integer not null default 0,
  error_count       integer not null default 0,
  created_by        uuid references auth.users(id),
  started_at        timestamptz not null default now(),
  committed_at      timestamptz,
  discarded_at      timestamptz
);

create index import_runs_org_idx on public.import_runs (organisation_id, started_at desc);

create table public.import_rows (
  id                 uuid primary key default gen_random_uuid(),
  import_run_id      uuid not null references public.import_runs(id) on delete cascade,
  row_number         integer not null,
  -- The file exactly as it arrived. Never normalised, never cleaned. If we get
  -- the mapping wrong we can re-derive; if we overwrite the source we cannot.
  raw_payload        jsonb not null,
  mapped_payload     jsonb,
  validation_state   text not null default 'pending',
  validation_errors  jsonb not null default '[]'::jsonb,
  unique (import_run_id, row_number)
);

create index import_rows_run_idx on public.import_rows (import_run_id, validation_state);

-- ---------------------------------------------------------------------------
-- Book position
-- ---------------------------------------------------------------------------

create table public.book_snapshots (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid not null references public.sites(id) on delete cascade,
  item_id           uuid not null references public.items(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete set null,
  quantity          numeric not null,
  unit              text not null,
  -- When the source says this was true. Null means the source did not say, and
  -- that is materially different from "now" — an undated book figure cannot be
  -- placed before or after a count.
  as_of             timestamptz,
  source_system_id  uuid references public.source_systems(id) on delete set null,
  import_run_id     uuid references public.import_runs(id) on delete set null,
  source_reference  text,
  created_at        timestamptz not null default now()
);

-- The engine asks "latest book figure for this item at this location" constantly.
create index book_snapshots_lookup_idx
  on public.book_snapshots (site_id, item_id, location_id, as_of desc nulls last);

-- ---------------------------------------------------------------------------
-- Physical counts
-- ---------------------------------------------------------------------------

create table public.count_sessions (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid not null references public.sites(id) on delete cascade,
  name              text,
  status            public.count_status not null default 'draft',
  started_by        uuid references auth.users(id),
  started_at        timestamptz,
  completed_at      timestamptz,
  -- Where the movement feed had got to when counting began. A movement that
  -- arrives mid-count is not allowed to quietly change what the counter was
  -- looking at; it gets reconciled afterwards instead.
  source_watermark  timestamptz,
  created_at        timestamptz not null default now()
);

create index count_sessions_site_idx on public.count_sessions (site_id, started_at desc);

create table public.count_lines (
  id                        uuid primary key default gen_random_uuid(),
  count_session_id          uuid not null references public.count_sessions(id) on delete cascade,
  organisation_id           uuid not null references public.organisations(id) on delete cascade,
  site_id                   uuid not null references public.sites(id) on delete cascade,
  item_id                   uuid not null references public.items(id) on delete cascade,
  location_id               uuid references public.locations(id) on delete set null,
  quantity                  numeric not null check (quantity >= 0),
  unit                      text not null,
  counted_by                uuid references auth.users(id),
  -- What the counting device said the time was.
  counted_at                timestamptz not null,
  -- What the server said the time was when it arrived. The gap between these
  -- two is how we notice a handset with the wrong clock, and how an offline
  -- count keeps its real time without us having to trust it blindly.
  received_at               timestamptz not null default now(),
  -- 'manual', 'scan'
  method                    text not null default 'manual',
  note                      text,
  -- Generated on the device, so a retry over a bad connection cannot write the
  -- same physical count twice.
  client_event_id           uuid unique,
  -- Corrections are new rows. The original stays.
  supersedes_count_line_id  uuid references public.count_lines(id) on delete set null,
  superseded                boolean not null default false,
  created_at                timestamptz not null default now()
);

create index count_lines_session_idx on public.count_lines (count_session_id);
create index count_lines_lookup_idx
  on public.count_lines (site_id, item_id, location_id, counted_at desc)
  where not superseded;

-- ---------------------------------------------------------------------------
-- Movements
-- ---------------------------------------------------------------------------

create table public.movements (
  id                       uuid primary key default gen_random_uuid(),
  organisation_id          uuid not null references public.organisations(id) on delete cascade,
  site_id                  uuid not null references public.sites(id) on delete cascade,
  -- Nullable on purpose. A movement we cannot yet attach to an item is still a
  -- movement that happened, and hiding it would make the stock look tidier than
  -- it is. It sits here unlinked and shows up as an open issue.
  item_id                  uuid references public.items(id) on delete set null,
  location_id              uuid references public.locations(id) on delete set null,
  movement_type            public.movement_type not null,
  quantity                 numeric not null check (quantity >= 0),
  unit                     text not null,
  -- When the goods actually moved.
  occurred_at              timestamptz,
  -- When someone wrote it down. These are routinely hours apart, and a count
  -- taken in between is affected by the difference.
  recorded_at              timestamptz,
  -- When we received it. Always known.
  imported_at              timestamptz not null default now(),
  source_system_id         uuid references public.source_systems(id) on delete set null,
  -- The source's own id for the event, where it has one. This is the only
  -- reliable way to run a sync twice without doubling the stock.
  source_event_id          text,
  source_reference         text,
  -- Both halves of a transfer share this, so the pair can be recognised as one
  -- movement of goods rather than a disposal and an unexplained appearance.
  transfer_correlation_id  uuid,
  reversal_of_id           uuid references public.movements(id) on delete set null,
  raw_payload              jsonb
);

create unique index movements_source_event_unique
  on public.movements (source_system_id, source_event_id)
  where source_event_id is not null;

create index movements_window_idx
  on public.movements (site_id, item_id, occurred_at)
  where item_id is not null;

create index movements_unlinked_idx
  on public.movements (site_id, imported_at desc)
  where item_id is null;
