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
