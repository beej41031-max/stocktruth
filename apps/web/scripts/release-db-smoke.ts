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

  const scope = await client.query<{ organisation_id: string; site_id: string }>(
    `select s.organisation_id, s.id as site_id
       from sites s
      order by s.id
      limit 1`,
  );

  const row = scope.rows[0];
  if (!row) throw new Error('database smoke: authenticated user cannot see a site');

  // Proves the exact parameter typing used by resolveIssue() is accepted by
  // the live schema. The random UUID intentionally matches no issue.
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

  // Proves user-driven actions can append their own audit event while RLS is
  // active. This is the exact permission path used after resolving an issue.
  await client.query(
    `insert into audit_events
       (organisation_id, site_id, actor_user_id, actor_type,
        event_type, object_type, detail)
     values ($1,$2,$3,'user','RELEASE_DB_SMOKE','release_smoke',$4::jsonb)`,
    [
      row.organisation_id,
      row.site_id,
      userId,
      JSON.stringify({ rolledBack: true }),
    ],
  );

  await client.query('rollback');
  console.log('database smoke PASS — RLS read, reconcile SQL and audit append');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
