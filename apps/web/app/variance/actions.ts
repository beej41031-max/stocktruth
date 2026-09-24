'use server';

import { revalidatePath } from 'next/cache';
import { withSiteService, withUser } from '@/lib/db';
import { persistMaterialVarianceRun } from '@/lib/material-variance';
import { currentUserId } from '@/lib/session';

export async function attestEvidenceCutoff(formData: FormData): Promise<void> {
  const userId = await currentUserId();
  const siteId = String(formData.get('siteId') ?? '');
  const sessionId = String(formData.get('sessionId') ?? '');
  const confirmMovements = formData.get('confirmMovements') === 'on';
  const confirmProduction = formData.get('confirmProduction') === 'on';
  const note = String(formData.get('note') ?? '').trim() || null;

  if (!siteId || !sessionId || (!confirmMovements && !confirmProduction)) return;

  await withUser(userId, async (db) => {
    const session = await db.one<{
      organisation_id: string;
      cutoff_at: string | null;
      observed_cutoff_at: string | null;
      role: 'owner' | 'manager' | 'counter' | 'viewer' | null;
    }>(
      `select cs.organisation_id,
              max(cl.received_at)::text as cutoff_at,
              max(cl.counted_at)::text as observed_cutoff_at,
              (select m.role::text from memberships m
                where m.organisation_id = cs.organisation_id and m.user_id = $3) as role
         from count_sessions cs
         left join count_lines cl on cl.count_session_id = cs.id and not cl.superseded
        where cs.id = $1 and cs.site_id = $2 and cs.status = 'completed'
        group by cs.organisation_id`,
      [sessionId, siteId, userId],
    );

    if (!session || !session.cutoff_at) throw new Error('Completed count session not found.');
    if (session.role !== 'owner' && session.role !== 'manager') {
      throw new Error('Only an owner or manager can certify evidence completeness.');
    }

    // The assertion is through the trusted server-receive cutoff, never through
    // now() or a handset clock. confirmed_at records when the office asserted it.
    await db.query(
      `update count_sessions
          set movement_evidence_confirmed_through = case when $3 then $5::timestamptz else movement_evidence_confirmed_through end,
              movement_evidence_confirmed_at = case when $3 then now() else movement_evidence_confirmed_at end,
              movement_evidence_confirmed_by = case when $3 then $6 else movement_evidence_confirmed_by end,
              production_evidence_confirmed_through = case when $4 then $5::timestamptz else production_evidence_confirmed_through end,
              production_evidence_confirmed_at = case when $4 then now() else production_evidence_confirmed_at end,
              production_evidence_confirmed_by = case when $4 then $6 else production_evidence_confirmed_by end,
              evidence_confirmation_note = coalesce($7, evidence_confirmation_note),
              evidence_confirmed_by = $6
        where id = $1 and site_id = $2`,
      [sessionId, siteId, confirmMovements, confirmProduction, session.cutoff_at, userId, note],
    );

    await db.query(
      `insert into audit_events
         (organisation_id, site_id, actor_user_id, actor_type, event_type, object_type, object_id, detail)
       values ($1,$2,$3,'user','EVIDENCE_CUTOFF_ATTESTED','count_session',$4,$5)`,
      [
        session.organisation_id,
        siteId,
        userId,
        sessionId,
        JSON.stringify({
          trustedEvidenceCutoffAt: session.cutoff_at,
          observedPhysicalCutoffAt: session.observed_cutoff_at,
          manualMovementEvidenceConfirmed: confirmMovements,
          manualProductionEvidenceConfirmed: confirmProduction,
          note,
        }),
      ],
    );
  });

  revalidatePath('/variance');
  revalidatePath('/');
}


export async function reviewAutomatedEvidence(formData: FormData): Promise<void> {
  const userId = await currentUserId();
  const siteId = String(formData.get('siteId') ?? '');
  const closingCountLineId = String(formData.get('closingCountLineId') ?? '');
  const evidenceKind = String(formData.get('evidenceKind') ?? '');
  const sourceSystemId = String(formData.get('sourceSystemId') ?? '');
  const note = String(formData.get('note') ?? '').trim() || null;

  if (!siteId || !closingCountLineId || !sourceSystemId || !['movement', 'production'].includes(evidenceKind)) return;

  // Authorise before creating either variance snapshot. A direct call to
  // this server action by a counter must not be able to create audit/run noise.
  await withUser(userId, async (db) => {
    const role = await db.one<{ role: 'owner' | 'manager' | 'counter' | 'viewer' }>(
      `select m.role::text as role
         from memberships m
         join sites s on s.organisation_id = m.organisation_id
        where s.id = $1 and m.user_id = $2`,
      [siteId, userId],
    );
    if (!role || (role.role !== 'owner' && role.role !== 'manager')) {
      throw new Error('Only an owner or manager can review late automated evidence.');
    }
  });

  // Snapshot the current (reopened) numbers first. material_variance_runs/results
  // are append-only, so the pre-review figure can never be overwritten later.
  const before = await withSiteService(userId, siteId, (servicePool) =>
    persistMaterialVarianceRun(servicePool, siteId, userId, 'pre_automated_late_evidence_review'),
  );

  const reviewId = await withUser(userId, async (db) => {
    const result = await db.one<{ review_id: string }>(
      `select public.review_automated_evidence($1,$2,$3,$4,$5,$6) as review_id`,
      [siteId, closingCountLineId, evidenceKind, sourceSystemId, note, before.runId],
    );
    if (!result?.review_id) throw new Error('Late-evidence review was not created.');
    return result.review_id;
  });

  // Re-run after the acknowledgement. This is the "after" half of the audit
  // pair and proves exactly what changed when the interval was re-closed.
  const after = await withSiteService(userId, siteId, (servicePool) =>
    persistMaterialVarianceRun(servicePool, siteId, userId, 'post_automated_late_evidence_review'),
  );

  await withUser(userId, async (db) => {
    await db.query(
      `select public.finalise_automated_evidence_review($1,$2)`,
      [reviewId, after.runId],
    );
  });

  revalidatePath('/variance');
  revalidatePath('/audit');
  revalidatePath('/');
}
