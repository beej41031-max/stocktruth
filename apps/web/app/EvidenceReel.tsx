'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CanonicalExample } from '@/lib/canonical-example';

/**
 * The hero. One orchestrated sequence, played once, built entirely from real
 * numbers the engine actually produced.
 *
 * Every value here — the book figure, the count, the timestamps, the gap in
 * hours, the reason, the resolution — is a prop computed server-side by
 * running the real engine against the real database. There is no scripted
 * dialogue. If the seed data changes, the story this tells changes with it.
 *
 * The clock is the device carrying the idea: knowledge is timestamped, and
 * more evidence arriving is not the same as more certainty.
 */

const STEP_MS = 1500;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}


export default function EvidenceReel({ data }: { data: CanonicalExample }) {
  const { count, book, lateMovement, asOfBeforeLateMovement, now, operational } = data;
  const playable = count != null && lateMovement != null && asOfBeforeLateMovement != null;

  const [step, setStep] = useState(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (!playable) return;
    if (reduced.current) {
      setStep(5);
      return;
    }

    const timers = [1, 2, 3, 4, 5].map((s) => setTimeout(() => setStep(s), s * STEP_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playable]);

  function replay() {
    setStep(0);
    setTimeout(() => {
      [1, 2, 3, 4, 5].forEach((s) => setTimeout(() => setStep(s), s * STEP_MS));
    }, 50);
  }

  if (!playable) {
    // No spanning movement in this dataset. Show the item plainly rather than
    // forcing a story that is not there.
    return (
      <div className="reel">
        <div className="reel-head">
          <span className="reel-item">{data.sku}</span>
          <span className="reel-sub">{data.name}</span>
        </div>
        <p className="sub">
          Book {book?.quantity ?? '—'} · counted {count?.quantity ?? '—'}. Nothing currently
          disputes the figure.
        </p>
      </div>
    );
  }

  const blocker = now.blockers[0];
  const finalState = now.state;

  return (
    <div className="reel">
      <div className="reel-head">
        <span className="reel-item">{data.sku}</span>
        <span className="reel-sub">{data.name}</span>
      </div>

      <div className="reel-body">
        <div className={`reel-row ${step >= 1 ? 'in' : ''}`}>
          <span className="reel-clock">{fmtClock(count.countedAt)}</span>
          <span className="reel-line">
            {count.by ?? 'Someone'} counts {count.location ?? 'the floor'}.{' '}
            <strong>{count.quantity.toLocaleString()}</strong> {data.unit}.
          </span>
        </div>

        <div className={`reel-row ${step >= 2 ? 'in' : ''}`}>
          <span className="reel-clock" />
          <span className="reel-line dim">
            Book claimed {book?.quantity.toLocaleString() ?? 'nothing'}
            {book?.asOf ? `, as at ${fmtTime(book.asOf)}` : ''}.
          </span>
        </div>

        <div className={`reel-verdict ${step >= 3 ? 'in' : ''}`}>
          <span className="reel-tag">as known then</span>
          <span className={`reel-state st-${asOfBeforeLateMovement.state}`}>
            {asOfBeforeLateMovement.state?.toLowerCase()}
          </span>
          <span className="reel-qty">{asOfBeforeLateMovement.quantity?.toLocaleString()}</span>
        </div>

        <div className={`reel-row late ${step >= 4 ? 'in' : ''}`}>
          <span className="reel-clock">{fmtClock(lateMovement.recordedAt)}</span>
          <span className="reel-line">
            A receipt lands. <strong>{lateMovement.quantity.toLocaleString()}</strong>, occurred{' '}
            {fmtClock(lateMovement.occurredAt)}, {lateMovement.gapHours}{' '}
            {lateMovement.gapHours === 1 ? 'hour' : 'hours'} before that was recorded.
          </span>
        </div>

        <div className={`reel-verdict now ${step >= 5 ? 'in' : ''}`}>
          <span className="reel-tag">as known now</span>
          <span className={`reel-state st-${finalState}`}>
            {finalState === 'INCOMPLETE' || finalState === 'CONFLICT'
              ? 'cannot be stated'
              : finalState.toLowerCase()}
          </span>
        </div>

        {blocker && <p className={`reel-why ${step >= 5 ? 'in' : ''}`}>{blocker.resolution}</p>}

        {step >= 5 && operational.lowerBound != null && operational.upperBound != null && operational.exactQuantity == null && (
          <div className="reel-operational">
            <span className="reel-tag">safe operational reading</span>
            <strong>{operational.lowerBound.toLocaleString()}–{operational.upperBound.toLocaleString()}</strong>
            <span>
              {operational.omittedStockExposure
                ? `+${operational.omittedStockExposure.toLocaleString()} possible omitted stock · `
                : operational.phantomStockExposure
                  ? `${operational.phantomStockExposure.toLocaleString()} possible phantom stock · `
                  : ''}
              allocate up to {operational.lowerBound.toLocaleString()}; verify before purchasing or financial use
            </span>
          </div>
        )}
      </div>

      <div className="reel-actions">
        <button className="quiet" onClick={replay}>
          Replay
        </button>
        <Link href={`/items/${data.itemId}`} className="reel-link">
          See the full record
        </Link>
      </div>
    </div>
  );
}
