import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
const userId = process.env.DEMO_USER_ID;

if (!connectionString) throw new Error('DATABASE_URL is not set');
if (!userId) throw new Error('DEMO_USER_ID is not set');

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 });
const client = await pool.connect();

try {
  await client.query('begin');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await client.query('set local role authenticated');

  // Proves the app identity can enter the RLS-protected application schema.
  await client.query('select id from sites limit 1');

  // Proves the exact parameter typing used by resolveIssue() is accepted by
  // the live schema. The random UUID intentionally matches no row, and the
  // entire transaction is rolled back regardless.
  await client.query(
    `update reconciliation_issues
        set status = $2::public.issue_status,
            resolution = $3::public.issue_resolution,
            resolution_note = $4::text,
            resolved_by = $5::uuid,
            resolved_at = case
              when $2::public.issue_status = 'resolved'::public.issue_status then now()
              else null
            end,
            recount_requested = $6::boolean
      where id = $1::uuid`,
    [randomUUID(), 'open', 'investigating', 'release smoke — rolled back', userId, false],
  );

  await client.query('rollback');
  console.log('database smoke PASS');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
