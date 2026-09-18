'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const GROUPS: [string, [string, string, string][]][] = [
  [
    'Operate',
    [
      ['/', 'Overview', '01'],
      ['/reconcile', 'Issues', '02'],
      ['/items', 'Items', '03'],
      ['/movements', 'Movements', '04'],
      ['/count', 'Counts', '05'],
    ],
  ],
  [
    'Evidence',
    [
      ['/audit', 'Audit', '06'],
      ['/stress', 'Stress', '07'],
      ['/system', 'System', '08'],
    ],
  ],
];

export default function Nav() {
  const path = usePathname();

  const active = (href: string) => href === '/' ? path === '/' : path.startsWith(href);

  return (
    <aside className="rail">
      <div className="brand-block">
        <Link href="/" className="wordmark" aria-label="StockTruth overview">
          Stock<span>Truth</span>
        </Link>
        <p className="tagline">Inventory evidence, not inventory theatre.</p>
        <div className="demo-mark">DEMO / INVENTED DATA</div>
      </div>

      <div className="rail-groups">
        {GROUPS.map(([group, links]) => (
          <section className="rail-group" key={group}>
            <div className="group">{group}</div>
            <nav>
              {links.map(([href, label, index]) => (
                <Link key={href} href={href} aria-current={active(href) ? 'page' : undefined}>
                  <span className="nav-index">{index}</span>
                  <span>{label}</span>
                </Link>
              ))}
            </nav>
          </section>
        ))}
      </div>

      <div className="rail-foot">
        <div><span className="live-dot" aria-hidden="true" /> Engine online</div>
        <div className="rail-meta">v0.1.1 / evidence-first</div>
      </div>
    </aside>
  );
}
