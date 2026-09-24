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
