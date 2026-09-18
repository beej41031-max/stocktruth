-- Local-only stand-in for the parts of Supabase the migrations reference.
-- Never applied to a real project; Supabase provides these itself.
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- auth.uid() reads a session GUC so tests can switch user.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
