import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { OpSocket } from "./harness.ts";

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.emit("close", 1000, Buffer.alloc(0)); }
}

// The private constructor keeps browser callers on open(). No network is needed to exercise its waiter lifecycle.
const construct = OpSocket as unknown as new (socket: FakeSocket, history: null) => OpSocket;

for (const end of ["close", "resync"] as const) test(`op socket history waiter rejects promptly on ${end}, including later steps`, async (t) => {
  const wire = new FakeSocket();
  const socket = new construct(wire, null);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = socket.step("undo");
  let rejection: unknown;
  void pending.catch((error: unknown) => { rejection = error; });
  if (end === "close") socket.close();
  else wire.emit("message", Buffer.from(JSON.stringify({ t: "resync", reason: "test" })));
  await Promise.resolve();
  await Promise.resolve();
  // Keep the failing baseline test from leaving its ten-second timeout behind.
  const immediate = rejection;
  t.mock.timers.tick(10_001);
  await pending.catch(() => undefined);
  assert.ok(immediate instanceof Error, "closing must end history waiters without waiting for their timeout");
  assert.match(immediate.message, /closed|resynced/);
  const later = socket.step("redo");
  const checked = assert.rejects(later, /closed|resynced/);
  await Promise.resolve();
  t.mock.timers.tick(10_001);
  await checked;
  assert.deepEqual(wire.sent, []);
});
