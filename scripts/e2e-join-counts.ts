import pg from "pg";
import { withTimeout } from "./e2e-shard-plan.ts";

const CLEAR = "delete from rate_events where key like 'ok:%' or key like 'create:%'";

/**
 * The server counts successful joins and room creations per address in
 * Postgres (server/auth/ratelimit.ts), and every e2e file joins from
 * 127.0.0.1. One file stays under the hourly limits, but a shard's files
 * together can pass them, so scripts/e2e-shard.ts clears the counts before
 * each run, as the full check on a laptop does. A fresh database has no
 * table until the first server applies the schema, and then there is
 * nothing to clear.
 *
 * A database that stops answering would otherwise hold the shard, so the
 * cleanup gets `seconds` in all and says whether it finished: pg gives up
 * on the connection and on the statement at half that each, and a race
 * ends the wait whatever pg does.
 */
export function clearJoinCounts(databaseUrl: string, seconds: number): Promise<boolean> {
  const half = (seconds * 1000) / 2;
  return clearWith(new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: half, statement_timeout: half, query_timeout: half }), seconds);
}

/**
 * The cleanup on a client of the caller's, as a test gives it. pg's
 * timeouts all say "timeout", and the server's statement timeout is 57014.
 * Any other error, such as a wrong DATABASE_URL, stops the shard.
 *
 * Whatever happens, the client's socket is gone when this returns. A
 * graceful close gets `closeWaitMs`, and a socket still open after it, or
 * after a cleanup the race gave up on, is destroyed: a server that never
 * finishes the TCP shutdown would otherwise leave a half-closed socket
 * that keeps Node running after the shard has reported.
 */
export async function clearWith(client: pg.Client, seconds: number, closeWaitMs = 1000): Promise<boolean> {
  let gaveUp = false;
  const work = (async () => {
    await client.connect();
    await client.query(CLEAR);
  })();
  try {
    const result = await withTimeout(work, seconds * 1000);
    gaveUp = !result.done;
    return result.done;
  } catch (err) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    if (code === "42P01") return true;
    if (code === "57014" || /timeout/i.test(String(message))) return false;
    throw new Error(`Could not clear the join counts in DATABASE_URL's database: ${String(message)}`);
  } finally {
    if (!gaveUp) await withTimeout(client.end().catch(() => {}), closeWaitMs);
    const stream = (client as { connection?: { stream?: { destroyed?: boolean; destroy?: () => void } } }).connection?.stream;
    if (stream && !stream.destroyed) stream.destroy?.();
  }
}
