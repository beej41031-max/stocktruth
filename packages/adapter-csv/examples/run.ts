/**
 * Runs the real engine against a genuinely different business, through a
 * genuinely different adapter, with no Postgres, no Next.js, no shared code
 * with the brewery demo beyond the engine package itself.
 *
 *   npx tsx examples/run.ts
 */
import { DEFAULT_POLICY, reconcile } from '@stocktruth/engine';
import { CsvEvidenceSource } from '../src/index';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(fileURLToPath(new URL('.', import.meta.url)));
const source = new CsvEvidenceSource(dir, { receivedAt: new Date('2026-09-17T08:55:00Z') });

console.log(`adapter: ${source.adapterName}`);
console.log(`supports "as known at": ${source.supportsKnownAt}\n`);

const site = { siteId: 'stationer-01' };
const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(site)) };
const scopes = await source.loadSite(site);

for (const scope of scopes) {
  const r = reconcile({
    item: scope.item,
    locationId: scope.locationId,
    book: scope.book,
    count: scope.count,
    movements: scope.movements,
    unlinkedMovementCount: scope.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
    sources: scope.sources,
    policy,
    evaluatedAt: new Date('2026-09-17T09:00:00Z'),
  });

  const pos = r.derivedQuantity != null ? r.derivedQuantity.toLocaleString() : 'CANNOT BE STATED';
  console.log(`${scope.item.sku?.padEnd(14) ?? scope.item.id.padEnd(14)} ${r.state.padEnd(12)} ${pos}`);
  if (r.reasons.length) console.log(`  ${r.reasons.join(', ')}`);
}
