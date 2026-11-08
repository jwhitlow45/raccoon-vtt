import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState, Scene } from "#shared/model.ts";
import { stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { FLOOR_WORDS, floorProblem, floorsOf } from "#shared/rules/floors.ts";
import { floorFullWords } from "./actor.ts";
import { Connection } from "./connection.ts";
import type { RoomExport } from "./exportRoom.ts";
import { loadRoom } from "./persistence.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Several floors on the server (docs/design/design-v1-floors.md 9 and 15, lane
 * FLR-C): stored ops replay to the same room, the explore step runs once
 * for each floor players see, a scene's floors share one budget, Time of
 * day lights each floor by its own vision, and a backup carries floors and
 * their marks under new ids, refusing one whose floors do not fit together.
 */

const inline = (senses = "") => ({
  inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses, effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" },
});

const MONTHS = { kind: "months" as const, months: [{ name: "Deepwinter", days: 30 }] };

async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buffer);
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    out.set(entry.fileName, Buffer.concat(chunks));
  }
  return out;
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function importZip(client: TestClient, zip: Buffer) {
  const form = Buffer.from(JSON.stringify({ playerPassword: "owlbear-druid-wand", dmName: "Importer" })).toString("base64url");
  return client.request("POST", "/api/rooms/import", undefined, { "content-type": "application/zip", "x-import-form": form }, zip);
}

/** Every frame the socket receives from now on, as the text that crossed the wire. */
function wire(socket: Socket): string[] {
  const frames: string[] = [];
  socket.ws.on("message", (data) => frames.push(data.toString()));
  return frames;
}

type Tower = { roomId: string; dm: TestClient; dmSocket: Socket; dmKey: string; ground: string; ana: TestClient; anaId: string; bree: TestClient; breeId: string };

async function tower(t: Engine, name: string): Promise<Tower> {
  const dm = t.client();
  const { roomId, dmKey } = await dm.createRoom(name);
  const ana = t.client();
  const anaId = await ana.join(roomId, "Ana");
  const bree = t.client();
  const breeId = await bree.join(roomId, "Bree");
  const dmSocket = await t.connect(roomId, dm);
  const ground = ((await dmSocket.snapshot("dm")).state as ProjectedState).meta.playerSceneId!;
  await ok(dmSocket, { t: "scene.update", sceneId: ground, patch: { name: "Tower" } });
  return { roomId, dm, dmSocket, dmKey, ground, ana, anaId, bree, breeId };
}

async function ok(socket: Socket, op: Op): Promise<Extract<ServerMessage, { t: "ev" }>> {
  const ev = await socket.apply(op);
  assert.deepEqual(ev.rejects ?? [], [], `${op.t} was refused`);
  return ev;
}

async function addFloor(socket: Socket, beside: string, side: "above" | "below", name?: string): Promise<string> {
  const id = uuidv7();
  await ok(socket, { t: "scene.create", scene: { id, name: "Tower", bounds: { w: 30, h: 20 } }, floor: { beside, side } } as Op);
  if (name) await ok(socket, { t: "scene.update", sceneId: id, patch: { floor: { name } } } as Op);
  return id;
}

async function create(socket: Socket, sceneId: string, fields: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await ok(socket, { t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: inline(), ...fields } } as Op);
  return id;
}

const live = (t: Engine, roomId: string): RoomState => t.manager.get(roomId)!.committed.state;

describe("several floors on the server (docs/design/design-v1-floors.md 9)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("a tower's stored ops replay to the same room, its floors and marks included, and its snapshot loads the same", async () => {
    const r = await tower(t, "Replay");
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const cellar = await addFloor(r.dmSocket, r.ground, "below", "Cellar");
    const thorn = await create(r.dmSocket, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId] });
    await ok(r.dmSocket, { t: "token.update", tokenId: thorn, patch: { sceneId: upper } } as Op);
    await ok(r.dmSocket, { t: "floor.open", sceneId: cellar, open: true } as Op);
    await ok(r.dmSocket, { t: "floor.order", sceneId: r.ground, floors: [r.ground, cellar, upper] } as Op);
    const before = live(t, r.roomId);
    assert.equal(floorsOf(before, r.ground).length, 3);
    for (const id of [r.ground, upper, cellar]) assert.equal(floorProblem(before, id), null);
    assert.deepEqual(Object.keys(before.openFloors ?? {}).sort(), [r.ground, upper, cellar].sort(), "the start floor, Thorn's and the shown one");
    await t.manager.unload(r.roomId, 1011, false);
    const replayed = await loadRoom(t.pool, r.roomId);
    assert.ok(replayed && !replayed.replayFailed);
    assert.equal(stableStringify(replayed.state.scenes), stableStringify(before.scenes));
    assert.equal(stableStringify(replayed.state.openFloors), stableStringify(before.openFloors));
    assert.equal(stableStringify(replayed.state.tokens), stableStringify(before.tokens));
    const back = await t.connect(r.roomId, r.dm);
    await back.snapshot("dm-again");
    await ok(back, { t: "log.chat", text: "fence" });
    back.close();
    await back.waitClosed();
    await t.manager.unload(r.roomId);
    const reloaded = await loadRoom(t.pool, r.roomId);
    assert.equal(stableStringify(reloaded!.state.scenes), stableStringify(before.scenes), "through the snapshot too");
    assert.equal(stableStringify(reloaded!.state.openFloors), stableStringify(before.openFloors));
  });

  test("the explore step runs once for each floor players see, and never on one they have not reached", async () => {
    const r = await tower(t, "Explore");
    const dark = { fogEnabled: true, vision: { on: true, light: "dark" as const } };
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: dark } as Op);
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const attic = await addFloor(r.dmSocket, upper, "above", "Attic");
    for (const id of [upper, attic]) assert.equal(live(t, r.roomId).scenes[id]?.fogEnabled, true, "a new floor copies fog and vision from the one beside it");
    await create(r.dmSocket, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId], x: 5, y: 5, actor: inline("Darkvision 60 ft.") });
    await create(r.dmSocket, upper, { kind: "pc", name: "Wren", ownerIds: [r.breeId], x: 5, y: 5, actor: inline("Darkvision 60 ft.") });
    // Ana's hidden scout on Attic sees, but Attic is not reached, so nothing there is explored.
    await create(r.dmSocket, attic, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 5, y: 5, actor: inline("Darkvision 60 ft.") });
    const ev = await ok(r.dmSocket, { t: "log.chat", text: "a batch" });
    const explores = await t.pool.query<{ scene: string }>("select op->>'sceneId' as scene from room_ops where room_id = $1 and op->>'t' = 'sys.explore' order by seq", [r.roomId]);
    const scenes = new Set(explores.rows.map((row) => row.scene));
    assert.ok(scenes.has(r.ground) && scenes.has(upper), "Ground and Upper each explored");
    assert.ok(!scenes.has(attic), "Attic never");
    const state = live(t, r.roomId);
    const exploredOn = (id: string) => Object.values(state.exploredTiles).some((tile) => tile.sceneId === id);
    assert.ok(exploredOn(r.ground) && exploredOn(upper) && !exploredOn(attic));
    assert.ok(ev.seq > 0);
  });

  test("a walk on a floor players see ends the batch staged before it, and one on a floor they have not reached keeps batching", async () => {
    const r = await tower(t, "Walks");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { fogEnabled: true, vision: { on: true, light: "dark" } } } as Op);
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const gargoyle = await create(r.dmSocket, upper, { name: "Gargoyle" });
    await create(r.dmSocket, upper, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm" });
    const actor = t.manager.get(r.roomId)!;
    const dmId = Object.values(live(t, r.roomId).members).find((m) => m.kind === "dm")!.id;
    // Ops sent in one turn of the actor's queue, as actor.test.ts sends them, so they share a batch unless the walk ends it.
    const together = async (x: number): Promise<boolean> => {
      const sent: ServerMessage[] = [];
      const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
      const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: r.roomId, memberId: dmId, role: "dm" }, "203.0.113.9");
      assert.ok(actor.attach(conn));
      await actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
      void actor.op(conn, 1, { t: "log.chat", text: "one" });
      void actor.op(conn, 2, { t: "token.move", tokenId: gargoyle, x, y: 2 });
      const acked = (n: number) => sent.find((m) => m.t === "ev" && (m.acks ?? []).includes(n));
      for (let i = 0; i < 400 && acked(2) === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(acked(1) && acked(2), "both ops acked");
      actor.detach(conn);
      return acked(1) === acked(2);
    };
    assert.equal(await together(6), true, "Upper is not reached, and Ana's hidden creature there does not reach it, so the walk keeps batching");
    await ok(r.dmSocket, { t: "floor.open", sceneId: upper, open: true } as Op);
    assert.equal(await together(7), false, "once Upper is shown, the walk there ends the batch");
  });

  test("on a floor of the players' scene beside the start floor, what a party member walks back into sight of is live again, in a batch that only moved them", async () => {
    const r = await tower(t, "Remember upstairs");
    const dark = { fogEnabled: true, vision: { on: true, light: "dark" as const } };
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: dark } as Op);
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const wren = await create(r.dmSocket, upper, { kind: "pc", name: "Wren", ownerIds: [r.breeId], x: 12, y: 5, actor: inline("Darkvision 30 ft.") });
    // Wren sees the ground by x = 15, then walks off, and the DM adds a wall there out of her sight.
    await ok(r.dmSocket, { t: "token.move", tokenId: wren, x: 2, y: 5 });
    await ok(r.dmSocket, { t: "build.edge", sceneId: upper, edges: [{ key: "15,5,w", feature: { kind: "wall" } }] } as Op);
    const entry = () => Object.values(live(t, r.roomId).memory ?? {}).find((c) => c.sceneId === upper && c.edges !== undefined && "15,5,w" in c.edges);
    assert.ok(entry(), "players' memory of Upper keeps the ground as Wren last saw it, without the wall");
    // Her walk back writes nothing on Upper, yet the map step runs there and lets the entry go, since she sees the wall now.
    await ok(r.dmSocket, { t: "token.move", tokenId: wren, x: 12, y: 5 });
    assert.equal(entry(), undefined, "what she sees again is live");
  });

  test("Time of day on Roof alone: past dusk Roof goes Dim, Ground keeps its level, and a player holding Ground alone receives nothing of Roof", async () => {
    const r = await tower(t, "Daylight");
    const roof = await addFloor(r.dmSocket, r.ground, "above", "Roof");
    await create(r.dmSocket, r.ground, { kind: "pc", name: "Thorn", ownerIds: [r.anaId] });
    await create(r.dmSocket, roof, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm" });
    const bree = await t.connect(r.roomId, r.bree);
    const frames = wire(bree);
    await bree.snapshot("bree");
    await ok(r.dmSocket, { t: "clock.start", id: uuidv7(), at: 17 * 3_600 + 30 * 60, shown: false, calendar: MONTHS } as Op);
    await ok(r.dmSocket, { t: "clock.update", daylight: { dawn: 5 * 3_600 + 30 * 60, dusk: 18 * 3_600 } } as Op);
    await ok(r.dmSocket, { t: "scene.update", sceneId: roof, patch: { vision: { on: false, light: "bright", byClock: true } } } as Op);
    await ok(r.dmSocket, { t: "clock.advance", by: 3_600 } as Op);
    const state = live(t, r.roomId);
    assert.equal(state.scenes[roof]?.vision?.light, "dim", "Roof follows the clock");
    assert.notEqual(state.scenes[r.ground]?.vision?.light, "dim", "Ground keeps its own level");
    await ok(r.dmSocket, { t: "log.chat", text: "fence" });
    await bree.next("ev", (m) => JSON.stringify(m).includes("fence"));
    assert.deepEqual(frames.filter((f) => f.includes(roof) || f.includes('"Roof"')), [], "Bree receives nothing of Roof");
    bree.close();
  });

  test("empty Ground as the players' scene, add Upper, undo, then redo: no stray mark after the undo, Ground marked again after the redo", async () => {
    const r = await tower(t, "Undo an add");
    const upper = await addFloor(r.dmSocket, r.ground, "above");
    const added = live(t, r.roomId);
    assert.ok(added.openFloors?.[r.ground], "the first add marks the start floor");
    assert.equal(added.scenes[r.ground]?.floor?.name, "Ground floor");
    // The add and its name are one step each: undo the add.
    await ok(r.dmSocket, { t: "undo", head: (await r.dmSocket.historyHead("setup", "undo"))!, scope: "setup" } as Op);
    const undone = live(t, r.roomId);
    assert.equal(undone.scenes[upper], undefined);
    assert.equal(undone.scenes[r.ground]?.floor, undefined, "a plain scene again");
    assert.deepEqual(Object.keys(undone.openFloors ?? {}), [], "and no stray mark, which the floor check would refuse");
    assert.equal(floorProblem(undone, r.ground), null);
    await ok(r.dmSocket, { t: "redo", head: (await r.dmSocket.historyHead("setup", "redo"))!, scope: "setup" } as Op);
    const redone = live(t, r.roomId);
    assert.ok(redone.scenes[upper]?.floor);
    assert.ok(redone.openFloors?.[r.ground], "Ground marked again");
    for (const id of [r.ground, upper]) assert.equal(floorProblem(redone, id), null);
    // And the snapshot round-trips.
    await t.manager.unload(r.roomId);
    const reloaded = await loadRoom(t.pool, r.roomId);
    assert.equal(stableStringify(reloaded!.state.scenes), stableStringify(redone.scenes));
    assert.equal(stableStringify(reloaded!.state.openFloors), stableStringify(redone.openFloors));
  });

  test("Delete of a scene with floors takes every floor, and its undo brings them back with their contents", async () => {
    const r = await tower(t, "Delete set");
    const cave = uuidv7();
    await ok(r.dmSocket, { t: "scene.create", scene: { id: cave, name: "Cave", bounds: { w: 20, h: 20 } } });
    await ok(r.dmSocket, { t: "room.setPlayerScene", sceneId: cave });
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const bat = await create(r.dmSocket, upper, { name: "Bat" });
    const before = live(t, r.roomId);
    await ok(r.dmSocket, { t: "scene.delete", sceneId: r.ground } as Op);
    const gone = live(t, r.roomId);
    assert.equal(gone.scenes[r.ground], undefined);
    assert.equal(gone.scenes[upper], undefined, "the main floor's Delete takes every floor");
    assert.equal(gone.tokens[bat], undefined, "with what stands on them");
    // The DM viewed Tower, so their socket is sent back to the players' scene.
    await r.dmSocket.next("resync");
    await r.dmSocket.snapshot("dm");
    await ok(r.dmSocket, { t: "undo", head: (await r.dmSocket.historyHead("setup", "undo"))!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    // A restore writes each record under a rev of its own, so the records compare without it.
    const records = (state: RoomState) => stableStringify(Object.fromEntries(Object.entries(state.scenes).map(([id, { rev: _rev, ...scene }]) => [id, scene])));
    assert.equal(records(back), records(before), "every floor back as it was");
    assert.ok(back.tokens[bat]);
    for (const id of [r.ground, upper]) assert.equal(floorProblem(back, id), null);
  });

  test("an undo that would leave two floors on one level is refused by the floor check, in the DM's words", async () => {
    const r = await tower(t, "Two DMs");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const attic = await addFloor(r.dmSocket, upper, "above", "Attic");
    // The DM removes the top floor, which touches no other floor, and the co-DM adds a new top floor meanwhile.
    await ok(r.dmSocket, { t: "scene.delete", sceneId: attic } as Op);
    await addFloor(coSocket, upper, "above", "Belfry");
    const head = await r.dmSocket.historyHead("setup", "undo");
    const refused = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    const words = Object.values(FLOOR_WORDS).map((w) => w("Tower", "Belfry"));
    assert.ok(refused.rejects?.some((x) => words.some((w) => x.message.includes(w))), JSON.stringify(refused.rejects));
    const state = live(t, r.roomId);
    assert.equal(state.scenes[attic], undefined, "the room is as it was");
    for (const id of Object.keys(state.scenes)) assert.equal(floorProblem(state, id), null);
    coSocket.close();
  });

  test("a backup carries floors and their marks under new ids, and a hand-made one whose floors do not fit together is refused", async () => {
    const r = await tower(t, "Backup");
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const second = uuidv7();
    await ok(r.dmSocket, { t: "scene.create", scene: { id: second, name: "Cave", bounds: { w: 20, h: 20 } } });
    await ok(r.dmSocket, { t: "floor.open", sceneId: upper, open: true } as Op);
    const res = await r.dm.get(`/api/rooms/${r.roomId}/export`);
    assert.equal(res.statusCode, 200);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.equal(room.schemaVersion, SNAPSHOT_VERSION);
    assert.ok(room.state.openFloors?.[upper], "the backup carries the marks");
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const { rows } = await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId]);
    const state = rows[0]!.state;
    const floors = Object.values(state.scenes).filter((s) => s.floor !== undefined);
    assert.equal(floors.length, 2);
    const main = floors.find((s) => s.floor!.of === s.id)!;
    const top = floors.find((s) => s.floor!.of !== s.id)!;
    assert.ok(![r.ground, upper].includes(main.id) && ![r.ground, upper].includes(top.id), "under new ids");
    assert.equal(top.floor!.of, main.id, "a floor names its main floor's new id");
    assert.equal(state.meta.playerSceneId, main.id);
    assert.deepEqual(Object.keys(state.openFloors ?? {}).sort(), [main.id, top.id].sort(), "the marks follow their floors");
    assert.deepEqual(state.openFloors?.[top.id]?.sceneId, top.id);
    assert.ok(state.playedScenes?.[top.id], "every floor of the players' scene is played");
    for (const id of Object.keys(state.scenes)) assert.equal(floorProblem(state, id), null);

    // A hand-made file without the floors' played marks, and with its players on a scene it lacks, listing a floor before its main floor.
    const bare = JSON.parse(JSON.stringify(room)) as RoomExport;
    bare.state.playedScenes = {};
    bare.state.meta.playerSceneId = uuidv7();
    const { [upper]: upperScene, ...rest } = bare.state.scenes;
    bare.state.scenes = { [upper]: upperScene!, ...rest };
    const fallback = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(bare) }));
    assert.equal(fallback.statusCode, 201, fallback.body);
    const fallbackId = fallback.json<{ roomId: string }>().roomId;
    t.track(fallbackId);
    const after = (await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [fallbackId])).rows[0]!.state;
    const start = after.scenes[after.meta.playerSceneId!]!;
    assert.ok(start.floor === undefined || start.floor.of === start.id, "players start on a main floor, never a floor named in its place");
    for (const scene of Object.values(after.scenes)) {
      if (scene.floor?.of === (start.floor?.of ?? start.id)) assert.ok(after.playedScenes?.[scene.id], "every floor of the players' scene is played");
    }

    const refuse = async (what: string, edit: (copy: RoomExport) => void) => {
      const copy = JSON.parse(JSON.stringify(room)) as RoomExport;
      edit(copy);
      const answer = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(copy) }));
      assert.equal(answer.statusCode, 400, `${what}: ${answer.body}`);
      return answer.body;
    };
    const scenes = (copy: RoomExport) => copy.state.scenes as Record<string, Scene>;
    assert.ok((await refuse("mixed grid shapes", (c) => (scenes(c)[upper]!.gridShape = "hexColumns" as Scene["gridShape"]))).includes("grid shape"));
    await refuse("a mark on a scene without floors", (c) => (c.state.openFloors = { ...c.state.openFloors, [second]: { sceneId: second, rev: 0 } }));
    await refuse("a floor whose main floor is gone", (c) => (scenes(c)[upper]!.floor!.of = uuidv7()));
    await refuse("two floors on one level", (c) => (scenes(c)[upper]!.floor!.level = 0));
    await refuse("two floors of one name", (c) => (scenes(c)[upper]!.floor!.name = "Ground floor"));
    await refuse("a floor under another name", (c) => (scenes(c)[upper]!.name = "Not Tower"));
    await refuse("a lone floor", (c) => {
      delete scenes(c)[upper];
      if (c.state.openFloors) delete c.state.openFloors[upper];
    });
    await refuse("a height off its steps", (c) => (scenes(c)[upper]!.floor!.height = 12));
  });
});

describe("a scene's floors share one budget (docs/design/design-v1-floors.md 9, D-261102-485)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000 } });
  });
  after(() => t.close());

  test("a tower of 200 by 200 floors with fog and party vision fills its budget before its eighth floor, and the add past it reads the DM's words", async () => {
    const r = await tower(t, "Big tower");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: true, light: "dark" } } } as Op);
    let top = r.ground;
    let refused: Extract<ServerMessage, { t: "ev" }> | null = null;
    for (let floors = 1; floors < 8 && refused === null; floors++) {
      const id = uuidv7();
      const ev = await r.dmSocket.apply({ t: "scene.create", scene: { id, name: "Tower", bounds: { w: 200, h: 200 } }, floor: { beside: top, side: "above" } } as Op);
      if (ev.rejects?.length) refused = ev;
      else top = id;
    }
    const held = floorsOf(live(t, r.roomId), r.ground).length;
    assert.ok(refused, "a scene of 200 by 200 floors with fog and vision cannot hold eight");
    assert.ok(held >= 4, `it holds ${held} first`);
    assert.deepEqual(
      refused.rejects?.map((x) => [x.code, x.message]),
      [["quota", floorFullWords("Tower")]],
    );
    // The guard counts every floor: the refused add left the scene as it was.
    assert.equal(floorsOf(live(t, r.roomId), r.ground).length, held);
  });
});
