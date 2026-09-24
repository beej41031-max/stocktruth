import type { Pool } from 'pg';
import type {
  EvidenceSource,
  ReconciliationPolicy,
  ScopeEvidence,
  ScopeRef,
  SiteRef,
  SourceHealth,
} from '@stocktruth/engine';

/**
 * The StockTruth Postgres adapter.
 *
 * This is the ugly, specific side of the line. Everything about table names,
 * column names and how this particular schema records things lives here, and
 * none of it leaks into the engine.
 *
 * A different host system gets a different file like this one and reuses the
 * engine unchanged. That boundary is the whole reason the engine takes plain
 * shapes rather than rows.
 *
 * Knowledge time
 * --------------
 * Every query optionally filters on when this system *learned* something
 * rather than when it happened. `created_at` and `imported_at` are knowledge
 * time; `as_of`, `counted_at` and `occurred_at` are occurrence time. Keeping
 * them apart is what lets "what did we think we had on Tuesday morning" be
 * answered with the evidence that existed on Tuesday morning, rather than with
 * everything that has arrived since.
 */
export class PostgresEvidenceSource implements EvidenceSource {
  readonly supportsKnownAt = true;
  readonly adapterName = 'stocktruth-postgres';

  constructor(private readonly pool: Pool) {}

  async loadPolicy(site: SiteRef): Promise<Partial<ReconciliationPolicy>> {
    const res = await this.pool.query(
      `select stale_after_days, book_stale_after_days, source_silence_multiplier,
              max_clock_skew_minutes, require_location
         from reconciliation_policies where site_id = $1`,
      [site.siteId],
    );
    const r = res.rows[0];
    if (!r) return {};
    return {
      staleAfterDays: Number(r.stale_after_days),
      bookStaleAfterDays: Number(r.book_stale_after_days),
      sourceSilenceMultiplier: Number(r.source_silence_multiplier),
      maxClockSkewMinutes: Number(r.max_clock_skew_minutes),
      requireLocation: r.require_location,
    };
  }

  async listScopes(site: SiteRef, knownAt?: Date): Promise<ScopeRef[]> {
    return (await this.loadSite(site, knownAt)).map((s) => ({
      itemId: s.item.id,
      locationId: s.locationId,
    }));
  }

  async loadScope(site: SiteRef, scope: ScopeRef, knownAt?: Date): Promise<ScopeEvidence | null> {
    const all = await this.loadSite(site, knownAt);
    return (
      all.find(
        (s) => s.item.id === scope.itemId && (s.locationId ?? null) === (scope.locationId ?? null),
      ) ?? null
    );
  }

  /**
   * Everything for a site in a handful of queries rather than a handful per
   * item. Two dozen lines would survive the naive version; four thousand
   * would not, and the shape of the problem is the same either way.
   */
  async loadSite(site: SiteRef, knownAt?: Date): Promise<ScopeEvidence[]> {
    const siteId = site.siteId;
    const at = knownAt ?? null;

    const siteRow = await this.pool.query<{ organisation_id: string }>(
      `select organisation_id from sites where id = $1`,
      [siteId],
    );
    if (siteRow.rowCount === 0) throw new Error(`no such site: ${siteId}`);
    const organisationId = siteRow.rows[0]!.organisation_id;

    // --- items, with identity health --------------------------------------

    const itemsRes = await this.pool.query(
      // Both CTEs are scoped to this organisation. An unscoped shared_barcodes
      // would let two unrelated tenants using the same barcode make each
      // other's items look ambiguous, which is a tenancy leak wearing a data
      // quality costume.
      `with shared_barcodes as (
         select b.barcode from item_barcodes b
           join items i on i.id = b.item_id
          where i.organisation_id = $1 and b.active
          group by b.barcode having count(distinct b.item_id) > 1
       ),
       shared_skus as (
         select sku from items
          where organisation_id = $1 and sku is not null and active
          group by sku having count(*) > 1
       )
       select i.id, i.sku, i.name, i.stock_unit, i.active, i.blocked, i.blocked_reason,
              (
                exists (
                  select 1 from item_barcodes b
                   where b.item_id = i.id and b.active
                     and b.barcode in (select barcode from shared_barcodes)
                )
                or i.sku in (select sku from shared_skus)
              ) as identity_ambiguous
         from items i
        where i.organisation_id = $1
          and ($2::timestamptz is null or i.created_at <= $2)`,
      [organisationId, at],
    );

    const items = new Map<string, ScopeEvidence['item']>();
    for (const r of itemsRes.rows) {
      items.set(r.id, {
        id: r.id,
        sku: r.sku,
        name: r.name,
        stockUnit: r.stock_unit,
        active: r.active,
        blocked: r.blocked,
        blockedReason: r.blocked_reason,
        identityAmbiguous: r.identity_ambiguous,
      });
    }

    const key = (itemId: string, locationId: string | null) =>
      `${itemId}::${locationId ?? 'none'}`;

    // --- book, newest per scope as known at the given moment ---------------

    const bookRes = await this.pool.query(
      `select distinct on (item_id, location_id)
              id, item_id, location_id, quantity, unit, as_of, source_system_id
         from book_snapshots
        where site_id = $1 and ($2::timestamptz is null or created_at <= $2)
        order by item_id, location_id, as_of desc nulls last, created_at desc`,
      [siteId, at],
    );

    const books = new Map<string, ScopeEvidence['book']>();
    for (const r of bookRes.rows) {
      books.set(key(r.item_id, r.location_id), {
        id: r.id,
        quantity: Number(r.quantity),
        unit: r.unit,
        asOf: r.as_of,
        sourceSystemId: r.source_system_id,
      });
    }

    // --- counts ------------------------------------------------------------

    // Being superseded is itself a fact with a time. A line superseded
    // yesterday was still the current count last week, so a historical query
    // asks whether anything had superseded it *by then*, not whether anything
    // has superseded it since.
    const countRes = await this.pool.query(
      `select distinct on (cl.item_id, cl.location_id)
              cl.id, cl.item_id, cl.location_id, cl.quantity, cl.unit,
              cl.counted_at, cl.received_at, cl.counted_by, cl.count_session_id,
              cs.source_watermark
         from count_lines cl
         join count_sessions cs on cs.id = cl.count_session_id
        where cl.site_id = $1
          and ($2::timestamptz is null or cl.created_at <= $2)
          and ($2::timestamptz is not null or not cl.superseded)
          and not exists (
            select 1 from count_lines later
             where later.supersedes_count_line_id = cl.id
               and ($2::timestamptz is null or later.created_at <= $2)
          )
        order by cl.item_id, cl.location_id, cl.counted_at desc, cl.created_at desc`,
      [siteId, at],
    );

    const counts = new Map<string, ScopeEvidence['count']>();
    for (const r of countRes.rows) {
      counts.set(key(r.item_id, r.location_id), {
        id: r.id,
        quantity: Number(r.quantity),
        unit: r.unit,
        countedAt: r.counted_at,
        receivedAt: r.received_at,
        countedBy: r.counted_by,
        sessionId: r.count_session_id,
        sessionWatermark: r.source_watermark,
      });
    }

    // --- movements ---------------------------------------------------------

    // A mistaken movement is voided by a linked reversing movement, never by
    // deletion. The pair nets to zero and both halves stay readable, which is
    // what makes a bad entry auditable rather than merely gone.
    const moveRes = await this.pool.query(
      `select id, item_id, location_id, movement_type, quantity, unit,
              occurred_at, recorded_at, imported_at, source_system_id, reversal_of_id
         from movements
        where site_id = $1 and item_id is not null
          and ($2::timestamptz is null or imported_at <= $2)
        order by occurred_at nulls last`,
      [siteId, at],
    );

    const movements = new Map<string, ScopeEvidence['movements']>();
    for (const r of moveRes.rows) {
      const k = key(r.item_id, r.location_id);
      const m = {
        id: r.id,
        type: r.movement_type,
        quantity: Number(r.quantity),
        unit: r.unit,
        occurredAt: r.occurred_at,
        recordedAt: r.recorded_at,
        importedAt: r.imported_at,
        sourceSystemId: r.source_system_id,
        reversalOfId: r.reversal_of_id,
      };
      const list = movements.get(k);
      if (list) list.push(m);
      else movements.set(k, [m]);
    }

    // --- unmatched movements, and which items they might belong to ---------

    const unlinkedRes = await this.pool.query<{
      id: string;
      raw_payload: Record<string, unknown> | null;
    }>(
      `select id, raw_payload from movements
        where site_id = $1 and item_id is null
          and ($2::timestamptz is null or imported_at <= $2)`,
      [siteId, at],
    );
    const unlinkedMovementCount = unlinkedRes.rowCount ?? 0;

    const unlinkedCodes = unlinkedRes.rows
      .map((r) => normaliseCode(String(r.raw_payload?.code ?? '')))
      .filter((c) => c.length > 0);

    const labels = new Map<string, Set<string>>();
    const addLabel = (itemId: string, raw: string | null) => {
      const norm = normaliseCode(raw ?? '');
      if (!norm) return;
      const set = labels.get(itemId) ?? new Set<string>();
      set.add(norm);
      labels.set(itemId, set);
    };
    for (const item of items.values()) addLabel(item.id, item.sku);

    const aliasRes = await this.pool.query(
      `select a.item_id, a.alias from item_aliases a
         join items i on i.id = a.item_id
        where i.organisation_id = $1
          and ($2::timestamptz is null or a.created_at <= $2)`,
      [organisationId, at],
    );
    for (const r of aliasRes.rows) addLabel(r.item_id, r.alias);

    const barcodeRes = await this.pool.query(
      `select b.item_id, b.barcode from item_barcodes b
         join items i on i.id = b.item_id
        where i.organisation_id = $1 and b.active
          and ($2::timestamptz is null or b.created_at <= $2)`,
      [organisationId, at],
    );
    for (const r of barcodeRes.rows) addLabel(r.item_id, r.barcode);

    const possiblyRelated = new Map<string, number>();
    for (const code of unlinkedCodes) {
      for (const [itemId, set] of labels) {
        if (set.has(code)) possiblyRelated.set(itemId, (possiblyRelated.get(itemId) ?? 0) + 1);
      }
    }

    // --- source health -----------------------------------------------------

    // Source health is judged as at the moment being asked about, not as at
    // now. A feed that later went silent should not make a Tuesday report look
    // more doubtful than Tuesday actually was.
    const sourceRes = await this.pool.query(
      `select id, name, expected_sync_minutes, last_success_at
         from source_systems
        where organisation_id = $1
          and ($2::timestamptz is null or last_success_at is null or last_success_at <= $2)`,
      [organisationId, at],
    );
    const sources: SourceHealth[] = sourceRes.rows.map((r) => ({
      sourceSystemId: r.id,
      name: r.name,
      expectedSyncMinutes: r.expected_sync_minutes == null ? null : Number(r.expected_sync_minutes),
      lastSuccessAt: r.last_success_at,
    }));

    // --- assemble ----------------------------------------------------------

    const keys = new Set<string>([...books.keys(), ...counts.keys(), ...movements.keys()]);
    const out: ScopeEvidence[] = [];

    for (const k of keys) {
      const [itemId, locRaw] = k.split('::');
      const item = items.get(itemId!);
      if (!item) continue;
      out.push({
        item,
        locationId: locRaw === 'none' ? null : locRaw!,
        book: books.get(k) ?? null,
        count: counts.get(k) ?? null,
        movements: movements.get(k) ?? [],
        unlinkedMovementCount,
        possiblyRelatedUnlinkedCount: possiblyRelated.get(item.id) ?? 0,
        sources,
      });
    }

    // Items with nothing recorded anywhere. Never counted is a finding, not an
    // absence, so they belong in the output rather than being skipped.
    const seen = new Set([...keys].map((k) => k.split('::')[0]));
    for (const item of items.values()) {
      if (seen.has(item.id) || !item.active) continue;
      out.push({
        item,
        locationId: null,
        book: null,
        count: null,
        movements: [],
        unlinkedMovementCount,
        possiblyRelatedUnlinkedCount: possiblyRelated.get(item.id) ?? 0,
        sources,
      });
    }

    return out;
  }
}

/**
 * Codes get typed, printed and exported with whatever punctuation the day
 * brought. HOP-CAS-5 and HOPCAS5 are the same code to a person in the
 * warehouse, so they are the same code here. Only ever used to raise a
 * question; nothing is linked automatically on the strength of it.
 */
function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
