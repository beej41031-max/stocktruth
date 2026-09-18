import Link from 'next/link';
import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, siteConfidence, dataHealth, openIssues, listItems } from '@/lib/queries/read';
import { REASONS, type ReasonDefinition } from '@stocktruth/engine';
import Status, { statusLabel } from './components/Status';
import report from '../stress-report.json';

export const dynamic = 'force-dynamic';

const STATE_ROWS = [
  ['VERIFIED', 'Verified'],
  ['PROVISIONAL', 'With caveats'],
  ['STALE', 'Out of date'],
  ['INCOMPLETE', 'Cannot be stated'],
  ['CONFLICT', 'Contradictory'],
  ['UNVERIFIED', 'Never counted'],
] as const;

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export default async function Overview() {
  const userId = await currentUserId();

  const data = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return null;
    const confidence = await siteConfidence(db, site.id);
    const health = await dataHealth(db, site.id);
    const issues = await openIssues(db, site.id, 100);
    const heroRows = await listItems(db, site.id, 'PKG-CAN-440');
    return { site, confidence, health, issues, hero: heroRows.find((r) => r.sku === 'PKG-CAN-440') ?? heroRows[0] ?? null };
  });

  if (!data) {
    return <div className="empty-state"><span>NO SITE</span><h1>Nothing to judge yet.</h1><p>Import a book position or create a count and StockTruth will start building an evidence trail.</p></div>;
  }

  const { site, confidence, health, issues, hero } = data;
  const trusted = confidence.verified + confidence.provisional;
  const refused = confidence.incomplete + confidence.conflict;
  const issueGroups = new Map<string, number>();
  for (const issue of issues) issueGroups.set(issue.code, (issueGroups.get(issue.code) ?? 0) + 1);
  const topIssueGroups = [...issueGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const counts: Record<string, number> = {
    VERIFIED: confidence.verified,
    PROVISIONAL: confidence.provisional,
    STALE: confidence.stale,
    INCOMPLETE: confidence.incomplete,
    CONFLICT: confidence.conflict,
    UNVERIFIED: confidence.unverified,
  };

  return (
    <>
      <section className="page-intro overview-intro">
        <div>
          <div className="kicker">{site.organisationName} / {site.name}</div>
          <h1>Know what you have.<br /><span>Know when not to trust it.</span></h1>
          <p className="lede">StockTruth separates a stock figure from the evidence required to defend it. When the evidence is bad, the number disappears before the explanation does.</p>
        </div>
        <div className="intro-meta">
          <div><span>Last reconcile</span><strong>{ago(confidence.lastRunAt)}</strong></div>
          <div><span>Engine</span><strong>{confidence.engineVersion ?? 'not run'}</strong></div>
          <div><span>Live scopes</span><strong>{confidence.total.toLocaleString()}</strong></div>
        </div>
      </section>

      <section className="truth-summary">
        <div className="truth-number truth-number-good">
          <span className="metric-label">Stateable from recent evidence</span>
          <strong>{trusted.toLocaleString()}</strong>
          <small>verified + provisional</small>
        </div>
        <div className="truth-number truth-number-bad">
          <span className="metric-label">Withheld rather than guessed</span>
          <strong>{refused.toLocaleString()}</strong>
          <small>incomplete + conflict</small>
        </div>
        <div className="truth-statement">
          <span className="eyebrow">Product rule</span>
          <p>A missing answer is sometimes the most accurate answer in the building.</p>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div><span className="eyebrow">Live evidence state</span><h2>What the current demo can defend</h2></div>
          <Link className="text-action" href="/items">Inspect all items</Link>
        </div>
        <div className="distribution" aria-label="Current reconciliation state distribution">
          {STATE_ROWS.map(([state]) => {
            const n = counts[state] ?? 0;
            const width = confidence.total ? Math.max((n / confidence.total) * 100, n ? 2.5 : 0) : 0;
            return <Link key={state} href={`/items?state=${state}`} className={`distribution-segment ds-${state}`} style={{ width: `${width}%` }} title={`${statusLabel(state)}: ${n}`} />;
          })}
        </div>
        <div className="state-ledger">
          {STATE_ROWS.map(([state, label]) => (
            <Link href={`/items?state=${state}`} key={state} className="state-ledger-row">
              <Status state={state} />
              <strong>{(counts[state] ?? 0).toLocaleString()}</strong>
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="spotlight section-block">
        <div className="section-heading">
          <div><span className="eyebrow">Spotlight case / the whole point</span><h2>One stock line. Three versions of reality.</h2></div>
          {hero && <Link className="text-action" href={`/items/${hero.itemId}`}>Open evidence</Link>}
        </div>
        <div className="spotlight-grid">
          <div className="spotlight-metric">
            <span>Book</span><strong>{hero?.bookQuantity ?? '19,200'}</strong><small>what the system carried</small>
          </div>
          <div className="spotlight-metric">
            <span>Physical count</span><strong>{hero?.physicalQuantity ?? '27,600'}</strong><small>what somebody saw</small>
          </div>
          <div className="spotlight-metric spotlight-refused">
            <span>Current position</span><strong>{hero?.derivedQuantity ?? 'NOT STATED'}</strong><small>{hero?.derivedQuantity ? 'stateable' : 'evidence does not support one answer'}</small>
          </div>
        </div>
        <div className="evidence-line compact-evidence">
          <div className="evidence-step"><i className="evidence-mark movement" /><span>11:02</span><strong>Receipt occurs</strong><small>+8,400 physically moves</small></div>
          <div className="evidence-step"><i className="evidence-mark count" /><span>12:02</span><strong>Physical count</strong><small>27,600 observed</small></div>
          <div className="evidence-step danger"><i className="evidence-mark late" /><span>15:02</span><strong>Receipt gets recorded</strong><small>too late to know if the count included it</small></div>
        </div>
        <div className="editorial-note"><strong>Guessing gives two plausible answers.</strong><span>StockTruth records neither until somebody can establish what was physically present at count time.</span></div>
      </section>

      <section className="two-column section-block">
        <div>
          <div className="section-heading"><div><span className="eyebrow">Attention queue</span><h2>What deserves a human</h2></div><Link className="text-action" href="/reconcile">Open issues</Link></div>
          <div className="attention-list">
            {topIssueGroups.length === 0 ? <p className="empty-inline">No open issues.</p> : topIssueGroups.map(([code, n]) => {
              const def = (REASONS as Record<string, ReasonDefinition>)[code];
              return <Link href={`/reconcile?code=${encodeURIComponent(code)}`} className="attention-row" key={code}>
                <span className={`attention-count ${def?.blocks ? 'danger-text' : ''}`}>{n}</span>
                <span><strong>{def?.short ?? code}</strong><small>{def?.action ?? 'Inspect the evidence.'}</small></span>
                <span className="row-arrow">Ã¢â€ â€”</span>
              </Link>;
            })}
          </div>
        </div>
        <div>
          <div className="section-heading"><div><span className="eyebrow">Source hygiene</span><h2>Before trusting the maths</h2></div></div>
          <div className="instrument-list">
            <Instrument label="Unlinked movements" value={health.unlinkedMovements} href="/movements" />
            <Instrument label="Undated movements" value={health.undatedMovements} href="/movements" />
            <Instrument label="Blocked item codes" value={health.blockedItems} href="/items" />
            <Instrument label="Shared barcodes" value={health.sharedBarcodes} href="/items" />
            <Instrument label="Silent feeds" value={health.staleSources.length} href="/system" />
          </div>
        </div>
      </section>

      {report.ready && (
        <section className="benchmark-ribbon section-block">
          <div><span className="eyebrow">Synthetic torture test</span><strong>{report.itemCount.toLocaleString()}</strong><small>stock lines</small></div>
          <div><strong>{report.evidenceRows.toLocaleString()}</strong><small>evidence records</small></div>
          <div><strong>{report.timingsMs.reconcile} ms</strong><small>core reconcile</small></div>
          <div><strong>{report.invariantFailures.length}</strong><small>invariant failures</small></div>
          <Link href="/stress">See exactly what was thrown at it <span>Ã¢â€ â€”</span></Link>
        </section>
      )}
    </>
  );
}

function Instrument({ label, value, href }: { label: string; value: number; href: string }) {
  return <Link className="instrument-row" href={href}><span>{label}</span><strong className={value ? 'warn-text' : 'good-text'}>{value}</strong><small>{value ? 'needs attention' : 'clear'}</small></Link>;
}
