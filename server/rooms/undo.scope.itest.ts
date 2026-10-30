import assert from "node:assert/strict";
import { test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import { historyMessageSchema, type HistoryMessage } from "#shared/undoContract.ts";
import { startEngine, type Socket } from "./testing.ts";

async function history(socket: Socket, watermark = 0, match: (message: HistoryMessage) => boolean = () => true): Promise<HistoryMessage> {
  // The standalone contract lands before ServerMessage gains history. Validate the wire data here until then.
  const kind = "history" as Parameters<Socket["next"]>[0];
  return historyMessageSchema.parse(await socket.next(kind, (raw) => {
    const parsed = historyMessageSchema.safeParse(raw);
    return parsed.success && parsed.data.watermark >= watermark && match(parsed.data);
  }));
}

test("undo-scope-legacy: raw old hello and queued bare commands refuse without consuming a new head", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const modern = await engine.connect(roomId, device);
  const snap = await modern.snapshot("modern");
  await history(modern);
  const sceneId = (snap.state as RoomState).meta.playerSceneId!;
  const tokenId = uuidv7();
  const created = await modern.apply({ t: "token.create", token: { id: tokenId, sceneId, kind: "object", name: "Crate", size: "medium", x: 2, y: 2 } });
  assert.equal(created.rejects, undefined);
  await history(modern, modern.n);
  await modern.apply({ t: "token.move", tokenId, x: 4, y: 2 });
  const moved = await history(modern, modern.n);
  assert.ok(moved.play.undo.head);
  assert.equal((await modern.apply({ t: "undo", head: moved.play.undo.head.id })).rejects?.length ?? 0, 0);
  const recorded = await history(modern, modern.n);
  assert.ok(recorded.play.undo.head);
  assert.ok(recorded.play.redo.head);

  const legacy = await engine.connect(roomId, device);
  legacy.send({ t: "hello", clientId: "legacy-page", resumeFrom: 1 });
  await legacy.next("snapshot");
  await history(legacy);
  legacy.send({ t: "op", n: 1, op: { t: "undo" } });
  legacy.send({ t: "op", n: 2, op: { t: "redo" } });
  legacy.send({ t: "op", n: 3, op: { t: "undo", of: 1 } });
  legacy.send({ t: "op", n: 4, op: { t: "log.chat", text: "Compatible queued edit arrived" } });
  const rejected = new Map<number, string>();
  let acked = false;
  while (!acked || rejected.size < 3) {
    const event = await legacy.next("ev");
    for (const refusal of event.rejects ?? []) rejected.set(refusal.n, refusal.message);
    acked ||= event.acks?.includes(4) ?? false;
  }
  assert.deepEqual([...rejected].sort(([a], [b]) => a - b), [1, 2, 3].map((n) => [n, "Reload to use Undo"]));
  const after = await history(legacy, 4);
  assert.deepEqual(after.play, recorded.play);
  assert.deepEqual(after.setup, recorded.setup);
  const check = await (await engine.connect(roomId, device)).snapshot("legacy-check");
  const state = check.state as RoomState;
  assert.ok(state.tokens[tokenId]);
  assert.ok(state.log.some((line) => line.text === "Compatible queued edit arrived"));
});

test("undo-scope-isolation: devices share only their member's history, and stale device heads cannot replace it", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId, dmKey } = await device.createRoom();
  const one = await engine.connect(roomId, device);
  const two = await engine.connect(roomId, device);
  const snap = await one.snapshot("one");
  await two.snapshot("two");
  await history(one);
  await history(two);
  const playerDevice = engine.client();
  await playerDevice.join(roomId);
  const player = await engine.connect(roomId, playerDevice);
  await player.snapshot("player");
  const coDevice = engine.client();
  await coDevice.claimDm(roomId, dmKey);
  const coDm = await engine.connect(roomId, coDevice);
  await coDm.snapshot("co-dm");
  await history(player);
  await history(coDm);
  const sceneId = (snap.state as RoomState).meta.playerSceneId!;
  await one.apply({ t: "scene.update", sceneId, patch: { name: "Private preparation" } });
  const first = await history(one, one.n);
  assert.ok(first.setup?.undo.head);
  const second = await history(two, 0, (m) => m.setup?.undo.head?.id === first.setup?.undo.head?.id);
  assert.deepEqual(second.setup, first.setup);
  const co = await history(coDm, 0, (m) => m.seq >= first.seq);
  const party = await history(player, 0, (m) => m.seq >= first.seq);
  assert.equal(co.setup?.undo.depth, 0);
  assert.equal(party.setup, undefined);
  for (const message of [co, party]) assert.ok(!JSON.stringify(message).includes(first.setup.undo.head.id));

  await two.apply({ t: "scene.update", sceneId, patch: { name: "Second preparation" } });
  const replacement = await history(two, two.n);
  assert.ok(replacement.setup?.undo.head);
  assert.notEqual(replacement.setup.undo.head.id, first.setup.undo.head.id);
  const refusal = await one.apply({ t: "undo", scope: "setup", head: first.setup.undo.head.id });
  assert.match(refusal.rejects?.[0]?.message ?? "", /Setup history changed/);
  const preserved = await history(one, one.n);
  assert.deepEqual(preserved.setup, replacement.setup);
  const check = await (await engine.connect(roomId, device)).snapshot("isolation-check");
  assert.equal((check.state as RoomState).scenes[sceneId]?.name, "Second preparation");
});

test("undo-scope-reconnect: restart replaces the epoch and refuses a head from the retired room", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const socket = await engine.connect(roomId, device);
  await socket.snapshot("reconnecting");
  await history(socket);
  await socket.apply({ t: "room.update", name: "Before restart" });
  const before = await history(socket, socket.n);
  assert.ok(before.setup?.undo.head);
  await engine.restart();
  const next = await engine.connect(roomId, device);
  next.n = socket.n;
  await next.snapshot("reconnecting", socket.n + 1);
  const fresh = await history(next, socket.n);
  assert.notEqual(fresh.epoch, before.epoch);
  assert.equal(fresh.setup?.undo.depth, 0);
  const refusal = await next.apply({ t: "undo", scope: "setup", head: before.setup.undo.head.id });
  assert.ok(refusal.rejects?.length);
  await next.apply({ t: "room.update", name: "After restart" });
  const recorded = await history(next, next.n);
  assert.equal(recorded.setup?.undo.depth, 1);
  assert.notEqual(recorded.setup?.undo.head?.id, before.setup.undo.head.id);
  const check = await (await engine.connect(roomId, device)).snapshot("restart-check");
  assert.equal((check.state as RoomState).meta.name, "After restart");
});

test("undo-scope-groups: declared mixed gestures enter Setup from their first part and merge there", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const socket = await engine.connect(roomId, device);
  await socket.snapshot("mixed");
  await history(socket);
  const g = uuidv7();
  const send = async (op: unknown) => {
    const n = socket.nextN();
    socket.send({ t: "op", n, op, g, groupScope: "setup" });
    const event = await socket.next("ev", (m) => Boolean(m.acks?.includes(n) || m.rejects?.some((r) => r.n === n)));
    assert.equal(event.rejects?.length ?? 0, 0);
    return history(socket, n);
  };
  const first = await send({ t: "view.follow", follow: true });
  assert.equal(first.play.undo.depth, 0);
  assert.equal(first.setup?.undo.depth, 1);
  const second = await send({ t: "room.update", name: "Mixed setup" });
  assert.equal(second.play.undo.depth, 0);
  assert.equal(second.setup?.undo.depth, 1);
  assert.notEqual(second.setup?.undo.head?.id, first.setup?.undo.head?.id);
  const undone = await socket.apply({ t: "undo", scope: "setup", head: second.setup!.undo.head!.id });
  assert.equal(undone.rejects?.length ?? 0, 0);
  const restored = await (await engine.connect(roomId, device)).snapshot("mixed-check");
  const state = restored.state as RoomState;
  assert.equal(state.meta.view.follow, false);
  assert.equal(state.meta.name, "Test room");
});

test("undo-scope-groups: a contradictory later part refuses before mutation", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const socket = await engine.connect(roomId, device);
  await socket.snapshot("contradiction");
  await history(socket);
  const g = uuidv7();
  socket.send({ t: "op", n: socket.nextN(), op: { t: "view.follow", follow: true }, g });
  await socket.next("ev", (m) => m.acks?.includes(1) ?? false);
  const before = await history(socket, 1);
  assert.equal(before.play.undo.depth, 1);
  socket.send({ t: "op", n: socket.nextN(), op: { t: "room.update", name: "Must not apply" }, g });
  const refusal = await socket.next("ev", (m) => m.rejects?.some((r) => r.n === 2) ?? false);
  assert.equal(refusal.rejects?.length, 1);
  const after = await history(socket, 2);
  assert.deepEqual(after.play, before.play);
  assert.deepEqual(after.setup, before.setup);
  const restored = await (await engine.connect(roomId, device)).snapshot("contradiction-check");
  assert.equal((restored.state as RoomState).meta.name, "Test room");
});

test("undo-scope-groups: players cannot declare Setup groups", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const dmDevice = engine.client();
  const { roomId } = await dmDevice.createRoom();
  const device = engine.client();
  await device.join(roomId);
  const socket = await engine.connect(roomId, device);
  await socket.snapshot("player-group");
  await history(socket);
  socket.send({ t: "op", n: socket.nextN(), op: { t: "log.chat", text: "Must not be accepted" }, g: uuidv7(), groupScope: "setup" });
  const event = await socket.next("ev", (m) => m.rejects?.some((r) => r.n === 1) ?? false);
  assert.equal(event.rejects?.[0]?.code, "forbidden");
  const after = await history(socket, 1);
  assert.equal(after.setup, undefined);
  assert.equal(after.play.undo.depth, 0);
  const check = await (await engine.connect(roomId, dmDevice)).snapshot("declaration-check");
  assert.ok(!(check.state as RoomState).log.some((line) => line.text === "Must not be accepted"));
  const compatible = await socket.apply({ t: "log.chat", text: "Ordinary chat still works" });
  assert.equal(compatible.rejects?.length ?? 0, 0);
});
