/**
 * The stress test.
 *
 *   npx tsx scripts/stress.ts --items=10000 --movements=8
 *
 * Generates a large, deliberately unpleasant synthetic warehouse, loads it
 * through the real Postgres adapter, reconciles every scope with the real
 * engine, and checks one thing on every single result: does the refusal
 * invariant hold. Not a benchmark dressed up as a test. The timings are
 * reported because they are true, not because they are the point.
 *
 * Writes apps/web/stress-report.json, which the /stress page renders.
 * Deterministic seed, so a report committed today should be reproducible by
 * anyone who runs this against a fresh database.
 */
import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_POLICY,
  analyseMaterialVariance,
  assessOperationalPosition,
  explain,
  reconcile,
  type Movement,
  type ReconciliationOutput,
} from '@stocktruth/engine';

import { PostgresEvidenceSource } from '../lib/adapters/postgres';
import { checkInvariant } from '../../../packages/engine/test/invariant';
import { generateStressData, cleanupStressData } from './stress-generate';

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

const itemCount = arg('items', 10_000);
const movementsPerItem = arg('movements', 8);
const labelFlag = process.argv.indexOf('--label');
const label =
  labelFlag >= 0
    ? process.argv[labelFlag + 1]
    : `${itemCount.toLocaleString()} items, ${movementsPerItem} movement slots each`;


function runDecisionLayerStressProbes(): string[] {
  const failures: string[] = [];
  const base: ReconciliationOutput = {
    state: 'INCOMPLETE',
    bookQuantity: null,
    bookAsOf: null,
    physicalQuantity: 1000,
    physicalCountedAt: new Date('2026-09-01T12:00:00Z'),
    derivedQuantity: null,
    derivedAsOf: null,
    varianceAtCount: null,
    movementNet: 0,
    movementWindowStart: new Date('2026-09-01T12:00:00Z'),
    movementWindowEnd: new Date('2026-09-01T13:00:00Z'),
    reasons: ['MOVEMENT_SPANS_COUNT'],
    evidence: { movementIds: [], ignoredMovementIds: [] },
  };

  // Independent-sign range property. Opposite movements are deliberately
  // common in this probe because netting them before building the range is the
  // exact false-certainty failure this layer must never regress to.
  for (let i = 0; i < 500; i++) {
    const movements: Movement[] = [];
    let positive = 0;
    let negative = 0;
    for (let j = 0; j < 6; j++) {
      const qty = ((i * 17 + j * 31) % 97) + 1;
      const positiveType = (i + j) % 2 === 0;
      const type: Movement['type'] = positiveType ? 'RECEIVE' : 'TRANSFER_OUT';
      movements.push({
        id: `probe-${i}-${j}`,
        type,
        quantity: qty,
        unit: 'each',
        occurredAt: new Date('2026-09-01T11:00:00Z'),
        recordedAt: new Date('2026-09-01T12:30:00Z'),
        importedAt: new Date('2026-09-01T12:30:00Z'),
        sourceSystemId: 'probe',
      });
      if (positiveType) positive += qty;
      else negative += qty;
    }
    const assessed = assessOperationalPosition({ result: base, spanningMovements: movements });
    if (assessed.lowerBound !== 1000 - negative || assessed.upperBound !== 1000 + positive) {
      failures.push(`operational range probe ${i} collapsed independent movement exposure`);
      break;
    }
  }

  const openingAt = new Date('2026-09-01T00:00:00Z');
  const closingAt = new Date('2026-09-08T00:00:00Z');
  const watermark = new Date('2026-09-08T01:00:00Z');
  const original: Movement = {
    id: 'receipt', type: 'RECEIVE', quantity: 200, unit: 'kg',
    occurredAt: new Date('2026-09-03T00:00:00Z'), recordedAt: new Date('2026-09-03T00:05:00Z'),
    importedAt: new Date('2026-09-03T00:05:00Z'), sourceSystemId: 'probe',
  };
  const reversal: Movement = {
    ...original, id: 'reversal', type: 'ISSUE', reversalOfId: 'receipt',
  };
  const reversed = analyseMaterialVariance({
    itemId: 'resin', unit: 'kg',
    opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
    closing: { id: 'c2', quantity: 600, unit: 'kg', countedAt: closingAt },
    movements: [original, reversal],
    production: [{ id: 'p1', productId: 'widget', quantity: 40, unit: 'each', completedAt: new Date('2026-09-04T00:00:00Z'), recordedAt: new Date('2026-09-04T00:05:00Z'), importedAt: new Date('2026-09-04T00:05:00Z'), sourceSystemId: 'probe' }],
    boms: [{ id: 'b1', productId: 'widget', outputUnit: 'each', validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, lines: [{ itemId: 'resin', quantityPerOutput: 10, unit: 'kg' }] }],
    movementWatermark: watermark,
    productionWatermark: watermark,
    unitCost: 1,
  });
  if (reversed.state !== 'CLOSED' || reversed.varianceQuantity !== 0) {
    failures.push('variance reversal probe turned a corrected receipt into loss');
  }

  const missingProduction = analyseMaterialVariance({
    itemId: 'resin', unit: 'kg',
    opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
    closing: { id: 'c2', quantity: 600, unit: 'kg', countedAt: closingAt },
    movements: [], production: [], boms: [],
    movementWatermark: watermark,
    productionWatermark: null,
    unitCost: 1,
  });
  if (missingProduction.state === 'CLOSED' || missingProduction.varianceCost != null) {
    failures.push('variance production-feed probe manufactured a closed loss from missing theory');
  }

  const duplicateReceiptA: Movement = {
    id: 'dup-receipt-a', type: 'RECEIVE', quantity: 200, unit: 'kg',
    occurredAt: new Date('2026-09-03T10:00:00Z'), recordedAt: new Date('2026-09-03T10:01:00Z'),
    importedAt: new Date('2026-09-03T10:02:00Z'), sourceSystemId: 'probe',
  };
  const duplicateReceiptB: Movement = {
    ...duplicateReceiptA, id: 'dup-receipt-b', occurredAt: new Date('2026-09-03T10:01:00Z'),
  };
  const duplicateVariance = analyseMaterialVariance({
    itemId: 'resin', unit: 'kg',
    opening: { id: 'c1', quantity: 1000, unit: 'kg', countedAt: openingAt },
    closing: { id: 'c2', quantity: 600, unit: 'kg', countedAt: closingAt },
    movements: [duplicateReceiptA, duplicateReceiptB],
    production: [{ id: 'p1', productId: 'widget', quantity: 40, unit: 'each', completedAt: new Date('2026-09-04T00:00:00Z'), recordedAt: new Date('2026-09-04T00:05:00Z'), importedAt: new Date('2026-09-04T00:05:00Z'), sourceSystemId: 'probe' }],
    boms: [{ id: 'b1', productId: 'widget', outputUnit: 'each', validFrom: new Date('2026-01-01T00:00:00Z'), validTo: null, lines: [{ itemId: 'resin', quantityPerOutput: 10, unit: 'kg' }] }],
    movementWatermark: watermark,
    movementWatermarkObservedAt: watermark,
    productionWatermark: watermark,
    productionWatermarkObservedAt: watermark,
    unitCost: 1,
  });
  if (
    duplicateVariance.state !== 'INCOMPLETE' ||
    duplicateVariance.varianceCost != null ||
    !duplicateVariance.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT')
  ) {
    failures.push('variance duplicate-receipt probe converted phantom inbound stock into closed loss');
  }

  return failures;
}

const decisionLayerProbeFailures = runDecisionLayerStressProbes();
if (decisionLayerProbeFailures.length > 0) {
  console.error('Decision-layer stress probes failed:');
  for (const failure of decisionLayerProbeFailures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('Decision-layer stress probes: operational range + variance + duplicate-evidence safety passed.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const organisationId = randomUUID();
const siteId = randomUUID();

console.log(`Generating ${itemCount.toLocaleString()} items...`);
const genStart = performance.now();
const gen = await generateStressData(pool, { organisationId, siteId, itemCount, movementsPerItem });
const genMs = performance.now() - genStart;
console.log(
  `  ${gen.evidenceRows.toLocaleString()} evidence rows in ${(genMs / 1000).toFixed(1)}s ` +
    `(${gen.bookSnapshots.toLocaleString()} book, ${gen.countLines.toLocaleString()} counts, ` +
    `${gen.movements.toLocaleString()} movements)`,
);

console.log('Loading through the Postgres adapter...');
const source = new PostgresEvidenceSource(pool);
const loadStart = performance.now();
const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy({ siteId })) };
const scopes = await source.loadSite({ siteId });
const adapterLoadMs = performance.now() - loadStart;
console.log(`  ${scopes.length.toLocaleString()} scopes loaded in ${adapterLoadMs.toFixed(0)}ms`);

console.log('Reconciling and checking the invariant on every scope...');
const states: Record<string, number> = {
  VERIFIED: 0,
  PROVISIONAL: 0,
  STALE: 0,
  INCOMPLETE: 0,
  CONFLICT: 0,
  UNVERIFIED: 0,
};
const reasonCounts = new Map<string, number>();
const invariantFailures: { itemId: string; error: string }[] = [];
let wouldBeVerifiedButForSiteWideCaveat = 0;

const reconcileStart = performance.now();
for (const scope of scopes) {
  const input = {
    item: scope.item,
    locationId: scope.locationId,
    book: scope.book,
    count: scope.count,
    movements: scope.movements,
    unlinkedMovementCount: scope.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
    sources: scope.sources,
    policy,
    evaluatedAt: new Date('2026-09-18T09:00:00Z'),
  };

  // Determinism check, at scale rather than in one hand-written test. If
  // reconciling the same evidence twice ever disagrees, that is worse than any
  // single wrong answer, because it means the rule itself is not a function.
  const first = explain(input);
  const second = explain(input);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    invariantFailures.push({ itemId: scope.item.id, error: 'explain() is not deterministic on this input' });
  }

  states[first.state] = (states[first.state] ?? 0) + 1;
  for (const b of first.blockers) reasonCounts.set(b.code, (reasonCounts.get(b.code) ?? 0) + 1);
  for (const c of first.caveats) reasonCounts.set(c.code, (reasonCounts.get(c.code) ?? 0) + 1);

  // Would this scope have been VERIFIED if the site-wide unmatched-movements
  // caveat did not exist? Worth knowing, because that one caveat is applied
  // identically to every scope at a site the moment a single movement anywhere
  // cannot be matched, and this generator always seeds a handful. Without this
  // number, VERIFIED reading as zero looks like a red flag rather than what it
  // actually is: the engine refusing to give any item at this site a clean
  // bill of health while unrelated evidence sits unresolved.
  if (
    first.state === 'PROVISIONAL' &&
    first.caveats.length === 1 &&
    first.caveats[0]!.code === 'UNMATCHED_MOVEMENTS_AT_SITE'
  ) {
    wouldBeVerifiedButForSiteWideCaveat++;
  }

  const err = checkInvariant(input);
  if (err) invariantFailures.push({ itemId: scope.item.id, error: err });
}
const reconcileMs = performance.now() - reconcileStart;

console.log(`  ${scopes.length.toLocaleString()} scopes reconciled in ${reconcileMs.toFixed(0)}ms`);
console.log(`  invariant failures: ${invariantFailures.length}`);

if (invariantFailures.length > 0) {
  console.error('\nFAILURES:');
  for (const f of invariantFailures.slice(0, 20)) console.error(`  ${f.itemId}: ${f.error}`);
}

const topReasons = [...reasonCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([reason, count]) => ({ reason, count }));

const report = {
  ready: true,
  generatedAt: new Date().toISOString(),
  label,
  itemCount: scopes.length,
  bookSnapshots: gen.bookSnapshots,
  countLines: gen.countLines,
  movements: gen.movements,
  evidenceRows: gen.evidenceRows,
  states,
  topReasons,
  timingsMs: {
    generate: Math.round(genMs),
    adapterLoad: Math.round(adapterLoadMs),
    reconcile: Math.round(reconcileMs),
  },
  scopesPerSecond: Math.round(scopes.length / (reconcileMs / 1000)),
  wouldBeVerifiedButForSiteWideCaveat,
  decisionLayerProbeFailures,
  invariantFailures,
};

writeFileSync(
  new URL('../stress-report.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log('\nWrote apps/web/stress-report.json');

console.log('Cleaning up synthetic data...');
await cleanupStressData(pool, organisationId);
await pool.end();

if (invariantFailures.length > 0) {
  console.error(`\n${invariantFailures.length} invariant failures. See stress-report.json.`);
  process.exit(1);
}
console.log('\nAll scopes held the invariant.');
