'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import Status from '../components/Status';

type Row = {
  itemId: string;
  sku: string | null;
  name: string;
  stockUnit: string;
  locationCode: string | null;
  state: string | null;
  bookQuantity: string | null;
  physicalQuantity: string | null;
  physicalCountedAt: string | null;
  derivedQuantity: string | null;
  varianceAtCount: string | null;
  reasonCodes: string[] | null;
};

const STATES = ['ALL', 'VERIFIED', 'PROVISIONAL', 'STALE', 'INCOMPLETE', 'CONFLICT', 'UNVERIFIED'] as const;
const RISK: Record<string, number> = { CONFLICT: 0, INCOMPLETE: 1, UNVERIFIED: 2, STALE: 3, PROVISIONAL: 4, VERIFIED: 5 };

const age = (iso: string | null) => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
};

export default function ItemsClient({ rows, initialQuery = '', initialState = 'ALL' }: { rows: Row[]; initialQuery?: string; initialState?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState(STATES.includes(initialState as (typeof STATES)[number]) ? initialState : 'ALL');
  const [sort, setSort] = useState('risk');
  const [compact, setCompact] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => state === 'ALL' || (r.state ?? 'UNVERIFIED') === state)
      .filter((r) => !q || [r.sku, r.name, r.locationCode, ...(r.reasonCodes ?? [])].filter(Boolean).some((x) => String(x).toLowerCase().includes(q)))
      .sort((a, b) => {
        if (sort === 'sku') return String(a.sku ?? '').localeCompare(String(b.sku ?? ''));
        if (sort === 'quantity') return Number(b.derivedQuantity ?? -Infinity) - Number(a.derivedQuantity ?? -Infinity);
        const ar = RISK[a.state ?? 'UNVERIFIED'] ?? 99;
        const br = RISK[b.state ?? 'UNVERIFIED'] ?? 99;
        return ar - br || String(a.sku ?? '').localeCompare(String(b.sku ?? ''));
      });
  }, [rows, query, state, sort]);

  const counts = Object.fromEntries(STATES.slice(1).map((s) => [s, rows.filter((r) => (r.state ?? 'UNVERIFIED') === s).length]));

  return (
    <>
      <div className="item-state-strip">
        {STATES.slice(1).map((s) => <button key={s} type="button" className={state === s ? `state-filter sf-${s} active` : `state-filter sf-${s}`} onClick={() => setState(state === s ? 'ALL' : s)}><span>{counts[s]}</span><small>{s.toLowerCase()}</small></button>)}
      </div>

      <div className="data-toolbar">
        <input type="search" placeholder="Search SKU, name, location or reason" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort items">
          <option value="risk">Highest risk first</option>
          <option value="sku">SKU</option>
          <option value="quantity">Current quantity</option>
        </select>
        <button type="button" className="button-secondary" onClick={() => setCompact((v) => !v)}>{compact ? 'Comfortable' : 'Compact'}</button>
      </div>

      <div className="table-frame">
        <table className={compact ? 'data-table compact-table' : 'data-table'}>
          <thead><tr><th>Item</th><th>Location</th><th>Evidence state</th><th className="num">Book</th><th className="num">Counted</th><th className="num">Current</th><th>Last count</th><th>Flags</th></tr></thead>
          <tbody>
            {visible.map((r) => (
              <tr key={`${r.itemId}-${r.locationCode ?? 'none'}`}>
                <td><Link href={`/items/${r.itemId}`} className="item-link"><strong className="code">{r.sku ?? '(no code)'}</strong><span>{r.name}</span></Link></td>
                <td><span className="location-tag">{r.locationCode ?? '—'}</span></td>
                <td><Status state={r.state} /></td>
                <td className="num subtle-number">{r.bookQuantity ?? '—'}</td>
                <td className="num subtle-number">{r.physicalQuantity ?? '—'}</td>
                <td className={`num current-number ${r.derivedQuantity == null ? 'refused-number' : ''}`}>{r.derivedQuantity ?? 'NOT STATED'}</td>
                <td className="muted-cell">{age(r.physicalCountedAt)}</td>
                <td><div className="reason-pills">{(r.reasonCodes ?? []).slice(0, 2).map((code) => <span key={code}>{code.replaceAll('_', ' ')}</span>)}{(r.reasonCodes?.length ?? 0) > 2 && <span>+{(r.reasonCodes?.length ?? 0) - 2}</span>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <div className="empty-inline">Nothing matches that view.</div>}
      </div>
      <div className="table-foot"><span>{visible.length} of {rows.length} positions</span><span>Current is deliberately blank only when the engine will not defend a figure.</span></div>
    </>
  );
}
