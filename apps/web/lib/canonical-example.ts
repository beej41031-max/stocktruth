import type { Pool } from 'pg';
import { DEFAULT_POLICY, explain, asOfKnowledge, type Explanation } from '@stocktruth/engine';
import { PostgresEvidenceSource } from './adapters/postgres';

/**
 * The one item this whole product is explained around.
 *
 * Not a scripted mockup. Every number and timestamp here comes from the real
 * engine running against the real (synthetic) database, the same code path
 * `/items/[id]` and `scripts/explain.ts` use. If the seed data changes, this
 * changes with it, honestly, rather than a marketing page quietly drifting
 * out of sync with what the product actually does.
 */

export interface CanonicalExample {
  itemId: string;
  sku: string;
  name: string;
  unit: string;
  book: { quantity: number; asOf: string | null } | null;
  count: { quantity: number; countedAt: string; location: string | null; by: string | null } | null;
  now: Explanation;
  asOfBeforeLateMovement: { at: string; state: string | null; quantity: number | null } | null;
  lateMovement: { quantity: number; occurredAt: string; recordedAt: string; gapHours: number } | null;
}

export async function loadCanonicalExample(
  pool: Pool,
  siteId: string,
  sku = 'PKG-CAN-440',
): Promise<CanonicalExample | null> {
  const itemRow = await pool.query<{ id: string; sku: string; name: string; stock_unit: string }>(
    `select id, sku, name, stock_unit from items where sku = $1 limit 1`,
    [sku],
  );
  const item = itemRow.rows[0];
  if (!item) return null;

  const source = new PostgresEvidenceSource(pool);
  const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy({ siteId })) };
  // Found by item id across whatever scopes exist at the site, rather than
  // guessing a location. loadScope needs an exact (item, location) key; here
  // we do not yet know which location this item actually landed at.
  const allScopes = await source.loadSite({ siteId });
  const scope = allScopes.find((s) => s.item.id === item.id);
  if (!scope) return null;

  const now = explain({
    item: scope.item,
    locationId: scope.locationId,
    book: scope.book,
    count: scope.count,
    movements: scope.movements,
    unlinkedMovementCount: scope.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
    sources: scope.sources,
    policy,
    evaluatedAt: new Date(),
  });

  // The movement that spans the count, if there is one, is the one worth
  // dramatising: it is the exact mechanism, not a stand-in for it.
  const spanning = scope.count
    ? scope.movements.find(
        (m) =>
          m.occurredAt != null &&
          m.recordedAt != null &&
          m.occurredAt.getTime() <= scope.count!.countedAt.getTime() &&
          m.recordedAt.getTime() > scope.count!.countedAt.getTime(),
      )
    : undefined;

  let asOfBeforeLateMovement: CanonicalExample['asOfBeforeLateMovement'] = null;
  let lateMovement: CanonicalExample['lateMovement'] = null;

  if (spanning?.recordedAt) {
    const before = new Date(spanning.recordedAt.getTime() - 60_000);
    const answer = await asOfKnowledge(source, {
      site: { siteId },
      scope: { itemId: item.id, locationId: scope.locationId },
      knownAt: before,
    });
    asOfBeforeLateMovement = {
      at: before.toISOString(),
      state: answer.result?.state ?? null,
      quantity: answer.result?.derivedQuantity ?? null,
    };
    lateMovement = {
      quantity: spanning.quantity,
      occurredAt: spanning.occurredAt!.toISOString(),
      recordedAt: spanning.recordedAt.toISOString(),
      gapHours: Math.round((spanning.recordedAt.getTime() - spanning.occurredAt!.getTime()) / 3_600_000),
    };
  }

  let locationCode: string | null = null;
  if (scope.locationId) {
    const loc = await pool.query<{ code: string }>(`select code from locations where id = $1`, [
      scope.locationId,
    ]);
    locationCode = loc.rows[0]?.code ?? null;
  }
  // Do not query Supabase's private auth schema from app code.
  // The demo only needs to show that a signed-in actor performed the count.
  const countedByName = scope.count?.countedBy ? 'Signed-in counter' : null;
return {
    itemId: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.stock_unit,
    book: scope.book ? { quantity: scope.book.quantity, asOf: scope.book.asOf?.toISOString() ?? null } : null,
    count: scope.count
      ? {
          quantity: scope.count.quantity,
          countedAt: scope.count.countedAt.toISOString(),
          location: locationCode,
          by: countedByName,
        }
      : null,
    now,
    asOfBeforeLateMovement,
    lateMovement,
  };
}
