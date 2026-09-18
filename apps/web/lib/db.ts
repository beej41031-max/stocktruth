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
 *   withService() - the reconciliation engine and import committer, which work
 *                   across every item at a site and cannot run as one user.
 *                   Used in exactly two places, both of which take a site id
 *                   and scope every query to it by hand.
 *
 * If a new caller wants withService, that is a decision, not a convenience.
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
      max: 10,
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

/** Unrestricted. Only the engine and the import committer should reach for this. */
export async function withService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    return await fn(wrap(client));
  } finally {
    client.release();
  }
}

export function rawPool(): Pool {
  return pool();
}
