import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_POLICY,
  ENGINE_VERSION,
  REASONS,
  reconcile,
  type ReconciliationOutput,
  type ReasonDefinition,
} from '@stocktruth/engine';
import { PostgresEvidenceSource } from './adapters/postgres';

/**
 * Running the engine over a site and writing down what it decided.
 *
 * Two rules here that matter more than the code:
 *
 * 1. A run never edits a previous run's results. It writes new ones. If the
 *    rules change and the same evidence now says something different, both
 *    answers survive and the engine_version on each says why they differ.
 *
 * 2. An issue outlives the run that raised it. Re-running does not close work
 *    somebody is halfway through, and does not raise the same thing thirty
 *    times. Still there means last_seen_at moves; gone means resolved.
 */

export interface RunOptions {
  siteId: string;
  triggeredBy?: string | null;
  triggerReason?: string;
  evaluatedAt?: Date;
}

export interface RunSummary {
  runId: string;
  engineVersion: string;
  evaluatedAt: Date;
  itemCount: number;
  byState: Record<string, number>;
  issuesOpened: number;
  issuesStillOpen: number;
  issuesAutoResolved: number;
}

export async function runReconciliation(pool: Pool, opts: RunOptions): Promise<RunSummary> {
  const evaluatedAt = opts.evaluatedAt ?? new Date();
  const correlationId = randomUUID();

  // The engine is reached through the port, exactly as another host system
  // would reach it. Nothing in this function knows a table name.
  const source = new PostgresEvidenceSource(pool);
  const site = { siteId: opts.siteId };
  const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy(site)) };
  const scopes = await source.loadSite(site);

  const orgRow = await pool.query<{ organisation_id: string }>(
    `select organisation_id from sites where id = $1`,
    [opts.siteId],
  );
  const organisationId = orgRow.rows[0]!.organisation_id;

  const results = scopes.map((scope) => ({
    scope,
    output: reconcile({
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
    }),
  }));

  const client = await pool.connect();
  try {
    await client.query('begin');

    const runId = await insertRun(client, organisationId, opts, evaluatedAt, results.length);
    await insertResults(client, runId, organisationId, opts.siteId, results);

    const issueCounts = await syncIssues(
      client,
      organisationId,
      opts.siteId,
      runId,
      results,
      evaluatedAt,
    );

    await client.query(
      `update reconciliation_runs set completed_at = now() where id = $1`,
      [runId],
    );

    await client.query(
      `insert into audit_events
         (organisation_id, site_id, actor_user_id, actor_type, actor_label,
          event_type, object_type, object_id, detail, correlation_id)
       values ($1,$2,$3,'engine','reconciliation engine','RECONCILIATION_RUN','reconciliation_run',$4,$5,$6)`,
      [
        organisationId,
        opts.siteId,
        opts.triggeredBy ?? null,
        runId,
        JSON.stringify({
          engineVersion: ENGINE_VERSION,
          itemCount: results.length,
          ...issueCounts,
        }),
        correlationId,
      ],
    );

    await client.query('commit');

    const byState: Record<string, number> = {};
    for (const { output } of results) {
      byState[output.state] = (byState[output.state] ?? 0) + 1;
    }

    return {
      runId,
      engineVersion: ENGINE_VERSION,
      evaluatedAt,
      itemCount: results.length,
      byState,
      ...issueCounts,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------

async function insertRun(
  client: PoolClient,
  organisationId: string,
  opts: RunOptions,
  evaluatedAt: Date,
  itemCount: number,
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `insert into reconciliation_runs
       (organisation_id, site_id, engine_version, evaluated_at, triggered_by, trigger_reason, item_count)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id`,
    [
      organisationId,
      opts.siteId,
      ENGINE_VERSION,
      evaluatedAt,
      opts.triggeredBy ?? null,
      opts.triggerReason ?? 'manual',
      itemCount,
    ],
  );
  return res.rows[0]!.id;
}

async function insertResults(
  client: PoolClient,
  runId: string,
  organisationId: string,
  siteId: string,
  results: { scope: { item: { id: string }; locationId: string | null }; output: ReconciliationOutput }[],
): Promise<void> {
  if (results.length === 0) return;

  // One multi-row insert. A site with a few thousand lines should be one round
  // trip, not a few thousand.
  const cols = 18;
  const values: unknown[] = [];
  const tuples: string[] = [];

  results.forEach(({ scope, output }, i) => {
    const base = i * cols;
    tuples.push(
      `(${Array.from({ length: cols }, (_, j) => `$${base + j + 1}`).join(',')})`,
    );
    values.push(
      runId,
      organisationId,
      siteId,
      scope.item.id,
      scope.locationId,
      output.state,
      output.bookQuantity,
      output.bookAsOf,
      output.physicalQuantity,
      output.physicalCountedAt,
      output.derivedQuantity,
      output.derivedAsOf,
      output.varianceAtCount,
      output.movementNet,
      output.movementWindowStart,
      output.movementWindowEnd,
      output.reasons,
      JSON.stringify(output.evidence),
    );
  });

  await client.query(
    `insert into reconciliation_results
       (reconciliation_run_id, organisation_id, site_id, item_id, location_id, state,
        book_quantity, book_as_of, physical_quantity, physical_counted_at,
        derived_quantity, derived_as_of, variance_at_count, movement_net,
        movement_window_start, movement_window_end, reason_codes, evidence)
     values ${tuples.join(',')}`,
    values,
  );
}

/**
 * Issues are the work queue, so they are treated as state rather than output.
 *
 * Still present  -> touch last_seen_at, leave status and any part-written
 *                   resolution note alone.
 * Newly present  -> open it.
 * Gone           -> resolve it, with the engine named as the actor, so the
 *                   history shows it stopped being true rather than that
 *                   somebody fixed it.
 */
async function syncIssues(
  client: PoolClient,
  organisationId: string,
  siteId: string,
  runId: string,
  results: {
    scope: { item: { id: string }; locationId: string | null };
    output: ReconciliationOutput;
  }[],
  evaluatedAt: Date,
): Promise<{ issuesOpened: number; issuesStillOpen: number; issuesAutoResolved: number }> {
  const wanted = new Map<
    string,
    { itemId: string; locationId: string | null; code: string; severity: string; detail: unknown }
  >();

  for (const { scope, output } of results) {
    for (const code of output.reasons) {
      const def = (REASONS as Record<string, ReasonDefinition>)[code];
      if (!def) continue;
      // Low severity findings are shown on the item but do not become work.
      if (def.severity === 'low') continue;

      const key = `${scope.item.id}::${scope.locationId ?? 'none'}::${code}`;
      wanted.set(key, {
        itemId: scope.item.id,
        locationId: scope.locationId,
        code,
        severity: def.severity,
        detail: {
          state: output.state,
          bookQuantity: output.bookQuantity,
          physicalQuantity: output.physicalQuantity,
          derivedQuantity: output.derivedQuantity,
          evidence: output.evidence,
        },
      });
    }
  }

  const existing = await client.query<{
    id: string;
    item_id: string | null;
    location_id: string | null;
    code: string;
  }>(
    `select id, item_id, location_id, code
       from reconciliation_issues
      where site_id = $1 and status = 'open'`,
    [siteId],
  );

  const existingKeys = new Map<string, string>();
  for (const r of existing.rows) {
    existingKeys.set(`${r.item_id}::${r.location_id ?? 'none'}::${r.code}`, r.id);
  }

  let opened = 0;
  let stillOpen = 0;

  for (const [key, issue] of wanted) {
    const id = existingKeys.get(key);
    if (id) {
      await client.query(
        `update reconciliation_issues
            set last_seen_at = $2, result_id = coalesce(result_id, null), detail = $3
          where id = $1`,
        [id, evaluatedAt, JSON.stringify(issue.detail)],
      );
      stillOpen++;
    } else {
      await client.query(
        `insert into reconciliation_issues
           (organisation_id, site_id, item_id, location_id, code, severity, status, detail, first_seen_at, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,'open',$7,$8,$8)`,
        [
          organisationId,
          siteId,
          issue.itemId,
          issue.locationId,
          issue.code,
          issue.severity,
          JSON.stringify(issue.detail),
          evaluatedAt,
        ],
      );
      opened++;
    }
  }

  let autoResolved = 0;
  for (const [key, id] of existingKeys) {
    if (wanted.has(key)) continue;
    await client.query(
      `update reconciliation_issues
          set status = 'resolved', resolved_at = $2,
              resolution = 'not_an_issue',
              resolution_note = 'Stopped being reported once the evidence changed'
        where id = $1`,
      [id, evaluatedAt],
    );
    autoResolved++;
  }

  return { issuesOpened: opened, issuesStillOpen: stillOpen, issuesAutoResolved: autoResolved };
}
