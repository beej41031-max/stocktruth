-- StockTruth v0.4.4 one-shot demo setup
-- Generated from migrations 0001..0014, then seed.sql.

-- ===== 0001_core.sql =====
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

-- ===== 0002_catalogue.sql =====
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

-- ===== 0003_evidence.sql =====
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

-- ===== 0004_reconciliation.sql =====
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

-- ===== 0005_audit.sql =====
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

-- ===== 0006_rls.sql =====
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

-- Readable by anyone in the org. UPDATE and DELETE are blocked by the
-- append-only triggers in 0005.
--
-- User-driven server actions deliberately run as `authenticated` so RLS protects
-- the business mutation. 0009 adds the matching INSERT policy that lets the same
-- transaction append its own audit row without granting broader write access.
create policy audit_events_read on public.audit_events
  for select using (public.is_org_member(organisation_id));

-- ===== 0007_variance.sql =====
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

-- ===== 0008_blind_count_and_resolution.sql =====
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

-- ===== 0009_audit_user_insert.sql =====
-- 0009_audit_user_insert.sql
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

-- ===== 0010_material_variance.sql =====
-- 0010_material_variance.sql
--
-- v0.4.0: the second count becomes a product, not just another stock number.
--
-- Two physical observations close a measurement interval. Receipts and known
-- non-consumption transfers explain external flows. The residual is actual
-- material use. Production output multiplied by the BOM effective when that
-- output completed gives theoretical use. The difference is material variance.
--
-- Crucially, posting a stock adjustment later does not erase this interval.
-- Conclusions are append-only snapshots just like reconciliation results.

alter table public.items
  add column standard_unit_cost numeric check (standard_unit_cost is null or standard_unit_cost >= 0),
  add column cost_currency text not null default 'GBP' check (length(cost_currency) = 3),
  add column target_count_cycle_days integer not null default 30 check (target_count_cycle_days > 0);

comment on column public.items.target_count_cycle_days is
  'Desired repeat-count cadence. High-value/high-variance materials can be weekly while low-value lines remain monthly.';

-- Processing success is not the same as event-time completeness. This is the
-- latest occurrence time the source explicitly says is complete.
alter table public.source_systems
  add column event_watermark_at timestamptz;

comment on column public.source_systems.event_watermark_at is
  'Event-time completeness watermark. Evidence before this instant is expected to have arrived; later events may still be outstanding.';

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  code             text not null,
  name             text not null,
  output_unit      text not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (organisation_id, code)
);

create table public.bom_versions (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  version     text not null,
  valid_from  timestamptz not null,
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  unique (product_id, version)
);

create index bom_versions_effective_idx
  on public.bom_versions (product_id, valid_from, valid_to);

create table public.bom_lines (
  id                  uuid primary key default gen_random_uuid(),
  bom_version_id      uuid not null references public.bom_versions(id) on delete cascade,
  item_id             uuid not null references public.items(id) on delete restrict,
  quantity_per_output numeric not null check (quantity_per_output >= 0),
  unit                text not null,
  created_at          timestamptz not null default now(),
  unique (bom_version_id, item_id)
);

create index bom_lines_item_idx on public.bom_lines (item_id);

create table public.production_outputs (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid not null references public.sites(id) on delete cascade,
  product_id        uuid not null references public.products(id) on delete restrict,
  quantity          numeric not null check (quantity >= 0),
  unit              text not null,
  -- Event time. This chooses the BOM version and the count interval.
  completed_at      timestamptz not null,
  -- Knowledge time. Kept separate for the same reason movements carry both.
  recorded_at       timestamptz,
  imported_at       timestamptz not null default now(),
  source_system_id  uuid references public.source_systems(id) on delete set null,
  source_event_id   text,
  source_reference  text,
  raw_payload       jsonb,
  unique (source_system_id, source_event_id)
);

create index production_outputs_window_idx
  on public.production_outputs (site_id, completed_at, product_id);

create type public.material_variance_state as enum (
  'CLOSED',       -- both counts, external flows, watermark and theory support the result
  'PROVISIONAL',  -- arithmetic exists but the movement feed has not closed through the second count
  'ACTUAL_ONLY',  -- physical consumption is measurable; theory/BOM is incomplete
  'INCOMPLETE',   -- physical interval cannot be safely measured
  'CONFLICT'      -- the evidence contradicts conservation/chronology
);

create table public.material_variance_runs (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  site_id           uuid not null references public.sites(id) on delete cascade,
  engine_version    text not null,
  evaluated_at      timestamptz not null,
  triggered_by      uuid references auth.users(id),
  trigger_reason    text,
  interval_count    integer not null default 0,
  started_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create table public.material_variance_results (
  id                        uuid primary key default gen_random_uuid(),
  material_variance_run_id  uuid not null references public.material_variance_runs(id) on delete cascade,
  organisation_id           uuid not null references public.organisations(id) on delete cascade,
  site_id                   uuid not null references public.sites(id) on delete cascade,
  item_id                   uuid not null references public.items(id) on delete cascade,
  location_id               uuid references public.locations(id) on delete set null,
  opening_count_line_id     uuid not null references public.count_lines(id) on delete restrict,
  closing_count_line_id     uuid not null references public.count_lines(id) on delete restrict,
  state                     public.material_variance_state not null,
  interval_start            timestamptz not null,
  interval_end              timestamptz not null,
  opening_quantity          numeric not null,
  closing_quantity          numeric not null,
  receipts                  numeric not null default 0,
  transfer_in               numeric not null default 0,
  returns_in                numeric not null default 0,
  transfer_out              numeric not null default 0,
  actual_consumption        numeric,
  theoretical_consumption   numeric,
  variance_quantity         numeric,
  variance_percent          numeric,
  unit_cost                 numeric,
  variance_cost             numeric,
  cost_currency             text not null default 'GBP',
  movement_watermark        timestamptz,
  late_movement_count       integer not null default 0,
  reason_codes              text[] not null default '{}',
  evidence                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now()
);

create index material_variance_latest_idx
  on public.material_variance_results (site_id, item_id, location_id, interval_end desc, created_at desc);
create index material_variance_cost_idx
  on public.material_variance_results (site_id, interval_end desc, variance_cost)
  where variance_cost is not null;

-- ---------------------------------------------------------------------------
-- RLS: same tenant boundary as the rest of the product.
-- ---------------------------------------------------------------------------

alter table public.products enable row level security;
alter table public.bom_versions enable row level security;
alter table public.bom_lines enable row level security;
alter table public.production_outputs enable row level security;
alter table public.material_variance_runs enable row level security;
alter table public.material_variance_results enable row level security;

create policy products_read on public.products
  for select using (public.is_org_member(organisation_id));
create policy products_write on public.products
  for all using (public.can_write_org(organisation_id))
  with check (public.can_write_org(organisation_id));

create policy bom_versions_read on public.bom_versions
  for select using (exists (
    select 1 from public.products p where p.id = product_id and public.is_org_member(p.organisation_id)
  ));
create policy bom_versions_write on public.bom_versions
  for all using (exists (
    select 1 from public.products p where p.id = product_id and public.can_write_org(p.organisation_id)
  ))
  with check (exists (
    select 1 from public.products p where p.id = product_id and public.can_write_org(p.organisation_id)
  ));

create policy bom_lines_read on public.bom_lines
  for select using (exists (
    select 1 from public.bom_versions bv join public.products p on p.id = bv.product_id
     where bv.id = bom_version_id and public.is_org_member(p.organisation_id)
  ));
create policy bom_lines_write on public.bom_lines
  for all using (exists (
    select 1 from public.bom_versions bv join public.products p on p.id = bv.product_id
     where bv.id = bom_version_id and public.can_write_org(p.organisation_id)
  ))
  with check (exists (
    select 1 from public.bom_versions bv join public.products p on p.id = bv.product_id
     where bv.id = bom_version_id and public.can_write_org(p.organisation_id)
  ));

create policy production_outputs_read on public.production_outputs
  for select using (public.can_access_site(site_id));
create policy production_outputs_write on public.production_outputs
  for all using (
    public.can_write_org(organisation_id)
    and public.can_access_site(site_id)
    and public.site_org(site_id) = organisation_id
    and exists (select 1 from public.products p where p.id = product_id and p.organisation_id = organisation_id)
  )
  with check (
    public.can_write_org(organisation_id)
    and public.can_access_site(site_id)
    and public.site_org(site_id) = organisation_id
    and exists (select 1 from public.products p where p.id = product_id and p.organisation_id = organisation_id)
  );

create policy material_variance_runs_read on public.material_variance_runs
  for select using (public.can_access_site(site_id));
create policy material_variance_runs_write on public.material_variance_runs
  for all using (public.can_write_org(organisation_id) and public.can_access_site(site_id) and public.site_org(site_id) = organisation_id)
  with check (public.can_write_org(organisation_id) and public.can_access_site(site_id) and public.site_org(site_id) = organisation_id);

create policy material_variance_results_read on public.material_variance_results
  for select using (public.can_access_site(site_id));
create policy material_variance_results_write on public.material_variance_results
  for all using (public.can_write_org(organisation_id) and public.can_access_site(site_id) and public.site_org(site_id) = organisation_id)
  with check (public.can_write_org(organisation_id) and public.can_access_site(site_id) and public.site_org(site_id) = organisation_id);

-- ===== 0011_variance_safety.sql =====
-- 0011_variance_safety.sql
-- v0.4.1: close the ways a plausible-looking variance could be wrong.

-- A manual/spreadsheet business has no automated event watermark. The second
-- count can close an interval only when a person explicitly attests that the
-- relevant evidence has been entered through the count cutoff. Movement and
-- production are separate assertions because many small factories track one
-- well and the other badly.
alter table public.count_sessions
  add column movement_evidence_confirmed_through timestamptz,
  add column production_evidence_confirmed_through timestamptz,
  add column evidence_confirmed_by uuid references auth.users(id),
  add column evidence_confirmation_note text;

comment on column public.count_sessions.movement_evidence_confirmed_through is
  'Manual evidence-cutoff attestation: receipts, transfers and returns are complete through this instant.';
comment on column public.count_sessions.production_evidence_confirmed_through is
  'Manual evidence-cutoff attestation: production output is complete through this instant.';

-- Preserve both independent timelines in stored variance results.
alter table public.material_variance_results
  add column production_watermark timestamptz,
  add column late_production_count integer not null default 0;

comment on column public.material_variance_results.production_watermark is
  'Event-time completeness watermark for production output, independent of movement completeness.';

-- ===== 0012_attestation_and_closure.sql =====
-- 0012_attestation_and_closure.sql
-- v0.4.2: evidence closure is an office assertion, not a counter checkbox.

-- A watermark needs two times: how far through event-time the source claims to
-- be complete, and when StockTruth learned that claim. Without the second time
-- we cannot tell whether evidence arriving later invalidated an earlier close.
alter table public.source_systems
  add column event_watermark_updated_at timestamptz;

comment on column public.source_systems.event_watermark_updated_at is
  'Knowledge time of event_watermark_at. Stamped automatically when the event watermark advances; evidence arriving after this assertion reopens affected intervals.';

create or replace function public.stamp_event_watermark_updated_at()
returns trigger language plpgsql as $$
begin
  if new.event_watermark_at is distinct from old.event_watermark_at then
    new.event_watermark_updated_at := now();
  end if;
  return new;
end;
$$;

create trigger source_systems_event_watermark_stamp
before update of event_watermark_at on public.source_systems
for each row execute function public.stamp_event_watermark_updated_at();

-- Existing watermarks deliberately remain without a knowledge time on upgrade.
-- That makes affected intervals provisional until the connector advances the
-- watermark again and records when the claim was made; guessing this timestamp
-- would manufacture closure history.

-- Movement and production may be attested independently and by different
-- office users. The *_through value is the physical closing-count cutoff; the
-- *_at value is when the office/owner actually made the assertion.
alter table public.count_sessions
  add column movement_evidence_confirmed_at timestamptz,
  add column movement_evidence_confirmed_by uuid references auth.users(id),
  add column production_evidence_confirmed_at timestamptz,
  add column production_evidence_confirmed_by uuid references auth.users(id);

comment on column public.count_sessions.movement_evidence_confirmed_at is
  'When an owner/manager attested manual movement evidence complete through movement_evidence_confirmed_through.';
comment on column public.count_sessions.production_evidence_confirmed_at is
  'When an owner/manager attested manual production evidence complete through production_evidence_confirmed_through.';

alter table public.material_variance_results
  add column movement_watermark_observed_at timestamptz,
  add column production_watermark_observed_at timestamptz;

comment on column public.material_variance_results.movement_watermark_observed_at is
  'Knowledge time at which all required movement completeness claims supporting this result had been made.';
comment on column public.material_variance_results.production_watermark_observed_at is
  'Knowledge time at which all required production completeness claims supporting this result had been made.';

-- ===== 0013_historical_closure_and_db_guards.sql =====
-- 0013_historical_closure_and_db_guards.sql
-- v0.4.3: closure is historical evidence, and Postgres owns the safety boundary.

-- ---------------------------------------------------------------------------
-- 1. Immutable automated watermark history.
-- ---------------------------------------------------------------------------
-- A mutable "latest watermark" cannot answer a historical question. If a feed
-- first claimed on Tuesday that it was complete through Monday, a row imported
-- on Wednesday is late relative to that Tuesday promise forever; Thursday's
-- next sync must not rewrite that fact.
create table public.source_watermark_history (
  id                uuid primary key default gen_random_uuid(),
  organisation_id   uuid not null references public.organisations(id) on delete cascade,
  source_system_id  uuid not null references public.source_systems(id) on delete cascade,
  watermark_at      timestamptz not null,
  claimed_at        timestamptz not null default now()
);

create index source_watermark_history_lookup_idx
  on public.source_watermark_history (source_system_id, watermark_at, claimed_at);

comment on table public.source_watermark_history is
  'Append-only automated completeness claims. Historical intervals use the first claim that crossed their closing cutoff.';

alter table public.source_watermark_history enable row level security;

create policy source_watermark_history_read on public.source_watermark_history
  for select using (public.is_org_member(organisation_id));

-- Replace the v0.4.2 update-only stamp. Initial watermarks now receive a real
-- knowledge time too, so a newly configured connector does not remain
-- provisional until its second sync.
drop trigger if exists source_systems_event_watermark_stamp on public.source_systems;

create or replace function public.stamp_event_watermark_updated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.event_watermark_at is not null then
      new.event_watermark_updated_at := now();
    end if;
  elsif new.event_watermark_at is distinct from old.event_watermark_at then
    if new.event_watermark_at is null then
      new.event_watermark_updated_at := null;
    else
      new.event_watermark_updated_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger source_systems_event_watermark_stamp
before insert or update on public.source_systems
for each row execute function public.stamp_event_watermark_updated_at();

create or replace function public.capture_source_watermark_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.event_watermark_at is not null then
      insert into public.source_watermark_history
        (organisation_id, source_system_id, watermark_at, claimed_at)
      values
        (new.organisation_id, new.id, new.event_watermark_at,
         coalesce(new.event_watermark_updated_at, now()));
    end if;
  elsif new.event_watermark_at is not null
        and new.event_watermark_at is distinct from old.event_watermark_at then
    insert into public.source_watermark_history
      (organisation_id, source_system_id, watermark_at, claimed_at)
    values
      (new.organisation_id, new.id, new.event_watermark_at,
       coalesce(new.event_watermark_updated_at, now()));
  end if;
  return new;
end;
$$;

create trigger source_systems_watermark_history_capture
after insert or update on public.source_systems
for each row execute function public.capture_source_watermark_history();

-- Preserve any v0.4.2 claim whose knowledge time is genuinely known. Rows with
-- a null event_watermark_updated_at remain deliberately unclaimed rather than
-- inventing historical certainty during migration.
insert into public.source_watermark_history
  (organisation_id, source_system_id, watermark_at, claimed_at)
select organisation_id, id, event_watermark_at, event_watermark_updated_at
  from public.source_systems
 where event_watermark_at is not null
   and event_watermark_updated_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Count-session permissions: counters operate a session; office roles attest.
-- ---------------------------------------------------------------------------
-- The old FOR ALL policy also granted DELETE. Split it so count sessions cannot
-- be deleted through the authenticated API and leave update details to the
-- trigger below.
drop policy if exists count_sessions_write on public.count_sessions;

create policy count_sessions_insert on public.count_sessions
  for insert with check (
    public.can_count_org(organisation_id) and public.can_access_site(site_id));

create policy count_sessions_update on public.count_sessions
  for update using (
    public.can_count_org(organisation_id) and public.can_access_site(site_id))
  with check (
    public.can_count_org(organisation_id) and public.can_access_site(site_id));

-- A counter must not be able to pre-populate attestation fields on INSERT and
-- later complete the session without ever triggering the owner/manager check.
-- New sessions always begin as draft/open physical work; evidence closure is a
-- separate later transition after count lines exist.
create or replace function public.guard_count_session_insert()
returns trigger
language plpgsql
as $$
begin
  if new.status not in ('draft', 'open') then
    raise exception 'COUNT_SESSION_MUST_START_OPEN';
  end if;

  if new.completed_at is not null then
    raise exception 'COUNT_SESSION_COMPLETED_AT_REQUIRES_COMPLETION';
  end if;

  if new.movement_evidence_confirmed_through is not null
     or new.movement_evidence_confirmed_at is not null
     or new.movement_evidence_confirmed_by is not null
     or new.production_evidence_confirmed_through is not null
     or new.production_evidence_confirmed_at is not null
     or new.production_evidence_confirmed_by is not null
     or new.evidence_confirmed_by is not null
     or new.evidence_confirmation_note is not null then
    raise exception 'EVIDENCE_ATTESTATION_NOT_ALLOWED_ON_INSERT';
  end if;

  return new;
end;
$$;

create trigger count_sessions_guard_insert
before insert on public.count_sessions
for each row execute function public.guard_count_session_insert();

create or replace function public.guard_count_session_update()
returns trigger
language plpgsql
as $$
declare
  trusted_cutoff timestamptz;
  movement_attestation_changed boolean;
  production_attestation_changed boolean;
  protected_changed boolean;
  actor uuid;
begin
  actor := auth.uid();

  -- Identity and the start-of-count evidence boundary never mutate in place.
  if new.id is distinct from old.id
     or new.organisation_id is distinct from old.organisation_id
     or new.site_id is distinct from old.site_id
     or new.started_by is distinct from old.started_by
     or new.started_at is distinct from old.started_at
     or new.source_watermark is distinct from old.source_watermark
     or new.created_at is distinct from old.created_at then
    raise exception 'COUNT_SESSION_IMMUTABLE_FIELD';
  end if;

  movement_attestation_changed :=
       new.movement_evidence_confirmed_through is distinct from old.movement_evidence_confirmed_through
    or new.movement_evidence_confirmed_at is distinct from old.movement_evidence_confirmed_at
    or new.movement_evidence_confirmed_by is distinct from old.movement_evidence_confirmed_by;

  production_attestation_changed :=
       new.production_evidence_confirmed_through is distinct from old.production_evidence_confirmed_through
    or new.production_evidence_confirmed_at is distinct from old.production_evidence_confirmed_at
    or new.production_evidence_confirmed_by is distinct from old.production_evidence_confirmed_by;

  protected_changed := movement_attestation_changed
    or production_attestation_changed
    or new.evidence_confirmation_note is distinct from old.evidence_confirmation_note
    or new.evidence_confirmed_by is distinct from old.evidence_confirmed_by;

  -- A completed physical observation cannot be reopened or otherwise edited.
  -- The only later mutation is an office evidence attestation.
  if old.status = 'completed' then
    if (to_jsonb(new)
          - 'movement_evidence_confirmed_through'
          - 'movement_evidence_confirmed_at'
          - 'movement_evidence_confirmed_by'
          - 'production_evidence_confirmed_through'
          - 'production_evidence_confirmed_at'
          - 'production_evidence_confirmed_by'
          - 'evidence_confirmation_note'
          - 'evidence_confirmed_by')
       is distinct from
       (to_jsonb(old)
          - 'movement_evidence_confirmed_through'
          - 'movement_evidence_confirmed_at'
          - 'movement_evidence_confirmed_by'
          - 'production_evidence_confirmed_through'
          - 'production_evidence_confirmed_at'
          - 'production_evidence_confirmed_by'
          - 'evidence_confirmation_note'
          - 'evidence_confirmed_by') then
      raise exception 'COMPLETED_COUNT_SESSION_IMMUTABLE';
    end if;
  end if;

  if protected_changed then
    if old.status <> 'completed' or new.status <> 'completed' then
      raise exception 'EVIDENCE_ATTESTATION_REQUIRES_COMPLETED_SESSION';
    end if;

    -- service/background roles have no auth.uid(); authenticated people must be
    -- owner/manager. This makes the database, not the page, the authority.
    if actor is not null and not public.can_write_org(old.organisation_id) then
      raise exception 'EVIDENCE_ATTESTATION_REQUIRES_OWNER_OR_MANAGER';
    end if;

    -- Server receive time is the trusted evidence cutoff. A handset clock can
    -- be early/late; using the latest received_at is conservative for offline
    -- counts and cannot be pushed forward by a fast device clock.
    select max(cl.received_at)
      into trusted_cutoff
      from public.count_lines cl
     where cl.count_session_id = old.id
       and not cl.superseded;

    if trusted_cutoff is null then
      raise exception 'EVIDENCE_ATTESTATION_REQUIRES_COUNT_LINES';
    end if;

    if movement_attestation_changed then
      if new.movement_evidence_confirmed_through is null then
        raise exception 'EVIDENCE_ATTESTATION_CANNOT_BE_CLEARED';
      end if;
      new.movement_evidence_confirmed_through := trusted_cutoff;
      new.movement_evidence_confirmed_at := now();
      if actor is not null then new.movement_evidence_confirmed_by := actor; end if;
    end if;

    if production_attestation_changed then
      if new.production_evidence_confirmed_through is null then
        raise exception 'EVIDENCE_ATTESTATION_CANNOT_BE_CLEARED';
      end if;
      new.production_evidence_confirmed_through := trusted_cutoff;
      new.production_evidence_confirmed_at := now();
      if actor is not null then new.production_evidence_confirmed_by := actor; end if;
    end if;

    if actor is not null and (movement_attestation_changed or production_attestation_changed) then
      new.evidence_confirmed_by := actor;
    end if;
  end if;

  return new;
end;
$$;

create trigger count_sessions_guard_update
before update on public.count_sessions
for each row execute function public.guard_count_session_update();

-- ---------------------------------------------------------------------------
-- 3. Count lines: open-session inserts only; updates may only supersede an
--    existing open-session line. Completed physical evidence is immutable.
-- ---------------------------------------------------------------------------
drop policy if exists count_lines_insert on public.count_lines;
create policy count_lines_insert on public.count_lines
  for insert with check (
    public.can_count_org(organisation_id)
    and public.can_access_site(site_id)
    and exists (
      select 1 from public.count_sessions cs
       where cs.id = count_session_id
         and cs.organisation_id = organisation_id
         and cs.site_id = site_id
         and cs.status = 'open'
    )
  );

create or replace function public.guard_count_line_mutation()
returns trigger
language plpgsql
as $$
declare
  session_status public.count_status;
  session_org uuid;
  session_site uuid;
begin
  if tg_op = 'INSERT' then
    select cs.status, cs.organisation_id, cs.site_id
      into session_status, session_org, session_site
      from public.count_sessions cs
     where cs.id = new.count_session_id;

    if session_status is null or session_status <> 'open' then
      raise exception 'COUNT_LINE_REQUIRES_OPEN_SESSION';
    end if;
    if new.organisation_id is distinct from session_org or new.site_id is distinct from session_site then
      raise exception 'COUNT_LINE_SESSION_SCOPE_MISMATCH';
    end if;
    return new;
  end if;

  select cs.status
    into session_status
    from public.count_sessions cs
   where cs.id = old.count_session_id;

  if session_status is null or session_status <> 'open' then
    raise exception 'COMPLETED_COUNT_LINE_IMMUTABLE';
  end if;

  if old.superseded or not new.superseded then
    raise exception 'COUNT_LINE_UPDATE_ONLY_SUPERSEDES';
  end if;

  if (to_jsonb(new) - 'superseded') is distinct from (to_jsonb(old) - 'superseded') then
    raise exception 'COUNT_LINE_UPDATE_ONLY_SUPERSEDED_FLAG';
  end if;

  return new;
end;
$$;

create trigger count_lines_guard_insert
before insert on public.count_lines
for each row execute function public.guard_count_line_mutation();

create trigger count_lines_guard_update
before update on public.count_lines
for each row execute function public.guard_count_line_mutation();

-- ===== 0014_automated_evidence_review.sql =====
-- 0014_automated_evidence_review.sql
-- v0.4.4: late automated evidence can be reviewed and re-closed without
-- rewriting the source's original completeness claim. Client receive times are
-- server-authored.

-- ---------------------------------------------------------------------------
-- 1. Append-only owner/manager review of late automated evidence.
-- ---------------------------------------------------------------------------
create table public.automated_evidence_reviews (
  id                           uuid primary key default gen_random_uuid(),
  organisation_id              uuid not null references public.organisations(id) on delete cascade,
  site_id                      uuid not null references public.sites(id) on delete cascade,
  closing_count_session_id     uuid not null references public.count_sessions(id) on delete restrict,
  closing_count_line_id        uuid not null references public.count_lines(id) on delete restrict,
  evidence_kind                text not null check (evidence_kind in ('movement', 'production')),
  source_system_id             uuid not null references public.source_systems(id) on delete restrict,
  interval_start_at            timestamptz not null,
  interval_cutoff_at           timestamptz not null,
  baseline_watermark_at        timestamptz not null,
  baseline_claimed_at          timestamptz not null,
  reviewed_through_imported_at timestamptz not null,
  reviewed_evidence_count      integer not null check (reviewed_evidence_count > 0),
  reviewed_at                  timestamptz not null default now(),
  reviewed_by                  uuid not null references auth.users(id),
  note                         text,
  before_variance_run_id       uuid not null references public.material_variance_runs(id) on delete restrict,
  after_variance_run_id        uuid references public.material_variance_runs(id) on delete restrict,
  created_at                   timestamptz not null default now()
);

create index automated_evidence_reviews_lookup_idx
  on public.automated_evidence_reviews
    (closing_count_line_id, evidence_kind, source_system_id, reviewed_through_imported_at desc, reviewed_at desc);

comment on table public.automated_evidence_reviews is
  'Append-only owner/manager acknowledgements of late automated evidence. The original watermark claim remains immutable; a review only advances the knowledge cutoff for this historical count close. Future late rows reopen it again.';

alter table public.automated_evidence_reviews enable row level security;

create policy automated_evidence_reviews_read on public.automated_evidence_reviews
  for select using (public.can_access_site(site_id));

-- No direct INSERT/UPDATE/DELETE policy. Reviews are created/finalised only by
-- the guarded RPCs below so scope, actor, evidence cutoff and run references are
-- server-derived rather than client-authored.

create or replace function public.review_automated_evidence(
  p_site_id uuid,
  p_closing_count_line_id uuid,
  p_evidence_kind text,
  p_source_system_id uuid,
  p_note text,
  p_before_variance_run_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  org_id uuid;
  session_status public.count_status;
  session_id uuid;
  cutoff_at timestamptz;
  opening_at timestamptz;
  scope_item_id uuid;
  scope_location_id uuid;
  baseline_watermark timestamptz;
  baseline_claimed timestamptz;
  reviewed_through timestamptz;
  evidence_count integer;
  source_sync_minutes integer;
  review_id uuid;
begin
  if actor is null then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_USER';
  end if;

  if p_evidence_kind not in ('movement', 'production') then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_KIND_INVALID';
  end if;

  select cs.organisation_id, cs.status, cs.id, cl.counted_at, cl.item_id, cl.location_id
    into org_id, session_status, session_id, cutoff_at, scope_item_id, scope_location_id
    from public.count_lines cl
    join public.count_sessions cs on cs.id = cl.count_session_id
   where cl.id = p_closing_count_line_id
     and not cl.superseded
     and cs.site_id = p_site_id;

  if org_id is null or session_status <> 'completed' or cutoff_at is null then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_COMPLETED_SESSION';
  end if;

  if not public.can_write_org(org_id) or not public.can_access_site(p_site_id) then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_OWNER_OR_MANAGER';
  end if;

  select cl.counted_at
    into opening_at
    from public.count_lines cl
    join public.count_sessions cs on cs.id = cl.count_session_id
   where cl.site_id = p_site_id
     and cl.item_id = scope_item_id
     and cl.location_id is not distinct from scope_location_id
     and not cl.superseded
     and cs.status = 'completed'
     and cl.count_session_id <> session_id
     and cl.counted_at < cutoff_at
   order by cl.counted_at desc
   limit 1;

  if opening_at is null then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_REPEAT_COUNT_INTERVAL';
  end if;

  select ss.expected_sync_minutes
    into source_sync_minutes
    from public.source_systems ss
   where ss.id = p_source_system_id
     and ss.organisation_id = org_id;

  if not found or source_sync_minutes is null then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_AUTOMATED_SOURCE';
  end if;

  select h.watermark_at, h.claimed_at
    into baseline_watermark, baseline_claimed
    from public.source_watermark_history h
   where h.source_system_id = p_source_system_id
     and h.watermark_at >= cutoff_at
   order by h.claimed_at asc, h.id asc
   limit 1;

  if baseline_claimed is null then
    raise exception 'AUTOMATED_SOURCE_NEVER_CLOSED_THROUGH_INTERVAL';
  end if;

  if p_evidence_kind = 'movement' then
    select max(m.imported_at), count(*)::integer
      into reviewed_through, evidence_count
      from public.movements m
     where m.site_id = p_site_id
       and m.source_system_id = p_source_system_id
       and m.item_id = scope_item_id
       and m.location_id is not distinct from scope_location_id
       and m.occurred_at is not null
       and m.occurred_at > opening_at
       and m.occurred_at <= cutoff_at
       and m.imported_at > baseline_claimed;
  else
    select max(po.imported_at), count(*)::integer
      into reviewed_through, evidence_count
      from public.production_outputs po
     where po.site_id = p_site_id
       and po.source_system_id = p_source_system_id
       and po.completed_at > opening_at
       and po.completed_at <= cutoff_at
       and po.imported_at > baseline_claimed;
  end if;

  if reviewed_through is null or evidence_count = 0 then
    raise exception 'NO_LATE_AUTOMATED_EVIDENCE_TO_REVIEW';
  end if;

  if not exists (
    select 1 from public.material_variance_runs r
     where r.id = p_before_variance_run_id
       and r.organisation_id = org_id
       and r.site_id = p_site_id
       and r.completed_at is not null
  ) then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_BEFORE_RUN';
  end if;

  insert into public.automated_evidence_reviews (
    organisation_id, site_id, closing_count_session_id, closing_count_line_id, evidence_kind,
    source_system_id, interval_start_at, interval_cutoff_at, baseline_watermark_at,
    baseline_claimed_at, reviewed_through_imported_at, reviewed_evidence_count,
    reviewed_at, reviewed_by, note, before_variance_run_id
  ) values (
    org_id, p_site_id, session_id, p_closing_count_line_id, p_evidence_kind,
    p_source_system_id, opening_at, cutoff_at, baseline_watermark,
    baseline_claimed, reviewed_through, evidence_count,
    now(), actor, nullif(btrim(coalesce(p_note, '')), ''), p_before_variance_run_id
  ) returning id into review_id;

  insert into public.audit_events
    (organisation_id, site_id, actor_user_id, actor_type, event_type, object_type, object_id, detail)
  values
    (org_id, p_site_id, actor, 'user', 'AUTOMATED_EVIDENCE_REVIEWED',
     'automated_evidence_review', review_id,
     jsonb_build_object(
       'closingCountSessionId', session_id,
       'closingCountLineId', p_closing_count_line_id,
       'evidenceKind', p_evidence_kind,
       'sourceSystemId', p_source_system_id,
       'intervalStartAt', opening_at,
       'intervalCutoffAt', cutoff_at,
       'baselineClaimedAt', baseline_claimed,
       'reviewedThroughImportedAt', reviewed_through,
       'reviewedEvidenceCount', evidence_count,
       'beforeVarianceRunId', p_before_variance_run_id,
       'note', nullif(btrim(coalesce(p_note, '')), '')
     ));

  return review_id;
end;
$$;

create or replace function public.finalise_automated_evidence_review(
  p_review_id uuid,
  p_after_variance_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  review_row public.automated_evidence_reviews%rowtype;
begin
  if actor is null then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_USER';
  end if;

  select * into review_row
    from public.automated_evidence_reviews
   where id = p_review_id
   for update;

  if not found then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_NOT_FOUND';
  end if;

  if not public.can_write_org(review_row.organisation_id)
     or not public.can_access_site(review_row.site_id) then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_OWNER_OR_MANAGER';
  end if;

  if review_row.after_variance_run_id is not null then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_ALREADY_FINALISED';
  end if;

  if not exists (
    select 1 from public.material_variance_runs r
     where r.id = p_after_variance_run_id
       and r.organisation_id = review_row.organisation_id
       and r.site_id = review_row.site_id
       and r.completed_at is not null
       and r.started_at >= review_row.reviewed_at
  ) then
    raise exception 'AUTOMATED_EVIDENCE_REVIEW_REQUIRES_AFTER_RUN';
  end if;

  update public.automated_evidence_reviews
     set after_variance_run_id = p_after_variance_run_id
   where id = p_review_id;

  insert into public.audit_events
    (organisation_id, site_id, actor_user_id, actor_type, event_type, object_type, object_id, detail)
  values
    (review_row.organisation_id, review_row.site_id, actor, 'user',
     'AUTOMATED_EVIDENCE_REVIEW_FINALISED', 'automated_evidence_review', p_review_id,
     jsonb_build_object(
       'beforeVarianceRunId', review_row.before_variance_run_id,
       'afterVarianceRunId', p_after_variance_run_id
     ));
end;
$$;

revoke all on function public.review_automated_evidence(uuid, uuid, text, uuid, text, uuid) from public;
revoke all on function public.finalise_automated_evidence_review(uuid, uuid) from public;
grant execute on function public.review_automated_evidence(uuid, uuid, text, uuid, text, uuid) to authenticated;
grant execute on function public.finalise_automated_evidence_review(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Server receive time is actually server-authored.
-- ---------------------------------------------------------------------------
-- v0.4.3 trusted received_at for clock-skew classification but a direct client
-- could still supply it. Clamp authenticated/API inserts before any downstream
-- logic sees the row. Service-role historical seed/backfill work may preserve a
-- known server-receive instant explicitly.
create or replace function public.guard_count_line_mutation()
returns trigger
language plpgsql
as $$
declare
  session_status public.count_status;
  session_org uuid;
  session_site uuid;
begin
  if tg_op = 'INSERT' then
    select cs.status, cs.organisation_id, cs.site_id
      into session_status, session_org, session_site
      from public.count_sessions cs
     where cs.id = new.count_session_id;

    if session_status is null or session_status <> 'open' then
      raise exception 'COUNT_LINE_REQUIRES_OPEN_SESSION';
    end if;
    if new.organisation_id is distinct from session_org or new.site_id is distinct from session_site then
      raise exception 'COUNT_LINE_SESSION_SCOPE_MISMATCH';
    end if;

    -- Never trust a handset/API value for server receive time.
    if auth.uid() is not null then
      new.received_at := now();
    end if;
    return new;
  end if;

  select cs.status
    into session_status
    from public.count_sessions cs
   where cs.id = old.count_session_id;

  if session_status is null or session_status <> 'open' then
    raise exception 'COMPLETED_COUNT_LINE_IMMUTABLE';
  end if;

  if old.superseded or not new.superseded then
    raise exception 'COUNT_LINE_UPDATE_ONLY_SUPERSEDES';
  end if;

  if (to_jsonb(new) - 'superseded') is distinct from (to_jsonb(old) - 'superseded') then
    raise exception 'COUNT_LINE_UPDATE_ONLY_SUPERSEDED_FLAG';
  end if;

  return new;
end;
$$;

-- Make the RLS policy say what the trigger already enforces. The qualified
-- target-table columns avoid the old accidental cs.column = cs.column checks.
drop policy if exists count_lines_insert on public.count_lines;
create policy count_lines_insert on public.count_lines
  for insert with check (
    public.can_count_org(count_lines.organisation_id)
    and public.can_access_site(count_lines.site_id)
    and exists (
      select 1 from public.count_sessions cs
       where cs.id = count_lines.count_session_id
         and cs.organisation_id = count_lines.organisation_id
         and cs.site_id = count_lines.site_id
         and cs.status = 'open'
    )
  );

-- ===== seed.sql =====
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
   'Quarter end', 'open', '11111111-1111-4111-8111-000000000001',
   now() - interval '49 days', null, now() - interval '49 days'),
  ('10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Monday walk round', 'open', '11111111-1111-4111-8111-000000000002',
   now() - interval '3 days', null, now() - interval '3 days' - interval '20 minutes');

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

-- v0.4.3 database guards only accept count lines while a session is open.
-- Seed the historical observations through the same lifecycle as the app, then
-- freeze them once all of their lines exist.
update public.count_sessions
   set status = 'completed',
       completed_at = case id
         when '10000000-0000-4000-8000-000000000001' then now() - interval '49 days'
         when '10000000-0000-4000-8000-000000000002' then now() - interval '3 days'
       end
 where id in (
   '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002'
 );

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

-- ---------------------------------------------------------------------------
-- v0.4.0 · the second count is the product
-- ---------------------------------------------------------------------------
--
-- The original demo proved that one count cannot magically repair a dirty
-- ledger. These extra rows prove the more valuable manufacturing question:
-- between two physical observations, how much material did the plant actually
-- consume, how much should production have consumed, and what did the gap cost?

-- The warehouse feed is currently stale (last_success_at above remains four
-- days old), but it explicitly closed event time through two days ago. That is
-- enough to close the historical interval ending three days ago without
-- pretending today's feed is healthy.
update public.source_systems
   set event_watermark_at = now() - interval '2 days'
 where id = 'd0000000-0000-4000-8000-000000000001';

-- Economic context and count cadence. High-throughput packaging gets weekly
-- observations; cheaper/slower lines can stay monthly.
update public.items set standard_unit_cost = 0.12, cost_currency = 'GBP', target_count_cycle_days = 7
 where id = 'e0000000-0000-4000-8000-000000000011';
update public.items set standard_unit_cost = 0.04, cost_currency = 'GBP', target_count_cycle_days = 7
 where id = 'e0000000-0000-4000-8000-000000000013';
update public.items set standard_unit_cost = 0.80, cost_currency = 'GBP', target_count_cycle_days = 14
 where id = 'e0000000-0000-4000-8000-000000000014';

-- Opening observation for the packaging interval. It is deliberately a normal
-- count session, not a special "opening balance" table. The same mechanism
-- repeats forever.
insert into public.count_sessions
  (id, organisation_id, site_id, name, status, started_by, started_at, completed_at, source_watermark)
values
  ('10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Packaging cycle count · opening', 'open', '11111111-1111-4111-8111-000000000001',
   now() - interval '31 days', null, now() - interval '31 days' - interval '15 minutes');

insert into public.count_lines
  (id, count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_by, counted_at, received_at, method, note, created_at)
values
  ('20000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004',30000,'each','11111111-1111-4111-8111-000000000001',now() - interval '31 days',now() - interval '31 days','scan','repeat-count baseline',now() - interval '31 days'),
  ('20000000-0000-4000-8000-000000000102','10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004',34500,'each','11111111-1111-4111-8111-000000000001',now() - interval '31 days',now() - interval '31 days','scan','repeat-count baseline',now() - interval '31 days'),
  ('20000000-0000-4000-8000-000000000103','10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004',1020,'each','11111111-1111-4111-8111-000000000001',now() - interval '31 days',now() - interval '31 days','scan','repeat-count baseline',now() - interval '31 days');

update public.count_sessions
   set status = 'completed',
       completed_at = now() - interval '31 days'
 where id = '10000000-0000-4000-8000-000000000003';

-- Production evidence. Output is the thing the plant already knows. BOM
-- versioning means the theoretical material use follows the recipe that was
-- actually effective when the run completed, not today's recipe.
insert into public.products (id, organisation_id, code, name, output_unit) values
  ('51000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','NGP-440','Northgate Pale 440ml packaged can','each');

insert into public.bom_versions (id, product_id, version, valid_from, valid_to) values
  ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','2026-A',now() - interval '120 days',null);

insert into public.bom_lines (bom_version_id, item_id, quantity_per_output, unit) values
  ('52000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011',1.0,'each'),
  ('52000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013',1.0,'each'),
  ('52000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014',0.0416666666667,'each');

insert into public.production_outputs
  (id, organisation_id, site_id, product_id, quantity, unit, completed_at, recorded_at, imported_at, source_system_id, source_event_id, source_reference)
values
  ('53000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',10200,'each',
   now() - interval '10 days', now() - interval '10 days' + interval '20 minutes', now() - interval '10 days' + interval '20 minutes',
   'd0000000-0000-4000-8000-000000000001','PROD-242','Packaging run 242');
