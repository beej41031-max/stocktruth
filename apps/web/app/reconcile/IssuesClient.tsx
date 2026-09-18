'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import ResolveForm from './ResolveForm';

type Issue = {
  id: string;
  code: string;
  severity: 'high' | 'medium' | 'low';
  itemId: string | null;
  sku: string | null;
  itemName: string | null;
  locationCode: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  state: string | null;
  bookQuantity: string | null;
  physicalQuantity: string | null;
  derivedQuantity: string | null;
  short: string;
  action: string;
  blocks: boolean;
};

const FILTERS = [
  ['all', 'All'],
  ['blocking', 'Blocking'],
  ['warning', 'Warnings'],
  ['identity', 'Identity'],
  ['timing', 'Timing'],
  ['missing', 'Missing data'],
] as const;

function matchesFamily(issue: Issue, filter: string) {
  if (filter === 'all') return true;
  if (filter === 'blocking') return issue.blocks;
  if (filter === 'warning') return !issue.blocks;
  if (filter === 'identity') return /BLOCKED|BARCODE|AMBIGUOUS|UNIT/.test(issue.code);
  if (filter === 'timing') return /COUNT|CLOCK|SPAN|DATE|STALE/.test(issue.code);
  if (filter === 'missing') return /NO_|UNLINKED|UNMATCHED|UNVERIFIED|NEVER/.test(issue.code);
  return true;
}

const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function IssuesClient({ issues, initialCode }: { issues: Issue[]; initialCode?: string }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const seeded = issues.find((i) => i.code === initialCode) ?? issues[0] ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(seeded?.id ?? null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((issue) => {
      if (!matchesFamily(issue, filter)) return false;
      if (!q) return true;
      return [issue.sku, issue.itemName, issue.locationCode, issue.short, issue.code]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(q));
    });
  }, [issues, filter, query]);

  const selected = issues.find((i) => i.id === selectedId) ?? visible[0] ?? null;
  const blocking = issues.filter((i) => i.blocks).length;
  const warnings = issues.length - blocking;

  return (
    <>
      <div className="queue-summary">
        <div><span>Open</span><strong>{issues.length}</strong></div>
        <div><span>Blocking</span><strong className="danger-text">{blocking}</strong></div>
        <div><span>Warnings</span><strong className="warn-text">{warnings}</strong></div>
        <div><span>Selected</span><strong>{selected?.sku ?? '—'}</strong></div>
      </div>

      <div className="queue-toolbar">
        <div className="filter-chips" role="group" aria-label="Filter issues">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? 'filter-chip active' : 'filter-chip'} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
        <input className="queue-search" type="search" placeholder="Find item, code or reason" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="issue-console">
        <section className="issue-list" aria-label="Open issues">
          <div className="issue-list-head"><span>{visible.length} shown</span><span>Evidence queue</span></div>
          {visible.length === 0 ? <div className="empty-inline">Nothing matches that filter.</div> : visible.map((issue) => (
            <button key={issue.id} type="button" className={selected?.id === issue.id ? 'issue-row selected' : 'issue-row'} onClick={() => setSelectedId(issue.id)}>
              <span className={`severity-rail ${issue.blocks ? 'blocking' : 'warning'}`} />
              <span className="issue-main">
                <span className="issue-code-line"><strong>{issue.sku ?? 'SITE-WIDE'}</strong><small>{issue.locationCode ?? 'all locations'}</small></span>
                <span className="issue-short">{issue.short}</span>
              </span>
              <span className="issue-state">{issue.blocks ? 'BLOCKS NUMBER' : 'CAVEAT'}</span>
            </button>
          ))}
        </section>

        <section className="issue-detail" aria-live="polite">
          {!selected ? <div className="empty-state compact"><span>NO SELECTION</span><h2>Choose an issue.</h2></div> : (
            <>
              <div className="detail-kicker"><span>{selected.blocks ? 'BLOCKING EVIDENCE' : 'EVIDENCE CAVEAT'}</span><span>{selected.code}</span></div>
              <div className="detail-title-row">
                <div>
                  <h2>{selected.short}</h2>
                  <p>{selected.sku ?? 'Site-wide'}{selected.locationCode ? ` / ${selected.locationCode}` : ''}</p>
                </div>
                <span className={selected.blocks ? 'verdict verdict-bad' : 'verdict verdict-warn'}>{selected.blocks ? 'NUMBER WITHHELD' : 'NUMBER DEGRADED'}</span>
              </div>

              <div className="issue-numbers">
                <div><span>Book</span><strong>{selected.bookQuantity ?? '—'}</strong></div>
                <div><span>Counted</span><strong>{selected.physicalQuantity ?? '—'}</strong></div>
                <div className={selected.derivedQuantity == null ? 'refused-cell' : ''}><span>Current</span><strong>{selected.derivedQuantity ?? 'NOT STATED'}</strong></div>
              </div>

              <div className="detail-section">
                <span className="eyebrow">Why this matters</span>
                <p className="detail-copy">{selected.action}</p>
              </div>

              <div className="detail-section evidence-mini">
                <span className="eyebrow">Evidence record</span>
                <dl>
                  <div><dt>First seen</dt><dd>{fmt(selected.firstSeenAt)}</dd></div>
                  <div><dt>Last seen</dt><dd>{fmt(selected.lastSeenAt)}</dd></div>
                  <div><dt>Engine state</dt><dd>{selected.state ?? '—'}</dd></div>
                  <div><dt>Severity</dt><dd>{selected.severity}</dd></div>
                </dl>
              </div>

              <div className="detail-actions">
                {selected.itemId && <Link href={`/items/${selected.itemId}`} className="button-secondary">Inspect item evidence</Link>}
                <ResolveForm issueId={selected.id} />
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
