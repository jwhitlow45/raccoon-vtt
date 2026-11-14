import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import pg from "pg";

/**
 * A stand-in for server/main.ts in the supervisor's tests
 * (RACCOONVTT_TEST_SERVER_ENTRY): it listens where it is told, answers
 * /healthz, holds one connection to the database as a running server does,
 * reports a status, and stops on `shutdown` or a closed channel, as the
 * real one does. The supervisor builds the server's environment from
 * nothing, so a test steers this through `fake-server.json` in the data
 * folder: `{"exitAfterMs": n}` makes it crash.
 */

const port = Number(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
db.on("error", () => undefined);
await db.connect();
// The real server applies db/schema.sql before it listens, so every backup
// taken while one runs holds the tables a restore reads back.
await db.query(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  res.writeHead(404).end();
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  await db.end().catch(() => undefined);
  process.exit(0);
}

process.on("message", (m: unknown) => {
  if ((m as { type?: unknown }).type === "shutdown") void shutdown();
});
process.on("disconnect", () => void shutdown());

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: 30, msg: `fake server listening on ${host}:${port}` }));
  process.send?.({ type: "status", sockets: 0, remoteDevices: 0 });
});

let options: { exitAfterMs?: number } = {};
try {
  options = JSON.parse(readFileSync(join(dirname(process.env.ASSET_DIR ?? "."), "fake-server.json"), "utf8")) as typeof options;
} catch {
  // No file: a server that keeps running.
}
const crashAfter = options.exitAfterMs ?? 0;
if (crashAfter > 0) {
  setTimeout(() => {
    console.log(JSON.stringify({ level: 60, msg: "fake server crashed on purpose" }));
    process.exit(3);
  }, crashAfter);
}
