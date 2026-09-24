-- Core tenancy.
--
-- An organisation is a customer. A site is somewhere stock physically sits.
-- Everything operational hangs off a site, because two sites can hold the same
-- item and the quantities are not interchangeable.

create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'manager', 'counter', 'viewer');

create table public.organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.sites (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  name             text not null,
  -- Counts happen on a local working day. Reconciliation compares instants.
  -- Storing the site's zone means we never have to guess which one a bare
  -- date belongs to.
  timezone         text not null default 'UTC',
  created_at       timestamptz not null default now()
);

create index sites_org_idx on public.sites (organisation_id);

create table public.memberships (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  role             public.member_role not null,
  created_at       timestamptz not null default now(),
  unique (organisation_id, user_id)
);

create index memberships_user_idx on public.memberships (user_id);

-- A counter is often hired for one site, not the whole company. Absence of any
-- row here means "all sites in the org"; presence means "these sites only".
create table public.site_memberships (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (site_id, user_id)
);

create index site_memberships_user_idx on public.site_memberships (user_id);

create table public.locations (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites(id) on delete cascade,
  code        text not null,
  name        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (site_id, code)
);

create index locations_site_idx on public.locations (site_id) where active;
