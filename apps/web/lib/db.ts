import { Pool, type PoolClient } from 'pg';

/**
 * Database access.
 *
 * Two deliberately different ways in:
 *
 *   withUser()    - everything a person does. Sets the request's identity on
 *                   the connection, so row level security applies exactly as it
 *                   would through PostgREST. A bug in a page cannot leak
 *                   another customer's stock, because the database will not
 *                   return it.
 *
 *   withService() - background reconciliation/import work that has no user
 *                   request identity. Callers must scope every query manually.
 *
 *   withSiteService() - user-facing engine reads that need a Pool adapter. It
 *                   first proves the signed-in user can access the site under
 *                   RLS, then opens the same deliberately privileged engine
 *                   path scoped to that site. This is the only user-facing
 *                   gateway allowed to bypass row policies.
 */

declare global {
  // eslint-disable-next-line no-var
  var __stocktruthPool: Pool | undefined;
}

function pool(): Pool {
  if (!globalThis.__stocktruthPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    globalThis.__stocktruthPool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 30_000,
      // Supabase's pooler terminates idle sessions; failing fast is better than
      // a page hanging on a dead socket.
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalThis.__stocktruthPool;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

function wrap(client: PoolClient): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async one<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return (res.rows[0] as T) ?? null;
    },
  };
}

/**
 * Run work as a signed-in person, inside a transaction, with row level security
 * live. `set local` means the identity dies with the transaction, so a pooled
 * connection can never be handed on still wearing someone else's name.
 */
export async function withUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`set local role authenticated`);
    const result = await fn(wrap(client));
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Unrestricted background path. Never call this directly from a page. */
export async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(wrap(client));
  } finally {
    client.release();
  }
}

/**
 * Controlled privileged gateway for user-facing engine/adaptor work. Access to
 * the requested site is proved through RLS before a raw Pool is exposed to the
 * callback. The callback must still scope every query to siteId.
 */
export async function withSiteService<T>(
  userId: string,
  siteId: string,
  fn: (servicePool: Pool) => Promise<T>,
): Promise<T> {
  const allowed = await withUser(userId, async (db) =>
    db.one<{ id: string }>(`select id from sites where id = $1`, [siteId]),
  );
  if (!allowed) throw new Error('Site not found or access denied');
  return fn(pool());
}
