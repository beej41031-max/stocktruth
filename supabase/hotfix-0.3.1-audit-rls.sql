-- StockTruth v0.3.1 live hotfix
-- Safe to run more than once.

begin;

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

commit;
