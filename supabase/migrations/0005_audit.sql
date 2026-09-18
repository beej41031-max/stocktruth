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
