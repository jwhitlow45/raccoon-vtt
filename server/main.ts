import type { ServerToSupervisor } from "../desktop/contract.ts";
import { buildApp } from "./app.ts";
import { checkDatabaseDisk, loadConfig } from "./config.ts";
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
 * The log archive's metadata worker starts only once the server listens,
 * and app.close() stops it first, its job's connection closed.
 *
 * In the desktop app the supervisor runs this file with an IPC channel
 * (docs/design/design-v1-local-app.md 4). On Windows `kill("SIGTERM")` ends
 * a process at once, so the supervisor's `shutdown` message and the
 * channel closing, when the supervisor itself is gone, both run the same
 * graceful shutdown, and the process's exit is its stopped report.
 */
/** How often the desktop app's server reports its sockets: the contract's SERVER_STATUS_INTERVAL_MS, which only a type import may reach from here. */
const STATUS_MS = 5_000;

const config = loadConfig();
checkDatabaseDisk(config);
const pool = getPool(config.DATABASE_URL);
await applySchema(pool);
const app = await buildApp({ config, pool });

let closing = false;
let listening: Promise<unknown> = Promise.resolve();
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => process.exit(1), 25_000);
  timer.unref();
  try {
    // A stop asked for while the server is still binding waits for the bind, so the close finds it whole.
    await listening.catch(() => undefined);
    await closeServer(app, closePool);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
if (config.local && process.send) watchSupervisor();

// A shutdown that began during the boot (the desktop app's supervisor gone) binds nothing and starts nothing.
if (!closing) {
  listening = app.listen({ port: config.PORT, host: config.HOST });
  await listening;
  // After listen, so the log archive's index build and backfill never hold up the boot or health checks.
  if (!closing) app.logMigration.start();
}

/**
 * The desktop app's channel. Listened to before the server binds, so a
 * supervisor that dies during the boot still stops it. Socket counts go
 * out only when one changed, both 0 until the first report.
 */
function watchSupervisor(): void {
  process.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "shutdown") void shutdown("shutdown");
  });
  process.on("disconnect", () => void shutdown("disconnect"));
  // A channel that closed during the boot, before anything listened for it.
  if (!process.connected) void shutdown("disconnect");
  let last: ServerToSupervisor = { type: "status", sockets: 0, remoteDevices: 0 };
  const timer = setInterval(() => {
    const open = app.openSockets();
    if (open.total === last.sockets && open.remoteDevices === last.remoteDevices) return;
    const next: ServerToSupervisor = { type: "status", sockets: open.total, remoteDevices: open.remoteDevices };
    if (!process.connected || !process.send) return;
    last = next;
    // A send that races the channel closing reports to its callback, never as an uncaught error.
    process.send(next, undefined, undefined, (err: Error | null) => {
      if (err) app.log.warn({ err }, "socket count not sent to the supervisor");
    });
  }, STATUS_MS);
  timer.unref();
}
