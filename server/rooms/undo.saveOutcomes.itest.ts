import assert from "node:assert/strict";
import { test } from "node:test";
import yauzl from "yauzl";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import type { SaveOutcomeLedger } from "#shared/saveOutcomeContract.ts";
import { actor } from "#shared/testutil.ts";
import { historyMessageSchema, type HistoryMessage } from "#shared/undoContract.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { failCommits, startEngine, type Socket } from "./testing.ts";
import type { RoomExport } from "./exportRoom.ts";

type Tracked = RoomState & { saveOutcomes?: SaveOutcomeLedger };
const records = (state: RoomState) => (state as Tracked).saveOutcomes ?? {};
async function history(socket: Socket, watermark = socket.n): Promise<HistoryMessage> {
  return historyMessageSchema.parse(await socket.next("history", (message) => message.watermark >= watermark));
}
async function accepted(socket: Socket, op: Record<string, unknown>) {
  const event = await socket.apply(op);
  assert.equal(event.rejects?.length ?? 0, 0, JSON.stringify(event.rejects));
  return event;
}
async function exported(zipBytes: Buffer): Promise<RoomExport> {
  const zip = await yauzl.fromBufferPromise(zipBytes);
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName !== "room.json") continue;
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    const result = JSON.parse(Buffer.concat(chunks).toString()) as RoomExport;
    zip.close();
    return result;
  }
  assert.fail("export has room.json");
}

test("undo-scope-save: lifecycle-only outcome crosses real receipts, two DM devices, reconnect and restart", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const one = await engine.connect(roomId, device);
  const snapshot = await one.snapshot("one");
  await history(one);
  const sceneId = (snapshot.state as RoomState).meta.playerSceneId!;
  const tokenId = uuidv7();
  await accepted(one, { t: "token.create", token: { id: tokenId, sceneId, size: "medium", kind: "monster", name: "Goblin", x: 2, y: 2, actor: { inline: actor() } } });
  const two = await engine.connect(roomId, device);
  await two.snapshot("two");
  await history(two, 0);
  const id = uuidv7();
  const op = { t: "actor.outcome", plan: id, page: { id, expectRevision: 0 }, targets: [{ target: { tokenId } }] };
  await accepted(one, op);
  const first = await history(one);
  assert.equal(first.play.undo.depth, 2);
  const shared = historyMessageSchema.parse(await two.next("history", (m) => m.seq >= first.seq));
  assert.equal(shared.play.undo.head?.id, first.play.undo.head?.id);
  await accepted(two, { t: "undo", head: shared.play.undo.head!.id });
  const undone = await history(two);
  assert.equal(undone.play.redo.depth, 1);
  one.terminate();
  const reconnected = await engine.connect(roomId, device);
  const view = await reconnected.snapshot("reconnected");
  assert.equal(records(view.state as RoomState)[id]?.state, "undone");
  assert.equal(records(view.state as RoomState)[id]?.revision, 2);
  await history(reconnected, 0);
  await accepted(reconnected, op);
  const duplicate = await history(reconnected);
  assert.equal(duplicate.play.redo.depth, 1);
  await accepted(reconnected, { t: "redo", head: duplicate.play.redo.head!.id });
  await engine.restart();
  const restarted = await engine.connect(roomId, device);
  const after = await restarted.snapshot("restarted");
  const fresh = await history(restarted, 0);
  assert.equal(records(after.state as RoomState)[id]?.state, "applied");
  assert.equal(records(after.state as RoomState)[id]?.revision, 3);
  assert.equal(fresh.play.undo.depth, 0);
  assert.equal(fresh.play.redo.depth, 0);
  assert.notEqual(fresh.epoch, first.epoch);
});

test("undo-scope-save: commit answer loss retries one tracked Apply and never duplicates damage or history", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const socket = await engine.connect(roomId, device);
  const snap = await socket.snapshot("commit-loss");
  await history(socket);
  const tokenId = uuidv7();
  await accepted(socket, { t: "token.create", token: { id: tokenId, sceneId: (snap.state as RoomState).meta.playerSceneId, size: "medium", kind: "monster", name: "Goblin", x: 2, y: 2, actor: { inline: actor({ hp: { cur: 20, max: 20, temp: 0 } }) } } });
  await history(socket);
  const failures = failCommits(engine.pool, ["committed"]);
  t.after(() => failures.restore());
  const id = uuidv7();
  const op = { t: "actor.outcome", plan: id, page: { id, expectRevision: 0 }, targets: [{ target: { tokenId }, amount: 3 }] };
  await accepted(socket, op);
  assert.equal(failures.remaining(), 0);
  const first = await history(socket);
  await accepted(socket, op);
  const duplicate = await history(socket);
  assert.deepEqual(duplicate.play, first.play);
  const check = await (await engine.connect(roomId, device)).snapshot("commit-loss-check");
  const state = check.state as RoomState;
  assert.equal((state.tokens[tokenId]!.actor as { inline: { hp: { cur: number } } }).inline.hp.cur, 17);
  assert.equal(records(state)[id]?.revision, 1);
  const persisted = await engine.pool.query("select op from room_ops where room_id = $1 and op->>'plan' = $2", [roomId, id]);
  assert.equal(persisted.rows.length, 1);
});

test("undo-scope-save: queued legacy Undo/Redo refuses without consuming the head and untracked Apply settles once", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const modern = await engine.connect(roomId, device);
  const snap = await modern.snapshot("modern");
  await history(modern);
  const tokenId = uuidv7();
  await accepted(modern, { t: "token.create", token: { id: tokenId, sceneId: (snap.state as RoomState).meta.playerSceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: { inline: actor({ hp: { cur: 20, max: 20, temp: 0 } }) } } });
  const before = await history(modern);
  const legacy = await engine.connect(roomId, device);
  await legacy.snapshot("legacy");
  await history(legacy);
  for (const t of ["undo", "redo"]) {
    const rejected = await legacy.apply({ t });
    assert.equal(rejected.rejects?.[0]?.message, "Reload to use Undo");
    assert.deepEqual((await history(legacy)).play, before.play);
  }
  const op = { t: "actor.outcome", plan: "old-queued-apply", targets: [{ target: { tokenId }, amount: 3 }] };
  await accepted(legacy, op);
  const applied = await history(legacy);
  await accepted(legacy, op);
  assert.deepEqual((await history(legacy)).play, applied.play);
  await accepted(legacy, { t: "log.chat", text: "queue continued" });
  const view = await (await engine.connect(roomId, device)).snapshot("legacy-check");
  const state = view.state as RoomState;
  assert.equal((state.tokens[tokenId]!.actor as { inline: { hp: { cur: number } } }).inline.hp.cur, 17);
  assert.deepEqual(records(state), {});
  assert.ok(state.log.some((line) => line.text === "queue continued"));
});

test("undo-scope-save: export retains status, new-room import drops it and player/display wire bytes never contain it", async (t) => {
  const engine = await startEngine();
  t.after(() => engine.close());
  const device = engine.client();
  const { roomId } = await device.createRoom();
  const dm = await engine.connect(roomId, device);
  const snapshot = await dm.snapshot("export");
  await history(dm);
  const tokenId = uuidv7();
  await accepted(dm, { t: "token.create", token: { id: tokenId, sceneId: (snapshot.state as RoomState).meta.playerSceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: { inline: actor() } } });
  const id = uuidv7();
  await accepted(dm, { t: "actor.outcome", plan: id, page: { id, expectRevision: 0 }, targets: [{ target: { tokenId } }] });
  const response = await device.request("GET", `/api/rooms/${roomId}/export`);
  assert.equal(response.statusCode, 200, response.body);
  const contents = await exported(response.rawPayload);
  assert.equal(contents.schemaVersion, 31);
  assert.equal(records(contents.state)[id]?.state, "applied");
  const importer = engine.client();
  const imported = await importer.request("POST", "/api/rooms/import", undefined, {
    "content-type": "application/zip",
    "x-import-form": Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url"),
  }, response.rawPayload);
  assert.equal(imported.statusCode, 201, imported.body);
  const newRoomId = imported.json<{ roomId: string }>().roomId;
  engine.track(newRoomId);
  const newView = await (await engine.connect(newRoomId, importer)).snapshot("import-check");
  assert.equal((newView.state as Tracked).saveOutcomes, undefined);
  const playerDevice = engine.client();
  await playerDevice.join(roomId);
  const player = await engine.connect(roomId, playerDevice);
  const playerView = await player.snapshot("privacy");
  const tv = engine.client();
  const code = (await device.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
  assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code) })).statusCode, 200);
  const display = await engine.connectDisplay(roomId, tv);
  const displayView = await display.snapshot("privacy-display");
  for (const view of [playerView, displayView]) {
    const bytes = JSON.stringify(view);
    for (const secret of [id, "saveOutcomes", "firstAppliedAt", "checkpoint", "beforeApply"]) assert.ok(!bytes.includes(secret), secret);
  }
});
