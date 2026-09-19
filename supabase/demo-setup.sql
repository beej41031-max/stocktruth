-- StockTruth 0.3.0 fresh demo setup
-- Run only on a new/empty Supabase project. Migrations first, then synthetic portfolio data.

-- ============================================================================
-- supabase/migrations/0001_core.sql
-- ============================================================================
-- Core tenancy.
--
-- An organisation is a customer. A site is somewhere stock physically sits.
-- Everything operational hangs off a site, because two sites can hold the same
-- item and the quantities are not interchangeable.

create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'manager', 'counter', 'viewer');

create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.sites (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  name             text not null,
  -- Counts happen on a local working day. Reconciliation compares instants.
  -- Storing the site's zone means we never have to guess which one a bare
  -- date belongs to.
  timezone         text not null default 'UTC',
  created_at       timestamptz not null default now()
);

create index sites_org_idx on public.sites (organisation_id);

create table public.memberships (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             public.member_role not null,
  created_at       timestamptz not null default now(),
  unique (organisation_id, user_id)
);

create index memberships_user_idx on public.memberships (user_id);

-- A counter is often hired for one site, not the whole company. Absence of any
-- row here means "all sites in the org"; presence means "these sites only".
create table public.site_memberships (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (site_id, user_id)
);

create index site_memberships_user_idx on public.site_memberships (user_id);

create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  code        text not null,
  name        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (site_id, code)
);

create index locations_site_idx on public.locations (site_id) where active;

-- ============================================================================
-- supabase/migrations/0002_catalogue.sql
-- ============================================================================
-- Catalogue and identity.
--
-- Identity is the part everyone gets wrong. A SKU is a label a business puts on
-- a thing; it is not the thing. Businesses reuse codes, mistype them, change
-- them, and occasionally use one code for two genuinely different products.
--
-- So: items.id is identity. Everything else is a label pointing at it, and any
-- label can turn out to point at two things.

create type public.identity_state as enum (
  'linked',      -- resolves to exactly one item
  'ambiguous',   -- resolves to more than one, needs a human
  'unresolved'   -- resolves to none
);

create table public.items (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  sku              text,
  name             text not null,
  stock_unit       text not null,
  active           boolean not null default true,
  -- Set when the business knows a code is broken and nothing should be counted
  -- or received against it until someone decides what it means.
  blocked          boolean not null default false,
  blocked_reason   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Deliberately not unique. If a customer's data has two items with the same
-- SKU, that is a fact about their business we need to surface, not an import
-- error we refuse. Uniqueness here would just mean we silently drop one.
create index items_org_sku_idx on public.items (organisation_id, sku);
create index items_org_active_idx on public.items (organisation_id) where active;

create table public.item_aliases (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  alias       text not null,
  -- 'legacy_sku', 'supplier_code', 'shop_floor_name', 'other'
  alias_type  text not null default 'other',
  created_at  timestamptz not null default now()
);

create index item_aliases_lookup_idx on public.item_aliases (alias);

create table public.item_barcodes (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  barcode     text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Not unique either, for the same reason. Two items sharing a barcode is a real
-- situation and the scanner has to handle it by asking, not by picking one.
create index item_barcodes_lookup_idx on public.item_barcodes (barcode) where active;

create table public.source_systems (
  id                      uuid primary key default gen_random_uuid(),
  organisation_id         uuid not null references public.organisations(id) on delete cascade,
  name                    text not null,
  -- 'csv_upload', 'google_sheets', 'api'
  source_type             text not null,
  -- How long before silence means something is wrong. Null = manual, no
  -- expectation of regular delivery.
  expected_sync_minutes   integer,
  last_attempt_at         timestamptz,
  last_success_at         timestamptz,
  last_error              text,
  created_at              timestamptz not null default now()
);

create index source_systems_org_idx on public.source_systems (organisation_id);

-- How an external system refers to one of our items. One item can carry several
-- of these, one per source, which is how we survive a customer whose ERP and
-- whose spreadsheet disagree about what a thing is called.
create table public.item_source_identities (
  id                uuid primary key default gen_random_uuid(),
  source_system_id  uuid not null references public.source_systems(id) on delete cascade,
  item_id           uuid references public.items(id) on delete set null,
  external_id       text not null,
  external_code     text,
  identity_state    public.identity_state not null default 'linked',
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  unique (source_system_id, external_id)
);

create index item_source_identities_item_idx on public.item_source_identities (item_id);

-- ============================================================================
-- supabase/migrations/0003_evidence.sql
-- ============================================================================
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

-- ============================================================================
-- supabase/migrations/0004_reconciliation.sql
-- ============================================================================
-- Reconciliation.
--
-- Evidence lives in 0003. This is where conclusions live, and the two are kept
-- apart so that a conclusion can be wrong without corrupting the record it was
-- drawn from. Re-running the engine writes new results; it never edits old ones.
--
-- The states are deliberately not a confidence percentage. "87% confident" is a
-- number nobody can act on and everybody argues with. A reason code is a thing
-- someone can go and fix.

create type public.reconciliation_state as enum (
  'VERIFIED',      -- evidence supports a current position
  'PROVISIONAL',   -- a position is derivable, but something non-critical is off
  'STALE',         -- last physical verification is older than policy allows
  'INCOMPLETE',    -- required evidence is missing; no position is claimed
  'CONFLICT',      -- evidence contradicts itself
  'UNVERIFIED'     -- never physically counted
);

create type public.issue_severity as enum ('high', 'medium', 'low');
create type public.issue_status   as enum ('open', 'resolved', 'accepted');

create table public.reconciliation_runs (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid not null references public.sites(id) on delete cascade,
  -- Bumped whenever the rules change. Without it, an old result is unreadable:
  -- you cannot tell whether it says what it says because of the evidence or
  -- because of the logic at the time.
  engine_version    text not null,
  -- Everything is judged as at this instant, so a run is reproducible.
  evaluated_at      timestamptz not null default now(),
  triggered_by      uuid references auth.users(id),
  trigger_reason    text,
  item_count        integer not null default 0,
  started_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index reconciliation_runs_site_idx
  on public.reconciliation_runs (site_id, started_at desc);

create table public.reconciliation_results (
  id                      uuid primary key default gen_random_uuid(),
  reconciliation_run_id   uuid not null references public.reconciliation_runs(id) on delete cascade,
  organisation_id         uuid not null references public.organisations(id) on delete cascade,
  site_id                 uuid not null references public.sites(id) on delete cascade,
  item_id                 uuid not null references public.items(id) on delete cascade,
  location_id             uuid references public.locations(id) on delete set null,
  state                   public.reconciliation_state not null,

  book_quantity           numeric,
  book_as_of              timestamptz,
  physical_quantity       numeric,
  physical_counted_at     timestamptz,
  -- Null whenever the engine will not commit to a number. That is the whole
  -- product: an empty cell here is a deliberate statement, not missing data.
  derived_quantity        numeric,
  derived_as_of           timestamptz,

  -- Movements the engine actually applied, and the window it applied them over.
  movement_net            numeric,
  movement_window_start   timestamptz,
  movement_window_end     timestamptz,

  reason_codes            text[] not null default '{}',
  -- Ids of every row that went into this, so the UI can show its working.
  evidence                jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now()
);

create index reconciliation_results_run_idx
  on public.reconciliation_results (reconciliation_run_id);

-- The dashboard reads the newest result per item constantly.
create index reconciliation_results_latest_idx
  on public.reconciliation_results (site_id, item_id, location_id, created_at desc);

create index reconciliation_results_state_idx
  on public.reconciliation_results (site_id, state, created_at desc);

-- An issue is a thing a person can pick up and deal with. It outlives the run
-- that raised it, because re-running the engine should not silently close work
-- somebody was halfway through.
create table public.reconciliation_issues (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid not null references public.sites(id) on delete cascade,
  item_id           uuid references public.items(id) on delete cascade,
  location_id       uuid references public.locations(id) on delete set null,
  result_id         uuid references public.reconciliation_results(id) on delete set null,
  code              text not null,
  severity          public.issue_severity not null default 'medium',
  status            public.issue_status not null default 'open',
  detail            jsonb not null default '{}'::jsonb,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  resolved_by       uuid references auth.users(id),
  resolved_at       timestamptz,
  -- 'accepted' without a note is how an audit trail becomes useless.
  resolution_note   text,
  created_at        timestamptz not null default now()
);

-- One open issue per item/location/code. A nightly run should update
-- last_seen_at, not raise the same thing thirty times.
create unique index reconciliation_issues_open_unique
  on public.reconciliation_issues (site_id, coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
  where status = 'open';

create index reconciliation_issues_queue_idx
  on public.reconciliation_issues (site_id, status, severity, last_seen_at desc);

-- Per-site policy. Sensible defaults, overridable, because "how old is too old"
-- is a business question and a brewery and a fastener stockist answer it
-- differently.
create table public.reconciliation_policies (
  site_id                    uuid primary key references public.sites(id) on delete cascade,
  -- A count older than this stops being current.
  stale_after_days           integer not null default 30,
  -- A book figure older than this cannot anchor a comparison on its own.
  book_stale_after_days      integer not null default 14,
  -- Feed silence beyond its expected interval by this factor is a data-health
  -- problem, not just a quiet day.
  source_silence_multiplier  numeric not null default 3,
  -- Clock skew on a counting device beyond this makes its timestamp suspect.
  max_clock_skew_minutes     integer not null default 10,
  require_location           boolean not null default false,
  updated_at                 timestamptz not null default now()
);

-- ============================================================================
-- supabase/migrations/0005_audit.sql
-- ============================================================================
-- Audit.
--
-- One table, not one per module. The question people actually ask is "what
-- happened to this item", and that is unanswerable if the history is scattered
-- across six different logs with six different shapes.
--
-- Append-only. Nothing in here is ever updated or deleted.

create table public.audit_events (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  site_id          uuid references public.sites(id) on delete set null,

  actor_user_id    uuid references auth.users(id) on delete set null,
  -- 'user' | 'system' | 'import' | 'engine'
  actor_type       text not null default 'user',
  -- Kept as plain text alongside the id, because a user can be deleted and the
  -- history still has to say who did it.
  actor_label      text,

  event_type       text not null,
  object_type      text not null,
  object_id        uuid,

  before_data      jsonb,
  after_data       jsonb,
  detail           jsonb not null default '{}'::jsonb,

  -- Ties every row written by one import or one engine run together.
  correlation_id   uuid,
  created_at       timestamptz not null default now()
);

create index audit_events_object_idx
  on public.audit_events (object_type, object_id, created_at desc);

create index audit_events_org_idx
  on public.audit_events (organisation_id, created_at desc);

create index audit_events_correlation_idx
  on public.audit_events (correlation_id)
  where correlation_id is not null;

-- Deletes and updates are refused at the database, not just avoided in code.
-- An audit log that the application can quietly rewrite is decoration.
create or replace function public.audit_events_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_no_update
  before update on public.audit_events
  for each row execute function public.audit_events_immutable();

create trigger audit_events_no_delete
  before delete on public.audit_events
  for each row execute function public.audit_events_immutable();

-- ============================================================================
-- supabase/migrations/0006_rls.sql
-- ============================================================================
-- Row level security.
--
-- Tenancy is enforced here, not in the application. The browser sends an
-- organisation id; that is a request, not a permission. Every policy below
-- proves reachability from the signed-in user through a membership row.
--
-- Helper functions are security definer and read only membership tables, so
-- they cannot be used to reach anything else.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = org and m.user_id = auth.uid()
  );
$$;

create or replace function public.org_role(org uuid)
returns public.member_role
language sql
stable
security definer
set search_path = public
as $$
  select m.role from public.memberships m
  where m.organisation_id = org and m.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.can_write_org(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.org_role(org) in ('owner', 'manager');
$$;

-- A counter may record counts but may not touch the catalogue or the sources.
create or replace function public.can_count_org(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.org_role(org) in ('owner', 'manager', 'counter');
$$;

-- Site access: either the user has no site restriction in this org, or the site
-- is explicitly granted. Written as one query so a missing restriction row can
-- never accidentally mean "no access".
create or replace function public.can_access_site(site uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sites s
    join public.memberships m
      on m.organisation_id = s.organisation_id
     and m.user_id = auth.uid()
    where s.id = site
      and (
        not exists (
          select 1 from public.site_memberships sm
          where sm.user_id = auth.uid()
            and sm.site_id in (select id from public.sites where organisation_id = s.organisation_id)
        )
        or exists (
          select 1 from public.site_memberships sm
          where sm.user_id = auth.uid() and sm.site_id = s.id
        )
      )
  );
$$;

create or replace function public.site_org(site uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organisation_id from public.sites where id = site;
$$;

-- ---------------------------------------------------------------------------
-- Enable
-- ---------------------------------------------------------------------------

alter table public.organisations           enable row level security;
alter table public.sites                   enable row level security;
alter table public.memberships             enable row level security;
alter table public.site_memberships        enable row level security;
alter table public.locations               enable row level security;
alter table public.items                   enable row level security;
alter table public.item_aliases            enable row level security;
alter table public.item_barcodes           enable row level security;
alter table public.source_systems          enable row level security;
alter table public.item_source_identities  enable row level security;
alter table public.import_runs             enable row level security;
alter table public.import_rows             enable row level security;
alter table public.book_snapshots          enable row level security;
alter table public.count_sessions          enable row level security;
alter table public.count_lines             enable row level security;
alter table public.movements               enable row level security;
alter table public.reconciliation_runs     enable row level security;
alter table public.reconciliation_results  enable row level security;
alter table public.reconciliation_issues   enable row level security;
alter table public.reconciliation_policies enable row level security;
alter table public.audit_events            enable row level security;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

create policy org_read on public.organisations
  for select using (public.is_org_member(id));

create policy org_update on public.organisations
  for update using (public.org_role(id) = 'owner');

create policy sites_read on public.sites
  for select using (public.can_access_site(id));

create policy sites_write on public.sites
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

-- A user can always see their own membership rows. Owners see all of theirs.
create policy memberships_read on public.memberships
  for select using (user_id = auth.uid() or public.org_role(organisation_id) = 'owner');

create policy memberships_write on public.memberships
  for all using (public.org_role(organisation_id) = 'owner')
  with check (public.org_role(organisation_id) = 'owner');

create policy site_memberships_read on public.site_memberships
  for select using (user_id = auth.uid() or public.can_write_org(public.site_org(site_id)));

create policy site_memberships_write on public.site_memberships
  for all using (public.can_write_org(public.site_org(site_id)))
  with check (public.can_write_org(public.site_org(site_id)));

create policy locations_read on public.locations
  for select using (public.can_access_site(site_id));

create policy locations_write on public.locations
  for all using (public.can_write_org(public.site_org(site_id)))
  with check (public.can_write_org(public.site_org(site_id)));

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

create policy items_read on public.items
  for select using (public.is_org_member(organisation_id));

create policy items_write on public.items
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy item_aliases_read on public.item_aliases
  for select using (exists (
    select 1 from public.items i
    where i.id = item_id and public.is_org_member(i.organisation_id)));

create policy item_aliases_write on public.item_aliases
  for all using (exists (
    select 1 from public.items i
    where i.id = item_id and public.can_write_org(i.organisation_id)))
  with check (exists (
    select 1 from public.items i
    where i.id = item_id and public.can_write_org(i.organisation_id)));

create policy item_barcodes_read on public.item_barcodes
  for select using (exists (
    select 1 from public.items i
    where i.id = item_id and public.is_org_member(i.organisation_id)));

create policy item_barcodes_write on public.item_barcodes
  for all using (exists (
    select 1 from public.items i
    where i.id = item_id and public.can_write_org(i.organisation_id)))
  with check (exists (
    select 1 from public.items i
    where i.id = item_id and public.can_write_org(i.organisation_id)));

create policy source_systems_read on public.source_systems
  for select using (public.is_org_member(organisation_id));

create policy source_systems_write on public.source_systems
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy item_source_identities_read on public.item_source_identities
  for select using (exists (
    select 1 from public.source_systems s
    where s.id = source_system_id and public.is_org_member(s.organisation_id)));

create policy item_source_identities_write on public.item_source_identities
  for all using (exists (
    select 1 from public.source_systems s
    where s.id = source_system_id and public.can_write_org(s.organisation_id)))
  with check (exists (
    select 1 from public.source_systems s
    where s.id = source_system_id and public.can_write_org(s.organisation_id)));

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------

create policy import_runs_read on public.import_runs
  for select using (public.is_org_member(organisation_id));

create policy import_runs_write on public.import_runs
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy import_rows_read on public.import_rows
  for select using (exists (
    select 1 from public.import_runs r
    where r.id = import_run_id and public.is_org_member(r.organisation_id)));

create policy import_rows_write on public.import_rows
  for all using (exists (
    select 1 from public.import_runs r
    where r.id = import_run_id and public.can_write_org(r.organisation_id)))
  with check (exists (
    select 1 from public.import_runs r
    where r.id = import_run_id and public.can_write_org(r.organisation_id)));

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

create policy book_snapshots_read on public.book_snapshots
  for select using (public.can_access_site(site_id));

create policy book_snapshots_write on public.book_snapshots
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy count_sessions_read on public.count_sessions
  for select using (public.can_access_site(site_id));

create policy count_sessions_write on public.count_sessions
  for all using (public.can_count_org(organisation_id) and public.can_access_site(site_id))
  with check (public.can_count_org(organisation_id) and public.can_access_site(site_id));

create policy count_lines_read on public.count_lines
  for select using (public.can_access_site(site_id));

-- Counters insert. Nobody updates: a correction is a new row that supersedes.
create policy count_lines_insert on public.count_lines
  for insert with check (
    public.can_count_org(organisation_id) and public.can_access_site(site_id));

-- The one permitted update is marking a line superseded, and only by someone
-- who could have written it in the first place.
create policy count_lines_supersede on public.count_lines
  for update using (public.can_count_org(organisation_id) and public.can_access_site(site_id))
  with check (public.can_count_org(organisation_id) and public.can_access_site(site_id));

create policy movements_read on public.movements
  for select using (public.can_access_site(site_id));

create policy movements_write on public.movements
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------

create policy reconciliation_runs_read on public.reconciliation_runs
  for select using (public.can_access_site(site_id));

create policy reconciliation_runs_write on public.reconciliation_runs
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy reconciliation_results_read on public.reconciliation_results
  for select using (public.can_access_site(site_id));

create policy reconciliation_results_write on public.reconciliation_results
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy reconciliation_issues_read on public.reconciliation_issues
  for select using (public.can_access_site(site_id));

create policy reconciliation_issues_write on public.reconciliation_issues
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy reconciliation_policies_read on public.reconciliation_policies
  for select using (public.can_access_site(site_id));

create policy reconciliation_policies_write on public.reconciliation_policies
  for all using (public.can_write_org(public.site_org(site_id)))
  with check (public.can_write_org(public.site_org(site_id)));

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Readable by anyone in the org; the triggers in 0005 stop anyone changing it.
-- Writes go through the service role from the server, so there is no insert
-- policy for browser clients on purpose.
create policy audit_events_read on public.audit_events
  for select using (public.is_org_member(organisation_id));

--
-- Application mutations run under `set local role authenticated` so RLS is
-- active. Those mutations must be able to append their own audit row inside
-- the same transaction; otherwise the business change succeeds until the
-- audit insert is attempted and the whole transaction rolls back.
--
-- Audit remains append-only: 0005 still rejects UPDATE and DELETE.

drop policy if exists audit_events_insert_user on public.audit_events;

create policy audit_events_insert_user on public.audit_events
  for insert
  to authenticated
  with check (
    actor_type = 'user'
    and actor_user_id = auth.uid()
    and public.is_org_member(organisation_id)
    and (
      site_id is null
      or (
        public.can_access_site(site_id)
        and public.site_org(site_id) = organisation_id
      )
    )
  );

-- ============================================================================
-- supabase/migrations/0007_variance.sql
-- ============================================================================
-- The engine works out two separate numbers and 0004 only had somewhere to put
-- one of them.
--
--   derived_quantity  - what is on the shelf now, anchored on the count
--   variance_at_count - how wrong the book was when somebody last looked
--
-- They answer different questions and go stale at different rates. A business
-- wants the first to run the place and the second to decide whether its records
-- are worth anything, so both need storing rather than one being recomputed on
-- demand from evidence that may since have changed.

alter table public.reconciliation_results
  add column variance_at_count numeric,
  -- The book figure carried forward to the moment of the count, which is what
  -- the variance is measured against. Stored so the arithmetic can be shown
  -- rather than asserted.
  add column book_at_count numeric;

comment on column public.reconciliation_results.variance_at_count is
  'Counted quantity minus the book carried forward to the count. Null when the movement window between them is not complete enough to make the comparison mean anything.';

comment on column public.reconciliation_results.derived_quantity is
  'Best supported current position. Null whenever the evidence does not support exactly one answer.';

-- ============================================================================
-- supabase/migrations/0008_blind_count_and_resolution.sql
-- ============================================================================
-- Two things the first pass got wrong.
--
-- 1. Blind counting.
--
--    The count screen showed the book figure before the counter typed a
--    number. That biases the count: you see 40, you find roughly 40, you
--    write 40. The physical count is the only independent evidence in this
--    system and anchoring it to the number it is meant to check makes it
--    worth less than nothing, because it now looks like agreement.
--
--    Blind is the default. Some operations genuinely want the expected figure
--    visible (a two-person check where one reads and one verifies), so it is
--    a policy rather than a rule, and turning it off is a decision somebody
--    has to make on purpose.
--
-- 2. What happens to a discrepancy.
--
--    An issue could be open or resolved and nothing said what a person was
--    supposed to do in between. Accept it, recount it, or investigate it are
--    different decisions with different consequences, and which one was taken
--    matters more later than the fact that somebody closed it.

alter table public.reconciliation_policies
  add column blind_count boolean not null default true,
  -- After a count is saved, show what the book said. That is not biasing;
  -- the observation is already recorded and cannot be changed by seeing it.
  add column reveal_after_count boolean not null default true,
  -- A manual adjustment without a reason is an unexplained change to the
  -- record, which is the thing this product exists to make impossible.
  add column require_note_on_accept boolean not null default true;

comment on column public.reconciliation_policies.blind_count is
  'Hide the expected quantity until the counter has committed to a number. On by default: a count that was shown the answer is not evidence.';

-- How a person dealt with an issue, rather than merely that they closed it.
create type public.issue_resolution as enum (
  'accepted',      -- the difference is real and the count stands
  'recount',       -- not trusted, somebody is going back to look
  'investigating', -- picked up, cause not yet known
  'data_fixed',    -- the underlying record was corrected
  'not_an_issue'   -- the engine was being over-cautious here
);

alter table public.reconciliation_issues
  add column resolution public.issue_resolution,
  -- Set when a resolution asks for a recount, so the count screen can offer
  -- the item rather than waiting for somebody to remember.
  add column recount_requested boolean not null default false;

-- Anything already closed predates the idea of recording how, and the engine
-- closes issues itself when they stop being reported. Those are legitimate and
-- get labelled rather than deleted, because rewriting history to satisfy a new
-- constraint is the exact habit this schema exists to prevent.
update public.reconciliation_issues
   set resolution = 'not_an_issue',
       resolution_note = coalesce(nullif(trim(resolution_note), ''), 'Closed before resolutions were recorded')
 where status = 'resolved' and resolution is null;

-- Closing an issue without saying how is what turns an audit trail back into
-- a list of timestamps. Enforced here rather than in a form handler, because
-- the form is not the only way rows get written.
alter table public.reconciliation_issues
  add constraint resolved_issues_explain_themselves
  check (
    status <> 'resolved'
    or (resolution is not null and coalesce(length(trim(resolution_note)), 0) > 0)
  );

create index reconciliation_issues_recount_idx
  on public.reconciliation_issues (site_id)
  where recount_requested and status = 'open';

-- ============================================================================
-- supabase/seed.sql
-- ============================================================================
-- Demo data: Northgate Brewing Co.
--
-- A small brewery with about two dozen lines. Everything in here is invented,
-- but the mess is not decorative. Each defect below is one that turns up in
-- real stock data, and each one makes the engine produce a different answer:
--
--   * a book import with no as-at date on some rows
--   * a delivery that landed before a count but was keyed in after it
--   * movements that arrived with no item attached
--   * one code covering two physically different things
--   * a barcode printed on two products
--   * a book figure in the wrong unit
--   * a receipt entered twice
--   * counts that have gone out of date
--   * items nobody has ever counted
--   * a feed that stopped delivering four days ago
--
-- Fixed UUIDs so tests and screenshots can refer to specific rows.
-- Times are relative to now() so the demo never goes stale.

-- The demo user. On a real project this is a Supabase auth user; here we make
-- one so counted_by has something to point at.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-000000000001', 'sam@northgatebrewing.example'),
  ('11111111-1111-4111-8111-000000000002', 'rana@northgatebrewing.example')
on conflict do nothing;

insert into public.organisations (id, name) values
  ('a0000000-0000-4000-8000-000000000001', 'Northgate Brewing Co.');

insert into public.sites (id, organisation_id, name, timezone) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Northgate Brewery', 'Europe/London');

insert into public.memberships (organisation_id, user_id, role) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000001', 'owner'),
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000002', 'counter');

insert into public.reconciliation_policies (site_id, stale_after_days, book_stale_after_days, require_location)
values ('b0000000-0000-4000-8000-000000000001', 30, 14, false);

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------

insert into public.locations (id, site_id, code, name) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'DRY-01', 'Dry store, racking A'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'DRY-02', 'Dry store, racking B'),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'COLD-01', 'Cold store'),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'PACK-01', 'Packaging bay'),
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'CELLAR', 'Cellar');

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------

insert into public.source_systems (id, organisation_id, name, source_type, expected_sync_minutes, last_success_at) values
  -- Runs hourly. Has not run for four days, which is the point.
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Warehouse export', 'google_sheets', 60, now() - interval '4 days'),
  -- Manual. Silence means nothing.
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Monthly stock spreadsheet', 'csv_upload', null, now() - interval '19 days');

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

-- created_at matters as much as the content. Knowledge time is what lets the
-- system answer "what did we think we had last Tuesday" with the evidence that
-- existed last Tuesday, so the demo has to carry realistic arrival times rather
-- than stamping everything with the moment the seed ran.
insert into public.items (id, organisation_id, sku, name, stock_unit, active, blocked, blocked_reason, created_at) values
  -- malt
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'MLT-PALE-25',  'Maris Otter pale malt 25kg', 'sack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'MLT-CRYS-25',  'Crystal malt 150L 25kg',     'sack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'MLT-CHOC-25',  'Chocolate malt 25kg',        'sack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'MLT-WHEA-25',  'Torrified wheat 25kg',       'sack', true, false, null, now() - interval '120 days'),
  -- hops. Harvest year matters and the codes do not carry it, which is how
  -- HOP-CAS-5 ended up meaning two different things.
  ('e0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'HOP-CAS-5',    'Cascade hop pellets 5kg',    'box',  true, true,
     'Same code used for 2023 and 2024 harvest. Split before counting.', now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'HOP-CTZ-5',    'Columbus hop pellets 5kg',   'box',  true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'HOP-EKG-5',    'East Kent Goldings 5kg',     'box',  true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', 'HOP-MOS-5',    'Mosaic hop pellets 5kg',     'box',  true, false, null, now() - interval '120 days'),
  -- yeast
  ('e0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'YST-A04-PK',   'Ale yeast A04 pitch pack',   'pack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001', 'YST-L17-PK',   'Lager yeast L17 pitch pack', 'pack', true, false, null, now() - interval '120 days'),
  -- packaging
  ('e0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'PKG-CAN-440',  'Can 440ml unprinted',        'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'PKG-CAN-330',  'Can 330ml unprinted',        'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001', 'PKG-LID-440',  'Can end 202 diameter',       'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000001', 'PKG-CRT-24',   'Carton, 24 can',             'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000001', 'LBL-NGP-440',  'Northgate Pale label 440ml', 'roll', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000016', 'a0000000-0000-4000-8000-000000000001', 'LBL-NGS-440',  'Northgate Stout label 440ml','roll', true, false, null, now() - interval '120 days'),
  -- kegs and gas
  ('e0000000-0000-4000-8000-000000000017', 'a0000000-0000-4000-8000-000000000001', 'KEG-30L-S',    'Keg 30L stainless',          'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000018', 'a0000000-0000-4000-8000-000000000001', 'KEG-50L-S',    'Keg 50L stainless',          'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000019', 'a0000000-0000-4000-8000-000000000001', 'GAS-CO2-6',    'CO2 cylinder 6kg',           'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000020', 'a0000000-0000-4000-8000-000000000001', 'GAS-MIX-20',   'Mixed gas cylinder 20kg',    'each', true, false, null, now() - interval '120 days'),
  -- cleaning and misc
  ('e0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000001', 'CLN-CAU-25',   'Caustic cleaner 25L',        'drum', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000022', 'a0000000-0000-4000-8000-000000000001', 'CLN-PAA-20',   'Peracetic sanitiser 20L',    'drum', true, false, null, now() - interval '120 days'),
  -- retired but still on the shelf
  ('e0000000-0000-4000-8000-000000000023', 'a0000000-0000-4000-8000-000000000001', 'LBL-OLD-440',  'Old branding label 440ml',   'roll', false, false, null, now() - interval '120 days'),
  -- never counted, never received. Exists in the catalogue and nowhere else.
  ('e0000000-0000-4000-8000-000000000024', 'a0000000-0000-4000-8000-000000000001', 'MLT-RYE-25',   'Rye malt 25kg',              'sack', true, false, null, now() - interval '120 days');

-- Two products, one barcode. The scanner has to ask rather than pick.
insert into public.item_barcodes (item_id, barcode) values
  ('e0000000-0000-4000-8000-000000000011', '5012345000114'),
  ('e0000000-0000-4000-8000-000000000012', '5012345000121'),
  ('e0000000-0000-4000-8000-000000000015', '5012345000152'),
  ('e0000000-0000-4000-8000-000000000016', '5012345000152'),  -- same barcode, different label
  ('e0000000-0000-4000-8000-000000000017', '5012345000176'),
  ('e0000000-0000-4000-8000-000000000018', '5012345000183');

insert into public.item_aliases (item_id, alias, alias_type) values
  ('e0000000-0000-4000-8000-000000000001', 'PALE25',     'legacy_sku'),
  ('e0000000-0000-4000-8000-000000000001', 'Maris',      'shop_floor_name'),
  ('e0000000-0000-4000-8000-000000000019', 'CO2 small',  'shop_floor_name'),
  ('e0000000-0000-4000-8000-000000000020', 'Big gas',    'shop_floor_name');

-- ---------------------------------------------------------------------------
-- Book position
--
-- One bulk import, 19 days ago, of a monthly spreadsheet that was itself
-- already a week out of date when it was exported. Two rows carry no as-at
-- date because that column was blank in the file.
-- ---------------------------------------------------------------------------

insert into public.import_runs (id, organisation_id, site_id, source_system_id, import_kind, status, source_filename, row_count, started_at, committed_at)
values ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
        'book_position', 'committed', 'stock-may.csv', 22,
        now() - interval '19 days', now() - interval '19 days');

insert into public.book_snapshots
  (organisation_id, site_id, item_id, location_id, quantity, unit, as_of, source_system_id, import_run_id, created_at)
values
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001', 40,   'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001', 12,   'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000001', 6,    'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001', 9,    'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000003', 8,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000003', 5,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000007','c0000000-0000-4000-8000-000000000003', 3,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000003', 4,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000003', 14,   'pack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000010','c0000000-0000-4000-8000-000000000003', 6,    'pack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004', 19200,'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000004', 7440, 'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004', 24000,'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004', 620,  'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  -- as-at blank in the source file. Cannot be placed in time.
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000015','c0000000-0000-4000-8000-000000000004', 11,   'roll', null,                        'd0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000016','c0000000-0000-4000-8000-000000000004', 7,    'roll', null,                        'd0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005', 148,  'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000018','c0000000-0000-4000-8000-000000000005', 62,   'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000019','c0000000-0000-4000-8000-000000000005', 9,    'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000020','c0000000-0000-4000-8000-000000000005', 4,    'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  -- exported in litres while the item is held in drums. Refused, not converted.
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000021','c0000000-0000-4000-8000-000000000002', 75,   'L',    now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000022','c0000000-0000-4000-8000-000000000002', 3,    'drum', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days');

-- ---------------------------------------------------------------------------
-- Counts
--
-- Two sessions. An old one from seven weeks ago that has gone stale, and a
-- recent one that covered most but not all of the store.
-- ---------------------------------------------------------------------------

insert into public.count_sessions (id, organisation_id, site_id, name, status, started_by, started_at, completed_at, source_watermark) values
  ('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Quarter end', 'completed', '11111111-1111-4111-8111-000000000001',
   now() - interval '49 days', now() - interval '49 days', now() - interval '49 days'),
  ('10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Monday walk round', 'completed', '11111111-1111-4111-8111-000000000002',
   now() - interval '3 days', now() - interval '3 days', now() - interval '3 days' - interval '20 minutes');

-- Stale session: only cleaning chemicals, and nobody has been back since.
insert into public.count_lines
  (count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_by, counted_at, received_at, method, created_at)
values
  ('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000022','c0000000-0000-4000-8000-000000000002', 3, 'drum', '11111111-1111-4111-8111-000000000001', now() - interval '49 days', now() - interval '49 days', 'manual', now() - interval '49 days');

-- Recent session.
insert into public.count_lines
  (id, count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_by, counted_at, received_at, method, note, created_at)
values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001', 38,   'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001', 10,   'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000001', 6,    'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001', 7,    'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  -- the big one. Counted at 11:05, and a pallet was booked in at 14:00 that
  -- had physically arrived at 11:00.
  ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004', 27600,'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000004', 7440, 'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004', 23500,'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004', 604,  'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  -- counted with no location recorded
  ('20000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000019', null,                                    7,    'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'manual', 'found by the loading door', now() - interval '3 days'),
  -- an empty shelf. Zero is an observation, not a blank.
  ('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000010','c0000000-0000-4000-8000-000000000003', 0,    'pack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', 'none left', now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000003', 11,   'pack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  -- retired item still physically present
  ('20000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000023','c0000000-0000-4000-8000-000000000004', 2,    'roll', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'manual', 'old labels still on the shelf', now() - interval '3 days'),
  -- counted on a handset whose clock was 35 minutes fast
  ('20000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005', 141,  'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days' + interval '35 minutes', now() - interval '3 days', 'scan', null, now() - interval '3 days');

-- ---------------------------------------------------------------------------
-- Movements
-- ---------------------------------------------------------------------------

insert into public.movements
  (id, organisation_id, site_id, item_id, location_id, movement_type, quantity, unit, occurred_at, recorded_at, imported_at, source_system_id, source_event_id, source_reference)
values
  -- routine issues to brew days, all clean
  ('30000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','ISSUE',   6, 'sack', now() - interval '2 days',  now() - interval '2 days',  now() - interval '2 days',  'd0000000-0000-4000-8000-000000000001','WE-10041','Brew 241'),
  ('30000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001','ISSUE',   1, 'sack', now() - interval '2 days',  now() - interval '2 days',  now() - interval '2 days',  'd0000000-0000-4000-8000-000000000001','WE-10042','Brew 241'),
  ('30000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','RECEIVE',20, 'sack', now() - interval '1 day',   now() - interval '1 day',   now() - interval '1 day',   'd0000000-0000-4000-8000-000000000001','WE-10055','PO-8821'),

  -- the pallet of cans. Physically arrived an hour before the counter reached
  -- the packaging bay; keyed in three hours after.
  ('30000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004','RECEIVE',8400,'each',
     now() - interval '3 days' - interval '1 hour',
     now() - interval '3 days' + interval '3 hours',
     now() - interval '3 days' + interval '3 hours',
     'd0000000-0000-4000-8000-000000000001','WE-10048','PO-8817'),

  -- entered twice, four minutes apart, same quantity
  ('30000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004','RECEIVE',200,'each', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10050','PO-8819'),
  ('30000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004','RECEIVE',200,'each', now() - interval '2 days' + interval '4 minutes', now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10051','PO-8819'),

  -- kegs going out and coming back
  ('30000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005','ISSUE',  24,'each', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10052','Trade order 4412'),
  ('30000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005','RETURN', 18,'each', now() - interval '1 day',  now() - interval '1 day',  now() - interval '1 day',  'd0000000-0000-4000-8000-000000000001','WE-10057','Empties in'),

  -- an issue with no date on it in the source export
  ('30000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004','ISSUE', 1200,'each', null, now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10053','Canning run'),

  -- more issued than the count plus receipts can support
  ('30000000-0000-4000-8000-000000000010','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000003','ISSUE',  14,'each', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'd0000000-0000-4000-8000-000000000001','WE-10058','Brew 242'),

  -- a transfer between locations, both halves correlated
  ('30000000-0000-4000-8000-000000000011','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000004','TRANSFER_OUT',1200,'each', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day','d0000000-0000-4000-8000-000000000001','WE-10059','Move to line'),
  ('30000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000002','TRANSFER_IN', 1200,'each', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day','d0000000-0000-4000-8000-000000000001','WE-10060','Move to line'),

  -- arrived in litres against an item held in drums
  ('30000000-0000-4000-8000-000000000013','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000021','c0000000-0000-4000-8000-000000000002','RECEIVE', 50,'L', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days','d0000000-0000-4000-8000-000000000001','WE-10054','PO-8820');

update public.movements set transfer_correlation_id = '40000000-0000-4000-8000-000000000001'
where id in ('30000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000012');

-- Movements the import could not attach to any item. Their existence is why
-- nothing at this site can be called fully verified until someone links them.
insert into public.movements
  (organisation_id, site_id, item_id, location_id, movement_type, quantity, unit, occurred_at, recorded_at, imported_at, source_system_id, source_event_id, source_reference, raw_payload)
values
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001', null, null, 'RECEIVE', 4, 'box', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days','d0000000-0000-4000-8000-000000000001','WE-10056','PO-8822', '{"code":"HOP-CAS-5","note":"which harvest?"}'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001', null, null, 'ISSUE',   2, 'box', now() - interval '1 day',  now() - interval '1 day',  now() - interval '1 day', 'd0000000-0000-4000-8000-000000000001','WE-10061','Brew 242', '{"code":"HOPCAS5","note":"code not in catalogue"}'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001', null, null, 'RECEIVE', 1, 'each',now() - interval '5 days', now() - interval '5 days', now() - interval '5 days','d0000000-0000-4000-8000-000000000001','WE-10030','PO-8810', '{"code":"","note":"blank code in export"}');
