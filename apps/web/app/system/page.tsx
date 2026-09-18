import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, siteConfidence, dataHealth } from '@/lib/queries/read';

export const dynamic = 'force-dynamic';

export default async function SystemPage() {
  const userId = await currentUserId();
  const data = await withUser(userId, async (db) => {
    const site = (await listSites(db))[0];
    if (!site) return null;
    const confidence = await siteConfidence(db, site.id);
    const health = await dataHealth(db, site.id);
    return { site, confidence, health };
  });

  if (!data) return <div className="empty-state"><span>NO SITE</span><h1>System has nothing to inspect.</h1></div>;
  const { site, confidence, health } = data;

  return (
    <>
      <section className="page-intro slim-intro"><div><div className="kicker">System / evidence boundary</div><h1>The maths is small.<br /><span>The discipline around it matters.</span></h1><p className="lede">StockTruth keeps source evidence, policy, reconciliation output and audit history separate. This page exposes the operating assumptions instead of pretending they do not exist.</p></div><div className="intro-meta"><div><span>Engine</span><strong>{confidence.engineVersion ?? 'not run'}</strong></div><div><span>Site TZ</span><strong>{site.timezone}</strong></div></div></section>

      <section className="system-grid">
        <article><span className="eyebrow">Evidence adapter</span><h2>Postgres</h2><p>The UI does not calculate stock. It reads stored evidence and engine results. The reconciliation engine reaches the database through an adapter rather than knowing table names.</p><code>source system -&gt; adapter -&gt; engine -&gt; result</code></article>
        <article><span className="eyebrow">Current site</span><h2>{site.name}</h2><dl><div><dt>Organisation</dt><dd>{site.organisationName}</dd></div><div><dt>Scopes</dt><dd>{confidence.total}</dd></div><div><dt>Timezone</dt><dd>{site.timezone}</dd></div></dl></article>
        <article><span className="eyebrow">Identity health</span><h2>{health.blockedItems + health.sharedBarcodes}</h2><p>unsafe catalogue conditions</p><dl><div><dt>Blocked codes</dt><dd>{health.blockedItems}</dd></div><div><dt>Shared barcodes</dt><dd>{health.sharedBarcodes}</dd></div></dl></article>
        <article><span className="eyebrow">Movement health</span><h2>{health.unlinkedMovements + health.undatedMovements}</h2><p>movement rows that weaken chronology or identity</p><dl><div><dt>Unlinked</dt><dd>{health.unlinkedMovements}</dd></div><div><dt>Undated</dt><dd>{health.undatedMovements}</dd></div></dl></article>
      </section>

      <section className="section-block"><div className="section-heading"><div><span className="eyebrow">Design principles</span><h2>Promises the UI should make visible</h2></div></div><div className="principle-list">
        <div><span>01</span><strong>Zero is data.</strong><p>Zero is never treated as missing.</p></div>
        <div><span>02</span><strong>Unknown stays unknown.</strong><p>Missing evidence does not become an inferred number for convenience.</p></div>
        <div><span>03</span><strong>Occurred and recorded are different clocks.</strong><p>Late paperwork stays late instead of being rewritten into a neat timeline.</p></div>
        <div><span>04</span><strong>Corrections preserve history.</strong><p>Reversals and superseded counts remain visible rather than disappearing.</p></div>
        <div><span>05</span><strong>A count is an observation.</strong><p>Blind counting protects it from being anchored to the book figure.</p></div>
        <div><span>06</span><strong>Refusal is a result.</strong><p>“Cannot be stated” is a valid engine output, not a UI error state.</p></div>
      </div></section>
    </>
  );
}
