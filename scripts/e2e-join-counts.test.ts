import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { clearWith } from "./e2e-join-counts.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type FakePostgres = { url: string; close(): Promise<void> };

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const message = (type: string, body: Buffer) => Buffer.concat([Buffer.from(type), int32(4 + body.length), body]);
const ready = () => message("Z", Buffer.from("I"));

/**
 * A stand-in for Postgres on a free port. "silent" takes the connection
 * and never says a word. "never closes" lets the client in, answers its
 * query, then ignores Terminate and never closes its side of the socket,
 * as a server or a proxy stuck in its shutdown would.
 */
async function fakePostgres(mode: "silent" | "never closes"): Promise<FakePostgres> {
  const sockets = new Set<net.Socket>();
  // Half-open, so the client's end of the socket does not end this side too.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    if (mode === "silent") return;
    let pending = Buffer.alloc(0);
    let started = false;
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // The startup message has no type byte, and every message after it has one.
      for (;;) {
        const typed = started ? 1 : 0;
        if (pending.length < typed + 4) return;
        const end = typed + pending.readInt32BE(typed);
        if (pending.length < end) return;
        const type = started ? String.fromCharCode(pending[0]!) : "startup";
        pending = pending.subarray(end);
        if (type === "startup") {
          started = true;
          socket.write(Buffer.concat([message("R", int32(0)), ready()]));
        } else if (type === "Q") {
          socket.write(Buffer.concat([message("C", Buffer.from("DELETE 0\0")), ready()]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgres://raccoon:raccoon@127.0.0.1:${port}/raccoon`,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("the join counts' cleanup leaves no socket open", () => {
  test("a database that never answers: the race gives up, and the socket is destroyed", async () => {
    const db = await fakePostgres("silent");
    try {
      const client = new pg.Client({ connectionString: db.url });
      const started = Date.now();
      assert.equal(await clearWith(client, 0.3), false);
      assert.ok(Date.now() - started < 2_000, "the cleanup gave up in time");
      assert.equal(client.connection.stream.destroyed, true);
    } finally {
      await db.close();
    }
  });

  test("a database that never closes its side: the counts clear, and the socket is destroyed once the close has waited", async () => {
    const db = await fakePostgres("never closes");
    try {
      const client = new pg.Client({ connectionString: db.url });
      assert.equal(await clearWith(client, 2, 100), true);
      assert.equal(client.connection.stream.destroyed, true);
    } finally {
      await db.close();
    }
  });
});

describe("the shard script ends once it has reported", () => {
  let dir = "";
  before(() => {
    // The script in a folder of its own, with one quick e2e file, so a run takes a second.
    dir = mkdtempSync(path.join(os.tmpdir(), "e2e-shard-"));
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "e2e"));
    mkdirSync(path.join(dir, "dist"));
    for (const f of ["e2e-shard.ts", "e2e-shard-plan.ts", "e2e-join-counts.ts", "e2e-results.ts"]) copyFileSync(path.join(ROOT, "scripts", f), path.join(dir, "scripts", f));
    copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
    symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "dist/index.html"), "<!doctype html>\n");
    writeFileSync(path.join(dir, "e2e/macos-only.json"), JSON.stringify({ rule: "none", files: {} }));
    writeFileSync(path.join(dir, "e2e/durations.json"), JSON.stringify({ defaultSeconds: 5, seconds: {} }));
    writeFileSync(path.join(dir, "e2e/quick.e2e.ts"), 'import { test } from "node:test";\ntest("passes", () => {});\n');
    writeFileSync(path.join(dir, "keep-alive.mjs"), "setInterval(() => {}, 1000);\n");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a database that never closes and a timer that never stops do not hold it open", async () => {
    const db = await fakePostgres("never closes");
    try {
      // The preloaded timer would keep Node alive for good, so only an explicit exit ends this run.
      const child = spawn(process.execPath, [`--import=${pathToFileURL(path.join(dir, "keep-alive.mjs")).href}`, "scripts/e2e-shard.ts", "1", "1"], {
        cwd: dir,
        env: { PATH: process.env.PATH, DATABASE_URL: db.url, E2E_SCREENSHOT_DIR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (c: Buffer) => (output += c.toString()));
      child.stderr.on("data", (c: Buffer) => (output += c.toString()));
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 30_000);
        child.once("close", (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      assert.equal(code, 0, output);
      assert.match(output, /^ {2}quick {2}passed \(1 tests\) in \d+ s$/m);
    } finally {
      await db.close();
    }
  });
});
