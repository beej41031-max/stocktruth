import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites } from '@/lib/queries/read';
import CountClient from './CountClient';

export const dynamic = 'force-dynamic';

export default async function CountPage() {
  const userId = await currentUserId();

  const data = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return null;

    const locations = await db.query<{ id: string; code: string; name: string | null }>(
      `select id, code, name from locations where site_id = $1 and active order by code`,
      [site.id],
    );

    const open = await db.one<{ id: string; name: string | null; started_at: string }>(
      `select id, name, started_at from count_sessions
        where site_id = $1 and status = 'open'
        order by started_at desc limit 1`,
      [site.id],
    );

    const recent = await db.query<{
      id: string;
      sku: string | null;
      name: string;
      quantity: string;
      unit: string;
      code: string | null;
      counted_at: string;
    }>(
      `select cl.id, i.sku, i.name, cl.quantity::text, cl.unit, l.code, cl.counted_at
         from count_lines cl
         join items i on i.id = cl.item_id
         left join locations l on l.id = cl.location_id
        where cl.site_id = $1 and not cl.superseded
        order by cl.created_at desc limit 12`,
      [site.id],
    );

    return { site, locations, open, recent };
  });

  if (!data) return <p className="empty">No site to count.</p>;

  return (
    <CountClient
      siteId={data.site.id}
      siteName={data.site.name}
      locations={data.locations}
      openSession={data.open}
      recent={data.recent}
    />
  );
}
