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
