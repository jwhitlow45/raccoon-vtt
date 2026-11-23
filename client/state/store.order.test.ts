import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { DM, room, token } from "#shared/testutil.ts";
import { LocalServer } from "../dev/localServer.ts";
import { createRoomStore, inIdOrder } from "./store.ts";
import { FakeClock, FakeOutbox } from "./testing.ts";

/** Ids whose order is not the order they come in: a live create adds its key at the end. */
const LATE = "00000000-0000-8000-8000-000000000001";
const MID = "80000000-0000-8000-8000-000000000001";
const LAST = "f0000000-0000-8000-8000-000000000001";

function made(id: string, x: number): ClientOp {
  const { rev: _rev, fogExemptAuto: _auto, ...input } = token(id, { sceneId: "s1", name: "Goblin", x, y: 2 });
  return { t: "token.create", token: input } as ClientOp;
}

test("a collection a live change or a pending create adds to reads in id order, as the same room does after a reload", () => {
  const state: RoomState = room({ tokens: { [MID]: token(MID, { x: 1 }), [LAST]: token(LAST, { x: 3 }) } });
  const clock = new FakeClock();
  const outbox = new FakeOutbox();
  const server = new LocalServer(structuredClone(state), DM, "s1");
  const store = createRoomStore({ roomId: "R1", you: DM, clock, random: () => 0.5, clientId: "c1" });
  store.setOutbox(outbox);
  const connect = () => {
    const hello = store.prepareHello();
    store.setConnection("open");
    store.applySnapshot(server.hello({ resumeFrom: hello.resumeFrom, sceneId: "s1" }));
  };
  connect();
  store.dispatch(made(LATE, 5));
  assert.deepEqual(Object.keys(store.store.getState().view!.tokens), [LATE, MID, LAST], "the pending create, in id order in the view");
  const ops = outbox.sent.flatMap((m) => (m.t === "op" ? [{ n: m.n, op: m.op }] : []));
  outbox.sent = [];
  for (const msg of server.batch(ops)) if (msg.t === "ev") store.applyEv(msg);
  const live = Object.keys(store.store.getState().confirmed!.tokens);
  assert.deepEqual(live, [LATE, MID, LAST], "confirmed, after the live change");
  store.suspend();
  connect();
  assert.deepEqual(Object.keys(store.store.getState().confirmed!.tokens), live, "the same order after a reload");
  assert.deepEqual(Object.keys(store.store.getState().view!.tokens), live);
});

test("only a collection that changed and lists its keys out of order is rebuilt, and a room's single records never are", () => {
  const prev: Record<string, unknown> & { tokens: Record<string, number>; drawings: Record<string, number> } = { meta: { z: 1, a: 2 }, tokens: { a: 1, b: 2 }, drawings: { b: 1, a: 2 }, log: [3, 1] };
  assert.equal(inIdOrder(prev, prev), prev, "nothing changed");
  const next = { ...prev, tokens: { b: 2, a: 1 }, meta: { z: 1, a: 3 } };
  const out = inIdOrder(next, prev);
  assert.deepEqual(Object.keys(out.tokens), ["a", "b"]);
  assert.equal(out.drawings, prev.drawings, "unchanged, kept as it is");
  assert.equal(out.meta, next.meta, "a record, never sorted");
  assert.equal(out.log, prev.log);
  const sorted = { ...prev, tokens: { a: 1, c: 3 } };
  assert.equal(inIdOrder(sorted, prev), sorted, "already in order, the same object");
  assert.deepEqual(Object.keys(inIdOrder(prev, null).drawings), ["a", "b"], "a snapshot's every collection is read");
});
