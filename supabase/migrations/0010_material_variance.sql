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
