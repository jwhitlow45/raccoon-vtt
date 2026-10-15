import assert from "node:assert/strict";
import { test } from "node:test";
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { loadConfig } from "../config.ts";
import { registerRequestLimits } from "./ratelimit.ts";
import type { SessionStore } from "./sessions.ts";

/**
 * The request limiter's keying, against a fake session store, so no database
 * is needed: an `x-test-session` header stands in for a valid cookie.
 */
async function limitedApp() {
  const app = Fastify();
  await app.register(fastifyCookie);
  const store = (header: string) =>
    ({
      lookup: async (req: FastifyRequest) => {
        const id = req.headers[header];
        return typeof id === "string" ? { id, token: "t", slide: false, touch: false } : null;
      },
    }) as unknown as SessionStore;
  await registerRequestLimits(app, {
    sessions: store("x-test-session"),
    displaySessions: store("x-test-display"),
    config: loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://unused" }),
  });
  app.get("/api/thing", async () => ({ ok: true }));
  app.get("/api/assets/:id/:variant", async () => ({ ok: true }));
  app.get("/api/rooms/:id/display/me", async () => ({ ok: true }));
  app.get("/api/rooms/:id/display/assets/:assetId/:variant", async () => ({ ok: true }));
  app.get("/index.html", async () => "page");
  app.get("/ws", async () => ({ ok: true }));
  await app.ready();
  return app;
}

async function hammer(app: Awaited<ReturnType<typeof limitedApp>>, url: string, n: number, headers: Record<string, string> = {}) {
  let limited = 0;
  for (let i = 0; i < n; i++) {
    const res = await app.inject({ method: "GET", url, remoteAddress: "203.0.113.9", headers });
    if (res.statusCode === 429) limited++;
  }
  return limited;
}

test("without a session, 120 a minute per IP", async () => {
  const app = await limitedApp();
  assert.equal(await hammer(app, "/api/thing", 125), 5);
  // The socket endpoint counts too.
  assert.equal(await hammer(app, "/ws", 1), 1);
  await app.close();
});

test("with a session, 600 a minute per session, apart from the IP", async () => {
  const app = await limitedApp();
  assert.equal(await hammer(app, "/api/thing", 605, { "x-test-session": "a" }), 5);
  assert.equal(await hammer(app, "/api/thing", 10, { "x-test-session": "b" }), 0);
  assert.equal(await hammer(app, "/api/thing", 10), 0);
  await app.close();
});

test("asset reads with a session and static files are exempt", async () => {
  const app = await limitedApp();
  assert.equal(await hammer(app, "/api/assets/x/full", 700, { "x-test-session": "a" }), 0);
  assert.equal(await hammer(app, "/index.html", 200), 0);
  // Without a session an asset read is an ordinary unauthenticated request.
  assert.equal(await hammer(app, "/api/assets/x/full", 125), 5);
  await app.close();
});

test("a table display's own routes count against its display session, and no other route reads that cookie", async () => {
  const app = await limitedApp();
  const display = { "x-test-display": "d" };
  assert.equal(await hammer(app, "/api/rooms/R/display/me", 605, display), 5);
  // Its image reads get the image allowance, as a signed-in device's do.
  assert.equal(await hammer(app, "/api/rooms/R/display/assets/x/full", 700, display), 0);
  // Anywhere else a display session is no session: the request counts against its address.
  assert.equal(await hammer(app, "/api/thing", 125, display), 5);
  await app.close();
});
