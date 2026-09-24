-- Demo data: Northgate Brewing Co.
--
-- A small brewery with about two dozen lines. Everything in here is invented,
-- but the mess is not decorative. Each defect below is one that turns up in
-- real stock data, and each one makes the engine produce a different answer:
--
--   * a book import with no as-at date on some rows
--   * a delivery that landed before a count but was keyed in after it
--   * movements that arrived with no item attached
--   * one code covering two physically different things
--   * a barcode printed on two products
--   * a book figure in the wrong unit
--   * a receipt entered twice
--   * counts that have gone out of date
--   * items nobody has ever counted
--   * a feed that stopped delivering four days ago
--
-- Fixed UUIDs so tests and screenshots can refer to specific rows.
-- Times are relative to now() so the demo never goes stale.

-- The demo user. On a real project this is a Supabase auth user; here we make
-- one so counted_by has something to point at.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-000000000001', 'sam@northgatebrewing.example'),
  ('11111111-1111-4111-8111-000000000002', 'rana@northgatebrewing.example')
on conflict do nothing;

insert into public.organisations (id, name) values
  ('a0000000-0000-4000-8000-000000000001', 'Northgate Brewing Co.');

insert into public.sites (id, organisation_id, name, timezone) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Northgate Brewery', 'Europe/London');

insert into public.memberships (organisation_id, user_id, role) values
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000001', 'owner'),
  ('a0000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000002', 'counter');

insert into public.reconciliation_policies (site_id, stale_after_days, book_stale_after_days, require_location)
values ('b0000000-0000-4000-8000-000000000001', 30, 14, false);

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------

insert into public.locations (id, site_id, code, name) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'DRY-01', 'Dry store, racking A'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'DRY-02', 'Dry store, racking B'),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'COLD-01', 'Cold store'),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'PACK-01', 'Packaging bay'),
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'CELLAR', 'Cellar');

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------

insert into public.source_systems (id, organisation_id, name, source_type, expected_sync_minutes, last_success_at) values
  -- Runs hourly. Has not run for four days, which is the point.
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'Warehouse export', 'google_sheets', 60, now() - interval '4 days'),
  -- Manual. Silence means nothing.
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001',
   'Monthly stock spreadsheet', 'csv_upload', null, now() - interval '19 days');

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------

-- created_at matters as much as the content. Knowledge time is what lets the
-- system answer "what did we think we had last Tuesday" with the evidence that
-- existed last Tuesday, so the demo has to carry realistic arrival times rather
-- than stamping everything with the moment the seed ran.
insert into public.items (id, organisation_id, sku, name, stock_unit, active, blocked, blocked_reason, created_at) values
  -- malt
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'MLT-PALE-25',  'Maris Otter pale malt 25kg', 'sack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'MLT-CRYS-25',  'Crystal malt 150L 25kg',     'sack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'MLT-CHOC-25',  'Chocolate malt 25kg',        'sack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'MLT-WHEA-25',  'Torrified wheat 25kg',       'sack', true, false, null, now() - interval '120 days'),
  -- hops. Harvest year matters and the codes do not carry it, which is how
  -- HOP-CAS-5 ended up meaning two different things.
  ('e0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'HOP-CAS-5',    'Cascade hop pellets 5kg',    'box',  true, true,
     'Same code used for 2023 and 2024 harvest. Split before counting.', now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'HOP-CTZ-5',    'Columbus hop pellets 5kg',   'box',  true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000001', 'HOP-EKG-5',    'East Kent Goldings 5kg',     'box',  true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000001', 'HOP-MOS-5',    'Mosaic hop pellets 5kg',     'box',  true, false, null, now() - interval '120 days'),
  -- yeast
  ('e0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001', 'YST-A04-PK',   'Ale yeast A04 pitch pack',   'pack', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000010', 'a0000000-0000-4000-8000-000000000001', 'YST-L17-PK',   'Lager yeast L17 pitch pack', 'pack', true, false, null, now() - interval '120 days'),
  -- packaging
  ('e0000000-0000-4000-8000-000000000011', 'a0000000-0000-4000-8000-000000000001', 'PKG-CAN-440',  'Can 440ml unprinted',        'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000012', 'a0000000-0000-4000-8000-000000000001', 'PKG-CAN-330',  'Can 330ml unprinted',        'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000013', 'a0000000-0000-4000-8000-000000000001', 'PKG-LID-440',  'Can end 202 diameter',       'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000014', 'a0000000-0000-4000-8000-000000000001', 'PKG-CRT-24',   'Carton, 24 can',             'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000015', 'a0000000-0000-4000-8000-000000000001', 'LBL-NGP-440',  'Northgate Pale label 440ml', 'roll', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000016', 'a0000000-0000-4000-8000-000000000001', 'LBL-NGS-440',  'Northgate Stout label 440ml','roll', true, false, null, now() - interval '120 days'),
  -- kegs and gas
  ('e0000000-0000-4000-8000-000000000017', 'a0000000-0000-4000-8000-000000000001', 'KEG-30L-S',    'Keg 30L stainless',          'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000018', 'a0000000-0000-4000-8000-000000000001', 'KEG-50L-S',    'Keg 50L stainless',          'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000019', 'a0000000-0000-4000-8000-000000000001', 'GAS-CO2-6',    'CO2 cylinder 6kg',           'each', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000020', 'a0000000-0000-4000-8000-000000000001', 'GAS-MIX-20',   'Mixed gas cylinder 20kg',    'each', true, false, null, now() - interval '120 days'),
  -- cleaning and misc
  ('e0000000-0000-4000-8000-000000000021', 'a0000000-0000-4000-8000-000000000001', 'CLN-CAU-25',   'Caustic cleaner 25L',        'drum', true, false, null, now() - interval '120 days'),
  ('e0000000-0000-4000-8000-000000000022', 'a0000000-0000-4000-8000-000000000001', 'CLN-PAA-20',   'Peracetic sanitiser 20L',    'drum', true, false, null, now() - interval '120 days'),
  -- retired but still on the shelf
  ('e0000000-0000-4000-8000-000000000023', 'a0000000-0000-4000-8000-000000000001', 'LBL-OLD-440',  'Old branding label 440ml',   'roll', false, false, null, now() - interval '120 days'),
  -- never counted, never received. Exists in the catalogue and nowhere else.
  ('e0000000-0000-4000-8000-000000000024', 'a0000000-0000-4000-8000-000000000001', 'MLT-RYE-25',   'Rye malt 25kg',              'sack', true, false, null, now() - interval '120 days');

-- Two products, one barcode. The scanner has to ask rather than pick.
insert into public.item_barcodes (item_id, barcode) values
  ('e0000000-0000-4000-8000-000000000011', '5012345000114'),
  ('e0000000-0000-4000-8000-000000000012', '5012345000121'),
  ('e0000000-0000-4000-8000-000000000015', '5012345000152'),
  ('e0000000-0000-4000-8000-000000000016', '5012345000152'),  -- same barcode, different label
  ('e0000000-0000-4000-8000-000000000017', '5012345000176'),
  ('e0000000-0000-4000-8000-000000000018', '5012345000183');

insert into public.item_aliases (item_id, alias, alias_type) values
  ('e0000000-0000-4000-8000-000000000001', 'PALE25',     'legacy_sku'),
  ('e0000000-0000-4000-8000-000000000001', 'Maris',      'shop_floor_name'),
  ('e0000000-0000-4000-8000-000000000019', 'CO2 small',  'shop_floor_name'),
  ('e0000000-0000-4000-8000-000000000020', 'Big gas',    'shop_floor_name');

-- ---------------------------------------------------------------------------
-- Book position
--
-- One bulk import, 19 days ago, of a monthly spreadsheet that was itself
-- already a week out of date when it was exported. Two rows carry no as-at
-- date because that column was blank in the file.
-- ---------------------------------------------------------------------------

insert into public.import_runs (id, organisation_id, site_id, source_system_id, import_kind, status, source_filename, row_count, started_at, committed_at)
values ('f0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
        'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
        'book_position', 'committed', 'stock-may.csv', 22,
        now() - interval '19 days', now() - interval '19 days');

insert into public.book_snapshots
  (organisation_id, site_id, item_id, location_id, quantity, unit, as_of, source_system_id, import_run_id, created_at)
values
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001', 40,   'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001', 12,   'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000001', 6,    'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001', 9,    'sack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000003', 8,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000003', 5,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000007','c0000000-0000-4000-8000-000000000003', 3,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000008','c0000000-0000-4000-8000-000000000003', 4,    'box',  now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000003', 14,   'pack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000010','c0000000-0000-4000-8000-000000000003', 6,    'pack', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004', 19200,'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000004', 7440, 'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004', 24000,'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004', 620,  'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  -- as-at blank in the source file. Cannot be placed in time.
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000015','c0000000-0000-4000-8000-000000000004', 11,   'roll', null,                        'd0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000016','c0000000-0000-4000-8000-000000000004', 7,    'roll', null,                        'd0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005', 148,  'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000018','c0000000-0000-4000-8000-000000000005', 62,   'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000019','c0000000-0000-4000-8000-000000000005', 9,    'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000020','c0000000-0000-4000-8000-000000000005', 4,    'each', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  -- exported in litres while the item is held in drums. Refused, not converted.
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000021','c0000000-0000-4000-8000-000000000002', 75,   'L',    now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000022','c0000000-0000-4000-8000-000000000002', 3,    'drum', now() - interval '26 days','d0000000-0000-4000-8000-000000000002','f0000000-0000-4000-8000-000000000001', now() - interval '19 days');

-- ---------------------------------------------------------------------------
-- Counts
--
-- Two sessions. An old one from seven weeks ago that has gone stale, and a
-- recent one that covered most but not all of the store.
-- ---------------------------------------------------------------------------

insert into public.count_sessions (id, organisation_id, site_id, name, status, started_by, started_at, completed_at, source_watermark) values
  ('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Quarter end', 'open', '11111111-1111-4111-8111-000000000001',
   now() - interval '49 days', null, now() - interval '49 days'),
  ('10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Monday walk round', 'open', '11111111-1111-4111-8111-000000000002',
   now() - interval '3 days', null, now() - interval '3 days' - interval '20 minutes');

-- Stale session: only cleaning chemicals, and nobody has been back since.
insert into public.count_lines
  (count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_by, counted_at, received_at, method, created_at)
values
  ('10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000022','c0000000-0000-4000-8000-000000000002', 3, 'drum', '11111111-1111-4111-8111-000000000001', now() - interval '49 days', now() - interval '49 days', 'manual', now() - interval '49 days');

-- Recent session.
insert into public.count_lines
  (id, count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_by, counted_at, received_at, method, note, created_at)
values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001', 38,   'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001', 10,   'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000001', 6,    'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001', 7,    'sack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  -- the big one. Counted at 11:05, and a pallet was booked in at 14:00 that
  -- had physically arrived at 11:00.
  ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004', 27600,'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000004', 7440, 'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004', 23500,'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004', 604,  'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  -- counted with no location recorded
  ('20000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000019', null,                                    7,    'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'manual', 'found by the loading door', now() - interval '3 days'),
  -- an empty shelf. Zero is an observation, not a blank.
  ('20000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000010','c0000000-0000-4000-8000-000000000003', 0,    'pack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', 'none left', now() - interval '3 days'),
  ('20000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000003', 11,   'pack', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'scan', null, now() - interval '3 days'),
  -- retired item still physically present
  ('20000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000023','c0000000-0000-4000-8000-000000000004', 2,    'roll', '11111111-1111-4111-8111-000000000002', now() - interval '3 days', now() - interval '3 days', 'manual', 'old labels still on the shelf', now() - interval '3 days'),
  -- counted on a handset whose clock was 35 minutes fast
  ('20000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005', 141,  'each', '11111111-1111-4111-8111-000000000002', now() - interval '3 days' + interval '35 minutes', now() - interval '3 days', 'scan', null, now() - interval '3 days');

-- v0.4.3 database guards only accept count lines while a session is open.
-- Seed the historical observations through the same lifecycle as the app, then
-- freeze them once all of their lines exist.
update public.count_sessions
   set status = 'completed',
       completed_at = case id
         when '10000000-0000-4000-8000-000000000001' then now() - interval '49 days'
         when '10000000-0000-4000-8000-000000000002' then now() - interval '3 days'
       end
 where id in (
   '10000000-0000-4000-8000-000000000001',
   '10000000-0000-4000-8000-000000000002'
 );

-- ---------------------------------------------------------------------------
-- Movements
-- ---------------------------------------------------------------------------

insert into public.movements
  (id, organisation_id, site_id, item_id, location_id, movement_type, quantity, unit, occurred_at, recorded_at, imported_at, source_system_id, source_event_id, source_reference)
values
  -- routine issues to brew days, all clean
  ('30000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','ISSUE',   6, 'sack', now() - interval '2 days',  now() - interval '2 days',  now() - interval '2 days',  'd0000000-0000-4000-8000-000000000001','WE-10041','Brew 241'),
  ('30000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000001','ISSUE',   1, 'sack', now() - interval '2 days',  now() - interval '2 days',  now() - interval '2 days',  'd0000000-0000-4000-8000-000000000001','WE-10042','Brew 241'),
  ('30000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','RECEIVE',20, 'sack', now() - interval '1 day',   now() - interval '1 day',   now() - interval '1 day',   'd0000000-0000-4000-8000-000000000001','WE-10055','PO-8821'),

  -- the pallet of cans. Physically arrived an hour before the counter reached
  -- the packaging bay; keyed in three hours after.
  ('30000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004','RECEIVE',8400,'each',
     now() - interval '3 days' - interval '1 hour',
     now() - interval '3 days' + interval '3 hours',
     now() - interval '3 days' + interval '3 hours',
     'd0000000-0000-4000-8000-000000000001','WE-10048','PO-8817'),

  -- entered twice, four minutes apart, same quantity
  ('30000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004','RECEIVE',200,'each', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10050','PO-8819'),
  ('30000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004','RECEIVE',200,'each', now() - interval '2 days' + interval '4 minutes', now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10051','PO-8819'),

  -- kegs going out and coming back
  ('30000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005','ISSUE',  24,'each', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10052','Trade order 4412'),
  ('30000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000017','c0000000-0000-4000-8000-000000000005','RETURN', 18,'each', now() - interval '1 day',  now() - interval '1 day',  now() - interval '1 day',  'd0000000-0000-4000-8000-000000000001','WE-10057','Empties in'),

  -- an issue with no date on it in the source export
  ('30000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004','ISSUE', 1200,'each', null, now() - interval '2 days', now() - interval '2 days', 'd0000000-0000-4000-8000-000000000001','WE-10053','Canning run'),

  -- more issued than the count plus receipts can support
  ('30000000-0000-4000-8000-000000000010','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000009','c0000000-0000-4000-8000-000000000003','ISSUE',  14,'each', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'd0000000-0000-4000-8000-000000000001','WE-10058','Brew 242'),

  -- a transfer between locations, both halves correlated
  ('30000000-0000-4000-8000-000000000011','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000004','TRANSFER_OUT',1200,'each', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day','d0000000-0000-4000-8000-000000000001','WE-10059','Move to line'),
  ('30000000-0000-4000-8000-000000000012','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000012','c0000000-0000-4000-8000-000000000002','TRANSFER_IN', 1200,'each', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day','d0000000-0000-4000-8000-000000000001','WE-10060','Move to line'),

  -- arrived in litres against an item held in drums
  ('30000000-0000-4000-8000-000000000013','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000021','c0000000-0000-4000-8000-000000000002','RECEIVE', 50,'L', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days','d0000000-0000-4000-8000-000000000001','WE-10054','PO-8820');

update public.movements set transfer_correlation_id = '40000000-0000-4000-8000-000000000001'
where id in ('30000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000012');

-- Movements the import could not attach to any item. Their existence is why
-- nothing at this site can be called fully verified until someone links them.
insert into public.movements
  (organisation_id, site_id, item_id, location_id, movement_type, quantity, unit, occurred_at, recorded_at, imported_at, source_system_id, source_event_id, source_reference, raw_payload)
values
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001', null, null, 'RECEIVE', 4, 'box', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days','d0000000-0000-4000-8000-000000000001','WE-10056','PO-8822', '{"code":"HOP-CAS-5","note":"which harvest?"}'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001', null, null, 'ISSUE',   2, 'box', now() - interval '1 day',  now() - interval '1 day',  now() - interval '1 day', 'd0000000-0000-4000-8000-000000000001','WE-10061','Brew 242', '{"code":"HOPCAS5","note":"code not in catalogue"}'),
  ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001', null, null, 'RECEIVE', 1, 'each',now() - interval '5 days', now() - interval '5 days', now() - interval '5 days','d0000000-0000-4000-8000-000000000001','WE-10030','PO-8810', '{"code":"","note":"blank code in export"}');

-- ---------------------------------------------------------------------------
-- v0.4.0 · the second count is the product
-- ---------------------------------------------------------------------------
--
-- The original demo proved that one count cannot magically repair a dirty
-- ledger. These extra rows prove the more valuable manufacturing question:
-- between two physical observations, how much material did the plant actually
-- consume, how much should production have consumed, and what did the gap cost?

-- The warehouse feed is currently stale (last_success_at above remains four
-- days old), but it explicitly closed event time through two days ago. That is
-- enough to close the historical interval ending three days ago without
-- pretending today's feed is healthy.
update public.source_systems
   set event_watermark_at = now() - interval '2 days'
 where id = 'd0000000-0000-4000-8000-000000000001';

-- Economic context and count cadence. High-throughput packaging gets weekly
-- observations; cheaper/slower lines can stay monthly.
update public.items set standard_unit_cost = 0.12, cost_currency = 'GBP', target_count_cycle_days = 7
 where id = 'e0000000-0000-4000-8000-000000000011';
update public.items set standard_unit_cost = 0.04, cost_currency = 'GBP', target_count_cycle_days = 7
 where id = 'e0000000-0000-4000-8000-000000000013';
update public.items set standard_unit_cost = 0.80, cost_currency = 'GBP', target_count_cycle_days = 14
 where id = 'e0000000-0000-4000-8000-000000000014';

-- Opening observation for the packaging interval. It is deliberately a normal
-- count session, not a special "opening balance" table. The same mechanism
-- repeats forever.
insert into public.count_sessions
  (id, organisation_id, site_id, name, status, started_by, started_at, completed_at, source_watermark)
values
  ('10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',
   'Packaging cycle count · opening', 'open', '11111111-1111-4111-8111-000000000001',
   now() - interval '31 days', null, now() - interval '31 days' - interval '15 minutes');

insert into public.count_lines
  (id, count_session_id, organisation_id, site_id, item_id, location_id, quantity, unit, counted_by, counted_at, received_at, method, note, created_at)
values
  ('20000000-0000-4000-8000-000000000101','10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011','c0000000-0000-4000-8000-000000000004',30000,'each','11111111-1111-4111-8111-000000000001',now() - interval '31 days',now() - interval '31 days','scan','repeat-count baseline',now() - interval '31 days'),
  ('20000000-0000-4000-8000-000000000102','10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013','c0000000-0000-4000-8000-000000000004',34500,'each','11111111-1111-4111-8111-000000000001',now() - interval '31 days',now() - interval '31 days','scan','repeat-count baseline',now() - interval '31 days'),
  ('20000000-0000-4000-8000-000000000103','10000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014','c0000000-0000-4000-8000-000000000004',1020,'each','11111111-1111-4111-8111-000000000001',now() - interval '31 days',now() - interval '31 days','scan','repeat-count baseline',now() - interval '31 days');

update public.count_sessions
   set status = 'completed',
       completed_at = now() - interval '31 days'
 where id = '10000000-0000-4000-8000-000000000003';

-- Production evidence. Output is the thing the plant already knows. BOM
-- versioning means the theoretical material use follows the recipe that was
-- actually effective when the run completed, not today's recipe.
insert into public.products (id, organisation_id, code, name, output_unit) values
  ('51000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','NGP-440','Northgate Pale 440ml packaged can','each');

insert into public.bom_versions (id, product_id, version, valid_from, valid_to) values
  ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','2026-A',now() - interval '120 days',null);

insert into public.bom_lines (bom_version_id, item_id, quantity_per_output, unit) values
  ('52000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000011',1.0,'each'),
  ('52000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000013',1.0,'each'),
  ('52000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000014',0.0416666666667,'each');

insert into public.production_outputs
  (id, organisation_id, site_id, product_id, quantity, unit, completed_at, recorded_at, imported_at, source_system_id, source_event_id, source_reference)
values
  ('53000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001',10200,'each',
   now() - interval '10 days', now() - interval '10 days' + interval '20 minutes', now() - interval '10 days' + interval '20 minutes',
   'd0000000-0000-4000-8000-000000000001','PROD-242','Packaging run 242');
