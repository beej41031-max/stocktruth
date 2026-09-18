'use client';

import { useRef, useState, useTransition } from 'react';
import { lookupCode, revealAfterCount, saveCount, startSession, type LookupResult, type RevealResult } from './actions';

interface Props {
  siteId: string;
  siteName: string;
  locations: { id: string; code: string; name: string | null }[];
  openSession: { id: string; name: string | null; started_at: string } | null;
  recent: { id: string; sku: string | null; name: string; quantity: string; unit: string; code: string | null; counted_at: string }[];
}

export default function CountClient({ siteId, siteName, locations, openSession, recent }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(openSession?.id ?? null);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [code, setCode] = useState('');
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [qty, setQty] = useState('');
  const [saved, setSaved] = useState<{ message: string; item: string; quantity: number; unit: string; reveal: RevealResult | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const codeRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const eventId = useRef<string>(crypto.randomUUID());

  function reset() {
    setCode(''); setQty(''); setLookup(null); setError(null); eventId.current = crypto.randomUUID();
    setTimeout(() => codeRef.current?.focus(), 0);
  }

  function scan() {
    if (!code.trim()) return;
    setError(null);
    start(async () => {
      const res = await lookupCode(siteId, code);
      setLookup(res);
      if (res.status === 'found') setTimeout(() => qtyRef.current?.focus(), 0);
    });
  }

  function save() {
    if (!lookup?.item || !sessionId) return;
    const n = Number(qty);
    if (qty === '' || !Number.isFinite(n)) { setError('Enter a quantity. Zero is evidence; blank is not.'); return; }
    start(async () => {
      const res = await saveCount({ siteId, sessionId, itemId: lookup.item!.id, locationId: locationId || null, quantity: n, unit: lookup.item!.stockUnit, clientEventId: eventId.current, countedAt: new Date().toISOString() });
      if (res.status === 'refused') { setError(res.message); return; }
      const reveal = await revealAfterCount(siteId, lookup.item!.id, n);
      setSaved({ message: res.message, item: `${lookup.item!.sku ?? ''} ${lookup.item!.name}`.trim(), quantity: n, unit: lookup.item!.stockUnit, reveal });
      reset();
    });
  }

  if (!sessionId) return (
    <div className="count-stage start-stage">
      <div className="count-stage-label">FIELD MODE / {siteName}</div>
      <h1>Start a blind count.</h1>
      <p>Starting a session freezes the movement-feed watermark. That is what lets StockTruth tell a delivery that arrived during the count from one that was already on the shelf.</p>
      <button className="primary-large" onClick={() => start(async () => setSessionId(await startSession(siteId, new Date().toLocaleDateString('en-GB'))))} disabled={pending}>{pending ? 'Starting sessionâ€¦' : 'Start counting'}</button>
    </div>
  );

  return (
    <>
      <section className="page-intro count-intro"><div><div className="kicker">Field instrument / blind count</div><h1>Look at the shelf.<br /><span>Not the answer.</span></h1><p className="lede">Expected quantity stays out of the browser until the observation is saved. A count shown the answer first is agreement, not evidence.</p></div><div className="blind-badge"><span>BLIND</span><strong>Book hidden</strong><small>until submission</small></div></section>

      <div className="count-workbench">
        <section className="count-panel">
          <div className="count-step"><span>01</span><div><strong>Location</strong><small>Where are you standing?</small></div></div>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">No location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` / ${l.name}` : ''}</option>)}</select>

          <div className="count-step"><span>02</span><div><strong>Identify</strong><small>Scanner wedge or keyboard both work.</small></div></div>
          <input className="scan-input" ref={codeRef} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scan(); } }} placeholder="SCAN OR TYPE CODE" autoComplete="off" autoCapitalize="off" spellCheck={false} />

          {lookup?.status === 'unknown' && <Message title={lookup.message ?? "Code not found"} body="Nothing recorded. Check the label or add the code to the catalogue first." />}
          {lookup?.status === 'blocked' && <Message title="This code cannot be counted" body={lookup.message} />}
          {lookup?.status === 'ambiguous' && <Message title={lookup.message ?? "More than one item matches"} body={(lookup.candidates ?? []).map((c) => `${c.sku} / ${c.name}`).join(' Â· ')} />}

          {lookup?.status === 'found' && lookup.item && <div className="count-found">
            <div className="found-id"><span className="code">{lookup.item.sku}</span><strong>{lookup.item.name}</strong><small>{lookup.item.stockUnit}</small></div>
            <div className="blind-note"><span className="live-dot" /> Expected quantity is intentionally withheld.</div>
            <div className="count-step"><span>03</span><div><strong>Observe</strong><small>Enter what is physically there.</small></div></div>
            <div className="qty-entry"><input ref={qtyRef} type="number" inputMode="decimal" step="any" min="0" value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} placeholder="0" /><span>{lookup.item.stockUnit}</span></div>
            {error && <Message title={error} />}
            <button className="primary-large" onClick={save} disabled={pending}>{pending ? 'Recording evidenceâ€¦' : 'Record count'}</button>
          </div>}
        </section>

        <aside className="count-side">
          <span className="eyebrow">Session</span><strong>{openSession?.name ?? 'Open count'}</strong><p>{recent.length} recent observations shown below. The expected quantity is not part of this workflow.</p>
          <div className="count-principle"><span>WHY BLIND?</span><p>Anchoring is real. Hiding the book figure makes the physical count independent evidence instead of a confirmation exercise.</p></div>
        </aside>
      </div>

      {saved && <section className="count-result"><div className="result-stamp">RECORDED</div><div><span className="eyebrow">Observation saved</span><h2>{saved.item}</h2><p>{saved.message}</p></div><div className="result-metrics"><div><span>You counted</span><strong>{saved.quantity}</strong></div><div><span>Book said</span><strong>{saved.reveal?.book?.quantity ?? 'â€”'}</strong></div><div><span>Difference</span><strong>{saved.reveal?.difference == null ? 'â€”' : `${saved.reveal.difference > 0 ? '+' : ''}${saved.reveal.difference}`}</strong></div></div><p className="result-note">A difference is not automatically shrinkage. Reconciliation decides what the evidence can support after movements are considered.</p></section>}

      {recent.length > 0 && <section className="section-block"><div className="section-heading"><div><span className="eyebrow">Recent observations</span><h2>Counted in this session</h2></div></div><div className="recent-counts">{recent.map((r) => <div key={r.id}><span className="code">{r.sku}</span><strong>{r.quantity} {r.unit}</strong><small>{r.name} / {r.code ?? 'no location'}</small></div>)}</div></section>}
    </>
  );
}

function Message({ title, body }: { title: string; body?: string }) {
  return <div className="field-message"><strong>{title}</strong>{body && <p>{body}</p>}</div>;
}
