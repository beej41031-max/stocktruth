import { withUser } from '@/lib/db';
import { currentUserId } from '@/lib/session';
import { listSites } from '@/lib/queries/read';

export const dynamic = 'force-dynamic';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });

/**
 * The audit trail, for a manager rather than for a DBA.
 *
 * Exists because "we keep an audit log" is worth nothing if reading it means
 * writing SQL. If a person cannot answer "who changed this and when" from a
 * screen, the log is storage, not accountability.
 */
export default async function Audit() {
  const userId = await currentUserId();

  const events = await withUser(userId, async (db) => {
    const sites = await listSites(db);
    const site = sites[0];
    if (!site) return [];
    return db.query<{
      id: string;
      created_at: string;
      event_type: string;
      object_type: string;
      actor_type: string;
      actor_label: string | null;
      detail: Record<string, unknown>;
    }>(
      `select ae.id, ae.created_at, ae.event_type, ae.object_type,
              ae.actor_type, ae.actor_label, ae.detail
         from audit_events ae
        where ae.site_id = $1
        order by ae.created_at desc
        limit 200`,
      [site.id],
    );
  });

  return (
    <>
      <h1>Audit</h1>
      <p className="sub">
        Everything that changed, who changed it and when. Append-only: the database refuses
        updates and deletes on this table, so what is here is what happened.
      </p>

      {events.length === 0 ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Who</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="dim">{fmt(e.created_at)}</td>
                <td>{e.event_type.toLowerCase().replace(/_/g, ' ')}</td>
                <td className="dim">
                  {e.actor_label ?? (e.actor_type === 'user' ? 'Signed-in user' : e.actor_type)}
                </td>
                <td className="dim">
                  {Object.entries(e.detail ?? {})
                    .filter(([, v]) => v !== null && typeof v !== 'object')
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' Â· ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
