/**
 * Close the latest count interval for every material/location and persist the
 * material-variance snapshot.
 *
 *   npx tsx scripts/material-variance.ts <siteId>
 */
import { Pool } from 'pg';
import { persistMaterialVarianceRun } from '../lib/material-variance';

const siteId = process.argv[2] ?? 'b0000000-0000-4000-8000-000000000001';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const result = await persistMaterialVarianceRun(pool, siteId, null, 'cli');

console.log(`\nmaterial variance run ${result.runId}`);
console.log(`${result.intervalCount} repeat-count intervals\n`);
for (const row of result.overview.rows) {
  const o = row.output;
  const money = o.varianceCost == null ? '—' : `${row.currency} ${o.varianceCost.toFixed(2)}`;
  console.log(
    `${(row.sku ?? row.name).padEnd(16)} ${o.state.padEnd(12)} actual=${String(o.actualConsumption ?? '—').padStart(8)} theory=${String(o.theoreticalConsumption ?? '—').padStart(8)} variance=${String(o.varianceQuantity ?? '—').padStart(8)}  ${money}`,
  );
}

await pool.end();
