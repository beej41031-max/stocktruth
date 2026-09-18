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
