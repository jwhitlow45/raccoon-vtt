import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { shutDown } from "./shutdown.ts";

/**
 * The stop's exit (design 15.4): its code, and the lines it leaves in the
 * log however it ends. server/shutdown.itest.ts stops the real server.
 */

/** An app whose `app.close()` does what `close` does, keeping the lines it logs. */
function fakeApp(close: () => Promise<void>): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = [];
  const server = new EventEmitter();
  const app = {
    log: {
      info: (_obj: unknown, msg: string) => lines.push(msg),
      error: (_obj: unknown, msg: string) => lines.push(msg),
    },
    server,
    rooms: { closeWrites: { close: async () => undefined } },
    async close() {
      await close();
      // As Fastify's close runs: the server closes, then the onClose hooks, the rooms' among them.
      server.emit("close");
    },
  };
  return { app: app as unknown as FastifyInstance, lines };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a stop that finishes logs each step, exits 0 and leaves no deadline to fire after", async () => {
  const { app, lines } = fakeApp(async () => undefined);
  const codes: number[] = [];
  await shutDown(app, async () => undefined, { deadlineMs: 50, exit: (code) => codes.push(code) });
  await sleep(100);
  assert.deepEqual(codes, [0]);
  assert.deepEqual(lines, ["shutdown: server closed", "shutdown: rooms closed", "shutdown: socket writes settled", "shutdown: pool closed", "shut down"]);
});

test("a stop still running at the deadline says so and exits 1", async () => {
  const { app, lines } = fakeApp(() => new Promise<never>(() => undefined));
  const codes: number[] = [];
  void shutDown(app, async () => undefined, { deadlineMs: 50, exit: (code) => codes.push(code) });
  await sleep(100);
  assert.deepEqual(codes, [1]);
  assert.deepEqual(lines, ["shutdown did not finish in time: forced exit"]);
});

test("a stop that fails says so and exits 1, once", async () => {
  const { app, lines } = fakeApp(async () => {
    throw new Error("the pool is gone");
  });
  const codes: number[] = [];
  await shutDown(app, async () => undefined, { deadlineMs: 50, exit: (code) => codes.push(code) });
  await sleep(100);
  assert.deepEqual(codes, [1]);
  assert.deepEqual(lines, ["shutdown failed"]);
});
