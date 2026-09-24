import Link from 'next/link';
import { withSiteService, withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, siteConfidence, dataHealth, openIssues } from '@/lib/queries/read';
import { REASONS, type ReasonDefinition } from '@stocktruth/engine';
import { loadCanonicalExample } from '@/lib/canonical-example';
import { loadMaterialVarianceOverview } from '@/lib/material-variance';
import EvidenceReel from './EvidenceReel';

export const dynamic = 'force-dynamic';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export default async function Control() {
  const userId = await currentUserId();

  const data = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return null;
    // One connection, one transaction: these run in order.
    const confidence = await siteConfidence(db, site.id);
    const health = await dataHealth(db, site.id);
    const issues = await openIssues(db, site.id, 12);
    return { site, confidence, health, issues };
  });

  const [example, variance] = data
    ? await withSiteService(userId, data.site.id, async (servicePool) =>
        Promise.all([
          loadCanonicalExample(servicePool, data.site.id),
          loadMaterialVarianceOverview(servicePool, data.site.id),
        ]),
      )
    : [null, null];

  if (!data) {
    return (
      <p className="empty">
        No sites yet. Once a site exists and a book position has been imported, this page
        shows how much of it anyone has actually checked.
      </p>
    );
  }

  const { site, confidence, health, issues } = data;

  // The headline counts only what has been physically checked recently enough
  // to mean something. Provisional counts, because a caveat is not a failure to
  // verify. Stale does not, because that is precisely the point of stale.
  const trusted = confidence.verified + confidence.provisional;
  const pct = confidence.total ? Math.round((trusted / confidence.total) * 100) : 0;

  return (
    <>
      <h1>{site.name}</h1>
      <p className="sub">
        Last reconciled {ago(confidence.lastRunAt)}
        {confidence.engineVersion ? ` by engine ${confidence.engineVersion}` : ''}.
      </p>

      {example && <EvidenceReel data={example} />}

      {variance && variance.rows.length > 0 && (
        <Link href="/variance" className="margin-strip">
          <span>
            Material variance · {variance.rows.length} repeat-count interval{variance.rows.length === 1 ? '' : 's'}
          </span>
          <strong>
            {variance.closedCount > 0 ? (
              <>
                {new Intl.NumberFormat('en-GB', { style: 'currency', currency: variance.rows[0]?.currency ?? 'GBP' }).format(Math.abs(variance.netVarianceCost))}
                {' '}{variance.netVarianceCost > 0 ? 'adverse' : variance.netVarianceCost < 0 ? 'favourable' : 'net'} · see where it went →
              </>
            ) : (
              <>No interval is closed strongly enough for a margin figure yet →</>
            )}
          </strong>
        </Link>
      )}

      <Link href="/system" className="kernel-strip">
        <span>A total is not a fact.</span>
        <strong>See how the same reasoning kernel sits behind Postgres, CSV and JSON →</strong>
      </Link>

      <div className="stat-line">
        <span className="stat-figure">{pct}%</span>
        <span className="stat-caption">
          {trusted} of {confidence.total} stock positions rest on a physical count recent
          enough to rely on.{' '}
          {confidence.unverified > 0 && (
            <>
              {confidence.unverified} {confidence.unverified === 1 ? 'has' : 'have'} never been
              counted at all.
            </>
          )}
        </span>
      </div>

      <div className="states">
        {(
          [
            ['VERIFIED', confidence.verified, 'verified'],
            ['PROVISIONAL', confidence.provisional, 'with caveats'],
            ['STALE', confidence.stale, 'out of date'],
            ['INCOMPLETE', confidence.incomplete, 'cannot be stated'],
            ['CONFLICT', confidence.conflict, 'contradictory'],
            ['UNVERIFIED', confidence.unverified, 'never counted'],
          ] as const
        ).map(([state, n, label]) => (
          <div className="state" key={state}>
            <div className={`n st-${state}`}>{n}</div>
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      <h2>Data health</h2>
      <table>
        <tbody>
          <HealthRow
            label="Movements not linked to any item"
            value={health.unlinkedMovements}
            note="Until these are linked, any position they might belong to carries a caveat."
            href="/movements"
          />
          <HealthRow
            label="Movements with no date"
            value={health.undatedMovements}
            note="These cannot be placed before or after a count, so they are left out of every figure."
            href="/movements"
          />
          <HealthRow
            label="Codes blocked as unsafe to use"
            value={health.blockedItems}
            note="Counting against these is refused until somebody decides what they mean."
            href="/items"
          />
          <HealthRow
            label="Barcodes printed on more than one item"
            value={health.sharedBarcodes}
            note="A scan cannot tell these apart, so the scanner asks rather than guessing."
            href="/items"
          />
          {health.staleSources.map((s) => (
            <tr key={s.name}>
              <td>{s.name} has stopped delivering</td>
              <td className="num st-STALE">{ago(s.lastSuccessAt)}</td>
              <td className="dim">
                Expected every {s.expectedSyncMinutes} minutes. Recent movements may be missing.
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>What needs attention</h2>
      {issues.length === 0 ? (
        <p className="empty">Nothing open. Either everything reconciles, or nothing has been counted yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Problem</th>
              <th className="num">Book</th>
              <th className="num">Counted</th>
              <th className="num">Now</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => {
              const def = (REASONS as Record<string, ReasonDefinition>)[issue.code];
              return (
                <tr key={issue.id}>
                  <td>
                    {issue.itemId ? (
                      <Link href={`/items/${issue.itemId}`} className="code">
                        {issue.sku ?? issue.itemName}
                      </Link>
                    ) : (
                      <span className="dim">site-wide</span>
                    )}
                    <div className="dim">{issue.itemName}</div>
                  </td>
                  <td>
                    <span className={issue.severity === 'high' ? 'st-CONFLICT' : 'st-STALE'}>
                      {def?.short ?? issue.code}
                    </span>
                    <div className="dim">{def?.action}</div>
                  </td>
                  <td className="num">{issue.bookQuantity ?? '—'}</td>
                  <td className="num">{issue.physicalQuantity ?? '—'}</td>
                  <td className="num">
                    {issue.derivedQuantity ?? <span className="none">not stated</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function HealthRow({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: number;
  note: string;
  href: string;
}) {
  if (value === 0) return null;
  return (
    <tr>
      <td>
        <Link href={href}>{label}</Link>
      </td>
      <td className="num st-STALE">{value}</td>
      <td className="dim">{note}</td>
    </tr>
  );
}
