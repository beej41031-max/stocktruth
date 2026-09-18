import Link from 'next/link';
import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, listItems } from '@/lib/queries/read';

export const dynamic = 'force-dynamic';

const AGO = (iso: string | null) => {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
};

export default async function Items({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const userId = await currentUserId();

  const rows = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return [];
    return listItems(db, site.id, q);
  });

  return (
    <>
      <h1>Items</h1>
      <p className="sub">
        Every line, with what the book claims, what was counted, and what can be said about it
        now. A blank in the last column is deliberate.
      </p>

      <form style={{ maxWidth: 320, marginBottom: 24 }}>
        <input type="search" name="q" placeholder="Code or name" defaultValue={q ?? ''} />
      </form>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Where</th>
            <th className="num">Book</th>
            <th className="num">Counted</th>
            <th className="num">Now</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.itemId}-${r.locationCode ?? 'none'}`}>
              <td>
                <Link href={`/items/${r.itemId}`} className="code">
                  {r.sku ?? '(no code)'}
                </Link>
                <div className="dim">{r.name}</div>
              </td>
              <td className="dim">{r.locationCode ?? '—'}</td>
              <td className="num">{r.bookQuantity ?? '—'}</td>
              <td className="num">
                {r.physicalQuantity ?? '—'}
                {r.physicalCountedAt && <div className="dim">{AGO(r.physicalCountedAt)}</div>}
              </td>
              <td className="num">
                {r.derivedQuantity ?? <span className="none">not stated</span>}
              </td>
              <td className={`st-${r.state ?? 'UNVERIFIED'}`}>
                {(r.state ?? 'UNVERIFIED').toLowerCase()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
