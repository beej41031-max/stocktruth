import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withUser, rawPool } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, itemDetail, itemTimeline, latestResult } from '@/lib/queries/read';
import { DEFAULT_POLICY, REASONS, explain, type ReasonDefinition } from '@stocktruth/engine';
import { PostgresEvidenceSource } from '@/lib/adapters/postgres';
import Status from '../../components/Status';

export const dynamic = 'force-dynamic';

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function lagMinutes(occurred: string, recorded: string | null): number | null {
  if (!recorded) return null;
  return Math.round((new Date(recorded).getTime() - new Date(occurred).getTime()) / 60_000);
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await currentUserId();
  const data = await withUser(userId, async (db) => {
    const site = (await listSites(db))[0];
    if (!site) return null;
    const item = await itemDetail(db, id);
    if (!item) return null;
    const result = await latestResult(db, site.id, id);
    const timeline = await itemTimeline(db, site.id, id);
    return { site, item, result, timeline };
  });

  if (!data) notFound();
  const { site, item, result, timeline } = data;

  const source = new PostgresEvidenceSource(rawPool());
  const policy = { ...DEFAULT_POLICY, ...(await source.loadPolicy({ siteId: site.id })) };
  const scope = (await source.loadSite({ siteId: site.id })).find((s) => s.item.id === id);
  const detail = scope ? explain({
    item: scope.item,
    locationId: scope.locationId,
    book: scope.book,
    count: scope.count,
    movements: scope.movements,
    unlinkedMovementCount: scope.unlinkedMovementCount,
    possiblyRelatedUnlinkedCount: scope.possiblyRelatedUnlinkedCount,
    sources: scope.sources,
    policy,
    evaluatedAt: new Date(),
  }) : null;

  const codes = result?.reasonCodes ?? [];
  const blocking = codes.filter((c) => (REASONS as Record<string, ReasonDefinition>)[c]?.blocks === true);
  const caveats = codes.filter((c) => !(REASONS as Record<string, ReasonDefinition>)[c]?.blocks);
  const stateable = result?.derivedQuantity != null;

  return (
    <>
      <div className="breadcrumbs"><Link href="/items">Items</Link><span>/</span><span>{item.sku ?? item.name}</span></div>
      <section className="item-hero">
        <div>
          <div className="kicker">Evidence file / {result?.locationCode ?? 'no location'}</div>
          <h1>{item.name}</h1>
          <div className="item-identity"><span className="code">{item.sku ?? '(no code)'}</span><span>{item.stockUnit}</span>{item.aliases.length > 0 && <span>{item.aliases.join(' / ')}</span>}{!item.active && <span>retired</span>}</div>
        </div>
        <div className="item-verdict">
          <Status state={result?.state} />
          <span className="eyebrow">Current stock</span>
          <strong className={stateable ? `st-${result?.state}` : 'danger-text'}>{stateable ? result?.derivedQuantity : 'NOT STATED'}</strong>
          <small>{stateable ? `as of ${result?.derivedAsOf ? fmtTime(result.derivedAsOf) : 'latest evidence'}` : 'The evidence does not support one answer.'}</small>
        </div>
      </section>

      {item.blocked && <div className="critical-banner"><span>CATALOGUE BLOCK</span><strong>This code is unsafe to count against.</strong><p>{item.blockedReason}</p></div>}

      <section className="position-equation section-block">
        <div className="equation-cell"><span>BOOK</span><strong>{result?.bookQuantity ?? '—'}</strong><small>{result?.bookAsOf ? `as at ${fmtDate(result.bookAsOf)}` : 'no dated book position'}</small></div>
        <div className="equation-symbol">→</div>
        <div className="equation-cell"><span>PHYSICAL</span><strong>{result?.physicalQuantity ?? '—'}</strong><small>{result?.physicalCountedAt ? fmtTime(result.physicalCountedAt) : 'never counted'}</small></div>
        <div className="equation-symbol">+</div>
        <div className="equation-cell"><span>MOVEMENTS SINCE</span><strong>{result?.movementNet != null ? `${Number(result.movementNet) > 0 ? '+' : ''}${result.movementNet}` : '?'}</strong><small>after the count anchor</small></div>
        <div className="equation-symbol">=</div>
        <div className={`equation-cell equation-final ${stateable ? '' : 'equation-refused'}`}><span>DEFENSIBLE NOW</span><strong>{result?.derivedQuantity ?? 'NOT STATED'}</strong><small>{stateable ? 'supported by the evidence above' : 'uncertainty survives the arithmetic'}</small></div>
      </section>

      {result?.varianceAtCount != null && <div className="editorial-note"><strong>At count time, book and shelf differed by {Math.abs(Number(result.varianceAtCount)).toLocaleString('en-GB')} {item.stockUnit}.</strong><span>That is a difference, not automatically shrinkage. StockTruth keeps the observation separate from the explanation.</span></div>}

      {(blocking.length > 0 || caveats.length > 0) && (
        <section className="section-block reason-section">
          <div className="section-heading"><div><span className="eyebrow">Verdict anatomy</span><h2>Why the engine landed here</h2></div></div>
          <div className="reason-grid">
            {blocking.map((code) => {
              const def = (REASONS as Record<string, ReasonDefinition>)[code];
              const blocker = detail?.blockers.find((b) => b.code === code);
              if (!def) return null;
              return <div className="reason-card blocking-card" key={code}><span>BLOCKING</span><strong>{def.short}</strong><p>{blocker?.resolution ?? def.action}</p><code>{code}</code></div>;
            })}
            {caveats.map((code) => {
              const def = (REASONS as Record<string, ReasonDefinition>)[code];
              if (!def) return null;
              return <div className="reason-card caveat-card" key={code}><span>CAVEAT</span><strong>{def.short}</strong><p>{def.action}</p><code>{code}</code></div>;
            })}
          </div>
          {detail?.ifCleared?.quantity != null && <div className="counterfactual"><span className="eyebrow">If the blocker were cleared</span><strong>{detail.ifCleared.quantity.toLocaleString('en-GB')}</strong><p>This is a counterfactual, not a recorded stock position.{detail.ifCleared.assuming.length ? ` It assumes ${detail.ifCleared.assuming.join('; ')}.` : ''}</p></div>}
        </section>
      )}

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Evidence chronology</span><h2>What happened, and when it was written down</h2></div><span className="section-note">Occurred time and recorded time stay separate.</span></div>
        {timeline.length === 0 ? <div className="empty-inline">Nothing recorded against this item.</div> : (
          <div className="forensic-timeline">
            {timeline.map((e, i) => {
              const lag = lagMinutes(e.at, e.recordedAt);
              const late = lag != null && Math.abs(lag) >= 15;
              return <article className={`forensic-event event-${e.kind} ${late ? 'event-late' : ''}`} key={`${e.at}-${i}`}>
                <div className="event-axis"><span className={`event-shape ${e.kind}`} /></div>
                <div className="event-time"><strong>{fmtTime(e.at)}</strong><span>occurred</span></div>
                <div className="event-body"><div className="event-title"><strong>{e.label}</strong><span>{e.quantity}</span></div>{e.detail && <p>{e.detail}</p>}{e.actor && <small>Source: {e.actor}</small>}
                  {late && <div className="late-record"><span>RECORDED LATER</span><strong>{e.recordedAt ? fmtTime(e.recordedAt) : 'unknown'}</strong><small>{Math.abs(lag!)} minutes after the event time</small></div>}
                </div>
              </article>;
            })}
          </div>
        )}
      </section>

      <details className="raw-drawer">
        <summary>Raw evidence summary <span>for auditors and curious people</span></summary>
        <div className="raw-grid"><div><span>Aliases</span><strong>{item.aliases.length ? item.aliases.join(', ') : 'none'}</strong></div><div><span>Barcodes</span><strong>{item.barcodes.length ? item.barcodes.join(', ') : 'none'}</strong></div><div><span>Reason codes</span><strong>{codes.length ? codes.join(', ') : 'none'}</strong></div><div><span>Timeline rows</span><strong>{timeline.length}</strong></div></div>
      </details>
    </>
  );
}
