import type pg from "pg";

/** A pool or a client inside a transaction: anything that runs a query. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/**
 * Runs `fn` in a transaction on one pooled connection. A connection whose
 * rollback also failed is destroyed rather than returned, because its
 * transaction state is unknown and the next borrower would inherit it.
 */
export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
