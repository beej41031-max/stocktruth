import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, listItems } from '@/lib/queries/read';
import ItemsClient from './ItemsClient';

export const dynamic = 'force-dynamic';

export default async function Items({ searchParams }: { searchParams: Promise<{ q?: string; state?: string }> }) {
  const params = await searchParams;
  const userId = await currentUserId();
  const rows = await withUser(userId, async (db) => {
    const site = (await listSites(db))[0];
    if (!site) return [];
    return listItems(db, site.id);
  });

  return (
    <>
      <section className="page-intro slim-intro">
        <div><div className="kicker">Position register</div><h1>Every stock line,<br /><span>with its evidence attached.</span></h1><p className="lede">Book, count and derived position are kept separate on purpose. Search the catalogue, isolate weak evidence, then drill into the timeline that produced the verdict.</p></div>
        <div className="intro-meta"><div><span>Positions</span><strong>{rows.length.toLocaleString()}</strong></div><div><span>Refused</span><strong>{rows.filter((r) => r.derivedQuantity == null).length.toLocaleString()}</strong></div></div>
      </section>
      <ItemsClient rows={rows} initialQuery={params.q ?? ''} initialState={params.state ?? 'ALL'} />
    </>
  );
}
