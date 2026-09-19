'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Two groups, because the people using them are different.
 *
 * Someone counting stock opens this on a phone at a rack and wants one thing.
 * Someone deciding whether to believe the numbers sits at a desk and wants
 * everything else. Mixing them makes both worse.
 */
const GROUPS: [string, [string, string][]][] = [
  ['On the floor', [['/count', 'Count']]],
  [
    'What we know',
    [
      ['/', 'Control'],
      ['/items', 'Items'],
      ['/movements', 'Movements'],
      ['/reconcile', 'Reconcile'],
    ],
  ],
  [
    'Proof',
    [
      ['/system', 'System'],
      ['/stress', 'Stress test'],
      ['/audit', 'Audit'],
    ],
  ],
];

export default function Nav() {
  const path = usePathname();

  return (
    <div className="rail">
      <Link href="/" className="wordmark">
        Stock<span>Truth</span>
      </Link>
      <p className="tagline">
        Know what stock you have.
        <br />
        Know why you believe it.
      </p>
      <div className="demo-mark">Demo · invented data</div>

      {GROUPS.map(([group, links]) => (
        <div key={group}>
          <div className="group">{group}</div>
          <nav>
            {links.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={path === href ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      ))}
    </div>
  );
}
