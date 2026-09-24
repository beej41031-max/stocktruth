import type { Db } from '../db';

/**
 * Reads for the screens.
 *
 * Every one of these takes a Db that already carries the signed-in person's
 * identity, so none of them filters by organisation. The database does that.
 * A query here that mentions organisation_id in a where clause is a sign
 * somebody has stopped trusting the policies, which is worth noticing.
 */

export interface SiteRef {
  id: string;
  name: string;
  organisationId: string;
  organisationName: string;
  timezone: string;
}

export async function listSites(db: Db): Promise<SiteRef[]> {
  return db.query<SiteRef>(
    `select s.id, s.name, s.organisation_id as "organisationId",
            o.name as "organisationName", s.timezone
       from sites s join organisations o on o.id = s.organisation_id
      order by o.name, s.name`,
  );
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export interface Confidence {
  total: number;
  verified: number;
  provisional: number;
  stale: number;
  incomplete: number;
  conflict: number;
  unverified: number;
  neverCounted: number;
  lastRunAt: string | null;
  engineVersion: string | null;
}

/**
 * The headline. Counted over the newest result per item and location, because
 * an older run's answer for an item is history, not a second opinion.
 */
export async function siteConfidence(db: Db, siteId: string): Promise<Confidence> {
  const rows = await db.query<{ state: string; n: string }>(
    `with latest as (
       select distinct on (item_id, location_id) state
         from reconciliation_results
        where site_id = $1
        order by item_id, location_id, created_at desc
     )
     select state, count(*)::text as n from latest group by state`,
    [siteId],
  );

  const by = (s: string) => Number(rows.find((r) => r.state === s)?.n ?? 0);

  const run = await db.one<{ started_at: string; engine_version: string }>(
    `select started_at, engine_version from reconciliation_runs
      where site_id = $1 and completed_at is not null
      order by started_at desc limit 1`,
    [siteId],
  );

  const never = await db.one<{ n: string }>(
    `select count(*)::text as n from (
       select distinct on (item_id, location_id) state
         from reconciliation_results where site_id = $1
        order by item_id, location_id, created_at desc
     ) x where state = 'UNVERIFIED'`,
    [siteId],
  );

  return {
    total: rows.reduce((sum, r) => sum + Number(r.n), 0),
    verified: by('VERIFIED'),
    provisional: by('PROVISIONAL'),
    stale: by('STALE'),
    incomplete: by('INCOMPLETE'),
    conflict: by('CONFLICT'),
    unverified: by('UNVERIFIED'),
    neverCounted: Number(never?.n ?? 0),
    lastRunAt: run?.started_at ?? null,
    engineVersion: run?.engine_version ?? null,
  };
}

export interface DataHealth {
  unlinkedMovements: number;
  undatedMovements: number;
  staleSources: { name: string; lastSuccessAt: string | null; expectedSyncMinutes: number }[];
  blockedItems: number;
  sharedBarcodes: number;
}

export async function dataHealth(db: Db, siteId: string): Promise<DataHealth> {
  // Sequential on purpose. These share one connection inside one transaction,
  // and firing them together interleaves queries on a single socket.
  const unlinked = await db.one<{ n: string }>(
    `select count(*)::text as n from movements where site_id = $1 and item_id is null`,
    [siteId],
  );

  const undated = await db.one<{ n: string }>(
    `select count(*)::text as n from movements where site_id = $1 and occurred_at is null`,
    [siteId],
  );

  const sources = await db.query<{ name: string; lastSuccessAt: string | null; expectedSyncMinutes: number }>(
    `select ss.name, ss.last_success_at as "lastSuccessAt",
            ss.expected_sync_minutes as "expectedSyncMinutes"
       from source_systems ss
       join sites s on s.organisation_id = ss.organisation_id
      where s.id = $1
        and ss.expected_sync_minutes is not null
        and (
          ss.last_success_at is null
          or ss.last_success_at < now() - (ss.expected_sync_minutes
               * coalesce((select source_silence_multiplier from reconciliation_policies where site_id = $1), 3)
               * interval '1 minute')
        )`,
    [siteId],
  );

  const blocked = await db.one<{ n: string }>(
    `select count(*)::text as n from items i
       join sites s on s.organisation_id = i.organisation_id
      where s.id = $1 and i.blocked`,
    [siteId],
  );

  const barcodes = await db.one<{ n: string }>(
    `select count(*)::text as n from (
       select b.barcode from item_barcodes b
         join items i on i.id = b.item_id
         join sites s on s.organisation_id = i.organisation_id
        where s.id = $1 and b.active
        group by b.barcode having count(distinct b.item_id) > 1
     ) x`,
    [siteId],
  );

  return {
    unlinkedMovements: Number(unlinked?.n ?? 0),
    undatedMovements: Number(undated?.n ?? 0),
    staleSources: sources,
    blockedItems: Number(blocked?.n ?? 0),
    sharedBarcodes: Number(barcodes?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface IssueRow {
  id: string;
  code: string;
  severity: 'high' | 'medium' | 'low';
  itemId: string | null;
  sku: string | null;
  itemName: string | null;
  locationCode: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  state: string | null;
  bookQuantity: string | null;
  physicalQuantity: string | null;
  derivedQuantity: string | null;
}

export async function openIssues(db: Db, siteId: string, limit = 100): Promise<IssueRow[]> {
  return db.query<IssueRow>(
    `select ri.id, ri.code, ri.severity, ri.item_id as "itemId",
            i.sku, i.name as "itemName", l.code as "locationCode",
            ri.first_seen_at as "firstSeenAt", ri.last_seen_at as "lastSeenAt",
            ri.detail->>'state' as state,
            ri.detail->>'bookQuantity' as "bookQuantity",
            ri.detail->>'physicalQuantity' as "physicalQuantity",
            ri.detail->>'derivedQuantity' as "derivedQuantity"
       from reconciliation_issues ri
       left join items i on i.id = ri.item_id
       left join locations l on l.id = ri.location_id
      where ri.site_id = $1 and ri.status = 'open'
      order by case ri.severity when 'high' then 0 when 'medium' then 1 else 2 end,
               ri.last_seen_at desc
      limit $2`,
    [siteId, limit],
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemRow {
  itemId: string;
  sku: string | null;
  name: string;
  stockUnit: string;
  locationCode: string | null;
  state: string | null;
  bookQuantity: string | null;
  physicalQuantity: string | null;
  physicalCountedAt: string | null;
  derivedQuantity: string | null;
  varianceAtCount: string | null;
  reasonCodes: string[] | null;
}

export async function listItems(db: Db, siteId: string, search?: string): Promise<ItemRow[]> {
  const like = search ? `%${search}%` : null;
  return db.query<ItemRow>(
    `with latest as (
       select distinct on (item_id, location_id) *
         from reconciliation_results
        where site_id = $1
        order by item_id, location_id, created_at desc
     )
     select i.id as "itemId", i.sku, i.name, i.stock_unit as "stockUnit",
            l.code as "locationCode", r.state::text,
            r.book_quantity::text as "bookQuantity",
            r.physical_quantity::text as "physicalQuantity",
            r.physical_counted_at as "physicalCountedAt",
            r.derived_quantity::text as "derivedQuantity",
            r.variance_at_count::text as "varianceAtCount",
            r.reason_codes as "reasonCodes"
       from items i
       left join latest r on r.item_id = i.id
       left join locations l on l.id = r.location_id
       join sites s on s.organisation_id = i.organisation_id
      where s.id = $1
        and ($2::text is null or i.sku ilike $2 or i.name ilike $2)
      order by i.sku nulls last, l.code nulls first`,
    [siteId, like],
  );
}

export interface ItemDetail {
  itemId: string;
  sku: string | null;
  name: string;
  stockUnit: string;
  active: boolean;
  blocked: boolean;
  blockedReason: string | null;
  aliases: string[];
  barcodes: string[];
}

export async function itemDetail(db: Db, itemId: string): Promise<ItemDetail | null> {
  const item = await db.one<ItemDetail>(
    `select i.id as "itemId", i.sku, i.name, i.stock_unit as "stockUnit",
            i.active, i.blocked, i.blocked_reason as "blockedReason",
            coalesce(array_agg(distinct a.alias) filter (where a.alias is not null), '{}') as aliases,
            coalesce(array_agg(distinct b.barcode) filter (where b.barcode is not null), '{}') as barcodes
       from items i
       left join item_aliases a on a.item_id = i.id
       left join item_barcodes b on b.item_id = i.id and b.active
      where i.id = $1
      group by i.id`,
    [itemId],
  );
  return item;
}

export interface TimelineEntry {
  at: string;
  kind: 'book' | 'count' | 'movement';
  label: string;
  quantity: string;
  detail: string | null;
  /** Set when the recorded time differs materially from when it happened. */
  recordedAt: string | null;
  actor: string | null;
}

/**
 * Everything that ever happened to this item, newest first.
 *
 * Movements carry both times where they differ, because a delivery that
 * happened at 11:00 and was written down at 14:00 is the single most useful
 * thing this screen can show somebody arguing about a count.
 */
export async function itemTimeline(db: Db, siteId: string, itemId: string): Promise<TimelineEntry[]> {
  return db.query<TimelineEntry>(
    `select * from (
       select bs.created_at as at, 'book' as kind,
              'Book position imported' as label,
              bs.quantity::text || ' ' || bs.unit as quantity,
              case when bs.as_of is null then 'No as-at date in the source file'
                   else 'As at ' || to_char(bs.as_of, 'DD Mon YYYY') end as detail,
              null::timestamptz as "recordedAt",
              ss.name as actor
         from book_snapshots bs
         left join source_systems ss on ss.id = bs.source_system_id
        where bs.site_id = $1 and bs.item_id = $2

       union all

       select cl.counted_at as at, 'count' as kind,
              'Physical count' as label,
              cl.quantity::text || ' ' || cl.unit as quantity,
              coalesce(cl.note, l.code) as detail,
              cl.received_at as "recordedAt",
              case when cl.counted_by is null then 'Unknown counter' else 'Signed-in counter' end as actor
         from count_lines cl
         left join locations l on l.id = cl.location_id
        where cl.site_id = $1 and cl.item_id = $2 and not cl.superseded

       union all

       select coalesce(m.occurred_at, m.imported_at) as at, 'movement' as kind,
              replace(m.movement_type::text, '_', ' ') as label,
              m.quantity::text || ' ' || m.unit as quantity,
              m.source_reference as detail,
              m.recorded_at as "recordedAt",
              ss.name as actor
         from movements m
         left join source_systems ss on ss.id = m.source_system_id
        where m.site_id = $1 and m.item_id = $2
     ) t
     order by at desc`,
    [siteId, itemId],
  );
}

export async function latestResult(db: Db, siteId: string, itemId: string) {
  return db.one<{
    state: string;
    bookQuantity: string | null;
    bookAsOf: string | null;
    physicalQuantity: string | null;
    physicalCountedAt: string | null;
    derivedQuantity: string | null;
    derivedAsOf: string | null;
    varianceAtCount: string | null;
    movementNet: string | null;
    reasonCodes: string[];
    locationCode: string | null;
  }>(
    `select r.state::text, r.book_quantity::text as "bookQuantity", r.book_as_of as "bookAsOf",
            r.physical_quantity::text as "physicalQuantity", r.physical_counted_at as "physicalCountedAt",
            r.derived_quantity::text as "derivedQuantity", r.derived_as_of as "derivedAsOf",
            r.variance_at_count::text as "varianceAtCount",
            r.movement_net::text as "movementNet",
            r.reason_codes as "reasonCodes", l.code as "locationCode"
       from reconciliation_results r
       left join locations l on l.id = r.location_id
      where r.site_id = $1 and r.item_id = $2
      order by r.created_at desc limit 1`,
    [siteId, itemId],
  );
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export async function listMovements(db: Db, siteId: string, limit = 200) {
  return db.query<{
    id: string;
    movementType: string;
    quantity: string;
    unit: string;
    occurredAt: string | null;
    recordedAt: string | null;
    importedAt: string;
    sku: string | null;
    itemName: string | null;
    locationCode: string | null;
    sourceReference: string | null;
    sourceName: string | null;
    rawCode: string | null;
  }>(
    `select m.id, m.movement_type::text as "movementType", m.quantity::text, m.unit,
            m.occurred_at as "occurredAt", m.recorded_at as "recordedAt", m.imported_at as "importedAt",
            i.sku, i.name as "itemName", l.code as "locationCode",
            m.source_reference as "sourceReference", ss.name as "sourceName",
            m.raw_payload->>'code' as "rawCode"
       from movements m
       left join items i on i.id = m.item_id
       left join locations l on l.id = m.location_id
       left join source_systems ss on ss.id = m.source_system_id
      where m.site_id = $1
      order by m.item_id is not null, coalesce(m.occurred_at, m.imported_at) desc
      limit $2`,
    [siteId, limit],
  );
}
