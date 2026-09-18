import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';

import {
  DEFAULT_POLICY,
  reconcile,
  type ReconciliationState,
} from '@stocktruth/engine';
import { PostgresEvidenceSource } from '../lib/adapters/postgres';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

const argInt = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=')[1];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return n;
};

const itemCount = argInt('items', 10_000, 120, 25_000);
const movementsPerItem = argInt('movements', 8, 1, 20);

const ORG_ID = '90000000-0000-4000-8000-000000000001';
const SITE_ID = '90000000-0000-4000-8000-000000000002';
const LOCATION_ID = '90000000-0000-4000-8000-000000000003';
const SOURCE_ID = '90000000-0000-4000-8000-000000000004';
const SESSION_ID = '90000000-0000-4000-8000-000000000005';

const pool = new Pool({
  connectionString,
  max: 3,
  connectionTimeoutMillis: 15_000,
});

const states: ReconciliationState[] = [
  'VERIFIED',
  'PROVISIONAL',
  'STALE',
  'INCOMPLETE',
  'CONFLICT',
  'UNVERIFIED',
];

const byState = Object.fromEntries(states.map((state) => [state, 0])) as Record<
  ReconciliationState,
  number
>;

const reasonCounts = new Map<string, number>();
const invariantFailures: string[] = [];

const seedStarted = performance.now();

const client = await pool.connect();
try {
  await client.query('begin');

  // The stress lab is disposable. It is deliberately kept in its own
  // organisation so the small hand-made demo stays readable.
  await client.query(`delete from organisations where id = $1`, [ORG_ID]);

  await client.query(
    `insert into organisations (id, name) values ($1, 'ZZ Synthetic Stress Lab')`,
    [ORG_ID],
  );

  await client.query(
    `insert into sites (id, organisation_id, name, timezone)
     values ($1, $2, 'Ten-thousand-line warehouse', 'Europe/London')`,
    [SITE_ID, ORG_ID],
  );

  await client.query(
    `insert into locations (id, site_id, code, name)
     values ($1, $2, 'MAIN', 'Synthetic main store')`,
    [LOCATION_ID, SITE_ID],
  );

  await client.query(
    `insert into source_systems
       (id, organisation_id, name, source_type, expected_sync_minutes, last_success_at, created_at)
     values ($1, $2, 'Synthetic WMS feed', 'api', 60, now(), now() - interval '120 days')`,
    [SOURCE_ID, ORG_ID],
  );

  await client.query(
    `insert into reconciliation_policies
       (site_id, stale_after_days, book_stale_after_days, source_silence_multiplier,
        max_clock_skew_minutes, require_location)
     values ($1, 30, 14, 3, 10, false)`,
    [SITE_ID],
  );

  await client.query(
    `insert into count_sessions
       (id, organisation_id, site_id, name, status, started_at, completed_at, source_watermark, created_at)
     values ($1, $2, $3, 'Synthetic stress count', 'completed',
             now() - interval '2 days 2 hours',
             now() - interval '2 days' + interval '1 hour',
             now() - interval '2 days 2 hours',
             now() - interval '2 days 2 hours')`,
    [SESSION_ID, ORG_ID, SITE_ID],
  );

  await client.query(
    `insert into items
       (organisation_id, sku, name, stock_unit, active, blocked, blocked_reason, created_at)
     select $1,
            'ST-' || lpad(g::text, 6, '0'),
            'Synthetic stock line ' || lpad(g::text, 6, '0'),
            'each',
            true,
            mod(g, 12) = 9,
            case when mod(g, 12) = 9
                 then 'Synthetic blocked identity: deliberately unsafe to use'
                 else null end,
            now() - interval '120 days'
       from generate_series(1, $2::int) g`,
    [ORG_ID, itemCount],
  );

  // A third of the catalogue is deliberately boring and clean. The rest is
  // split across specific failure modes rather than random corruption, so a
  // rerun means the same thing every time.
  await client.query(
    `insert into book_snapshots
       (organisation_id, site_id, item_id, location_id, quantity, unit, as_of,
        source_system_id, source_reference, created_at)
     select $1, $2, i.id, $3,
            100 + mod(x.n, 200),
            'each',
            (case when mod(x.n, 12) = 6
                   then now() - interval '45 days'
                   else now() - interval '2 days'
             end) - interval '1 day',
            $4,
            'stress-book-' || x.n,
            now() - interval '2 days 12 hours'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $1
        and mod(x.n, 12) <> 3`,
    [ORG_ID, SITE_ID, LOCATION_ID, SOURCE_ID],
  );

  await client.query(
    `insert into count_lines
       (count_session_id, organisation_id, site_id, item_id, location_id,
        quantity, unit, counted_at, received_at, method, note, client_event_id, created_at)
     select $1, $2, $3, i.id, $4,
            case when mod(x.n, 12) = 10
                 then 3
                 else 100 + mod(x.n, 200) + (mod(x.n, 5) - 2)
            end,
            'each',
            case when mod(x.n, 12) = 6
                 then now() - interval '45 days'
                 else now() - interval '2 days'
            end,
            (case when mod(x.n, 12) = 6
                   then now() - interval '45 days'
                   else now() - interval '2 days'
             end)
             + case when mod(x.n, 12) = 5
                    then interval '25 minutes'
                    else interval '1 minute'
               end,
            'manual',
            'Synthetic observation',
            gen_random_uuid(),
            now() - interval '1 day'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $2
        and mod(x.n, 12) <> 11`,
    [SESSION_ID, ORG_ID, SITE_ID, LOCATION_ID],
  );

  // Normal post-count traffic. This is the bulk of the evidence volume.
  await client.query(
    `insert into movements
       (organisation_id, site_id, item_id, location_id, movement_type,
        quantity, unit, occurred_at, recorded_at, imported_at,
        source_system_id, source_event_id, source_reference)
     select $1, $2, i.id, $3,
            case when mod(m, 4) = 0
                 then 'ISSUE'::movement_type
                 else 'RECEIVE'::movement_type
            end,
            mod(x.n + m, 5) + 1,
            'each',
            (case when mod(x.n, 12) = 6
                   then now() - interval '45 days'
                   else now() - interval '2 days'
             end) + make_interval(hours => m),
            (case when mod(x.n, 12) = 6
                   then now() - interval '45 days'
                   else now() - interval '2 days'
             end) + make_interval(hours => m, mins => 1),
            (case when mod(x.n, 12) = 6
                   then now() - interval '45 days'
                   else now() - interval '2 days'
             end) + make_interval(hours => m, mins => 2),
            $4,
            'stress-' || x.n || '-' || m,
            'normal synthetic movement'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
       cross join generate_series(1, $5::int) m
      where i.organisation_id = $1`,
    [ORG_ID, SITE_ID, LOCATION_ID, SOURCE_ID, movementsPerItem],
  );

  // 4/12: duplicate-looking receipt. It is only a warning; the engine never
  // quietly merges them.
  await client.query(
    `insert into movements
       (organisation_id, site_id, item_id, location_id, movement_type,
        quantity, unit, occurred_at, recorded_at, imported_at,
        source_system_id, source_event_id, source_reference)
     select $1::uuid, $2::uuid, i.id, $3::uuid, 'RECEIVE'::movement_type, 7, 'each',
            now() - interval '1 day 12 hours',
            now() - interval '1 day 12 hours' + interval '1 minute',
            now() - interval '1 day 12 hours' + interval '2 minutes',
            $4::uuid, 'stress-dup-a-' || x.n, 'duplicate candidate A'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $1 and mod(x.n, 12) = 4
     union all
     select $1::uuid, $2::uuid, i.id, $3::uuid, 'RECEIVE'::movement_type, 7, 'each',
            now() - interval '1 day 12 hours' + interval '2 minutes',
            now() - interval '1 day 12 hours' + interval '3 minutes',
            now() - interval '1 day 12 hours' + interval '4 minutes',
            $4::uuid, 'stress-dup-b-' || x.n, 'duplicate candidate B'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $1 and mod(x.n, 12) = 4`,
    [ORG_ID, SITE_ID, LOCATION_ID, SOURCE_ID],
  );

  // 7/12: goods moved before the count but paperwork arrived after it.
  await client.query(
    `insert into movements
       (organisation_id, site_id, item_id, location_id, movement_type,
        quantity, unit, occurred_at, recorded_at, imported_at,
        source_system_id, source_event_id, source_reference)
     select $1, $2, i.id, $3, 'RECEIVE', 20, 'each',
            now() - interval '2 days 1 hour',
            now() - interval '2 days' + interval '2 hours',
            now() - interval '2 days' + interval '2 hours',
            $4, 'stress-span-' || x.n, 'late paperwork across count'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $1 and mod(x.n, 12) = 7`,
    [ORG_ID, SITE_ID, LOCATION_ID, SOURCE_ID],
  );

  // 8/12: movement exists but cannot be placed in time at all.
  await client.query(
    `insert into movements
       (organisation_id, site_id, item_id, location_id, movement_type,
        quantity, unit, occurred_at, recorded_at, imported_at,
        source_system_id, source_event_id, source_reference)
     select $1, $2, i.id, $3, 'ISSUE', 9, 'each',
            null,
            now() - interval '1 day',
            now() - interval '1 day',
            $4, 'stress-undated-' || x.n, 'source supplied no movement date'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $1 and mod(x.n, 12) = 8`,
    [ORG_ID, SITE_ID, LOCATION_ID, SOURCE_ID],
  );

  // 10/12: impossible negative result after the post-count issues are applied.
  await client.query(
    `insert into movements
       (organisation_id, site_id, item_id, location_id, movement_type,
        quantity, unit, occurred_at, recorded_at, imported_at,
        source_system_id, source_event_id, source_reference)
     select $1, $2, i.id, $3, 'ISSUE', 1000, 'each',
            now() - interval '1 day',
            now() - interval '1 day',
            now() - interval '1 day',
            $4, 'stress-negative-' || x.n, 'deliberately impossible issue'
       from items i
       cross join lateral (select substring(i.sku from 4)::int as n) x
      where i.organisation_id = $1 and mod(x.n, 12) = 10`,
    [ORG_ID, SITE_ID, LOCATION_ID, SOURCE_ID],
  );

  await client.query('commit');
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
}

const seedMs = performance.now() - seedStarted;

const adapter = new PostgresEvidenceSource(pool);
const policy = {
  ...DEFAULT_POLICY,
  ...(await adapter.loadPolicy({ siteId: SITE_ID })),
};

const loadStarted = performance.now();
const scopes = await adapter.loadSite({ siteId: SITE_ID });
const loadMs = performance.now() - loadStarted;

const evaluatedAt = new Date();
const reconcileStarted = performance.now();

for (const scope of scopes) {
  const output = reconcile({
    item: scope.item,
    locationId: scope.locationId,
    book: scope.book,
    count: scope.count,
    movements: scope.movements,
    unlinkedMovementCount: scope.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
    sources: scope.sources,
    policy,
    evaluatedAt,
  });

  byState[output.state]++;

  for (const reason of output.reasons) {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  const shouldHaveNumber =
    output.state === 'VERIFIED' ||
    output.state === 'PROVISIONAL' ||
    output.state === 'STALE';

  if (shouldHaveNumber && output.derivedQuantity == null) {
    invariantFailures.push(`${scope.item.sku}: ${output.state} had no derived quantity`);
  }

  if (!shouldHaveNumber && output.derivedQuantity != null) {
    invariantFailures.push(`${scope.item.sku}: ${output.state} exposed a derived quantity`);
  }

  if (output.derivedQuantity != null && !Number.isFinite(output.derivedQuantity)) {
    invariantFailures.push(`${scope.item.sku}: derived quantity was not finite`);
  }

  if (invariantFailures.length >= 20) break;
}

const reconcileMs = performance.now() - reconcileStarted;

const counts = await pool.query<{
  items: string;
  books: string;
  counts: string;
  movements: string;
}>(
  `select
      (select count(*) from items where organisation_id = $1)::text as items,
      (select count(*) from book_snapshots where organisation_id = $1)::text as books,
      (select count(*) from count_lines where organisation_id = $1)::text as counts,
      (select count(*) from movements where organisation_id = $1)::text as movements`,
  [ORG_ID],
);

const row = counts.rows[0]!;
const evidenceRows =
  Number(row.books) +
  Number(row.counts) +
  Number(row.movements);

const topReasons = [...reasonCounts.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 12)
  .map(([reason, count]) => ({ reason, count }));

const report = {
  ready: true,
  generatedAt: new Date().toISOString(),
  label: 'Local runner â†’ hosted Supabase',
  itemCount: scopes.length,
  evidenceRows,
  bookSnapshots: Number(row.books),
  countLines: Number(row.counts),
  movements: Number(row.movements),
  movementsPerItem,
  timingsMs: {
    seed: Math.round(seedMs),
    adapterLoad: Math.round(loadMs),
    reconcile: Math.round(reconcileMs),
    total: Math.round(seedMs + loadMs + reconcileMs),
  },
  scopesPerSecond:
    reconcileMs > 0 ? Math.round(scopes.length / (reconcileMs / 1000)) : scopes.length,
  states: byState,
  topReasons,
  invariantFailures,
};

const reportPath = fileURLToPath(new URL('../stress-report.json', import.meta.url));
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('\nStockTruth synthetic torture test');
console.log('--------------------------------');
console.log(`items             ${scopes.length.toLocaleString()}`);
console.log(`evidence rows     ${evidenceRows.toLocaleString()}`);
console.log(`movements         ${Number(row.movements).toLocaleString()}`);
console.log(`adapter load      ${Math.round(loadMs).toLocaleString()} ms`);
console.log(`engine reconcile  ${Math.round(reconcileMs).toLocaleString()} ms`);
console.log(`engine throughput ${report.scopesPerSecond.toLocaleString()} scopes/sec\n`);

for (const state of states) {
  console.log(`${state.padEnd(13)} ${String(byState[state]).padStart(7)}`);
}

console.log('\nMost common reasons');
for (const x of topReasons.slice(0, 8)) {
  console.log(`  ${x.reason.padEnd(30)} ${String(x.count).padStart(7)}`);
}

if (invariantFailures.length > 0) {
  console.error('\nINVARIANT FAILURES');
  for (const failure of invariantFailures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\n0 invariant failures. Good. The warehouse is horrible; the engine is not.');
}

console.log(`\nReport written to ${reportPath}`);
await pool.end();
