import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withSiteService, withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, itemDetail, itemTimeline, latestResult } from '@/lib/queries/read';
import { DEFAULT_POLICY, REASONS, explain, reconcile, assessOperationalPosition, type ReasonDefinition } from '@stocktruth/engine';
import { PostgresEvidenceSource } from '@/lib/adapters/postgres';

export const dynamic = 'force-dynamic';

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** Gap between a thing happening and somebody writing it down. */
function lag(occurred: string, recorded: string | null): string | null {
  if (!recorded) return null;
  const mins = Math.round((new Date(recorded).getTime() - new Date(occurred).getTime()) / 60_000);
  if (Math.abs(mins) < 15) return null;
  if (Math.abs(mins) < 120) return `Recorded ${mins} minutes later`;
  return `Recorded ${Math.round(mins / 60)} hours later`;
}

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await currentUserId();

  const data = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return null;
    const item = await itemDetail(db, id);
    if (!item) return null;
    const result = await latestResult(db, site.id, id);
    const timeline = await itemTimeline(db, site.id, id);
    return { site, item, result, timeline };
  });

  if (!data) notFound();
  const { site, item, result, timeline } = data;

  // Re-run the engine for this one item so the page can show what would clear
  // each blocker, naming the actual records. The stored result carries the
  // codes; only the engine can turn them into an instruction.
  const { policy, scopes } = await withSiteService(userId, site.id, async (servicePool) => {
    const source = new PostgresEvidenceSource(servicePool);
    return {
      policy: { ...DEFAULT_POLICY, ...(await source.loadPolicy({ siteId: site.id })) },
      scopes: await source.loadSite({ siteId: site.id }),
    };
  });
  const scope = scopes.find((s) => s.item.id === id);
  const evaluatedAt = new Date();
  const engineInput = scope
    ? {
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
      }
    : null;
  const detail = engineInput ? explain(engineInput) : null;
  const rawResult = engineInput ? reconcile(engineInput) : null;
  const spanning = scope?.count
    ? scope.movements.filter(
        (m) =>
          m.occurredAt != null &&
          m.recordedAt != null &&
          m.occurredAt.getTime() <= scope.count!.countedAt.getTime() &&
          m.recordedAt.getTime() > scope.count!.countedAt.getTime(),
      )
    : [];
  const unbounded = new Set([
    'MOVEMENT_UNDATED',
    'MOVEMENT_MAY_BELONG_HERE',
    'ITEM_BLOCKED',
    'AMBIGUOUS_ITEM_IDENTITY',
    'MOVEMENT_UNIT_MISMATCH',
    'MOVEMENT_QUANTITY_INVALID',
    'ADJUSTMENT_IN_INTERVAL',
    'COUNT_UNIT_MISMATCH',
  ]);
  const operational = rawResult
    ? assessOperationalPosition({
        result: rawResult,
        spanningMovements: spanning,
        hasUnboundedBlocker: rawResult.reasons.some((r) => unbounded.has(r)),
      })
    : null;

  const codes = result?.reasonCodes ?? [];
  const isBlocking = (c: string) =>
    (REASONS as Record<string, ReasonDefinition>)[c]?.blocks === true;
  const blocking = codes.filter(isBlocking);
  const caveats = codes.filter((c) => !isBlocking(c));

  return (
    <>
      <p className="sub" style={{ marginBottom: 6 }}>
        <Link href="/items">Items</Link>
      </p>
      <h1>{item.name}</h1>
      <p className="sub">
        <span className="code">{item.sku}</span> · held in {item.stockUnit}
        {item.aliases.length > 0 && <> · also called {item.aliases.join(', ')}</>}
        {!item.active && <> · retired</>}
      </p>

      {item.blocked && (
        <div className="reason high">
          <div className="what">This code is blocked and cannot be counted</div>
          <div className="do">{item.blockedReason}</div>
        </div>
      )}

      {/*
        Three numbers that answer three different questions. Keeping them side
        by side is the whole argument of the product: a single "quantity" field
        would have to pick one and hide the other two.
      */}
      <div className="truth">
        <div>
          <div className="label">Book says</div>
          {result?.bookQuantity != null ? (
            <>
              <div className="value">{result.bookQuantity}</div>
              <div className="when">
                {result.bookAsOf ? `As at ${fmtDate(result.bookAsOf)}` : 'No as-at date in the source'}
              </div>
            </>
          ) : (
            <>
              <div className="value refused none">No book position</div>
              <div className="when">Nothing has been imported for this item.</div>
            </>
          )}
        </div>

        <div>
          <div className="label">Somebody counted</div>
          {result?.physicalQuantity != null ? (
            <>
              <div className="value">{result.physicalQuantity}</div>
              <div className="when">
                {result.physicalCountedAt && fmtTime(result.physicalCountedAt)}
                {result.locationCode && ` · ${result.locationCode}`}
              </div>
            </>
          ) : (
            <>
              <div className="value refused none">Never counted</div>
              <div className="when">Nobody has physically checked this.</div>
            </>
          )}
        </div>

        <div>
          <div className="label">On the shelf now</div>
          {result?.derivedQuantity != null ? (
            <>
              <div className={`value st-${result.state}`}>{result.derivedQuantity}</div>
              <div className="when">
                Counted {result.physicalQuantity}
                {result.movementNet != null && Number(result.movementNet) !== 0 && (
                  <>
                    , then {Number(result.movementNet) > 0 ? '+' : ''}
                    {result.movementNet} since
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="value refused none">Cannot be stated</div>
              <div className="when">
                The evidence does not support one answer. The reasons are below.
              </div>
            </>
          )}
        </div>
      </div>

      {result?.varianceAtCount != null && (
        <p className="sub">
          When it was counted, the records were {Math.abs(Number(result.varianceAtCount))}{' '}
          {Number(result.varianceAtCount) > 0 ? 'lower' : 'higher'} than what was on the shelf.
        </p>
      )}


      {operational && operational.lowerBound != null && operational.upperBound != null && (
        <>
          <h2>What the business can safely do</h2>
          <div className="decision-summary">
            <div>
              <span>Operational range</span>
              <strong>
                {operational.lowerBound.toLocaleString('en-GB')}
                {operational.upperBound !== operational.lowerBound && `–${operational.upperBound.toLocaleString('en-GB')}`}
              </strong>
              <small>
                {operational.exactQuantity != null
                  ? 'Exact supported position'
                  : operational.omittedStockExposure
                    ? `up to +${operational.omittedStockExposure.toLocaleString('en-GB')} ${item.stockUnit} may exist but be omitted`
                    : operational.phantomStockExposure
                      ? `up to ${operational.phantomStockExposure.toLocaleString('en-GB')} ${item.stockUnit} may be phantom stock`
                      : `${(operational.upperBound - operational.lowerBound).toLocaleString('en-GB')} ${item.stockUnit} unresolved`}
              </small>
            </div>
            {operational.advice.map((advice) => (
              <div key={advice.decision}>
                <span>{advice.decision.toLowerCase().replace('_', ' ')}</span>
                <strong className={`decision-${advice.disposition.toLowerCase()}`}>
                  {advice.disposition.toLowerCase()}
                  {advice.quantityLimit != null && ` ≤ ${advice.quantityLimit.toLocaleString('en-GB')}`}
                </strong>
                <small>{advice.reason}</small>
              </div>
            ))}
          </div>
        </>
      )}

      {result && result.reasonCodes.length > 0 && (
        <>
          {/*
            Blocking reasons first, and labelled as blocking. The difference
            between "this is why there is no number" and "this is worth knowing"
            is the difference between work and noise, and the person reading
            should not have to infer which is which.
          */}
          {blocking.length > 0 && <h2>Why there is no number</h2>}
          {blocking.map((code) => {
            const def = (REASONS as Record<string, ReasonDefinition>)[code];
            if (!def) return null;
            const blocker = detail?.blockers.find((b) => b.code === code);
            return (
              <div className={`reason ${def.severity}`} key={code}>
                <div className="what">{def.short}</div>
                {/* Naming the actual records is the difference between telling
                    somebody there is a problem and telling them what to do. */}
                <div className="do">{blocker?.resolution ?? def.action}</div>
              </div>
            );
          })}

          {detail?.ifCleared?.quantity != null && (
            <div className="banner">
              If that were settled the position would be{' '}
              <strong>{detail.ifCleared.quantity.toLocaleString('en-GB')}</strong>
              {detail.ifCleared.assuming.length > 0 && (
                <>
                  , assuming {detail.ifCleared.assuming.join('; and ')}. That assumption has not
                  been made and the figure is not recorded anywhere.
                </>
              )}
            </div>
          )}

          {caveats.length > 0 && <h2>Worth knowing</h2>}
          {caveats.map((code) => {
            const def = (REASONS as Record<string, ReasonDefinition>)[code];
            if (!def) return null;
            return (
              <div className={`reason ${def.severity}`} key={code}>
                <div className="what">{def.short}</div>
                <div className="do">{def.action}</div>
              </div>
            );
          })}
        </>
      )}

      <h2>Everything that happened</h2>
      {timeline.length === 0 ? (
        <p className="empty">Nothing recorded against this item yet.</p>
      ) : (
        <div className="timeline">
          {timeline.map((e, i) => {
            const delay = e.kind === 'movement' ? lag(e.at, e.recordedAt) : null;
            return (
              <div className={`entry ${e.kind}`} key={i}>
                <div className="top">
                  <span className="when">{fmtTime(e.at)}</span>
                  <span className="what">{e.label}</span>
                  <span className="qty">{e.quantity}</span>
                </div>
                {e.detail && <div className="note">{e.detail}</div>}
                {e.actor && <div className="note">{e.actor}</div>}
                {/*
                  The awkward chronology is the point. A delivery that arrived
                  before a count but was keyed in afterwards is exactly what
                  stops a number being stateable, so it is shown rather than
                  smoothed over.
                */}
                {delay && <div className="lag">{delay}</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
