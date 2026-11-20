import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { DEFAULT_MANAGER_OPTIONS, type UnsavedRoom } from "./rooms/manager.ts";
import { SHUTDOWN_DEADLINE_MS, shutDown, type StepFailure } from "./shutdown.ts";

/**
 * The stop's exit (design 15.4): its code, and the lines it leaves in the
 * log however it ends. server/shutdown.itest.ts stops the real server and a
 * real room manager.
 */

type Fake = {
  close?: () => Promise<void>;
  openSockets?: number;
  unsaved?: readonly UnsavedRoom[] | null;
  writes?: () => Promise<{ left: number; failed: number }>;
};

type Logged = { msg: string; obj: { failed?: readonly StepFailure[] } };

/** An app whose `app.close()` and each step after it do what `fake` says, keeping what it logs. */
function fakeApp(fake: Fake = {}): { app: FastifyInstance; logged: Logged[] } {
  const logged: Logged[] = [];
  const server = new EventEmitter();
  const app = {
    log: {
      info: (obj: Logged["obj"], msg: string) => logged.push({ msg, obj }),
      error: (obj: Logged["obj"], msg: string) => logged.push({ msg, obj }),
    },
    server,
    websocketServer: { clients: new Set(Array.from({ length: fake.openSockets ?? 0 }, (_, i) => i)) },
    rooms: {
      unsavedAtClose: fake.unsaved === undefined ? [] : fake.unsaved,
      closeWrites: { close: fake.writes ?? (async () => ({ left: 0, failed: 0 })) },
    },
    async close() {
      // As Fastify's close runs: the server closes, then the onClose hooks, the rooms' among them.
      server.emit("close");
      await fake.close?.();
    },
  };
  return { app: app as unknown as FastifyInstance, logged };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the stop's steps fit its deadline with 2 s left for the pool (design 15.4)", () => {
  // The sockets' grace and the second for those cut off (rooms/ws.ts), the rooms and their check, the socket writes (closeServer).
  const steps = 2_000 + 1_000 + DEFAULT_MANAGER_OPTIONS.closeTimeoutMs + DEFAULT_MANAGER_OPTIONS.auditTimeoutMs + 2_000;
  assert.ok(steps + 2_000 <= SHUTDOWN_DEADLINE_MS, `${steps} ms of steps in a ${SHUTDOWN_DEADLINE_MS} ms stop`);
});

const STEPS = ["shutdown: server closed", "shutdown: rooms closed", "shutdown: socket writes settled", "shutdown: pool closed"];
const lines = (logged: Logged[]) => logged.map((l) => l.msg);

test("a stop that finishes logs each step, exits 0 and leaves no deadline to fire after", async () => {
  const { app, logged } = fakeApp();
  const codes: number[] = [];
  await shutDown(app, async () => undefined, { deadlineMs: 50, exit: (code) => codes.push(code) });
  await sleep(100);
  assert.deepEqual(codes, [0]);
  assert.deepEqual(lines(logged), [...STEPS, "shut down"]);
});

test("a stop still running at the deadline says so and exits 1", async () => {
  const { app, logged } = fakeApp({ close: () => new Promise<never>(() => undefined) });
  const codes: number[] = [];
  void shutDown(app, async () => undefined, { deadlineMs: 50, exit: (code) => codes.push(code) });
  await sleep(100);
  assert.deepEqual(codes, [1]);
  assert.deepEqual(lines(logged), ["shutdown: server closed", "shutdown did not finish in time: forced exit"]);
});

test("a stop stuck on a promise nothing will settle still reaches the forced exit, its process kept alive until then", async () => {
  // In a process of its own: with nothing else to run, a deadline that kept nothing alive would let it end with code 0 and no line.
  const script = `
    import { shutDown } from ${JSON.stringify(new URL("./shutdown.ts", import.meta.url).href)};
    const log = { info: (_o, msg) => console.log(msg), error: (_o, msg) => console.log(msg) };
    const app = { log, server: { once() {} }, close: () => new Promise(() => {}) };
    void shutDown(app, async () => {}, { deadlineMs: 200, exit: (code) => { console.log("exit " + code); process.exit(code); } });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
  assert.equal(code, 1);
  assert.deepEqual(out.trim().split("\n"), ["shutdown did not finish in time: forced exit", "exit 1"]);
});

const ROOMS: UnsavedRoom[] = [
  { roomId: "AAAA0000", why: "snapshot behind" },
  { roomId: "BBBB0000", why: "timed out" },
];
const losses: Array<{ name: string; fake: Fake; endPool?: () => Promise<void>; failed: StepFailure }> = [
  {
    name: "a close hook that threw",
    fake: { close: async () => Promise.reject(new Error("the scan pool would not end")) },
    failed: { step: "server", reason: "a close hook failed: Error: the scan pool would not end" },
  },
  { name: "a socket still open after being cut off", fake: { openSockets: 1 }, failed: { step: "sockets", reason: "1 still open after being cut off" } },
  { name: "rooms not saved", fake: { unsaved: ROOMS }, failed: { step: "rooms", reason: "2 not saved", rooms: ROOMS } },
  { name: "rooms that never closed", fake: { unsaved: null }, failed: { step: "rooms", reason: "the rooms never closed" } },
  { name: "a socket's write left running", fake: { writes: async () => ({ left: 1, failed: 0 }) }, failed: { step: "socket writes", reason: "1 left running, 0 failed" } },
  { name: "a socket's write that failed", fake: { writes: async () => ({ left: 0, failed: 2 }) }, failed: { step: "socket writes", reason: "0 left running, 2 failed" } },
  {
    name: "a pool that would not end",
    fake: {},
    endPool: async () => Promise.reject(new Error("a client never came back")),
    failed: { step: "pool", reason: "Error: a client never came back" },
  },
];

for (const loss of losses) {
  test(`a stop that lost ${loss.name} runs every step after it, then names the loss and exits 1, once`, async () => {
    const { app, logged } = fakeApp(loss.fake);
    const codes: number[] = [];
    let poolEnded = false;
    const endPool =
      loss.endPool ??
      (async () => {
        poolEnded = true;
      });
    await shutDown(app, endPool, { deadlineMs: 50, exit: (code) => codes.push(code) });
    await sleep(100);
    assert.deepEqual(codes, [1]);
    assert.deepEqual(lines(logged), [...STEPS, "shutdown failed"]);
    assert.deepEqual(logged.find((l) => l.msg === "shutdown failed")?.obj.failed, [loss.failed]);
    if (!loss.endPool) assert.ok(poolEnded, "the pool still ended");
  });
}

test("a stop that threw outside its steps says so and exits 1, once", async () => {
  const { app, logged } = fakeApp({ writes: () => Promise.reject(new Error("broken")) });
  const codes: number[] = [];
  await shutDown(app, async () => undefined, { deadlineMs: 50, exit: (code) => codes.push(code) });
  await sleep(100);
  assert.deepEqual(codes, [1]);
  assert.deepEqual(lines(logged), ["shutdown: server closed", "shutdown: rooms closed", "shutdown failed"]);
});
