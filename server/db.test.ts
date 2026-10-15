import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { closePool, getPool } from "./db.ts";

describe("the database pool", () => {
  test("a connection that fails while idle or checked out is logged, never thrown", async () => {
    const seen: string[] = [];
    // Port 1 refuses connections, and nothing here connects anyway.
    const pool = getPool("postgres://nobody@127.0.0.1:1/none", (err, where) => seen.push(`${where}: ${err.message}`));
    try {
      // What pg-pool does when an idle client's connection ends.
      pool.emit("error", new Error("terminating connection due to administrator command"), new EventEmitter());
      // A client checked out between queries reports on itself instead.
      const client = new EventEmitter();
      pool.emit("connect", client);
      client.emit("error", new Error("Connection terminated unexpectedly"));
      assert.deepEqual(seen, ["idle: terminating connection due to administrator command", "client: Connection terminated unexpectedly"]);
    } finally {
      await closePool();
    }
  });
});
