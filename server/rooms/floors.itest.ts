import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import yauzl from "yauzl";
import yazl from "yazl";
import { uuidv7 } from "#shared/ids.ts";
import { LIMITS } from "#shared/limits.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { FloorLink, RoomState, Scene } from "#shared/model.ts";
import { stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { LINK_WORDS } from "#shared/rules/floorLinks.ts";
import { floorProblem, floorsOf } from "#shared/rules/floors.ts";
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

  test("a walk on a floor players see runs the explore step of the batch staged before it, in place, and one on a floor they have not reached runs none", async () => {
    const r = await tower(t, "Walks");
    await ok(r.dmSocket, { t: "scene.update", sceneId: r.ground, patch: { fogEnabled: true, vision: { on: true, light: "dark" } } } as Op);
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const gargoyle = await create(r.dmSocket, upper, { name: "Gargoyle" });
    const shade = await create(r.dmSocket, upper, { kind: "pc", name: "Shade", ownerIds: [r.anaId], visibility: "dm", x: 25, y: 10, actor: inline("Darkvision 30 ft.") });
    const actor = t.manager.get(r.roomId)!;
    const dmId = Object.values(live(t, r.roomId).members).find((m) => m.kind === "dm")!.id;
    // Shade's move, then the walk, sent in one turn of the actor's queue, as actor.test.ts sends them, so they share a batch.
    const together = async (shadeX: number, x: number): Promise<string[]> => {
      const { rows: mark } = await t.pool.query<{ seq: string }>("select coalesce(max(seq), 0)::text as seq from room_ops where room_id = $1", [r.roomId]);
      const sent: ServerMessage[] = [];
      const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => sent.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
      const conn = new Connection(socket as never, { sessionId: uuidv7(), roomId: r.roomId, memberId: dmId, role: "dm" }, "203.0.113.9");
      assert.ok(actor.attach(conn));
      await actor.hello(conn, { clientId: uuidv7(), resumeFrom: 1 });
      for (let i = 0; i < 400 && !sent.some((m) => m.t === "snapshot"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      void actor.op(conn, 1, { t: "token.move", tokenId: shade, x: shadeX, y: 10 });
      void actor.op(conn, 2, { t: "token.move", tokenId: gargoyle, x, y: 2 });
      const acked = (n: number) => sent.find((m) => m.t === "ev" && (m.acks ?? []).includes(n));
      for (let i = 0; i < 400 && acked(2) === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(acked(1) && acked(1) === acked(2), "both ops acked in one frame");
      actor.detach(conn);
      const { rows } = await t.pool.query<{ t: string; scene: string | null; token: string | null }>(
        "select op->>'t' as t, op->>'sceneId' as scene, op->>'tokenId' as token from room_ops where room_id = $1 and seq > $2 order by seq",
        [r.roomId, mark[0]!.seq],
      );
      return rows.flatMap((row) => (row.token === shade ? ["shade"] : row.token === gargoyle ? ["walk"] : row.t === "sys.explore" && row.scene === upper ? ["explore"] : []));
    };
    assert.deepEqual(await together(24, 6), ["shade", "walk"], "Upper is not reached, and Ana's hidden creature there does not reach it, so nothing there is explored");
    await ok(r.dmSocket, { t: "floor.open", sceneId: upper, open: true } as Op);
    // Shown to players, Shade's sight is the party's, so the move below shows them new ground.
    await ok(r.dmSocket, { t: "token.update", tokenId: shade, patch: { visibility: "all" } } as Op);
    assert.deepEqual(await together(4, 7), ["shade", "explore", "walk"], "once Upper is shown, the ground Shade's move shows is explored before the walk");
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

  test("an undo that would leave two floors on one level is refused, keeps its step, and works once the new floor is gone (LP35-A-FLR-1)", async () => {
    const r = await tower(t, "Two DMs");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const attic = await addFloor(r.dmSocket, upper, "above", "Attic");
    const pairs = [uuidv7(), uuidv7()];
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: pairs[0]!, pairId: uuidv7(), sceneId: upper, to: attic, rect: STAIRS, kind: "stairs" } } as Op);
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: pairs[1]!, pairId: uuidv7(), sceneId: upper, to: attic, rect: { x: 8, y: 8, w: 1, h: 1 }, kind: "ladder" } } as Op);
    // The DM removes the top floor with both pairs, and the co-DM adds a new top floor meanwhile.
    await ok(r.dmSocket, { t: "scene.delete", sceneId: attic } as Op);
    const fresh = await addFloor(coSocket, upper, "above", "New floor");
    const head = await r.dmSocket.historyHead("setup", "undo");
    const answer = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    assert.match(refused(answer), /^could not undo removing .*Attic.*: A floor added or moved since holds Attic's place\. Remove or move it, then Undo again\.$/);
    const state = live(t, r.roomId);
    assert.equal(state.scenes[attic], undefined, "the room is as it was");
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept");
    await ok(coSocket, { t: "scene.delete", sceneId: fresh } as Op);
    await ok(r.dmSocket, { t: "undo", head: head!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    assert.ok(back.scenes[attic]?.floor, "Attic is back");
    for (const id of pairs) assert.ok(back.floorLinks?.[id], "and both its pairs");
    for (const id of Object.keys(back.scenes)) assert.equal(floorProblem(back, id), null);
    coSocket.close();
  });

  test("a floor added under the others since pushes an old floor onto the level, so the words name no floor, and the step stays (B53-OPUS-1)", async () => {
    const r = await tower(t, "Add below");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    const attic = await addFloor(r.dmSocket, upper, "above", "Attic");
    await ok(r.dmSocket, { t: "scene.delete", sceneId: attic } as Op);
    // The new bottom floor renumbers the rest, so Upper floor now stands on Attic's level.
    const cellar = await addFloor(coSocket, r.ground, "below", "Cellar");
    assert.equal(live(t, r.roomId).scenes[upper]?.floor?.level, 2);
    const head = await r.dmSocket.historyHead("setup", "undo");
    const answer = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    assert.match(refused(answer), /^could not undo removing .*Attic.*: A floor added or moved since holds Attic's place\. Remove or move it, then Undo again\.$/);
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept");
    await ok(coSocket, { t: "scene.delete", sceneId: cellar } as Op);
    await ok(r.dmSocket, { t: "undo", head: head!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    assert.equal(back.scenes[attic]?.floor?.level, 2, "Attic is back on its level");
    for (const id of Object.keys(back.scenes)) assert.equal(floorProblem(back, id), null);
    coSocket.close();
  });

  test("a redo refused because a floor holds the level its floor comes back to says Redo again, and keeps its step (B53-SOL-03)", async () => {
    const r = await tower(t, "Redo taken");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
    // Left with its free name, so the add is the DM's newest step.
    const top = await addFloor(r.dmSocket, upper, "above");
    await ok(r.dmSocket, { t: "undo", head: (await r.dmSocket.historyHead("setup", "undo"))!, scope: "setup" } as Op);
    assert.equal(live(t, r.roomId).scenes[top], undefined);
    const roof = await addFloor(coSocket, upper, "above", "Roof");
    const head = await r.dmSocket.historyHead("setup", "redo");
    const answer = await r.dmSocket.apply({ t: "redo", head: head!, scope: "setup" } as Op);
    assert.match(refused(answer), /^could not redo .*: A floor added or moved since holds New floor's place\. Remove or move it, then Redo again\.$/);
    assert.equal(live(t, r.roomId).scenes[top], undefined, "the room is as it was");
    assert.equal(await r.dmSocket.historyHead("setup", "redo"), head, "the step is kept");
    await ok(coSocket, { t: "scene.delete", sceneId: roof } as Op);
    await ok(r.dmSocket, { t: "redo", head: head!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    assert.equal(back.scenes[top]?.floor?.level, 2, "the floor is back on its level");
    for (const id of Object.keys(back.scenes)) assert.equal(floorProblem(back, id), null);
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

/** Stairs' squares on both floors: two squares wide, as the tower tests place them. */
const STAIRS = { x: 3, y: 3, w: 2, h: 1 };

type Stairs = Tower & { upper: string; thorn: string; link: string; pair: string; anaSocket: Socket };

/**
 * Tower with Upper floor above Ground floor, stairs between them at STAIRS
 * (`link` on Ground floor, `pair` on Upper floor), and Thorn, Ana's
 * creature, on Ground floor 25 ft south of them. `fight` starts a fight on
 * Thorn's turn, so its moves write their path.
 */
async function stairsTower(t: Engine, name: string, fight = true): Promise<Stairs> {
  const r = await tower(t, name);
  const upper = await addFloor(r.dmSocket, r.ground, "above", "Upper floor");
  const thorn = await create(r.dmSocket, r.ground, { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: [r.anaId], x: 3, y: 8 });
  const link = uuidv7();
  const pair = uuidv7();
  await ok(r.dmSocket, { t: "floorLink.put", link: { id: link, pairId: pair, sceneId: r.ground, to: upper, rect: STAIRS, kind: "stairs" } } as Op);
  if (fight) {
    await ok(r.dmSocket, { t: "encounter.start", entries: [{ id: uuidv7(), tokenId: thorn, value: 20 }] } as Op);
    await ok(r.dmSocket, { t: "encounter.next" } as Op);
  }
  const anaSocket = await t.connect(r.roomId, r.ana);
  await anaSocket.snapshot("ana");
  return { ...r, upper, thorn, link, pair, anaSocket };
}

/** Where a token stands and its turn's path. */
function pose(state: RoomState, tokenId: string) {
  const token = state.tokens[tokenId]!;
  return { sceneId: token.sceneId, x: token.x, y: token.y, elevation: token.elevation, path: token.path };
}

/** The one refusal of a socket's op, its words. */
function refused(ev: Extract<ServerMessage, { t: "ev" }>): string {
  assert.equal(ev.rejects?.length, 1, `one refusal: ${JSON.stringify(ev.acks)}`);
  return ev.rejects![0]!.message;
}

describe("stairs and ladders on the server (docs/design/design-v1-floors.md phase 2, lane FL2-C)", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("Ana's Undo takes Thorn down the stairs it climbed and her Redo up again, twice, its walk's 25 ft kept upstairs, each toast naming the climb", async () => {
    const r = await stairsTower(t, "Climb undo");
    await ok(r.anaSocket, { t: "token.move", tokenId: r.thorn, x: 3, y: 3 });
    const below = pose(live(t, r.roomId), r.thorn);
    await ok(r.anaSocket, { t: "token.climb", tokenId: r.thorn, linkId: r.link });
    const above = pose(live(t, r.roomId), r.thorn);
    assert.equal(above.sceneId, r.upper);
    assert.equal(above.path?.prior?.moved, 25, "the walk downstairs is the turn's before the climb");
    for (let i = 0; i < 2; i++) {
      const undone = await ok(r.anaSocket, { t: "undo", head: (await r.anaSocket.historyHead("play", "undo"))! } as Op);
      assert.deepEqual(undone.restored?.map((x) => x.what), ["moving Thorn up the stairs"]);
      assert.deepEqual(pose(live(t, r.roomId), r.thorn), below, `undo ${i + 1}`);
      await ok(r.anaSocket, { t: "redo", head: (await r.anaSocket.historyHead("play", "redo"))! } as Op);
      assert.deepEqual(pose(live(t, r.roomId), r.thorn), above, `redo ${i + 1}`);
    }
    r.anaSocket.close();
  });

  test("Doesn't count on the climb keeps the 25 ft walked downstairs, which a reload and a backup carry, its stairs under new ids", async () => {
    const r = await stairsTower(t, "Climb kept");
    await ok(r.anaSocket, { t: "token.move", tokenId: r.thorn, x: 3, y: 3 });
    await ok(r.anaSocket, { t: "token.climb", tokenId: r.thorn, linkId: r.link });
    await ok(r.anaSocket, { t: "token.countLeg", tokenId: r.thorn, counts: false } as Op);
    const before = live(t, r.roomId);
    const path = before.tokens[r.thorn]!.path!;
    assert.equal(path.prior?.moved, 25, "the 25 ft stay");
    assert.equal(path.stops.at(-1)?.uncounted, true, "the climb itself is not counted");
    r.anaSocket.close();
    await r.anaSocket.waitClosed();
    await t.manager.unload(r.roomId);
    const reloaded = await loadRoom(t.pool, r.roomId);
    assert.ok(reloaded && !reloaded.replayFailed);
    assert.equal(stableStringify(reloaded.state.tokens[r.thorn]), stableStringify(before.tokens[r.thorn]), "a reload keeps the path whole");
    assert.equal(stableStringify(reloaded.state.floorLinks), stableStringify(before.floorLinks));

    const res = await r.dm.get(`/api/rooms/${r.roomId}/export`);
    assert.equal(res.statusCode, 200);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    assert.deepEqual(room.state.tokens[r.thorn]!.path?.prior, path.prior, "the backup carries the feet of floors left");
    const imported = await importZip(t.client(), await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const newId = imported.json<{ roomId: string }>().roomId;
    t.track(newId);
    const state = (await t.pool.query<{ state: RoomState }>("select state from room_snapshots where room_id = $1", [newId])).rows[0]!.state;
    const ends = Object.values(state.floorLinks ?? {});
    assert.equal(ends.length, 2);
    const floorIds = new Set(Object.keys(state.scenes));
    for (const end of ends) {
      assert.ok(![r.link, r.pair].includes(end.id), "a new id");
      assert.ok(floorIds.has(end.sceneId) && floorIds.has(end.to), "on the new floors");
      assert.equal(state.floorLinks![end.pair]?.pair, end.id, "each names the other");
      assert.equal(end.made, before.floorLinks![r.link]!.made, "the stamp stays");
    }
    for (const id of Object.keys(state.scenes)) assert.equal(floorProblem(state, id), null);
  });

  test("stairs removed and placed again with the same ids over a raised landing are other stairs: Ana's Undo answers the stairs changed (ASTRA-14)", async () => {
    const r = await stairsTower(t, "Placed again");
    await ok(r.anaSocket, { t: "token.move", tokenId: r.thorn, x: 3, y: 3 });
    await ok(r.anaSocket, { t: "token.climb", tokenId: r.thorn, linkId: r.link });
    await ok(r.dmSocket, { t: "floorLink.delete", linkId: r.link } as Op);
    await ok(r.dmSocket, { t: "build.height", sceneId: r.ground, cells: ["3,3", "4,3"], height: 5 } as Op);
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: r.link, pairId: r.pair, sceneId: r.ground, to: r.upper, rect: STAIRS, kind: "stairs" } } as Op);
    const answer = await r.anaSocket.apply({ t: "undo", head: (await r.anaSocket.historyHead("play", "undo"))! } as Op);
    assert.equal(refused(answer), `could not undo moving Thorn up the stairs: ${LINK_WORDS.changed("stairs")}`);
    assert.equal(live(t, r.roomId).tokens[r.thorn]!.sceneId, r.upper);
    r.anaSocket.close();
  });

  test("a backup whose stairs were placed past every op its lines name starts its room past them, so stairs placed again there are other stairs (ASTRA-16)", async () => {
    const r = await stairsTower(t, "Stamped", false);
    r.anaSocket.close();
    const res = await r.dm.get(`/api/rooms/${r.roomId}/export`);
    const room = JSON.parse((await unzip(res.rawPayload)).get("room.json")!.toString()) as RoomExport;
    const late = 100_000;
    for (const end of Object.values(room.state.floorLinks!)) end.made = late;
    const importer = t.client();
    const imported = await importZip(importer, await zipOf({ "room.json": JSON.stringify(room) }));
    assert.equal(imported.statusCode, 201, imported.body);
    const copyId = imported.json<{ roomId: string }>().roomId;
    t.track(copyId);
    const { rows } = await t.pool.query<{ imported_seq: string }>("select imported_seq from rooms where id = $1", [copyId]);
    assert.ok(Number(rows[0]!.imported_seq) >= late, `the room starts past the stamp: ${rows[0]!.imported_seq}`);
    const dm = await t.connect(copyId, importer);
    const view = (await dm.snapshot("dm")).state as ProjectedState;
    const cara = t.client();
    const caraId = await cara.join(copyId, "Cara");
    const thorn = Object.values(view.tokens).find((x) => x.name === "Thorn")!.id;
    const ends = Object.values(view.floorLinks!) as FloorLink[];
    const lower = ends.find((end) => view.scenes[end.sceneId]?.floor?.level === 0);
    const upper = ends.find((end) => end !== lower);
    await ok(dm, { t: "token.update", tokenId: thorn, patch: { ownerIds: [caraId], x: 3, y: 3 } } as Op);
    const caraSocket = await t.connect(copyId, cara);
    await caraSocket.snapshot("cara");
    await ok(caraSocket, { t: "token.climb", tokenId: thorn, linkId: lower!.id });
    await ok(dm, { t: "floorLink.delete", linkId: lower!.id } as Op);
    await ok(dm, { t: "floorLink.put", link: { id: lower!.id, pairId: upper!.id, sceneId: lower!.sceneId, to: upper!.sceneId, rect: STAIRS, kind: "stairs" } } as Op);
    assert.ok(live(t, copyId).floorLinks![lower!.id]!.made > late, "placed again past the stamp");
    const answer = await caraSocket.apply({ t: "undo", head: (await caraSocket.historyHead("play", "undo"))! } as Op);
    assert.equal(refused(answer), `could not undo moving Thorn up the stairs: ${LINK_WORDS.changed("stairs")}`);
    caraSocket.close();
    dm.close();
  });

  test("DM A's undo of a Remove floor after co-DM B placed stairs between the floors beside it is refused with its step kept, and works once B removes them (D-261109-108)", async () => {
    const r = await tower(t, "Kept step");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const middle = await addFloor(r.dmSocket, r.ground, "above", "Middle floor");
    const upper = await addFloor(r.dmSocket, middle, "above", "Upper floor");
    await ok(r.dmSocket, { t: "scene.delete", sceneId: middle } as Op);
    const link = uuidv7();
    await ok(coSocket, { t: "floorLink.put", link: { id: link, pairId: uuidv7(), sceneId: r.ground, to: upper, rect: STAIRS, kind: "stairs" } } as Op);
    const head = await r.dmSocket.historyHead("setup", "undo");
    const answer = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    assert.match(refused(answer), /^could not undo removing .*Middle floor.*: Stairs join Ground floor and Upper floor\. The DM who placed them can remove them\.$/);
    assert.equal(live(t, r.roomId).scenes[middle], undefined, "the room is as it was");
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept");
    await ok(coSocket, { t: "floorLink.delete", linkId: link } as Op);
    await ok(r.dmSocket, { t: "undo", head: head!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    assert.ok(back.scenes[middle]?.floor, "Middle floor is back");
    for (const id of Object.keys(back.scenes)) assert.equal(floorProblem(back, id), null);
    coSocket.close();
  });

  test("the same where the removed floor had stairs of its own: the words still name the stairs that stand, not stairs that would come back with the floor (FL2-OPUS-10)", async () => {
    const r = await tower(t, "Kept step with stairs");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const middle = await addFloor(r.dmSocket, r.ground, "above", "Middle floor");
    const upper = await addFloor(r.dmSocket, middle, "above", "Upper floor");
    const own = uuidv7();
    await ok(r.dmSocket, { t: "floorLink.put", link: { id: own, pairId: uuidv7(), sceneId: r.ground, to: middle, rect: STAIRS, kind: "stairs" } } as Op);
    await ok(r.dmSocket, { t: "scene.delete", sceneId: middle } as Op);
    assert.equal(live(t, r.roomId).floorLinks?.[own], undefined, "its stairs went with it");
    const link = uuidv7();
    await ok(coSocket, { t: "floorLink.put", link: { id: link, pairId: uuidv7(), sceneId: r.ground, to: upper, rect: { x: 8, y: 8, w: 1, h: 1 }, kind: "stairs" } } as Op);
    const head = await r.dmSocket.historyHead("setup", "undo");
    const answer = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    assert.match(refused(answer), /^could not undo removing .*Middle floor.*: Stairs join Ground floor and Upper floor\. The DM who placed them can remove them\.$/);
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept");
    await ok(coSocket, { t: "floorLink.delete", linkId: link } as Op);
    await ok(r.dmSocket, { t: "undo", head: head!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    assert.ok(back.scenes[middle]?.floor && back.floorLinks?.[own], "Middle floor and its stairs are back");
    for (const id of Object.keys(back.scenes)) assert.equal(floorProblem(back, id), null);
    coSocket.close();
  });

  test("an undo of Remove floor whose stairs a co-DM's wall on the floor below now blocks names the wall, keeps its step, and works once the wall is gone (FL2-ASTRA-04)", async () => {
    const r = await stairsTower(t, "Floor back onto a wall", false);
    r.anaSocket.close();
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    await ok(r.dmSocket, { t: "scene.delete", sceneId: r.upper } as Op);
    await ok(coSocket, { t: "build.edge", sceneId: r.ground, edges: [{ key: "4,3,w", feature: { kind: "wall" } }] } as Op);
    const head = await r.dmSocket.historyHead("setup", "undo");
    const answer = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    assert.match(refused(answer), /^could not undo removing .*Upper floor.*: A wall crosses those squares on Ground floor\.$/);
    assert.equal(live(t, r.roomId).scenes[r.upper], undefined);
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept");
    await ok(coSocket, { t: "build.edge", sceneId: r.ground, edges: [{ key: "4,3,w", feature: null }] } as Op);
    await ok(r.dmSocket, { t: "undo", head: head!, scope: "setup" } as Op);
    const back = live(t, r.roomId);
    assert.ok(back.scenes[r.upper]?.floor && back.floorLinks?.[r.link], "Upper floor and its stairs are back");
    coSocket.close();
  });

  test("the same with A removing the stairs in Setup: A's next Undo takes back A's own removal, as the history rules say", async () => {
    const r = await tower(t, "Own removal");
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const middle = await addFloor(r.dmSocket, r.ground, "above", "Middle floor");
    const upper = await addFloor(r.dmSocket, middle, "above", "Upper floor");
    await ok(r.dmSocket, { t: "scene.delete", sceneId: middle } as Op);
    const link = uuidv7();
    await ok(coSocket, { t: "floorLink.put", link: { id: link, pairId: uuidv7(), sceneId: r.ground, to: upper, rect: STAIRS, kind: "stairs" } } as Op);
    const head = await r.dmSocket.historyHead("setup", "undo");
    refused(await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op));
    await ok(r.dmSocket, { t: "floorLink.delete", linkId: link } as Op);
    const undone = await ok(r.dmSocket, { t: "undo", head: (await r.dmSocket.historyHead("setup", "undo"))!, scope: "setup" } as Op);
    assert.deepEqual(undone.restored?.map((x) => x.what), ["removing stairs to Upper floor"]);
    assert.ok(live(t, r.roomId).floorLinks?.[link], "the stairs are back");
    assert.equal(live(t, r.roomId).scenes[middle], undefined);
    coSocket.close();
  });

  test("a trap op meets its scene's checks now that the floor check reads its floor: the 51st trap on Ground floor is refused", async () => {
    const r = await stairsTower(t, "Trap cap", false);
    r.anaSocket.close();
    const rig = { on: ["enter"], who: "any", floor: true, resets: "never", stops: false, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false };
    const plate = (i: number): Op => ({ t: "trap.create", trap: { id: `plate-${uuidv7()}`, sceneId: r.ground, name: "Plate", zone: { cells: [{ x: 10 + (i % 10), y: 10 + Math.floor(i / 10), w: 1, h: 1 }] }, rig } }) as Op;
    for (let i = 0; i < LIMITS.trapsPerScene; i++) await ok(r.dmSocket, plate(i));
    assert.match(refused(await r.dmSocket.apply(plate(LIMITS.trapsPerScene))), new RegExp(`at most ${LIMITS.trapsPerScene} traps`));
  });

  test("an undo of Remove stairs after the co-DM drew a wall through them is refused, the floor check reading both floors, and a live edit of the ground under them reads the builder's words", async () => {
    const r = await stairsTower(t, "Wall since", false);
    r.anaSocket.close();
    const co = t.client();
    await co.claimDm(r.roomId, r.dmKey);
    const coSocket = await t.connect(r.roomId, co);
    await coSocket.snapshot("co");
    const raise = await coSocket.apply({ t: "build.height", sceneId: r.ground, cells: ["4,3"], height: 5 } as Op);
    assert.equal(refused(raise), LINK_WORDS.changeGround("stairs", "Upper floor"));
    await ok(r.dmSocket, { t: "floorLink.delete", linkId: r.link } as Op);
    await ok(coSocket, { t: "build.edge", sceneId: r.upper, edges: [{ key: "4,3,w", feature: { kind: "wall" } }] } as Op);
    const head = await r.dmSocket.historyHead("setup", "undo");
    const answer = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    // The stairs are gone and the wall is what blocks them, so the words name the wall on its floor, not stairs to remove (FL2-OPUS-2).
    assert.equal(refused(answer), `could not undo removing stairs to Upper floor: ${LINK_WORDS.wall("Upper floor")}`);
    assert.equal(live(t, r.roomId).floorLinks?.[r.link], undefined);
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept");
    await ok(coSocket, { t: "build.edge", sceneId: r.upper, edges: [{ key: "4,3,w", feature: null }] } as Op);
    // New ground of one height under them refuses it too, in the ground's words, and keeps the step.
    await ok(coSocket, { t: "build.height", sceneId: r.ground, cells: ["3,3", "4,3"], height: 5 } as Op);
    const raised = await r.dmSocket.apply({ t: "undo", head: head!, scope: "setup" } as Op);
    assert.equal(refused(raised), "could not undo removing stairs to Upper floor: That would change the ground under the stairs to Upper floor.");
    assert.equal(await r.dmSocket.historyHead("setup", "undo"), head, "the step is kept again");
    await ok(coSocket, { t: "build.height", sceneId: r.ground, cells: ["3,3", "4,3"], height: 0 } as Op);
    await ok(r.dmSocket, { t: "undo", head: head!, scope: "setup" } as Op);
    assert.ok(live(t, r.roomId).floorLinks?.[r.link], "back once the wall is gone");
    coSocket.close();
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
