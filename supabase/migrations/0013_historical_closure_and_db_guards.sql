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
