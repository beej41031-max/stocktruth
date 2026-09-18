'use client';

import { useRef, useState, useTransition } from 'react';
import {
  lookupCode,
  revealAfterCount,
  saveCount,
  startSession,
  type LookupResult,
  type RevealResult,
} from './actions';

/**
 * The counting screen.
 *
 * Written for someone standing at a rack with a scanner, so Enter moves
 * forward and nothing needs a mouse. A keyboard-wedge scanner types the code
 * and presses Enter, which is why the code field submits rather than the form.
 *
 * Two deliberate pieces of restraint.
 *
 * The expected quantity is not shown before counting, and is not sent to the
 * browser at all, because a number in the page source is a number somebody can
 * read. A count that was shown the answer is not evidence, it is agreement.
 *
 * And after saving, this reports a difference, not a discrepancy. At the rack
 * nobody knows whether a gap is shrinkage, a late delivery or a bad book
 * figure. That is the engine's job later, with the movements in front of it.
 */

interface Props {
  siteId: string;
  siteName: string;
  locations: { id: string; code: string; name: string | null }[];
  openSession: { id: string; name: string | null; started_at: string } | null;
  recent: {
    id: string;
    sku: string | null;
    name: string;
    quantity: string;
    unit: string;
    code: string | null;
    counted_at: string;
  }[];
}

export default function CountClient({ siteId, siteName, locations, openSession, recent }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(openSession?.id ?? null);
  const [locationId, setLocationId] = useState<string>(locations[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [qty, setQty] = useState('');
  const [saved, setSaved] = useState<{
    message: string;
    item: string;
    quantity: number;
    unit: string;
    reveal: RevealResult | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const codeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  // One id per physical count, generated before the first attempt so a retry
  // reuses it. This is what makes a dropped connection harmless.
  const eventId = useRef<string>(crypto.randomUUID());

  function reset() {
    setCode('');
    setQty('');
    setLookup(null);
    setError(null);
    eventId.current = crypto.randomUUID();
    codeRef.current?.focus();
  }

  function onScan() {
    if (!code.trim()) return;
    setError(null);
    start(async () => {
      const res = await lookupCode(siteId, code);
      setLookup(res);
      if (res.status === 'found') setTimeout(() => qtyRef.current?.focus(), 0);
    });
  }

  function onSave() {
    if (!lookup?.item || !sessionId) return;
    const n = Number(qty);
    if (qty === '' || !Number.isFinite(n)) {
      setError('Enter a quantity. Zero is fine; blank is not.');
      return;
    }

    start(async () => {
      const res = await saveCount({
        siteId,
        sessionId,
        itemId: lookup.item!.id,
        locationId: locationId || null,
        quantity: n,
        unit: lookup.item!.stockUnit,
        clientEventId: eventId.current,
        // The device's own clock, sent as-is. If it is wrong, that is
        // something the engine should see rather than something this screen
        // should quietly correct.
        countedAt: new Date().toISOString(),
      });

      if (res.status === 'refused') {
        setError(res.message);
        return;
      }

      // Only now. The count is written and cannot be changed by what comes back.
      const reveal = await revealAfterCount(siteId, lookup.item!.id, n);

      setSaved({
        message: res.message,
        item: `${lookup.item!.sku ?? ''} ${lookup.item!.name}`.trim(),
        quantity: n,
        unit: lookup.item!.stockUnit,
        reveal,
      });
      reset();
    });
  }

  if (!sessionId) {
    return (
      <>
        <h1>Count</h1>
        <p className="sub">
          {siteName}. Starting a session records where the movement feed had got to, so a
          delivery that lands while you are counting can be told apart from one that was already
          on the shelf.
        </p>
        <button
          onClick={() =>
            start(async () => {
              const id = await startSession(siteId, new Date().toLocaleDateString('en-GB'));
              setSessionId(id);
            })
          }
          disabled={pending}
        >
          {pending ? 'Starting' : 'Start counting'}
        </button>
      </>
    );
  }

  return (
    <>
      <h1>Count</h1>
      <p className="sub">{siteName}</p>

      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="loc">Where you are</label>
        <select id="loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">No location</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} {l.name ? `· ${l.name}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="code">Scan or type the code</label>
        <input
          id="code"
          ref={codeRef}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onScan();
            }
          }}
          onBlur={onScan}
        />
      </div>

      {lookup?.status === 'unknown' && (
        <div className="reason high">
          <div className="what">{lookup.message}</div>
          <div className="do">
            Nothing has been recorded. Check the label, or add the code to the catalogue first.
          </div>
        </div>
      )}

      {lookup?.status === 'blocked' && (
        <div className="reason high">
          <div className="what">This code cannot be counted</div>
          <div className="do">{lookup.message}</div>
        </div>
      )}

      {lookup?.status === 'ambiguous' && (
        <div className="reason high">
          <div className="what">{lookup.message}</div>
          <div className="do">
            {lookup.candidates?.map((c) => (
              <div key={c.id}>
                {c.sku} · {c.name}
              </div>
            ))}
          </div>
        </div>
      )}

      {lookup?.status === 'found' && lookup.item && (
        <div style={{ maxWidth: 420 }}>
          <p className="sub" style={{ marginTop: 4 }}>
            <span className="code">{lookup.item.sku}</span> · {lookup.item.name}
          </p>

          {lookup.blind ? (
            <p className="sub">
              Counting blind. You will see what the records say once you have entered a
              number, not before.
            </p>
          ) : (
            <div className="truth" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <div className="label">Book says</div>
                {lookup.book != null ? (
                  <>
                    <div className="value">{lookup.book.quantity}</div>
                    <div className="when">
                      {lookup.book.asOf
                        ? `as at ${new Date(lookup.book.asOf).toLocaleDateString('en-GB')}`
                        : 'no date given'}
                    </div>
                  </>
                ) : (
                  <div className="value refused none">No book figure</div>
                )}
              </div>
              <div>
                <div className="label">Last counted</div>
                {lookup.lastCount != null ? (
                  <>
                    <div className="value">{lookup.lastCount.quantity}</div>
                    <div className="when">
                      {new Date(lookup.lastCount.countedAt).toLocaleDateString('en-GB')}
                    </div>
                  </>
                ) : (
                  <div className="value refused none">Never</div>
                )}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="qty">How many are there, in {lookup.item.stockUnit}</label>
            <input
              id="qty"
              ref={qtyRef}
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onSave();
                }
              }}
            />
          </div>

          {error && (
            <div className="reason high">
              <div className="what">{error}</div>
            </div>
          )}

          <button onClick={onSave} disabled={pending}>
            {pending ? 'Saving' : 'Save count'}
          </button>
        </div>
      )}

      {saved && (
        <div className="receipt-wrap">
          {/*
            The one physical accessory in this system. A count is a physical
            observation, and this is the moment it gets confirmed, so it gets
            the one printed-paper treatment rather than another dark panel.
            Everything on it is real: the numbers came back from the server
            just now, nothing here is templated copy.
          */}
          <div className="receipt">
            <div className="receipt-brand">StockTruth &middot; count receipt</div>
            <div className="receipt-rule" />
            <div className="receipt-item">{saved.item}</div>

            <div className="receipt-row">
              <span>counted</span>
              <span className="receipt-num">
                {saved.quantity.toLocaleString()} {saved.unit}
              </span>
            </div>

            {saved.reveal?.book != null ? (
              <>
                <div className="receipt-row">
                  <span>records said</span>
                  <span className="receipt-num">{saved.reveal.book.quantity.toLocaleString()}</span>
                </div>
                <div className="receipt-row">
                  <span>difference</span>
                  <span className="receipt-num">
                    {saved.reveal.difference! > 0 ? '+' : ''}
                    {saved.reveal.difference!.toLocaleString()}
                  </span>
                </div>
                {saved.reveal.difference !== 0 && (
                  <p className="receipt-note">
                    Those two disagree. Whether that means anything depends on what moved
                    between the book date and now. No adjustment has been made.
                  </p>
                )}
              </>
            ) : (
              <p className="receipt-note">Nothing on record to compare it against yet.</p>
            )}

            <div className="receipt-rule" />
            <div className="receipt-foot">{saved.message}</div>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <>
          <h2>Counted in this session</h2>
          <table>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="code">{r.sku}</td>
                  <td className="dim">{r.name}</td>
                  <td className="num">
                    {r.quantity} {r.unit}
                  </td>
                  <td className="dim">{r.code ?? 'no location'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
