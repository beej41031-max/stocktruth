import type { Pool, PoolClient } from 'pg';
import {
  ENGINE_VERSION,
  analyseMaterialVariance,
  combineHistoricalEvidenceClosure,
  compareVerificationCandidates,
  scoreVerificationCandidate,
  type BomVersion,
  type EvidenceKnowledgePolicy,
  type MaterialVarianceOutput,
  type Movement,
  type ProductionOutput,
  type VerificationCandidate,
} from '@stocktruth/engine';

export interface LateEvidenceReviewTarget {
  evidenceKind: 'movement' | 'production';
  sourceSystemId: string;
  sourceName: string;
  lateCount: number;
}

export interface MaterialVarianceRow {
  itemId: string;
  sku: string | null;
  name: string;
  unit: string;
  locationId: string | null;
  locationCode: string | null;
  currency: string;
  unitCost: number | null;
  targetCountCycleDays: number;
  closingSessionId: string;
  closingCountLineId: string;
  reviewTargets: LateEvidenceReviewTarget[];
  output: MaterialVarianceOutput;
  verificationPriority: number;
  verificationBasis: VerificationCandidate['priorityBasis'];
  verificationCandidate: VerificationCandidate;
}

export interface MaterialVarianceOverview {
  rows: MaterialVarianceRow[];
  closedCount: number;
  provisionalCount: number;
  actualOnlyCount: number;
  incompleteCount: number;
  adverseCost: number;
  favourableCost: number;
  netVarianceCost: number;
  provisionalExposureCost: number;
  unquantifiedExposureCount: number;
  topVerification: MaterialVarianceRow[];
}

type CountRow = {
  id: string;
  count_session_id: string;
  item_id: string;
  location_id: string | null;
  quantity: string;
  unit: string;
  counted_at: Date;
  received_at: Date;
  movement_evidence_confirmed_through: Date | null;
  movement_evidence_confirmed_at: Date | null;
  production_evidence_confirmed_through: Date | null;
  production_evidence_confirmed_at: Date | null;
};

type ItemRow = {
  id: string;
  sku: string | null;
  name: string;
  stock_unit: string;
  standard_unit_cost: string | null;
  cost_currency: string;
  target_count_cycle_days: number;
};

type MovementRow = {
  id: string;
  item_id: string;
  location_id: string | null;
  movement_type: Movement['type'];
  quantity: string;
  unit: string;
  occurred_at: Date | null;
  recorded_at: Date | null;
  imported_at: Date;
  source_system_id: string | null;
  reversal_of_id: string | null;
};

type ProductionRow = {
  id: string;
  product_id: string;
  quantity: string;
  unit: string;
  completed_at: Date;
  recorded_at: Date | null;
  imported_at: Date;
  source_system_id: string | null;
};

type SourceHistoryRow = {
  source_system_id: string | null;
  source_name: string | null;
  expected_sync_minutes: number | null;
  watermark_at: Date | null;
  claimed_at: Date | null;
};

type SourceHistory = {
  hasManual: boolean;
  automatedSources: Array<{
    sourceSystemId: string;
    sourceName: string;
    claims: Array<{ watermarkAt: Date; claimedAt: Date }>;
  }>;
};

type ReviewRow = {
  closing_count_session_id: string;
  closing_count_line_id: string;
  evidence_kind: 'movement' | 'production';
  source_system_id: string;
  reviewed_through_imported_at: Date;
  reviewed_at: Date;
  reviewed_evidence_count: number;
};

export async function loadMaterialVarianceOverview(pool: Pool, siteId: string): Promise<MaterialVarianceOverview> {
  const site = await pool.query<{ organisation_id: string }>(
    `select organisation_id from sites where id = $1`,
    [siteId],
  );
  const organisationId = site.rows[0]?.organisation_id;
  if (!organisationId) return emptyOverview();

  const [
    itemsRes,
    policyRes,
    countsRes,
    movementsRes,
    productionRes,
    bomRes,
    movementSourceHistoryRes,
    productionSourceHistoryRes,
    reviewsRes,
  ] = await Promise.all([
    pool.query<ItemRow>(
      `select id, sku, name, stock_unit, standard_unit_cost, cost_currency, target_count_cycle_days
         from items where organisation_id = $1`,
      [organisationId],
    ),
    pool.query<{ max_clock_skew_minutes: number }>(
      `select max_clock_skew_minutes from reconciliation_policies where site_id = $1`,
      [siteId],
    ),
    pool.query<CountRow>(
      `select cl.id, cl.count_session_id, cl.item_id, cl.location_id, cl.quantity, cl.unit, cl.counted_at, cl.received_at,
              cs.movement_evidence_confirmed_through,
              cs.movement_evidence_confirmed_at,
              cs.production_evidence_confirmed_through,
              cs.production_evidence_confirmed_at
         from count_lines cl
         join count_sessions cs on cs.id = cl.count_session_id
        where cl.site_id = $1 and not cl.superseded and cs.status = 'completed'
        order by cl.item_id, cl.location_id nulls first, cl.counted_at`,
      [siteId],
    ),
    pool.query<MovementRow>(
      `select id, item_id, location_id, movement_type, quantity, unit,
              occurred_at, recorded_at, imported_at, source_system_id, reversal_of_id
         from movements
        where site_id = $1 and item_id is not null`,
      [siteId],
    ),
    pool.query<ProductionRow>(
      `select id, product_id, quantity, unit, completed_at, recorded_at, imported_at, source_system_id
         from production_outputs where site_id = $1`,
      [siteId],
    ),
    pool.query<{
      bom_id: string;
      product_id: string;
      output_unit: string;
      valid_from: Date;
      valid_to: Date | null;
      item_id: string | null;
      quantity_per_output: string | null;
      unit: string | null;
    }>(
      `select bv.id as bom_id, bv.product_id, p.output_unit, bv.valid_from, bv.valid_to,
              bl.item_id, bl.quantity_per_output, bl.unit
         from bom_versions bv
         join products p on p.id = bv.product_id
         left join bom_lines bl on bl.bom_version_id = bv.id
        where p.organisation_id = $1
        order by bv.id`,
      [organisationId],
    ),
    pool.query<SourceHistoryRow>(
      `with evidence_sources as (
         select distinct m.source_system_id
           from movements m
          where m.site_id = $2 and m.item_id is not null
       )
       select es.source_system_id,
              ss.name as source_name,
              ss.expected_sync_minutes,
              h.watermark_at,
              h.claimed_at
         from evidence_sources es
         left join source_systems ss
           on ss.id = es.source_system_id and ss.organisation_id = $1
         left join source_watermark_history h
           on h.source_system_id = ss.id
        order by es.source_system_id nulls first, h.claimed_at nulls first`,
      [organisationId, siteId],
    ),
    pool.query<SourceHistoryRow>(
      `with evidence_sources as (
         select distinct po.source_system_id
           from production_outputs po
          where po.site_id = $2
       )
       select es.source_system_id,
              ss.name as source_name,
              ss.expected_sync_minutes,
              h.watermark_at,
              h.claimed_at
         from evidence_sources es
         left join source_systems ss
           on ss.id = es.source_system_id and ss.organisation_id = $1
         left join source_watermark_history h
           on h.source_system_id = ss.id
        order by es.source_system_id nulls first, h.claimed_at nulls first`,
      [organisationId, siteId],
    ),
    pool.query<ReviewRow>(
      `select closing_count_session_id, closing_count_line_id, evidence_kind, source_system_id,
              reviewed_through_imported_at, reviewed_at, reviewed_evidence_count
         from automated_evidence_reviews
        where site_id = $1
        order by reviewed_at`,
      [siteId],
    ),
  ]);

  const items = new Map(itemsRes.rows.map((r) => [r.id, r]));
  const maxClockSkewMinutes = Number(policyRes.rows[0]?.max_clock_skew_minutes ?? 10);
  const [locationRows, observedLocationRows] = await Promise.all([
    pool.query<{ id: string; code: string }>(
      `select id, code from locations where site_id = $1`,
      [siteId],
    ),
    pool.query<{ item_id: string; location_id: string | null }>(
      `select distinct item_id, location_id from (
         select cl.item_id, cl.location_id from count_lines cl join count_sessions cs on cs.id = cl.count_session_id where cl.site_id = $1 and not cl.superseded and cs.status = 'completed'
         union all
         select item_id, location_id from movements where site_id = $1 and item_id is not null
         union all
         select item_id, location_id from book_snapshots where site_id = $1
       ) scopes`,
      [siteId],
    ),
  ]);
  const locations = new Map(locationRows.rows.map((r) => [r.id, r.code]));

  const production: ProductionOutput[] = productionRes.rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    quantity: Number(r.quantity),
    unit: r.unit,
    completedAt: new Date(r.completed_at),
    recordedAt: r.recorded_at ? new Date(r.recorded_at) : null,
    importedAt: new Date(r.imported_at),
    sourceSystemId: r.source_system_id,
  }));

  const bomMap = new Map<string, BomVersion>();
  for (const r of bomRes.rows) {
    let bom = bomMap.get(r.bom_id);
    if (!bom) {
      bom = {
        id: r.bom_id,
        productId: r.product_id,
        outputUnit: r.output_unit,
        validFrom: new Date(r.valid_from),
        validTo: r.valid_to ? new Date(r.valid_to) : null,
        lines: [],
      };
      bomMap.set(r.bom_id, bom);
    }
    if (r.item_id && r.quantity_per_output != null && r.unit) {
      bom.lines.push({
        itemId: r.item_id,
        quantityPerOutput: Number(r.quantity_per_output),
        unit: r.unit,
      });
    }
  }
  const boms = [...bomMap.values()];
  const movementSourceHistory = normaliseSourceHistory(movementSourceHistoryRes.rows);
  const productionSourceHistory = normaliseSourceHistory(productionSourceHistoryRes.rows);
  const reviewsByClosingLineKind = new Map<string, ReviewRow[]>();
  for (const review of reviewsRes.rows) {
    const reviewKey = `${review.closing_count_line_id}::${review.evidence_kind}`;
    const list = reviewsByClosingLineKind.get(reviewKey) ?? [];
    list.push(review);
    reviewsByClosingLineKind.set(reviewKey, list);
  }

  const scopeKey = (itemId: string, locationId: string | null) => `${itemId}::${locationId ?? 'none'}`;
  const countsByScope = new Map<string, CountRow[]>();
  const locationsByItem = new Map<string, Set<string>>();
  for (const scope of observedLocationRows.rows) {
    const set = locationsByItem.get(scope.item_id) ?? new Set<string>();
    set.add(scope.location_id ?? 'none');
    locationsByItem.set(scope.item_id, set);
  }
  for (const c of countsRes.rows) {
    const key = scopeKey(c.item_id, c.location_id);
    const list = countsByScope.get(key) ?? [];
    list.push(c);
    countsByScope.set(key, list);
  }

  const movementsByScope = new Map<string, Movement[]>();
  for (const r of movementsRes.rows) {
    const key = scopeKey(r.item_id, r.location_id);
    const list = movementsByScope.get(key) ?? [];
    list.push({
      id: r.id,
      type: r.movement_type,
      quantity: Number(r.quantity),
      unit: r.unit,
      occurredAt: r.occurred_at ? new Date(r.occurred_at) : null,
      recordedAt: r.recorded_at ? new Date(r.recorded_at) : null,
      importedAt: new Date(r.imported_at),
      sourceSystemId: r.source_system_id,
      reversalOfId: r.reversal_of_id,
    });
    movementsByScope.set(key, list);
  }

  const rows: MaterialVarianceRow[] = [];
  const now = new Date();

  for (const [key, countRows] of countsByScope) {
    const pair = latestDistinctSessionPair(countRows);
    if (!pair) continue;
    const { opening, closing } = pair;
    const item = items.get(closing.item_id);
    if (!item) continue;

    // Production output is site-wide. Until the model can allocate production
    // consumption to locations, charging the same theory to two storage scopes
    // would double count it. A multi-location material is therefore actual-only
    // rather than confidently wrong.
    const theoryScopeComplete = (locationsByItem.get(item.id)?.size ?? 0) <= 1;

    // Automated completeness is historical, not mutable current state. For
    // each source use the first immutable watermark claim that crossed this
    // interval's close. A later sync can never make a previously-late row look
    // timely. Manual attestation still covers only the manual-source side.
    const intervalClose = new Date(closing.counted_at);
    const movementClosure = combineHistoricalEvidenceClosure({
      cutoff: intervalClose,
      automatedSources: movementSourceHistory.automatedSources,
      hasManual: movementSourceHistory.hasManual,
      manualThrough: toDateOrNull(closing.movement_evidence_confirmed_through),
      manualClaimedAt: toDateOrNull(closing.movement_evidence_confirmed_at),
      automatedReviews: reviewsForClosingLine(reviewsByClosingLineKind, closing.id, 'movement'),
    });
    const productionClosure = combineHistoricalEvidenceClosure({
      cutoff: intervalClose,
      automatedSources: productionSourceHistory.automatedSources,
      hasManual: productionSourceHistory.hasManual,
      manualThrough: toDateOrNull(closing.production_evidence_confirmed_through),
      manualClaimedAt: toDateOrNull(closing.production_evidence_confirmed_at),
      automatedReviews: reviewsForClosingLine(reviewsByClosingLineKind, closing.id, 'production'),
    });

    const output = analyseMaterialVariance({
      itemId: item.id,
      unit: item.stock_unit,
      opening: {
        id: opening.id,
        quantity: Number(opening.quantity),
        unit: opening.unit,
        countedAt: new Date(opening.counted_at),
        receivedAt: new Date(opening.received_at),
      },
      closing: {
        id: closing.id,
        quantity: Number(closing.quantity),
        unit: closing.unit,
        countedAt: new Date(closing.counted_at),
        receivedAt: new Date(closing.received_at),
      },
      movements: movementsByScope.get(key) ?? [],
      production,
      boms,
      movementWatermark: movementClosure.watermark,
      movementWatermarkObservedAt: movementClosure.observedAt,
      movementKnowledgePolicy: knowledgePolicy(movementClosure.automatedKnowledgeCutoffBySource, toDateOrNull(closing.movement_evidence_confirmed_at)),
      productionWatermark: productionClosure.watermark,
      productionWatermarkObservedAt: productionClosure.observedAt,
      productionKnowledgePolicy: knowledgePolicy(productionClosure.automatedKnowledgeCutoffBySource, toDateOrNull(closing.production_evidence_confirmed_at)),
      theoryScopeComplete,
      unitCost: item.standard_unit_cost == null ? null : Number(item.standard_unit_cost),
      maxClockSkewMinutes,
    });

    const reviewTargets = buildReviewTargets(
      output,
      movementsByScope.get(key) ?? [],
      production,
      movementSourceHistory,
      productionSourceHistory,
    );

    const unitCost = item.standard_unit_cost == null ? null : Number(item.standard_unit_cost);
    const daysSinceCount = Math.max(0, (now.getTime() - new Date(closing.counted_at).getTime()) / 86_400_000);
    const priority = scoreVerificationCandidate({
      itemId: item.id,
      unitCost,
      // Provisional variance is not quantity uncertainty. Leave it unknown
      // unless a separate bounded quantity model supplies an actual range.
      uncertaintyQuantity: null,
      historicalVarianceCost: output.state === 'CLOSED' ? output.varianceCost ?? 0 : 0,
      historicalVarianceQuantity: output.state === 'CLOSED' ? output.varianceQuantity ?? 0 : 0,
      unsettledVarianceCost: output.state === 'PROVISIONAL' ? Math.abs(output.varianceCost ?? 0) : 0,
      daysSinceCount,
      targetCycleDays: item.target_count_cycle_days,
    });

    rows.push({
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.stock_unit,
      locationId: closing.location_id,
      locationCode: closing.location_id ? locations.get(closing.location_id) ?? null : null,
      currency: item.cost_currency,
      unitCost,
      targetCountCycleDays: item.target_count_cycle_days,
      closingSessionId: closing.count_session_id,
      closingCountLineId: closing.id,
      reviewTargets,
      output,
      verificationPriority: priority.priorityScore,
      verificationBasis: priority.priorityBasis,
      verificationCandidate: priority,
    });
  }

  rows.sort((a, b) => Math.abs(b.output.varianceCost ?? 0) - Math.abs(a.output.varianceCost ?? 0));
  const closed = rows.filter((r) => r.output.state === 'CLOSED');
  const adverseCost = closed.reduce((s, r) => s + Math.max(0, r.output.varianceCost ?? 0), 0);
  const favourableCost = closed.reduce((s, r) => s + Math.min(0, r.output.varianceCost ?? 0), 0);
  const provisionalRows = rows.filter((r) => r.output.state === 'PROVISIONAL' || r.output.state === 'ACTUAL_ONLY');
  const provisionalExposureCost = provisionalRows
    .filter((r) => r.output.varianceCost != null)
    .reduce((s, r) => s + Math.abs(r.output.varianceCost!), 0);
  const unquantifiedExposureCount = provisionalRows.filter((r) => r.output.varianceCost == null).length;

  return {
    rows,
    closedCount: rows.filter((r) => r.output.state === 'CLOSED').length,
    provisionalCount: rows.filter((r) => r.output.state === 'PROVISIONAL').length,
    actualOnlyCount: rows.filter((r) => r.output.state === 'ACTUAL_ONLY').length,
    incompleteCount: rows.filter((r) => r.output.state === 'INCOMPLETE' || r.output.state === 'CONFLICT').length,
    adverseCost,
    favourableCost,
    netVarianceCost: adverseCost + favourableCost,
    provisionalExposureCost,
    unquantifiedExposureCount,
    topVerification: [...rows].sort(compareVerificationRows).slice(0, 5),
  };
}

export async function persistMaterialVarianceRun(
  pool: Pool,
  siteId: string,
  triggeredBy: string | null = null,
  triggerReason = 'manual',
): Promise<{ runId: string; intervalCount: number; overview: MaterialVarianceOverview }> {
  const overview = await loadMaterialVarianceOverview(pool, siteId);
  const org = await pool.query<{ organisation_id: string }>(`select organisation_id from sites where id = $1`, [siteId]);
  const organisationId = org.rows[0]?.organisation_id;
  if (!organisationId) throw new Error(`no such site: ${siteId}`);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const run = await client.query<{ id: string }>(
      `insert into material_variance_runs
         (organisation_id, site_id, engine_version, evaluated_at, triggered_by, trigger_reason, interval_count)
       values ($1,$2,$3,now(),$4,$5,$6) returning id`,
      [organisationId, siteId, ENGINE_VERSION, triggeredBy, triggerReason, overview.rows.length],
    );
    const runId = run.rows[0]!.id;

    for (const row of overview.rows) {
      await insertVarianceResult(client, runId, organisationId, siteId, row);
    }

    await client.query(`update material_variance_runs set completed_at = now() where id = $1`, [runId]);
    await client.query(
      `insert into audit_events
         (organisation_id, site_id, actor_user_id, actor_type, actor_label,
          event_type, object_type, object_id, detail)
       values ($1,$2,$3,'engine','material variance engine','MATERIAL_VARIANCE_RUN','material_variance_run',$4,$5::jsonb)`,
      [
        organisationId,
        siteId,
        triggeredBy,
        runId,
        JSON.stringify({
          engineVersion: ENGINE_VERSION,
          intervalCount: overview.rows.length,
          adverseCost: overview.adverseCost,
          favourableCost: overview.favourableCost,
          netVarianceCost: overview.netVarianceCost,
        }),
      ],
    );
    await client.query('commit');
    return { runId, intervalCount: overview.rows.length, overview };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function insertVarianceResult(
  client: PoolClient,
  runId: string,
  organisationId: string,
  siteId: string,
  row: MaterialVarianceRow,
) {
  const o = row.output;
  await client.query(
    `insert into material_variance_results
       (material_variance_run_id, organisation_id, site_id, item_id, location_id,
        opening_count_line_id, closing_count_line_id, state, interval_start, interval_end,
        opening_quantity, closing_quantity, receipts, transfer_in, returns_in, transfer_out,
        actual_consumption, theoretical_consumption, variance_quantity, variance_percent,
        unit_cost, variance_cost, cost_currency, movement_watermark, movement_watermark_observed_at,
        production_watermark, production_watermark_observed_at,
        late_movement_count, late_production_count, reason_codes, evidence)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
    [
      runId,
      organisationId,
      siteId,
      row.itemId,
      row.locationId,
      o.evidence.openingCountId,
      o.evidence.closingCountId,
      o.state,
      o.intervalStart,
      o.intervalEnd,
      o.openingQuantity,
      o.closingQuantity,
      o.receipts,
      o.transferIn,
      o.returnsIn,
      o.transferOut,
      o.actualConsumption,
      o.theoreticalConsumption,
      o.varianceQuantity,
      o.variancePercent,
      row.unitCost,
      o.varianceCost,
      row.currency,
      o.movementWatermark,
      o.movementWatermarkObservedAt,
      o.productionWatermark,
      o.productionWatermarkObservedAt,
      o.lateRecordedMovementCount,
      o.lateRecordedProductionCount,
      o.reasons,
      JSON.stringify(o.evidence),
    ],
  );
}

function latestDistinctSessionPair(rows: CountRow[]): { opening: CountRow; closing: CountRow } | null {
  const sorted = [...rows].sort((a, b) => new Date(b.counted_at).getTime() - new Date(a.counted_at).getTime());
  const closing = sorted[0];
  if (!closing) return null;
  const opening = sorted.find((r) => r.count_session_id !== closing.count_session_id);
  return opening ? { opening, closing } : null;
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  return value == null ? null : new Date(value);
}

function normaliseSourceHistory(rows: SourceHistoryRow[]): SourceHistory {
  let hasManual = false;
  const bySource = new Map<string, { sourceName: string; claims: Array<{ watermarkAt: Date; claimedAt: Date }> }>();

  for (const row of rows) {
    if (row.source_system_id == null || row.expected_sync_minutes == null) {
      hasManual = true;
      continue;
    }

    const entry = bySource.get(row.source_system_id) ?? {
      sourceName: row.source_name ?? 'Automated source',
      claims: [],
    };
    if (row.watermark_at != null && row.claimed_at != null) {
      entry.claims.push({ watermarkAt: new Date(row.watermark_at), claimedAt: new Date(row.claimed_at) });
    }
    bySource.set(row.source_system_id, entry);
  }

  return {
    hasManual,
    automatedSources: [...bySource.entries()].map(([sourceSystemId, entry]) => ({
      sourceSystemId, sourceName: entry.sourceName, claims: entry.claims,
    })),
  };
}

function reviewsForClosingLine(
  reviewsByClosingLineKind: Map<string, ReviewRow[]>,
  closingCountLineId: string,
  evidenceKind: 'movement' | 'production',
) {
  return (reviewsByClosingLineKind.get(`${closingCountLineId}::${evidenceKind}`) ?? []).map((r) => ({
    sourceSystemId: r.source_system_id,
    reviewedThroughImportedAt: new Date(r.reviewed_through_imported_at),
    reviewedAt: new Date(r.reviewed_at),
  }));
}

function buildReviewTargets(
  output: MaterialVarianceOutput,
  movements: Movement[],
  production: ProductionOutput[],
  movementHistory: SourceHistory,
  productionHistory: SourceHistory,
): LateEvidenceReviewTarget[] {
  const targets = new Map<string, LateEvidenceReviewTarget>();
  const movementNames = new Map(movementHistory.automatedSources.map((s) => [s.sourceSystemId, s.sourceName]));
  const productionNames = new Map(productionHistory.automatedSources.map((s) => [s.sourceSystemId, s.sourceName]));
  const lateMovementIds = new Set(output.evidence.lateMovementIds);
  const lateProductionIds = new Set(output.evidence.lateProductionOutputIds);

  for (const m of movements) {
    if (!lateMovementIds.has(m.id) || !m.sourceSystemId || !movementNames.has(m.sourceSystemId)) continue;
    const key = `movement::${m.sourceSystemId}`;
    const existing = targets.get(key);
    if (existing) existing.lateCount += 1;
    else targets.set(key, {
      evidenceKind: 'movement', sourceSystemId: m.sourceSystemId,
      sourceName: movementNames.get(m.sourceSystemId)!, lateCount: 1,
    });
  }

  for (const po of production) {
    if (!lateProductionIds.has(po.id) || !po.sourceSystemId || !productionNames.has(po.sourceSystemId)) continue;
    const key = `production::${po.sourceSystemId}`;
    const existing = targets.get(key);
    if (existing) existing.lateCount += 1;
    else targets.set(key, {
      evidenceKind: 'production', sourceSystemId: po.sourceSystemId,
      sourceName: productionNames.get(po.sourceSystemId)!, lateCount: 1,
    });
  }

  return [...targets.values()];
}

function knowledgePolicy(
  automatedClaimedAtBySource: Readonly<Record<string, Date | null>>,
  manualClaimedAt: Date | null,
): EvidenceKnowledgePolicy {
  return { automatedClaimedAtBySource, manualClaimedAt };
}

function compareVerificationRows(a: MaterialVarianceRow, b: MaterialVarianceRow): number {
  return compareVerificationCandidates(a.verificationCandidate, b.verificationCandidate);
}

function emptyOverview(): MaterialVarianceOverview {
  return {
    rows: [],
    closedCount: 0,
    provisionalCount: 0,
    actualOnlyCount: 0,
    incompleteCount: 0,
    adverseCost: 0,
    favourableCost: 0,
    netVarianceCost: 0,
    provisionalExposureCost: 0,
    unquantifiedExposureCount: 0,
    topVerification: [],
  };
}
