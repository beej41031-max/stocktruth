import Link from 'next/link';
import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, openIssues } from '@/lib/queries/read';
import { REASONS, type ReasonDefinition } from '@stocktruth/engine';
import ResolveForm from './ResolveForm';

export const dynamic = 'force-dynamic';

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

export default async function Reconcile() {
  const userId = await currentUserId();
  const issues = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return [];
    return openIssues(db, site.id, 200);
  });

  const high = issues.filter((i) => i.severity === 'high');
  const rest = issues.filter((i) => i.severity !== 'high');

  return (
    <>
      <h1>Reconcile</h1>
      <p className="sub">
        Everything the engine could not settle on its own, and what it would take to settle it.
        Nothing here is fixed automatically, because every one of these needs somebody who was
        in the building to say what actually happened.
      </p>

      {issues.length === 0 && (
        <p className="empty">
          Nothing outstanding. Either every position reconciles, or the engine has not run since
          the last import.
        </p>
      )}

      {high.length > 0 && <h2>Blocking a number ({high.length})</h2>}
      <Queue issues={high} />

      {rest.length > 0 && <h2>Worth knowing ({rest.length})</h2>}
      <Queue issues={rest} />
    </>
  );
}

function Queue({ issues }: { issues: Awaited<ReturnType<typeof openIssues>> }) {
  if (issues.length === 0) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>What is wrong</th>
          <th className="num">Book</th>
          <th className="num">Counted</th>
          <th className="num">Now</th>
          <th>Since</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => {
          const def = (REASONS as Record<string, ReasonDefinition>)[issue.code];
          return (
            <tr key={issue.id}>
              <td>
                {issue.itemId ? (
                  <Link href={`/items/${issue.itemId}`} className="code">
                    {issue.sku ?? issue.itemName}
                  </Link>
                ) : (
                  <span className="dim">site-wide</span>
                )}
                <div className="dim">{issue.locationCode ?? ''}</div>
              </td>
              <td>
                <div>{def?.short ?? issue.code}</div>
                <div className="dim">{def?.action}</div>
              </td>
              <td className="num">{issue.bookQuantity ?? '—'}</td>
              <td className="num">{issue.physicalQuantity ?? '—'}</td>
              <td className="num">
                {issue.derivedQuantity ?? <span className="none">not stated</span>}
              </td>
              <td className="dim">{fmt(issue.firstSeenAt)}</td>
              <td>
                <ResolveForm issueId={issue.id} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
