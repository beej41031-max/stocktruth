-- Catalogue and identity.
--
-- Identity is the part everyone gets wrong. A SKU is a label a business puts on
-- a thing; it is not the thing. Businesses reuse codes, mistype them, change
-- them, and occasionally use one code for two genuinely different products.
--
-- So: items.id is identity. Everything else is a label pointing at it, and any
-- label can turn out to point at two things.

create type public.identity_state as enum (
  'linked',      -- resolves to exactly one item
  'ambiguous',   -- resolves to more than one, needs a human
  'unresolved'   -- resolves to none
);

create table public.items (
  id               uuid primary key default gen_random_uuid(),
  organisation_id  uuid not null references public.organisations(id) on delete cascade,
  sku              text,
  name             text not null,
  stock_unit       text not null,
  active           boolean not null default true,
  -- Set when the business knows a code is broken and nothing should be counted
  -- or received against it until someone decides what it means.
  blocked          boolean not null default false,
  blocked_reason   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Deliberately not unique. If a customer's data has two items with the same
-- SKU, that is a fact about their business we need to surface, not an import
-- error we refuse. Uniqueness here would just mean we silently drop one.
create index items_org_sku_idx on public.items (organisation_id, sku);
create index items_org_active_idx on public.items (organisation_id) where active;

create table public.item_aliases (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  alias       text not null,
  -- 'legacy_sku', 'supplier_code', 'shop_floor_name', 'other'
  alias_type  text not null default 'other',
  created_at  timestamptz not null default now()
);

create index item_aliases_lookup_idx on public.item_aliases (alias);

create table public.item_barcodes (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id) on delete cascade,
  barcode     text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Not unique either, for the same reason. Two items sharing a barcode is a real
-- situation and the scanner has to handle it by asking, not by picking one.
create index item_barcodes_lookup_idx on public.item_barcodes (barcode) where active;

create table public.source_systems (
  id                      uuid primary key default gen_random_uuid(),
  organisation_id         uuid not null references public.organisations(id) on delete cascade,
  name                    text not null,
  -- 'csv_upload', 'google_sheets', 'api'
  source_type             text not null,
  -- How long before silence means something is wrong. Null = manual, no
  -- expectation of regular delivery.
  expected_sync_minutes   integer,
  last_attempt_at         timestamptz,
  last_success_at         timestamptz,
  last_error              text,
  created_at              timestamptz not null default now()
);

create index source_systems_org_idx on public.source_systems (organisation_id);

-- How an external system refers to one of our items. One item can carry several
-- of these, one per source, which is how we survive a customer whose ERP and
-- whose spreadsheet disagree about what a thing is called.
create table public.item_source_identities (
  id                uuid primary key default gen_random_uuid(),
  source_system_id  uuid not null references public.source_systems(id) on delete cascade,
  item_id           uuid references public.items(id) on delete set null,
  external_id       text not null,
  external_code     text,
  identity_state    public.identity_state not null default 'linked',
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  unique (source_system_id, external_id)
);

create index item_source_identities_item_idx on public.item_source_identities (item_id);
