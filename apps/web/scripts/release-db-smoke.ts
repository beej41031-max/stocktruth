import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

const connectionString = process.env.DATABASE_URL;
const userId = process.env.DEMO_USER_ID;

if (!connectionString) throw new Error('DATABASE_URL is not set');
if (!userId) throw new Error('DEMO_USER_ID is not set');

const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 });
const client = await pool.connect();

async function expectFailure(client: PoolClient, name: string, fn: () => Promise<unknown>): Promise<void> {
  const savepoint = `sp_${name.replace(/[^a-z0-9_]/gi, '_')}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await fn();
    throw new Error(`database smoke: ${name} unexpectedly succeeded`);
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    if (error instanceof Error && error.message.startsWith('database smoke:')) throw error;
  } finally {
    await client.query(`release savepoint ${savepoint}`).catch(() => {});
  }
}

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

  const roleRes = await client.query<{ role: string }>(
    `select role::text as role from memberships where organisation_id = $1 and user_id = $2`,
    [row.organisation_id, userId],
  );
  const role = roleRes.rows[0]?.role ?? null;

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

  await client.query(
    `insert into audit_events
       (organisation_id, site_id, actor_user_id, actor_type,
        event_type, object_type, detail)
     values ($1,$2,$3,'user','RELEASE_DB_SMOKE','release_smoke',$4::jsonb)`,
    [row.organisation_id, row.site_id, userId, JSON.stringify({ rolledBack: true })],
  );

  // v0.4.4: closure history/review tables must exist. An initial connector watermark
  // must immediately create its first immutable completeness claim.
  await client.query(`select count(*) from source_watermark_history`);
  await client.query(`select count(*) from automated_evidence_reviews`);
  if (role === 'owner' || role === 'manager') {
    const sourceId = randomUUID();
    const initialWatermark = new Date('2026-09-01T00:00:00Z');
    await client.query(
      `insert into source_systems
         (id, organisation_id, name, source_type, expected_sync_minutes, event_watermark_at)
       values ($1,$2,$3,'api',60,$4)`,
      [sourceId, row.organisation_id, `release-smoke-${sourceId}`, initialWatermark],
    );
    const initialHistory = await client.query<{ watermark_at: Date }>(
      `select watermark_at from source_watermark_history where source_system_id = $1`,
      [sourceId],
    );
    if (initialHistory.rowCount !== 1 || new Date(initialHistory.rows[0]!.watermark_at).getTime() !== initialWatermark.getTime()) {
      throw new Error('database smoke: initial watermark history was not captured');
    }

    await client.query(
      `update source_systems set event_watermark_at = event_watermark_at + interval '1 hour' where id = $1`,
      [sourceId],
    );
    const advancedHistory = await client.query<{ n: string }>(
      `select count(*)::text as n from source_watermark_history where source_system_id = $1`,
      [sourceId],
    );
    if (Number(advancedHistory.rows[0]?.n ?? 0) !== 2) {
      throw new Error('database smoke: watermark advance did not append history');
    }
  }

  const completed = await client.query<{
    session_id: string;
    count_line_id: string;
    trusted_cutoff: Date;
  }>(
    `select cs.id as session_id, cl.id as count_line_id,
            max(cl.received_at) over (partition by cs.id) as trusted_cutoff
       from count_sessions cs
       join count_lines cl on cl.count_session_id = cs.id and not cl.superseded
      where cs.site_id = $1 and cs.status = 'completed'
      order by cs.completed_at desc nulls last
      limit 1`,
    [row.site_id],
  );

  const completedRow = completed.rows[0];
  if (completedRow && (role === 'owner' || role === 'manager')) {
    // Owner/manager can attest, but Postgres—not the client—chooses cutoff,
    // knowledge time and actor.
    const attested = await client.query<{
      movement_evidence_confirmed_through: Date;
      movement_evidence_confirmed_by: string;
    }>(
      `update count_sessions
          set movement_evidence_confirmed_through = '2099-01-01T00:00:00Z',
              movement_evidence_confirmed_at = '2000-01-01T00:00:00Z',
              movement_evidence_confirmed_by = $2
        where id = $1
        returning movement_evidence_confirmed_through, movement_evidence_confirmed_by`,
      [completedRow.session_id, userId],
    );
    const a = attested.rows[0];
    if (!a || new Date(a.movement_evidence_confirmed_through).getTime() !== new Date(completedRow.trusted_cutoff).getTime()) {
      throw new Error('database smoke: attestation cutoff was not clamped to server receive time');
    }
    if (a.movement_evidence_confirmed_by !== userId) {
      throw new Error('database smoke: attestation actor was not normalised by Postgres');
    }
  }

  // When the demo org contains a counter, impersonate them at the same RLS
  // boundary and prove app bypass cannot forge closure or mutate closed counts.
  if (completedRow && role === 'owner') {
    const counter = await client.query<{ user_id: string }>(
      `select user_id from memberships where organisation_id = $1 and role = 'counter' order by user_id limit 1`,
      [row.organisation_id],
    );
    const counterId = counter.rows[0]?.user_id;
    if (counterId) {
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [counterId]);

      await expectFailure(client, 'counter_attestation', () =>
        client.query(
          `update count_sessions
              set movement_evidence_confirmed_through = now() + interval '1 year'
            where id = $1`,
          [completedRow.session_id],
        ),
      );

      // Attestation cannot be smuggled onto a fresh open session and carried
      // through completion without an owner/manager ever making the claim.
      await expectFailure(client, 'counter_pre_attested_session_insert', () =>
        client.query(
          `insert into count_sessions
             (id, organisation_id, site_id, name, status, started_by, started_at,
              movement_evidence_confirmed_through, movement_evidence_confirmed_at,
              movement_evidence_confirmed_by)
           values ($1,$2,$3,'release-smoke-forged-attestation','open',$4,now(),now(),now(),$4)`,
          [randomUUID(), row.organisation_id, row.site_id, counterId],
        ),
      );

      await expectFailure(client, 'closed_count_rewrite', () =>
        client.query(`update count_lines set quantity = quantity + 1 where id = $1`, [completedRow.count_line_id]),
      );

      await expectFailure(client, 'closed_count_insert', () =>
        client.query(
          `insert into count_lines
             (id, count_session_id, organisation_id, site_id, item_id, location_id,
              quantity, unit, counted_by, counted_at, method, client_event_id)
           select $1, count_session_id, organisation_id, site_id, item_id, location_id,
                  quantity, unit, $2, counted_at, method, $3
             from count_lines where id = $4`,
          [randomUUID(), counterId, randomUUID(), completedRow.count_line_id],
        ),
      );

      // An authenticated handset may submit received_at, but the database must
      // overwrite it with server time so clock-skew classification cannot be
      // bypassed by inventing a huge offline delay.
      const openSessionId = randomUUID();
      await client.query(
        `insert into count_sessions
           (id, organisation_id, site_id, name, status, started_by, started_at)
         values ($1,$2,$3,'release-smoke-received-at','open',$4,now())`,
        [openSessionId, row.organisation_id, row.site_id, counterId],
      );
      const receiveClamp = await client.query<{ received_at: Date; server_now: Date }>(
        `insert into count_lines
           (id, count_session_id, organisation_id, site_id, item_id, location_id,
            quantity, unit, counted_by, counted_at, received_at, method, client_event_id)
         select $1,$2,organisation_id,site_id,item_id,location_id,quantity,unit,$3,now(),
                now() + interval '30 days',method,$4
           from count_lines where id = $5
         returning received_at, now() as server_now`,
        [randomUUID(), openSessionId, counterId, randomUUID(), completedRow.count_line_id],
      );
      const clamp = receiveClamp.rows[0];
      if (!clamp || Math.abs(new Date(clamp.received_at).getTime() - new Date(clamp.server_now).getTime()) > 5_000) {
        throw new Error('database smoke: authenticated client could forge count_lines.received_at');
      }

      const deleted = await client.query(`delete from count_sessions where id = $1`, [completedRow.session_id]);
      if ((deleted.rowCount ?? 0) !== 0) {
        throw new Error('database smoke: counter could delete a count session');
      }

      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    }
  }

  await client.query('rollback');
  console.log('database smoke PASS — RLS, audit, historical closure/review, server receive-time and count guards');
} catch (error) {
  await client.query('rollback').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
