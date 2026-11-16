import { buildApp } from "./app.ts";
import { checkDatabaseDisk, loadConfig } from "./config.ts";
import { applySchema, closePool, getPool } from "./db.ts";
import { shutDown } from "./shutdown.ts";

/**
 * Boot: configuration, database, server, graceful shutdown.
 *
 * Shutdown order matters (design section 15.4): stop accepting, close sockets
 * with 1012 so clients reconnect at once to the new container, let each room
 * finish its current commit and write its snapshot, then close the pool. The
 * socket layer and the room manager hook Fastify's preClose and onClose to do
 * their parts inside `app.close()`, the socket layer closing every HTTP
 * connection too once its sockets have closed, since the rooms' part waits
 * for the server to close. server/shutdown.ts then waits for the sockets
 * still closing and what they write, closes the pool and exits, logging each
 * step, with 1 when the stop fails or has not finished at 25 s. The log
 * archive's metadata worker starts only once the server listens, and
 * app.close() stops it first, its job's connection closed.
 */
const config = loadConfig();
checkDatabaseDisk(config);
const pool = getPool(config.DATABASE_URL);
await applySchema(pool);
const app = await buildApp({ config, pool });

let closing = false;
function onSignal(signal: string): void {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  void shutDown(app, closePool);
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
// After listen, so the log archive's index build and backfill never hold up the boot or health checks.
app.logMigration.start();
