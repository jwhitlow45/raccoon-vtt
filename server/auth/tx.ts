import type pg from "pg";

/** A pool or a client inside a transaction: anything that runs a query. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** The error thrown when the COMMIT itself failed, so the outcome must be read back before any retry. */
export class CommitOutcomeUnknown extends Error {
  constructor(cause: unknown) {
    super("commit outcome unknown", { cause });
    this.name = "CommitOutcomeUnknown";
  }
}

/** No pooled connection came within the transaction's checkout bound. Nothing ran. */
export class CheckoutTimeout extends Error {
  constructor(ms: number) {
    super(`no database connection within ${ms} ms`);
    this.name = "CheckoutTimeout";
  }
}

export type TxOptions = {
  /**
   * How long to wait for a pooled connection. A connection that arrives
   * after the bound is released unused, so a stalled pool costs the caller
   * a known refusal rather than an unbounded wait.
   */
  checkoutMs?: number;
};

// The after-commit callbacks of each open transaction, by its client, so a
// helper deep in a transaction can register one with only the client in hand.
const callbacks = new WeakMap<object, Array<() => void>>();

/**
 * Runs `fn` once the transaction on `tx` has committed, synchronously as the
 * COMMIT resolves, so it happens before anything the caller does next. It
 * also runs when the COMMIT's answer was lost (CommitOutcomeUnknown), since
 * the transaction may have committed: every callback must be idempotent and
 * harmless when it did not. Never run on a rollback.
 */
export function afterCommit(tx: Queryable, fn: () => void): void {
  const list = callbacks.get(tx);
  if (!list) throw new Error("afterCommit needs a transaction from withTx");
  list.push(fn);
}

/** Whether `q` is a client inside a withTx transaction, rather than a pool or a bare client. */
export function inTx(q: Queryable): boolean {
  return callbacks.has(q);
}

/**
 * Runs `fn` in a transaction on one pooled connection. A connection whose
 * rollback also failed is destroyed rather than returned, because its
 * transaction state is unknown and the next borrower would inherit it.
 *
 * A failure of the COMMIT statement itself throws CommitOutcomeUnknown: the
 * connection may have dropped after Postgres applied it, so a caller that
 * must know reads the outcome back. Every failure before COMMIT was sent is
 * a clean rollback and is rethrown as it is.
 */
export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const client = await checkout(pool, opts.checkoutMs);
  let broken = false;
  let committing = false;
  const after: Array<() => void> = [];
  callbacks.set(client, after);
  try {
    await client.query("begin");
    const result = await fn(client);
    committing = true;
    await client.query("commit");
    callbacks.delete(client);
    runAll(after);
    return result;
  } catch (err) {
    callbacks.delete(client);
    if (committing) {
      // The connection's transaction state is unknown, so the pool must not hand it to anyone else.
      broken = true;
      runAll(after);
      throw new CommitOutcomeUnknown(err);
    }
    await client.query("rollback").catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}

/** A callback that throws must not turn a committed transaction into a failure. */
function runAll(list: ReadonlyArray<() => void>): void {
  for (const run of list) {
    try {
      run();
    } catch {
      // Callbacks only clear caches. A failed one leaves a cache to expire on its own.
    }
  }
}

async function checkout(pool: pg.Pool, ms: number | undefined): Promise<pg.PoolClient> {
  if (ms === undefined) return pool.connect();
  const pending = pool.connect();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const first = await Promise.race([pending, late]);
    if (first !== "late") return first;
  } finally {
    clearTimeout(timer);
  }
  // The pool still owes this connection, and nobody waits for it now.
  void pending.then(
    (client) => client.release(),
    () => undefined,
  );
  throw new CheckoutTimeout(ms);
}
