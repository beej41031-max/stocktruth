'use client';

import { FormEvent, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Overview'],
  [/^\/reconcile/, 'Issues'],
  [/^\/items\//, 'Item evidence'],
  [/^\/items/, 'Items'],
  [/^\/movements/, 'Movements'],
  [/^\/count/, 'Counts'],
  [/^\/audit/, 'Audit'],
  [/^\/stress/, 'Stress'],
  [/^\/system/, 'System'],
];

export default function TopBar() {
  const path = usePathname();
  const router = useRouter();
  const [q, setQ] = useState('');
  const title = TITLES.find(([rx]) => rx.test(path))?.[1] ?? 'StockTruth';

  function search(e: FormEvent) {
    e.preventDefault();
    const value = q.trim();
    router.push(value ? `/items?q=${encodeURIComponent(value)}` : '/items');
  }

  return (
    <header className="topbar">
      <div className="topbar-context">
        <span className="eyebrow">Operational evidence</span>
        <strong>{title}</strong>
      </div>
      <form className="global-search" onSubmit={search}>
        <label className="sr-only" htmlFor="global-search">Find an item</label>
        <input
          id="global-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find SKU or item"
        />
        <button type="submit" className="search-button">Find</button>
      </form>
      <div className="topbar-badge">
        <span className="live-dot" aria-hidden="true" />
        Demo data
      </div>
    </header>
  );
}
