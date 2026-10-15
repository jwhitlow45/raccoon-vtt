import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import pg from "pg";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

describe("unexpected errors", () => {
  test("are answered with a bare code, never the error's own details", async () => {
    const assetDir = await mkdtemp(join(tmpdir(), "rvtt-app-"));
    // Nothing listens on port 1, so every query fails the way a database outage does.
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", ASSET_DIR: assetDir });
    const pool = new pg.Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 2_000 });
    const app = await buildApp({ config, pool });
    try {
      const res = await app.inject({ method: "GET", url: "/api/rooms/ABCD-EFGH" });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: "internal" });
      assert.doesNotMatch(res.body, /ECONNREFUSED|127\.0\.0\.1/);
      // A client error keeps Fastify's own answer.
      const bad = await app.inject({ method: "POST", url: "/api/rooms", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, payload: "{" });
      assert.equal(bad.statusCode, 400);
    } finally {
      await app.close();
      await pool.end();
      await rm(assetDir, { recursive: true, force: true });
    }
  });
});
