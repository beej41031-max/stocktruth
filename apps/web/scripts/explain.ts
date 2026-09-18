/**
 * Prove, from the database records alone, why an item's position is refused
 * and exactly what evidence would restore it.
 *
 *   npx tsx scripts/explain.ts PKG-CAN-440
 *
 * Exists because a refusal is only worth anything if it is derivable. If this
 * script cannot name the blocking rows and the remedy for each, then "cannot
 * be stated" is a hand-written warning rather than a conclusion, and the whole
 * design is decoration.
 */
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { DEFAULT_POLICY, explain, asOfKnowledge } from '@stocktruth/engine';
import { PostgresEvidenceSource } from '../lib/adapters/postgres';


if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const sku = process.argv[2] ?? 'PKG-CAN-440';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const site = { siteId: (await pool.query(`select id from sites limit 1`)).rows[0].id };
const itemRow = await pool.query(`select id, name from items where sku = $1`, [sku]);
if (itemRow.rowCount === 0) throw new Error(`no item with sku ${sku}`);
const item = itemRow.rows[0];

const source = new PostgresEvidenceSource(pool);
const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(site)) };
const scopes = await source.loadSite(site);
const scope = scopes.find((s) => s.item.id === item.id);
if (!scope) throw new Error('no evidence for that item');

const e = explain({
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

console.log(`\n${sku}  ${item.name}`);
console.log(`state: ${e.state}`);
console.log(`position: ${e.derivedQuantity ?? 'REFUSED'}\n`);

if (e.blockers.length) {
  console.log('Blocked by:');
  for (const b of e.blockers) {
    console.log(`\n  ${b.code}`);
    console.log(`    ${b.short}`);
    for (const ev of b.evidence) console.log(`    evidence: ${ev}`);
    console.log(`    cleared by: ${b.remedy}`);
  }
  console.log(`\nIf every blocker were cleared: ${e.ifCleared?.quantity ?? 'still nothing'}`);
  for (const a of e.ifCleared?.assuming ?? []) console.log(`  assuming: ${a}`);
} else {
  console.log('Nothing blocking. The position stands.');
}

if (e.caveats.length) {
  console.log('\nCaveats (do not withhold the number):');
  for (const c of e.caveats) console.log(`  ${c.code}: ${c.short}`);
}

// --- what did we know before the pallet paperwork landed? -----------------

const pallet = await pool.query(
  `select imported_at from movements where item_id = $1 order by imported_at desc limit 1`,
  [item.id],
);
if (pallet.rowCount) {
  const before = new Date(new Date(pallet.rows[0].imported_at).getTime() - 60_000);
  const then = await asOfKnowledge(source, {
    site,
    scope: { itemId: item.id, locationId: scope.locationId },
    knownAt: before,
  });
  console.log(`\nAs known at ${before.toISOString()} (a minute before the last movement arrived):`);
  console.log(`  state: ${then.result?.state ?? then.reason}`);
  console.log(`  position: ${then.result?.derivedQuantity ?? 'REFUSED'}`);
}

await pool.end();
