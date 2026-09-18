import Link from 'next/link';
import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, listMovements } from '@/lib/queries/read';

export const dynamic = 'force-dynamic';

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

export default async function Movements() {
  const userId = await currentUserId();
  const rows = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return [];
    return listMovements(db, site.id);
  });

  const unlinked = rows.filter((r) => !r.sku);

  return (
    <>
      <h1>Movements</h1>
      <p className="sub">
        Everything that changed a quantity. Unmatched rows are listed first, because until they
        are attached to an item they weaken every position they might belong to.
      </p>

      {unlinked.length > 0 && (
        <>
          <h2>Not linked to an item ({unlinked.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Code in the source</th>
                <th>What</th>
                <th className="num">Quantity</th>
                <th>When</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {unlinked.map((m) => (
                <tr key={m.id}>
                  <td className="code">
                    {m.rawCode ? m.rawCode : <span className="none">blank in the export</span>}
                  </td>
                  <td>{m.movementType.toLowerCase().replace('_', ' ')}</td>
                  <td className="num">
                    {m.quantity} {m.unit}
                  </td>
                  <td className="dim">{fmt(m.occurredAt) ?? <span className="none">no date</span>}</td>
                  <td className="dim">{m.sourceReference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Linked</h2>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>What</th>
            <th className="num">Quantity</th>
            <th>Happened</th>
            <th>Recorded</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((r) => r.sku)
            .map((m) => {
              const gapMins =
                m.occurredAt && m.recordedAt
                  ? Math.round((new Date(m.recordedAt).getTime() - new Date(m.occurredAt).getTime()) / 60000)
                  : 0;
              return (
                <tr key={m.id}>
                  <td className="code">{m.sku}</td>
                  <td>{m.movementType.toLowerCase().replace('_', ' ')}</td>
                  <td className="num">
                    {m.quantity} {m.unit}
                  </td>
                  <td className="dim">{fmt(m.occurredAt) ?? <span className="none">no date</span>}</td>
                  <td className={gapMins > 60 ? 'st-STALE' : 'dim'}>
                    {fmt(m.recordedAt) ?? '—'}
                    {gapMins > 60 && <div className="dim">{Math.round(gapMins / 60)}h later</div>}
                  </td>
                  <td className="dim">{m.sourceReference}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </>
  );
}
