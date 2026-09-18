'use client';

import { useMemo, useState } from 'react';

type Row = {
  id: string;
  movementType: string;
  quantity: string;
  unit: string;
  occurredAt: string | null;
  recordedAt: string | null;
  importedAt: string;
  sku: string | null;
  itemName: string | null;
  locationCode: string | null;
  sourceReference: string | null;
  sourceName: string | null;
  rawCode: string | null;
};

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const lag = (r: Row) => r.occurredAt && r.recordedAt ? Math.round((new Date(r.recordedAt).getTime() - new Date(r.occurredAt).getTime()) / 60_000) : null;

function risk(r: Row) {
  if (!r.sku) return 'unlinked';
  if (!r.occurredAt) return 'undated';
  const m = lag(r);
  if (m != null && Math.abs(m) >= 60) return 'late';
  return 'normal';
}

export default function MovementsClient({ rows }: { rows: Row[] }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const visible = useMemo(() => rows.filter((r) => {
    if (filter !== 'all' && risk(r) !== filter) return false;
    const query = q.trim().toLowerCase();
    return !query || [r.sku, r.itemName, r.rawCode, r.sourceReference, r.movementType, r.locationCode].filter(Boolean).some((x) => String(x).toLowerCase().includes(query));
  }), [rows, filter, q]);

  const count = (kind: string) => rows.filter((r) => risk(r) === kind).length;

  return (
    <>
      <div className="movement-radar">
        <button className={filter === 'unlinked' ? 'radar-stat active danger-stat' : 'radar-stat danger-stat'} onClick={() => setFilter(filter === 'unlinked' ? 'all' : 'unlinked')}><span>UNLINKED</span><strong>{count('unlinked')}</strong><small>identity unresolved</small></button>
        <button className={filter === 'undated' ? 'radar-stat active warn-stat' : 'radar-stat warn-stat'} onClick={() => setFilter(filter === 'undated' ? 'all' : 'undated')}><span>UNDATED</span><strong>{count('undated')}</strong><small>cannot place in time</small></button>
        <button className={filter === 'late' ? 'radar-stat active warn-stat' : 'radar-stat warn-stat'} onClick={() => setFilter(filter === 'late' ? 'all' : 'late')}><span>LATE RECORDED</span><strong>{count('late')}</strong><small>60+ minute lag</small></button>
        <button className={filter === 'normal' ? 'radar-stat active' : 'radar-stat'} onClick={() => setFilter(filter === 'normal' ? 'all' : 'normal')}><span>NORMAL</span><strong>{count('normal')}</strong><small>chronology intact</small></button>
      </div>

      <div className="data-toolbar"><input type="search" placeholder="Search movement, SKU, source reference" value={q} onChange={(e) => setQ(e.target.value)} /><button className="button-secondary" type="button" onClick={() => { setFilter('all'); setQ(''); }}>Reset</button></div>

      <div className="table-frame">
        <table className="data-table movement-table">
          <thead><tr><th>Occurred</th><th>Recorded</th><th>Lag</th><th>Item / source code</th><th>Movement</th><th className="num">Quantity</th><th>Location</th><th>Reference</th></tr></thead>
          <tbody>{visible.map((m) => {
            const mins = lag(m);
            const kind = risk(m);
            return <tr key={m.id} className={`movement-row risk-${kind}`}>
              <td className={m.occurredAt ? 'mono-cell' : 'danger-text'}>{m.occurredAt ? fmt(m.occurredAt) : 'NO DATE'}</td>
              <td className="mono-cell muted-cell">{fmt(m.recordedAt)}</td>
              <td><span className={`lag-chip lag-${kind}`}>{mins == null ? '—' : Math.abs(mins) < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`}</span></td>
              <td><strong className="code">{m.sku ?? m.rawCode ?? 'UNLINKED'}</strong><small className="block-note">{m.itemName ?? 'No item match'}</small></td>
              <td><span className="movement-type">{m.movementType.replaceAll('_', ' ').toLowerCase()}</span></td>
              <td className="num current-number">{m.quantity} <small>{m.unit}</small></td>
              <td><span className="location-tag">{m.locationCode ?? '—'}</span></td>
              <td className="muted-cell">{m.sourceReference ?? m.sourceName ?? '—'}</td>
            </tr>;
          })}</tbody>
        </table>
        {!visible.length && <div className="empty-inline">Nothing matches that movement view.</div>}
      </div>
    </>
  );
}
