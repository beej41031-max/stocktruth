import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites, listMovements } from '@/lib/queries/read';
import MovementsClient from './MovementsClient';

export const dynamic = 'force-dynamic';

export default async function Movements() {
  const userId = await currentUserId();
  const rows = await withUser(userId, async (db) => {
    const site = (await listSites(db))[0];
    if (!site) return [];
    return listMovements(db, site.id, 500);
  });

  return (
    <>
      <section className="page-intro slim-intro"><div><div className="kicker">Movement ledger</div><h1>Stock moves twice:<br /><span>once in reality, once in the system.</span></h1><p className="lede">The gap between those two times is evidence. Unlinked, undated and late-recorded movements rise to the top instead of being quietly normalised away.</p></div><div className="intro-meta"><div><span>Loaded</span><strong>{rows.length}</strong></div><div><span>Sources</span><strong>{new Set(rows.map((r) => r.sourceName).filter(Boolean)).size}</strong></div></div></section>
      <MovementsClient rows={rows} />
    </>
  );
}
