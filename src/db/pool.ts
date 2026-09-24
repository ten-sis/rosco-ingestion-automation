/**
 * Lazy Postgres pool backing the SQL driver-events reader fallback (`DRIVER_EVENTS_READER=sql`).
 * Only ever touched when that reader is selected and `DB_URL` is set — see `env.ts`.
 */
import { Pool } from 'pg';
import { env } from '../env';

// Module-level singleton: this models one shared external connection pool's lifecycle for the
// whole process, not a value object passed between callers, so it is a deliberate, narrow
// exception to the immutability rule rather than an oversight.
let pool: Pool | undefined;

/**
 * Session-level GUCs set on every connection this pool opens, applied via libpq's `options`
 * connection parameter (`-c name=value`, space-separated). These are a second, server-enforced
 * line of defence behind the `SELECT_ONLY` regex below, which only inspects the SQL text's shape
 * and therefore misses `SELECT ... INTO new_table` (creates a table), a volatile function called
 * from a SELECT list (writes), and an unbounded `select pg_sleep(...)` (hangs the worker
 * indefinitely). `default_transaction_read_only=on` rejects any write at the transaction level
 * regardless of statement shape; `statement_timeout` bounds the pathological-query case.
 *
 * This is still client-side enforcement. The DB role this connection string authenticates as
 * should ALSO be granted read-only (e.g. Postgres's `pg_read_all_data`, or a dedicated read-only
 * role) — that is the actual backstop against a bug in this pool's own defences, and nothing here
 * can substitute for it.
 */
const READ_ONLY_SESSION_OPTIONS = '-c default_transaction_read_only=on -c statement_timeout=30s';

/** Returns the shared pool, creating it from `env.dbUrl` on first use. */
export function getPool(): Pool {
  if (!pool) {
    if (!env.dbUrl) {
      throw new Error(
        'getPool: DB_URL is not set. The SQL driver-events reader needs the DB tunnel documented ' +
          'at the top of README.md.',
      );
    }
    pool = new Pool({ connectionString: env.dbUrl, options: READ_ONLY_SESSION_OPTIONS });
  }
  return pool;
}

/** Closes the pool, if one was ever created. Safe to call even when nothing was opened. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const toClose = pool;
  pool = undefined;
  await toClose.end();
}

/**
 * Second line of defence (see `READ_ONLY_SESSION_OPTIONS` above): catches the common case of an
 * obviously-not-a-SELECT statement before it is even sent, but a leading comment or a
 * `SELECT ... INTO` still passes this regex — the session GUCs are what actually stop those.
 */
const SELECT_ONLY = /^\s*select\b/i;

/**
 * Runs a read-only query and returns its rows. Rejects anything that is not a `SELECT`: this
 * suite never writes over the SQL reader tunnel.
 */
export async function query<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
  if (!SELECT_ONLY.test(sql)) {
    throw new Error(`query: only SELECT statements are allowed over the SQL reader tunnel. Got: ${sql.slice(0, 80)}`);
  }
  const result = await getPool().query(sql, params as unknown[]);
  return result.rows as T[];
}
