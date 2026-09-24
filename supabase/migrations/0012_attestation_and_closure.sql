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
