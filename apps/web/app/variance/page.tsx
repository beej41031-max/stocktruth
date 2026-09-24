import Link from 'next/link';
import { currentUserId } from '@/lib/session';
import { withSiteService, withUser } from '@/lib/db';
import { listSites } from '@/lib/queries/read';
import { loadMaterialVarianceOverview } from '@/lib/material-variance';
import { attestEvidenceCutoff, reviewAutomatedEvidence } from './actions';

export const dynamic = 'force-dynamic';

const money = (value: number, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

const qty = (value: number | null) =>
  value == null ? '—' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value);

const date = (value: Date) =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(value);

export default async function VariancePage() {
  const userId = await currentUserId();
  const site = await withUser(userId, async (db) => (await listSites(db))[0] ?? null);

  if (!site) return <p className="empty">No site exists yet.</p>;

  const attestation = await withUser(userId, async (db) => {
    const membership = await db.one<{ role: 'owner' | 'manager' | 'counter' | 'viewer' }>(
      `select m.role::text as role
         from memberships m
         join sites s on s.organisation_id = m.organisation_id
        where s.id = $1 and m.user_id = $2`,
      [site.id, userId],
    );
    if (!membership || (membership.role !== 'owner' && membership.role !== 'manager')) {
      return { canAttest: false, sessions: [] as Array<{ id: string; name: string | null; completed_at: string; cutoff_at: string; observed_cutoff_at: string; movement_done: boolean; production_done: boolean }> };
    }

    const sessions = await db.query<{
      id: string;
      name: string | null;
      completed_at: string;
      cutoff_at: string;
      observed_cutoff_at: string;
      movement_done: boolean;
      production_done: boolean;
    }>(
      `select cs.id, cs.name, cs.completed_at::text, max(cl.received_at)::text as cutoff_at,
              max(cl.counted_at)::text as observed_cutoff_at,
              (cs.movement_evidence_confirmed_through is not null) as movement_done,
              (cs.production_evidence_confirmed_through is not null) as production_done
         from count_sessions cs
         join count_lines cl on cl.count_session_id = cs.id and not cl.superseded
        where cs.site_id = $1 and cs.status = 'completed'
          and (cs.movement_evidence_confirmed_through is null or cs.production_evidence_confirmed_through is null)
        group by cs.id, cs.name, cs.completed_at, cs.movement_evidence_confirmed_through, cs.production_evidence_confirmed_through
        order by cs.completed_at desc
        limit 6`,
      [site.id],
    );
    return { canAttest: true, sessions };
  });

  const overview = await withSiteService(userId, site.id, (servicePool) =>
    loadMaterialVarianceOverview(servicePool, site.id),
  );
  const currency = overview.rows[0]?.currency ?? 'GBP';
  const net = overview.netVarianceCost;
  const lateReviewMap = new Map<string, {
    closingCountLineId: string; evidenceKind: 'movement' | 'production'; sourceSystemId: string;
    sourceName: string; lateCount: number; materials: Set<string>;
  }>();
  for (const row of overview.rows) {
    for (const target of row.reviewTargets) {
      const key = `${row.closingCountLineId}::${target.evidenceKind}::${target.sourceSystemId}`;
      const existing = lateReviewMap.get(key);
      if (existing) {
        existing.lateCount = Math.max(existing.lateCount, target.lateCount);
        existing.materials.add(row.sku ?? row.name);
      } else {
        lateReviewMap.set(key, {
          closingCountLineId: row.closingCountLineId, evidenceKind: target.evidenceKind,
          sourceSystemId: target.sourceSystemId, sourceName: target.sourceName,
          lateCount: target.lateCount, materials: new Set([row.sku ?? row.name]),
        });
      }
    }
  }
  const lateReviewTargets = [...lateReviewMap.values()];

  return (
    <>
      <h1>Material variance</h1>
      <p className="sub">
        A count is an observation, not an opening balance to carry forever. The next count closes
        the interval. Receipts explain what came in; production × the effective BOM explains what
        should have gone out. The remainder is unexplained material variance: the place to investigate scrap, overuse, rework, BOM error and shrinkage.
      </p>

      {attestation.canAttest && attestation.sessions.length > 0 && (
        <div className="banner" style={{ marginBottom: 24 }}>
          <strong>Office evidence confirmation</strong>
          <p className="sub" style={{ marginTop: 8 }}>
            The physical counts are closed. Certify manual paperwork only after receipts/transfers or production records have caught up.
            Confirmation is through the count cutoff shown below, not through the time you click this button. Automated feeds still have to settle independently.
          </p>
          {attestation.sessions.map((session) => (
            <form action={attestEvidenceCutoff} key={session.id} style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
              <input type="hidden" name="siteId" value={site.id} />
              <input type="hidden" name="sessionId" value={session.id} />
              <div>
                <strong>{session.name ?? 'Count session'}</strong>
                <span className="dim"> · evidence cutoff {new Date(session.cutoff_at).toLocaleString('en-GB')}
                {session.observed_cutoff_at !== session.cutoff_at ? ` · device observation ${new Date(session.observed_cutoff_at).toLocaleString('en-GB')}` : ''}</span>
              </div>
              {!session.movement_done && (
                <label style={{ display: 'block', marginTop: 8 }}>
                  <input type="checkbox" name="confirmMovements" />{' '}
                  Manual receipts, transfers and returns are complete through this trusted evidence cutoff.
                </label>
              )}
              {!session.production_done && (
                <label style={{ display: 'block', marginTop: 6 }}>
                  <input type="checkbox" name="confirmProduction" />{' '}
                  Manual production output is complete through this trusted evidence cutoff.
                </label>
              )}
              <input name="note" placeholder="Optional note / paperwork batch" style={{ marginTop: 8, maxWidth: 420 }} />
              <button type="submit" style={{ marginTop: 8 }}>Certify selected evidence</button>
            </form>
          ))}
        </div>
      )}

      {attestation.canAttest && lateReviewTargets.length > 0 && (
        <div className="banner" style={{ marginBottom: 24 }}>
          <strong>Late automated evidence reopened history</strong>
          <p className="sub" style={{ marginTop: 8 }}>
            These feeds delivered evidence after they had already claimed completeness through the count close.
            Review the changed evidence, then re-close it here. StockTruth keeps a material-variance run from before
            and after the review; a later correction will reopen the interval again.
          </p>
          {lateReviewTargets.map((target) => (
            <form
              action={reviewAutomatedEvidence}
              key={`${target.closingCountLineId}:${target.evidenceKind}:${target.sourceSystemId}`}
              style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}
            >
              <input type="hidden" name="siteId" value={site.id} />
              <input type="hidden" name="closingCountLineId" value={target.closingCountLineId} />
              <input type="hidden" name="evidenceKind" value={target.evidenceKind} />
              <input type="hidden" name="sourceSystemId" value={target.sourceSystemId} />
              <div>
                <strong>{target.sourceName}</strong>
                <span className="dim"> · late {target.evidenceKind} evidence · affects {Array.from(target.materials).join(', ')}</span>
              </div>
              <div className="dim" style={{ marginTop: 6 }}>
                At least {target.lateCount} late row{target.lateCount === 1 ? '' : 's'} detected in an affected interval.
                The database will determine the exact reviewed set at approval time.
              </div>
              <input name="note" required placeholder="What did you check? e.g. corrected Nory export / office batch 184" style={{ marginTop: 8, maxWidth: 520 }} />
              <button type="submit" style={{ marginTop: 8 }}>Review and re-close automated evidence</button>
            </form>
          ))}
        </div>
      )}

      {overview.rows.length === 0 ? (
        <div className="banner">
          <strong>The first count is only the cost of entry.</strong> Repeat one material in the same
          location and this page starts measuring actual consumption.
        </div>
      ) : (
        <>
          <div className="variance-hero">
            <div>
              <div className="label">Net unexplained material variance</div>
              {overview.closedCount > 0 ? (
                <>
                  <div className={`variance-money ${net > 0 ? 'bad' : net < 0 ? 'good' : ''}`}>
                    {money(Math.abs(net), currency)}
                  </div>
                  <div className="variance-direction">
                    {net > 0 ? 'adverse' : net < 0 ? 'favourable' : 'balanced'} across the latest closed
                    repeat-count intervals
                  </div>
                </>
              ) : (
                <>
                  <div className="variance-money">Not stated</div>
                  <div className="variance-direction">No repeat-count interval has closed strongly enough for a margin figure yet.</div>
                </>
              )}
            </div>
            <div className="variance-split">
              <div><span>Adverse</span><strong>{money(overview.adverseCost, currency)}</strong></div>
              <div><span>Favourable</span><strong>{money(Math.abs(overview.favourableCost), currency)}</strong></div>
              <div><span>Closed intervals</span><strong>{overview.closedCount}</strong></div>
              <div>
                <span>Quantified provisional</span>
                <strong>{money(overview.provisionalExposureCost, currency)}</strong>
              </div>
              <div>
                <span>Unquantified intervals</span>
                <strong>{overview.unquantifiedExposureCount}</strong>
              </div>
            </div>
          </div>

          <div className="variance-flow">
            <span>count₁</span><b>+</b><span>receipts</span><b>−</b><span>non-production outflow</span><b>−</b><span>count₂</span><b>=</b><strong>actual use</strong>
            <i>then</i>
            <span>output × effective BOM</span><b>=</b><strong>theoretical use</strong>
          </div>

          <h2>Where material use diverged</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Interval</th>
                  <th className="num">Actual use</th>
                  <th className="num">Should use</th>
                  <th className="num">Variance</th>
                  <th className="num">Value</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {overview.rows.map((row) => {
                  const o = row.output;
                  const v = o.varianceQuantity;
                  return (
                    <tr key={`${row.itemId}:${row.locationId ?? 'none'}`}>
                      <td>
                        <Link href={`/items/${row.itemId}`} className="code">{row.sku ?? row.name}</Link>
                        <div className="dim">{row.name}{row.locationCode ? ` · ${row.locationCode}` : ''}</div>
                      </td>
                      <td>
                        <span className="code">{date(o.intervalStart)} → {date(o.intervalEnd)}</span>
                        <div className="dim">{o.intervalDays.toFixed(0)} days · {o.productionOutputCount} production output{ o.productionOutputCount === 1 ? '' : 's' }</div>
                      </td>
                      <td className="num">{qty(o.actualConsumption)} {row.unit}</td>
                      <td className="num">{qty(o.theoreticalConsumption)} {row.unit}</td>
                      <td className={`num ${v != null && v > 0 ? 'st-CONFLICT' : v != null && v < 0 ? 'st-VERIFIED' : ''}`}>
                        {v == null ? <span className="none">not stated</span> : `${v > 0 ? '+' : ''}${qty(v)}`}
                        {o.variancePercent != null && <div className="dim">{o.variancePercent > 0 ? '+' : ''}{o.variancePercent.toFixed(1)}%</div>}
                      </td>
                      <td className={`num ${o.varianceCost != null && o.varianceCost > 0 ? 'st-CONFLICT' : o.varianceCost != null && o.varianceCost < 0 ? 'st-VERIFIED' : ''}`}>
                        {o.varianceCost == null ? '—' : money(Math.abs(o.varianceCost), row.currency)}
                        {o.varianceCost != null && <div className="dim">{o.varianceCost > 0 ? 'adverse' : o.varianceCost < 0 ? 'favourable' : 'even'}</div>}
                      </td>
                      <td>
                        <span className={`tag variance-${o.state.toLowerCase()}`}>{o.state.toLowerCase().replace('_', ' ')}</span>
                        {o.lateRecordedMovementCount > 0 && <div className="dim">{o.lateRecordedMovementCount} movement{ o.lateRecordedMovementCount === 1 ? '' : 's' } arrived after the evidence-closure assertion — interval reopened</div>}
                        {o.lateRecordedProductionCount > 0 && <div className="dim">{o.lateRecordedProductionCount} production output{ o.lateRecordedProductionCount === 1 ? '' : 's' } arrived after the evidence-closure assertion — theory reopened</div>}
                        {o.movementWatermark && <div className="dim">movement evidence settled through {date(o.movementWatermark)}</div>}
                        {o.productionWatermark && <div className="dim">production evidence settled through {date(o.productionWatermark)}</div>}
                        {o.reasons.includes('THEORY_SCOPE_AMBIGUOUS') && <div className="dim">site-wide production is not allocated to this storage location</div>}
                        {o.reasons.includes('PRODUCTION_NOT_SETTLED_THROUGH_CLOSE') && <div className="dim">production feed not confirmed through close</div>}
                        {o.reasons.includes('OUTPUT_UNIT_MISMATCH') && <div className="dim">production output unit does not match the product/BOM unit</div>}
                        {o.reasons.includes('COUNT_CLOCK_SKEW') && <div className="dim">count device/server clocks disagree beyond site policy — interval refused</div>}
                        {o.reasons.includes('SUSPECTED_DUPLICATE_MOVEMENT') && <div className="dim">possible duplicate movement — {o.evidence.suspectedDuplicateMovementIds.length} movement rows need review before margin can close</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h2>What should be counted next</h2>
          <p className="sub">
            Not the oldest item by default. Count where another observation can change a decision or
            close the largest economic exposure.
          </p>
          <div className="priority-list">
            {overview.topVerification.map((row, i) => (
              <Link href={`/items/${row.itemId}`} key={row.itemId} className="priority-row">
                <span className="priority-rank">{String(i + 1).padStart(2, '0')}</span>
                <span>
                  <strong>{row.sku ?? row.name}</strong>
                  <small>{row.name} · target every {row.targetCountCycleDays} days</small>
                </span>
                <span className="priority-value">
                  {row.output.varianceCost == null ? 'evidence gap' : money(Math.abs(row.output.varianceCost), row.currency)}
                  <small>{row.output.varianceCost != null && row.output.varianceCost > 0 ? 'last adverse variance' : 'latest exposure'}</small>
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      <div className="banner" style={{ marginTop: 34 }}>
        <strong>Inventory accuracy is admin. Material variance is margin.</strong>{' '}
        A ledger correction may fix the current balance; it does not erase the measured interval that
        created the discrepancy.
      </div>
    </>
  );
}
