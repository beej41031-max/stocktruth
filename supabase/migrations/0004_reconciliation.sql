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
