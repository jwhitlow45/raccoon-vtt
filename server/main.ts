import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { applySchema, closePool, getPool } from "./db.ts";
import { closeServer } from "./shutdown.ts";

/**
 * Boot: configuration, database, server, graceful shutdown.
 *
 * Shutdown order matters (design section 15.4): stop accepting, close sockets
 * with 1012 so clients reconnect at once to the new container, let each room
 * finish its current commit and write its snapshot, then close the pool. The
 * socket layer and the room manager hook Fastify's preClose and onClose to do
 * their parts inside `app.close()`. server/shutdown.ts then waits for the
 * sockets still closing and what they write, and the pool closes after it.
 */
const config = loadConfig();
const pool = getPool(config.DATABASE_URL);
await applySchema(pool);
const app = await buildApp({ config, pool });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => process.exit(1), 25_000);
  timer.unref();
  try {
    await closeServer(app, closePool);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
