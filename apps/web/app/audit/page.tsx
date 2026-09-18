import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites } from '@/lib/queries/read';

export const dynamic = 'force-dynamic';

const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default async function Audit() {
  const userId = await currentUserId();
  const events = await withUser(userId, async (db) => {
    const site = (await listSites(db))[0];
    if (!site) return [];
    return db.query<{
      id: string; created_at: string; event_type: string; object_type: string; actor_type: string; actor_label: string | null; email: string | null; detail: Record<string, unknown>;
    }>(`select ae.id, ae.created_at, ae.event_type, ae.object_type, ae.actor_type, ae.actor_label, u.email, ae.detail
          from audit_events ae left join auth.users u on u.id = ae.actor_user_id
         where ae.site_id = $1 order by ae.created_at desc limit 250`, [site.id]);
  });

  const engine = events.filter((e) => e.actor_type === 'engine').length;
  const people = events.length - engine;
  const types = new Set(events.map((e) => e.event_type)).size;

  return (
    <>
      <section className="page-intro slim-intro"><div><div className="kicker">Black-box recorder</div><h1>Nothing quietly disappears.<br /><span>The history is part of the product.</span></h1><p className="lede">Counts, reconciliations and human resolutions are recorded as events. This screen is for answering “what changed, who did it, and when?” without writing SQL.</p></div><div className="intro-meta"><div><span>Events</span><strong>{events.length}</strong></div><div><span>Engine</span><strong>{engine}</strong></div><div><span>Human</span><strong>{people}</strong></div></div></section>

      <div className="audit-header"><span>{types} event types in the current view</span><span>Newest first / append-only source</span></div>
      {events.length === 0 ? <div className="empty-state"><span>NO EVENTS</span><h2>The recorder is empty.</h2></div> : (
        <div className="audit-stream">
          {events.map((e) => {
            const detail = Object.entries(e.detail ?? {}).filter(([, v]) => v !== null && typeof v !== 'object');
            return <article className="audit-event" key={e.id}>
              <div className="audit-time"><strong>{fmt(e.created_at)}</strong><span>{e.actor_type}</span></div>
              <div className={`audit-mark actor-${e.actor_type}`}><span /></div>
              <div className="audit-body">
                <div className="audit-title"><strong>{e.event_type.replaceAll('_', ' ').toLowerCase()}</strong><span>{e.object_type}</span></div>
                <p>{e.email ?? e.actor_label ?? e.actor_type}</p>
                {detail.length > 0 && <details><summary>Event detail</summary><dl>{detail.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl></details>}
              </div>
            </article>;
          })}
        </div>
      )}
    </>
  );
}
