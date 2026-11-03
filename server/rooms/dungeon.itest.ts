import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { createInitialState } from "#shared/initial.ts";
import type { Member, RoomState, Trap } from "#shared/model.ts";
import { stableStringify, type ProjectedState } from "#shared/project.ts";
import { clientOpSchema, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { MOVE_PLAYERS_FIRST, MOVE_PLAYERS_FIRST_BACK } from "#shared/permissions.ts";
import { loadRoom } from "./persistence.ts";
import { projectedSceneBytes } from "./sizeGuard.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * A generated dungeon on the server (docs/design/design-v1-dungeon-generator.md
 * 4.4 to 4.6, 6 and 7), from the op fixture the client's
 * ops.fixture.test.ts writes, so this test imports no client module
 * (D-261102-389): every op taken through the actor and stored, replayed
 * the same, one Setup step that Undo setup and Redo setup take and bring
 * back, the splits the design names with Delete as the sure way back, a
 * refusal partway, and what players get of it: nothing off their scene,
 * and on it only what the fog shows, with locks read closed and no unfound
 * trap.
 */

type Rect = { x: number; y: number; w: number; h: number };
type FixtureDungeon = { name: string; sceneId: string; trapIds: string[]; rooms: Rect[]; entrance: Rect; ops: Op[] };
const FIXTURE = JSON.parse(readFileSync(new URL("./dungeon.fixture.json", import.meta.url), "utf8")) as { generatorVersion: number; dungeons: FixtureDungeon[] };
const MEDIUM = FIXTURE.dungeons.find((d) => d.name === "medium")!;
const LARGEST = FIXTURE.dungeons.find((d) => d.name === "largest")!;

const NAME = "Crypt";

/**
 * The fixture's ops under fresh ids, as Make sends them, with the dialog's
 * name and Players see on the scene: Reveal by hand unless told, or
 * Explore with party vision on.
 */
function made(d: FixtureDungeon, see: "reveal" | "explore" = "reveal"): { sceneId: string; trapIds: string[]; ops: Op[] } {
  const sceneId = uuidv7();
  const trapIds = d.trapIds.map(() => uuidv7());
  let text = JSON.stringify(d.ops).replaceAll(JSON.stringify(d.sceneId), JSON.stringify(sceneId));
  for (const [i, id] of d.trapIds.entries()) text = text.replaceAll(JSON.stringify(id), JSON.stringify(trapIds[i]));
  const ops = JSON.parse(text) as Op[];
  const create = ops[0];
  assert.ok(create?.t === "scene.create");
  const { vision: _v, ...rest } = create.scene;
  ops[0] = { t: "scene.create", scene: { ...rest, name: NAME, fogEnabled: true, ...(see === "explore" ? { vision: { on: true, light: "bright" as const } } : {}) } };
  return { sceneId, trapIds, ops };
}

/** Sends ops in one Setup group and waits for every answer, returning the refusals. */
async function send(socket: Socket, ops: readonly Op[], g: string = uuidv7()): Promise<{ n: number; code: string; message: string }[]> {
  const waiting = new Set<number>();
  for (const op of ops) {
    const n = socket.nextN();
    waiting.add(n);
    socket.send({ t: "op", n, op, g, groupScope: "setup" });
  }
  const refused: { n: number; code: string; message: string }[] = [];
  while (waiting.size > 0) {
    const ev = await socket.next("ev", (m) => (m.acks ?? []).some((n) => waiting.has(n)) || (m.rejects ?? []).some((r) => waiting.has(r.n)), 30_000);
    for (const n of ev.acks ?? []) waiting.delete(n);
    for (const r of ev.rejects ?? []) if (waiting.delete(r.n)) refused.push({ n: r.n, code: r.code, message: r.message });
  }
  return refused;
}

/** The newest Setup history covering every op the socket sent, left in its backlog for `step` to name the head from. */
async function setupHistory(socket: Socket): Promise<{ depth: number; label: string | null; redo: number }> {
  const h = (await socket.next("history", (m) => m.watermark >= socket.n, 10_000)) as Extract<ServerMessage, { t: "history" }>;
  socket.received.push(h);
  const setup = h.setup;
  return { depth: setup?.undo.depth ?? 0, label: setup?.undo.head?.label ?? null, redo: setup?.redo.depth ?? 0 };
}

/** The scene's build as the stored room holds it: chunks by place with revs left out, and traps by zone, state and rig. */
function contents(state: Pick<RoomState, "buildChunks" | "scenes"> & { traps?: Readonly<Record<string, Trap>> }, sceneId: string): string {
  const chunks = Object.values(state.buildChunks)
    .filter((c) => c.sceneId === sceneId)
    .map((c) => [`${c.cx},${c.cy}`, { cells: c.cells, edges: c.edges, heights: c.heights, up: c.up }] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const traps = Object.values(state.traps ?? {}).filter((t) => t.sceneId === sceneId).map((t) => stableStringify({ zone: t.zone, state: t.state, found: t.found, rig: t.rig })).sort();
  return stableStringify({ scene: state.scenes[sceneId] ? true : false, chunks, traps });
}

/**
 * The ops landed by the shared reducer alone, as the DM, on a fresh room:
 * what a client's own reducer makes of them, as the preview's scratch room
 * does, with no actor between.
 */
function reducerLanding(ops: readonly Op[], each?: (state: RoomState) => void): RoomState {
  const dm: Member = { id: uuidv7(), rev: 1, name: "DM", color: "#ffffff", kind: "dm", createdAt: "2026-01-01T00:00:00.000Z" };
  let state = createInitialState({ roomName: "Landing", dm, now: dm.createdAt });
  for (const [i, raw] of ops.entries()) {
    const op = clientOpSchema.parse(raw) as Op;
    const r = applyOp(state, op, { memberId: dm.id, role: "dm" }, { seq: i + 1, at: dm.createdAt });
    assert.ok(r.ok, `${op.t} refused by the reducer: ${r.ok ? "" : r.message}`);
    state = r.state;
    each?.(state);
  }
  return state;
}

const cellsOf = (state: Pick<RoomState, "buildChunks">, sceneId: string): string[] => Object.values(state.buildChunks).filter((c) => c.sceneId === sceneId).flatMap((c) => Object.keys(c.cells));
const inRect = (key: string, r: Rect): boolean => {
  const [x, y] = key.split(",").map(Number) as [number, number];
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
};
const grown = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

type Table = { roomId: string; dmKey: string; dm: TestClient; dmSocket: Socket; mat: string; player: TestClient; playerId: string };

async function table(t: Engine, name: string): Promise<Table> {
  const dm = t.client();
  const { roomId, dmKey } = await dm.createRoom(name);
  const player = t.client();
  const playerId = await player.join(roomId, "Pip");
  const dmSocket = await t.connect(roomId, dm);
  const snap = await dmSocket.snapshot(`dm-${name}`);
  await setupHistory(dmSocket);
  return { roomId, dmKey, dm, dmSocket, mat: (snap.state as ProjectedState).meta.playerSceneId!, player, playerId };
}

async function stored(t: Engine, tb: Table, sceneId: string, label: string): Promise<RoomState> {
  const s = await t.connect(tb.roomId, tb.dm);
  const snap = (await s.snapshot(label, undefined, sceneId)).state as RoomState;
  s.close();
  return snap;
}

async function playerView(t: Engine, tb: Table, label: string): Promise<ProjectedState> {
  const s = await t.connect(tb.roomId, tb.player);
  const snap = (await s.snapshot(label)).state as ProjectedState;
  s.close();
  return snap;
}

describe("a generated dungeon on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("DG-B: the fixture's version is the generator's, and both dungeons fit the server's burst of 60", () => {
    assert.equal(typeof FIXTURE.generatorVersion, "number");
    for (const d of FIXTURE.dungeons) {
      assert.ok(d.ops.length <= 60, `${d.name}: ${d.ops.length} ops`);
      assert.equal(d.ops[0]?.t, "scene.create");
      assert.ok(!JSON.stringify(d.ops).includes("defaultView"), "no starting view");
    }
  });

  test("DG-B: both dungeons are taken whole through the actor, store, and replay the same, and players on another scene get nothing of them", async () => {
    const tb = await table(t, "Dungeon parity");
    const watcher = await t.connect(tb.roomId, tb.player);
    await watcher.snapshot("watcher");
    for (const d of [MEDIUM, LARGEST]) {
      const m = made(d);
      assert.deepEqual(await send(tb.dmSocket, m.ops), [], `${d.name} all taken`);
      const live = t.manager.get(tb.roomId)!.committed.state;
      assert.ok(live.scenes[m.sceneId]);
      assert.equal(live.scenes[m.sceneId]!.defaultView, undefined);
      assert.equal(Object.values(live.traps).filter((x) => x.sceneId === m.sceneId).length, d.trapIds.length);
      assert.ok(Object.values(live.traps).every((x) => x.state === "armed" && !x.found));
      // The DM's view of the scene is what was stored.
      const dmSnapshot = await stored(t, tb, m.sceneId, `dm-check-${d.name}`);
      assert.equal(contents(dmSnapshot, m.sceneId), contents(live, m.sceneId));
      // DG-R1-11: and what the client's reducer lands of the same ops under the same fresh ids.
      assert.equal(contents(reducerLanding(m.ops), m.sceneId), contents(dmSnapshot, m.sceneId), `${d.name}: the snapshot is the reducer's landing`);
      const seen = JSON.stringify(watcher.received);
      assert.ok(!seen.includes(m.sceneId), `${d.name}: no message to a player names the new scene`);
      for (const id of m.trapIds) assert.ok(!seen.includes(id));
    }
    const live = t.manager.get(tb.roomId)!.committed.state;
    watcher.close();
    tb.dmSocket.close();
    await t.manager.unload(tb.roomId, 1011, false);
    const replayed = await loadRoom(t.pool, tb.roomId);
    assert.ok(replayed && !replayed.replayFailed);
    assert.equal(stableStringify(replayed.state.buildChunks), stableStringify(live.buildChunks));
    assert.equal(stableStringify(replayed.state.traps), stableStringify(live.traps));
    const player = await playerView(t, tb, "after");
    assert.deepEqual(Object.keys(player.scenes), [tb.mat], "a player holds only the players' scene");
  });

  test("DG-B: one Undo setup takes the whole dungeon back, and Redo setup brings it back", async () => {
    const tb = await table(t, "Dungeon undo");
    const m = made(MEDIUM);
    assert.deepEqual(await send(tb.dmSocket, m.ops), []);
    const h = await setupHistory(tb.dmSocket);
    assert.equal(h.depth, 1, "one Setup step");
    assert.match(h.label ?? "", new RegExp(NAME));
    const whole = contents(t.manager.get(tb.roomId)!.committed.state, m.sceneId);
    assert.equal((await tb.dmSocket.step("undo", "setup")).rejects, undefined);
    const undone = t.manager.get(tb.roomId)!.committed.state;
    assert.equal(undone.scenes[m.sceneId], undefined);
    assert.deepEqual(cellsOf(undone, m.sceneId), []);
    assert.equal(Object.values(undone.traps).some((x) => x.sceneId === m.sceneId), false);
    assert.equal((await tb.dmSocket.step("redo", "setup")).rejects, undefined);
    assert.equal(contents(t.manager.get(tb.roomId)!.committed.state, m.sceneId), whole);
    tb.dmSocket.close();
  });

  /** Deletes the scene and checks nothing of it is left. */
  async function deleteAll(socket: Socket, tb: Table, sceneId: string): Promise<void> {
    assert.equal((await socket.apply({ t: "scene.delete", sceneId })).rejects, undefined);
    const state = t.manager.get(tb.roomId)!.committed.state;
    assert.equal(state.scenes[sceneId], undefined);
    assert.equal(Object.values(state.buildChunks).some((c) => c.sceneId === sceneId), false);
    assert.equal(Object.values(state.traps).some((x) => x.sceneId === sceneId), false);
  }

  test("DG-B: another device of the same DM recording a step mid-send splits it in two Setup steps, and Delete removes all", async () => {
    const tb = await table(t, "Dungeon two devices");
    const other = await t.connect(tb.roomId, tb.dm);
    await other.snapshot("other-device");
    await setupHistory(other);
    const m = made(MEDIUM);
    const g = uuidv7();
    const half = Math.ceil(m.ops.length / 2);
    assert.deepEqual(await send(tb.dmSocket, m.ops.slice(0, half), g), []);
    assert.equal((await other.apply({ t: "scene.update", sceneId: tb.mat, patch: { name: "Renamed meanwhile" } })).rejects, undefined);
    assert.deepEqual(await send(tb.dmSocket, m.ops.slice(half), g), []);
    assert.equal((await setupHistory(tb.dmSocket)).depth, 3, "the dungeon's two parts, with the other device's step between");
    await deleteAll(tb.dmSocket, tb, m.sceneId);
    other.close();
    tb.dmSocket.close();
  });

  test("DG-B: a co-DM's edit on the new scene mid-send may split the merge, and Delete removes all", async () => {
    const tb = await table(t, "Dungeon co-DM edit");
    const co = t.client();
    await co.claimDm(tb.roomId, tb.dmKey);
    const coSocket = await t.connect(tb.roomId, co);
    await coSocket.snapshot("co-dm");
    const m = made(MEDIUM);
    const g = uuidv7();
    assert.deepEqual(await send(tb.dmSocket, m.ops.slice(0, 2), g), []);
    assert.equal((await coSocket.apply({ t: "build.paint", sceneId: m.sceneId, terrain: "grass", cells: ["0,0", "1,0"] })).rejects, undefined);
    assert.deepEqual(await send(tb.dmSocket, m.ops.slice(2), g), []);
    const depth = (await setupHistory(tb.dmSocket)).depth;
    assert.ok(depth === 1 || depth === 2, `the merge holds or splits once, not ${depth}`);
    await deleteAll(tb.dmSocket, tb, m.sceneId);
    coSocket.close();
    tb.dmSocket.close();
  });

  test("DG-B: after a restart history is empty, and Delete removes all", async () => {
    const tb = await table(t, "Dungeon restart");
    const m = made(MEDIUM);
    assert.deepEqual(await send(tb.dmSocket, m.ops), []);
    const n = tb.dmSocket.n;
    await t.restart();
    const back = await t.connect(tb.roomId, tb.dm);
    back.n = n;
    await back.snapshot("after-restart", n + 1);
    assert.equal((await setupHistory(back)).depth, 0);
    assert.ok(t.manager.get(tb.roomId)!.committed.state.scenes[m.sceneId]);
    await deleteAll(back, tb, m.sceneId);
    back.close();
  });

  test("DG-B: a co-DM moving the players there mid-send: it lands, Delete is refused until they are moved on, then removes all", async () => {
    const tb = await table(t, "Dungeon players moved");
    const co = t.client();
    await co.claimDm(tb.roomId, tb.dmKey);
    const coSocket = await t.connect(tb.roomId, co);
    await coSocket.snapshot("co-dm-mover");
    const m = made(MEDIUM);
    const g = uuidv7();
    assert.deepEqual(await send(tb.dmSocket, m.ops.slice(0, 1), g), []);
    assert.equal((await coSocket.apply({ t: "room.setPlayerScene", sceneId: m.sceneId })).rejects, undefined);
    const refused = await send(tb.dmSocket, m.ops.slice(1), g);
    // Only the memory guard could refuse here, and a dungeon this size stays far under it.
    assert.deepEqual(refused, []);
    const rejected = await tb.dmSocket.apply({ t: "scene.delete", sceneId: m.sceneId });
    assert.equal(rejected.rejects?.[0]?.message, MOVE_PLAYERS_FIRST);
    // DG-R1-03: Undo setup is refused there too, as the outcome's words say.
    const undo = await tb.dmSocket.step("undo", "setup");
    assert.ok(undo.rejects?.[0]?.message.includes(MOVE_PLAYERS_FIRST_BACK), `undo refused: ${JSON.stringify(undo.rejects)}`);
    assert.equal((await coSocket.apply({ t: "room.setPlayerScene", sceneId: tb.mat })).rejects, undefined);
    await deleteAll(tb.dmSocket, tb, m.sceneId);
    coSocket.close();
    tb.dmSocket.close();
  });

  test("DG-B: players moved there before anything is revealed get the scene with no starting view, no chunk and no trap", async () => {
    const tb = await table(t, "Dungeon fogged");
    const m = made(MEDIUM);
    assert.deepEqual(await send(tb.dmSocket, m.ops), []);
    assert.equal((await tb.dmSocket.apply({ t: "room.setPlayerScene", sceneId: m.sceneId })).rejects, undefined);
    const p = await playerView(t, tb, "fogged");
    assert.deepEqual(Object.keys(p.scenes), [m.sceneId]);
    assert.equal(p.scenes[m.sceneId]!.defaultView, undefined);
    assert.deepEqual(cellsOf(p, m.sceneId), []);
    assert.deepEqual(Object.keys(p.traps), []);
    tb.dmSocket.close();
  });

  test("DG-B: with one room revealed, a player holds nothing the fog hides, locks read closed, and no unfound trap", async () => {
    const tb = await table(t, "Dungeon revealed");
    const m = made(LARGEST);
    assert.deepEqual(await send(tb.dmSocket, m.ops), []);
    const live = t.manager.get(tb.roomId)!.committed.state;
    const doors = new Map(Object.values(live.buildChunks).filter((c) => c.sceneId === m.sceneId).flatMap((c) => Object.entries(c.edges)));
    const locked = [...doors].filter(([, f]) => f.kind === "door" && f.state === "locked").map(([k]) => k);
    assert.ok(locked.length > 0, "the largest dungeon has a locked door");
    const sides = (edge: string): string[] => {
      const [x, y, side] = edge.split(",");
      return side === "w" ? [`${x},${y}`, `${Number(x) - 1},${y}`] : [`${x},${y}`, `${x},${Number(y) - 1}`];
    };
    // A room with a trapped locked door, a Poisoned Needle, else any room with a locked door.
    const needles = Object.values(live.traps).flatMap((x) => (x.sceneId === m.sceneId && "door" in x.zone && "edge" in x.zone.door ? [x.zone.door.edge] : []));
    const touches = (r: Rect, edges: string[]) => edges.some((k) => sides(k).some((c) => inRect(c, r)));
    const room = LARGEST.rooms.find((r) => touches(r, needles.filter((e) => locked.includes(e)))) ?? LARGEST.rooms.find((r) => touches(r, locked))!;
    const shown = grown(room, 1);
    assert.equal((await tb.dmSocket.apply({ t: "fog.live", sceneId: m.sceneId, ops: [{ id: "r1", mode: "reveal", shape: { kind: "rect", ...shown } }] })).rejects, undefined);
    assert.equal((await tb.dmSocket.apply({ t: "room.setPlayerScene", sceneId: m.sceneId })).rejects, undefined);
    const p = await playerView(t, tb, "revealed");
    const cells = cellsOf(p, m.sceneId);
    assert.ok(cells.length > 0, "the revealed room shows");
    for (const key of cells) assert.ok(inRect(key, shown), `${key} lies in what the DM revealed`);
    const seen = Object.values(p.buildChunks).filter((c) => c.sceneId === m.sceneId).flatMap((c) => Object.entries(c.edges));
    assert.ok(seen.some(([k]) => locked.includes(k)), "a locked door is in view");
    for (const [k, f] of seen) {
      assert.equal(f.kind, "door", `${k}: no drawn wall marks a room's side, every wall is automatic`);
      assert.ok(f.kind === "door" && f.state === "closed", `${k}: a locked door reads closed`);
      assert.ok(sides(k).some((c) => inRect(c, shown)), `${k} borders what the DM revealed`);
    }
    assert.deepEqual(Object.keys(p.traps), [], "no unfound trap");
    const text = JSON.stringify(p);
    for (const id of m.trapIds) assert.ok(!text.includes(id));
    tb.dmSocket.close();
  });

  test("DG-B: on Explore, a party in the entrance sees no other room", async () => {
    const tb = await table(t, "Dungeon explore");
    const m = made(MEDIUM, "explore");
    assert.deepEqual(await send(tb.dmSocket, m.ops), []);
    const e = MEDIUM.entrance;
    const pc = uuidv7();
    const actor = { inline: { hp: { cur: 12, max: 12, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 12, senses: "Darkvision 60 ft.", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } };
    const token = { id: pc, sceneId: m.sceneId, kind: "pc", name: "Pip's", disposition: "ally", size: "medium", ownerIds: [tb.playerId], x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2), actor };
    assert.equal((await tb.dmSocket.apply({ t: "token.create", token } as Op)).rejects, undefined);
    assert.equal((await tb.dmSocket.apply({ t: "room.setPlayerScene", sceneId: m.sceneId })).rejects, undefined);
    // A move inside the room has the party look, as any move does.
    assert.equal((await tb.dmSocket.apply({ t: "token.move", tokenId: pc, x: e.x, y: e.y })).rejects, undefined);
    const p = await playerView(t, tb, "explore");
    const cells = cellsOf(p, m.sceneId);
    assert.ok(cells.some((k) => inRect(k, e)), "the entrance is seen");
    for (const key of cells) assert.ok(inRect(key, grown(e, 1)), `${key} is in the entrance room or its doorways`);
    assert.deepEqual(Object.keys(p.traps), []);
    tb.dmSocket.close();
  });

  test("DG-B: Duplicate copies the dungeon whole, and a room backup carries it into a new room", async () => {
    const tb = await table(t, "Dungeon backup");
    const m = made(MEDIUM);
    assert.deepEqual(await send(tb.dmSocket, m.ops), []);
    const copyId = uuidv7();
    const include = { creatures: true, characters: true, fog: true, drawings: true };
    assert.equal((await tb.dmSocket.apply({ t: "scene.duplicate", sceneId: m.sceneId, newSceneId: copyId, name: "Crypt copy", include })).rejects, undefined);
    const live = t.manager.get(tb.roomId)!.committed.state;
    const chunksOnly = (id: string) => contents({ ...live, traps: {} }, id);
    assert.equal(chunksOnly(copyId), chunksOnly(m.sceneId), "the copy holds every room, corridor, door, height and stair");
    tb.dmSocket.close();
    const res = await tb.dm.get(`/api/rooms/${tb.roomId}/export`);
    assert.equal(res.statusCode, 200, res.body);
    const importer = t.client();
    const imported = await importer.request("POST", "/api/rooms/import", undefined, {
      "content-type": "application/zip",
      "x-import-form": Buffer.from(JSON.stringify({ playerPassword: "wyvern-staff-rune", dmName: "Importer" })).toString("base64url"),
    }, res.rawPayload);
    assert.equal(imported.statusCode, 201, imported.body);
    const { roomId } = imported.json<{ roomId: string }>();
    t.track(roomId);
    const copy = await t.connect(roomId, importer);
    const first = (await copy.snapshot("copy")).state as RoomState;
    copy.close();
    const scene = Object.values(first.scenes).find((s) => s.name === NAME)!;
    assert.ok(scene, "the dungeon's scene came across");
    const onScene = await t.connect(roomId, importer);
    const state = (await onScene.snapshot("copy-scene", undefined, scene.id)).state as RoomState;
    onScene.close();
    const strip = (s: Pick<RoomState, "buildChunks" | "scenes"> & { traps?: Record<string, Trap> }, id: string) => contents({ ...s, traps: Object.fromEntries(Object.entries(s.traps ?? {}).map(([k, v]) => [k, { ...v, id: "" }])) }, id);
    assert.equal(strip(state, scene.id), strip(live, m.sceneId));
  });
});

describe("a generated dungeon refused partway", () => {
  let t: Engine;
  // The scene's projected bytes after the build's first paint and at the end, by the shared reducer, so the limit falls between them.
  const bytes = (() => {
    const m = made(LARGEST);
    const out: number[] = [];
    reducerLanding(m.ops, (state) => out.push(projectedSceneBytes(state, m.sceneId)));
    return out;
  })();
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { sizeLimits: { sceneLimit: Math.round((bytes[1]! + bytes.at(-1)!) / 2) } } } });
  });
  after(() => t.close());

  test("DG-B: a size refusal after the scene is partial, and Undo setup takes back what landed", async () => {
    const tb = await table(t, "Dungeon partial");
    const m = made(LARGEST);
    const refused = await send(tb.dmSocket, m.ops);
    assert.ok(refused.length > 0, "the scene's size guard refuses part of it");
    assert.ok(refused.every((r) => r.code === "quota"), JSON.stringify(refused));
    assert.ok(refused.every((r) => r.n > 1), "never the scene itself");
    assert.ok(t.manager.get(tb.roomId)!.committed.state.scenes[m.sceneId], "the scene was made");
    for (let i = 0; i < 3 && t.manager.get(tb.roomId)!.committed.state.scenes[m.sceneId]; i++) assert.equal((await tb.dmSocket.step("undo", "setup")).rejects, undefined);
    const state = t.manager.get(tb.roomId)!.committed.state;
    assert.equal(state.scenes[m.sceneId], undefined);
    assert.equal(Object.values(state.buildChunks).some((c) => c.sceneId === m.sceneId), false);
    assert.equal(Object.values(state.traps).some((x) => x.sceneId === m.sceneId), false);
    tb.dmSocket.close();
  });
});

