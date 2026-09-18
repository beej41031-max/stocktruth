/**
 * Run the engine against a site and print what it decided.
 *
 *   npx tsx scripts/reconcile.ts <siteId>
 *
 * Exists so the reconciliation can be watched working without a browser, which
 * is how most of its behaviour got checked in the first place.
 */
import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { runReconciliation } from '../lib/engine-run';


if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const siteId = process.argv[2] ?? 'b0000000-0000-4000-8000-000000000001';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const summary = await runReconciliation(pool, {
  siteId,
  triggerReason: 'cli',
});

console.log(`\nrun ${summary.runId}`);
console.log(`engine ${summary.engineVersion}, ${summary.itemCount} scopes\n`);

const order = ['VERIFIED', 'PROVISIONAL', 'STALE', 'INCOMPLETE', 'CONFLICT', 'UNVERIFIED'];
for (const state of order) {
  const n = summary.byState[state] ?? 0;
  if (n) console.log(`  ${state.padEnd(13)} ${String(n).padStart(3)}`);
}
console.log(`\nissues: ${summary.issuesOpened} opened, ${summary.issuesStillOpen} still open, ${summary.issuesAutoResolved} resolved`);

await pool.end();
