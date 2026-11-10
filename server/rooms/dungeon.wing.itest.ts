import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import { stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Op, OpOf, ServerMessage } from "#shared/protocol.ts";
import { JOIN_CHANGED, WING_MOVED, type JoinExpect, type WingClear } from "#shared/rules/wingClear.ts";
import { startEngine, type Engine, type Socket, type TestClient } from "./testing.ts";

/**
 * Add a wing on the server (docs/design: dungeon generator phase 3, 3.5,
 * 3.6 and 6), from the op fixture the client's ops.fixture.test.ts writes,
 * so this test imports no client module: Medium's dungeon on a scene
 * widened east, and a wing in the empty ground there joined to a sunk
 * room's automatic wall. Its asks carry the clear, which the actor checks
 * against the room as each part is read: taken, the wing lands as one
 * Setup step; a token walked into its floor, a join drawn over, or an op
 * landing between two parts in an earlier part's cells refuses it with
 * nothing landed. On the players' scene, sight off the area, players get
 * nothing of the wing but the join they see change.
 */

type Rect = { x: number; y: number; w: number; h: number };
type FixtureDungeon = { name: string; sceneId: string; placeholders: string[]; ops: Op[]; rooms: Rect[] };
type FixtureWing = FixtureDungeon & { bounds: { w: number; h: number }; area: Rect; join: Extract<JoinExpect, { grid: "squares" }>; clear: WingClear };
const FIXTURE = JSON.parse(readFileSync(new URL("./dungeon.fixture.json", import.meta.url), "utf8")) as { dungeons: (FixtureDungeon | FixtureWing)[] };
const MEDIUM = FIXTURE.dungeons.find((d) => d.name === "medium")!;
const WING = FIXTURE.dungeons.find((d) => d.name === "wing") as FixtureWing;

const BLOCK_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const shortId = () => Array.from(randomBytes(12), (b) => BLOCK_CHARS[b % BLOCK_CHARS.length]).join("");

/** Every placeholder of `d` under a fresh id, as Make gives them, the scene's as `sceneId`. */
function fresh(d: FixtureDungeon, sceneId: string): Op[] {
  const ids = new Map<string, string>([[d.sceneId, sceneId]]);
  for (const id of d.placeholders) if (id !== d.sceneId) ids.set(id, id.startsWith("dungeonblk") || id.startsWith("dgw") ? shortId() : uuidv7());
  let text = JSON.stringify(d.ops);
  for (const [was, now] of ids) text = text.replaceAll(JSON.stringify(was), JSON.stringify(now));
  return JSON.parse(text) as Op[];
}

/** Medium's dungeon on the scene widened east, the players' scene under fog, Reveal by hand, nothing revealed. */
function base(sceneId: string): Op[] {
  const ops = fresh(MEDIUM, sceneId);
  const create = ops[0]!;
  assert.ok(create.t === "scene.create");
  const { vision: _v, ...scene } = create.scene;
  ops[0] = { t: "scene.create", scene: { ...scene, bounds: WING.bounds, fogEnabled: true } };
  return ops;
}

const GOBLIN = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive" as const, ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

const MAP_OPS = new Set(["build.paint", "build.erase", "build.rect", "build.edge", "build.height", "build.stairs", "build.rough", "build.walls", "build.stamps"]);

/** The wing's asks as the device packs them: one map op each here, the clear on every part, `more` on all but the last. */
function asks(ops: readonly Op[], sceneId: string, clear: WingClear): OpOf<"build.ask">[] {
  const mapOps = ops.filter((op) => MAP_OPS.has(op.t)) as OpOf<"build.ask">["ops"];
  return mapOps.map((op, i) => ({ t: "build.ask", sceneId, ops: [op], part: i, ...(i < mapOps.length - 1 ? { more: true as const } : {}), clear }));
}

/** Sends ops one group under Setup and waits for every answer. */
async function send(socket: Socket, ops: readonly Op[], g: string = uuidv7()): Promise<{ n: number; code: string; message: string }[]> {
  const ns = ops.map(() => socket.nextN());
  const waiting = new Set(ns);
  const refused: { n: number; code: string; message: string }[] = [];
  const sendFrom = (from: number) => {
    for (const [i, n] of ns.entries()) if (n >= from && waiting.has(n)) socket.send({ t: "op", n, op: ops[i], g, groupScope: "setup" });
  };
  sendFrom(ns[0]!);
  const deadline = Date.now() + 60_000;
  while (waiting.size > 0) {
    assert.ok(Date.now() < deadline, `${waiting.size} ops still unanswered`);
    const ev = await socket.maybe("ev", (m) => (m.acks ?? []).some((n) => waiting.has(n)) || (m.rejects ?? []).some((r) => waiting.has(r.n)), 200);
    for (const n of ev?.acks ?? []) waiting.delete(n);
    for (const r of ev?.rejects ?? []) if (waiting.delete(r.n)) refused.push({ n: r.n, code: r.code, message: r.message });
    // Past the socket's burst the store resends from the first op answered busy, as here.
    const retries = socket.received.filter((m): m is Extract<ServerMessage, { t: "retry" }> => m.t === "retry" && m.n !== undefined && ns.includes(m.n));
    if (retries.length === 0) continue;
    for (const r of retries) socket.received.splice(socket.received.indexOf(r), 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    sendFrom(Math.min(...retries.map((r) => r.n!)));
  }
  return refused;
}

type Table = { roomId: string; dm: TestClient; dmSocket: Socket; player: TestClient; sceneId: string };

/** A room with the base landed on its players' scene, the scene everyone is on. */
async function table(t: Engine, name: string): Promise<Table> {
  const dm = t.client();
  const { roomId } = await dm.createRoom(name);
  const player = t.client();
  await player.join(roomId, "Pip");
  const dmSocket = await t.connect(roomId, dm);
  await dmSocket.snapshot(`dm-${name}`);
  const sceneId = uuidv7();
  assert.deepEqual(await send(dmSocket, base(sceneId)), [], "the base lands");
  assert.equal((await dmSocket.apply({ t: "room.setPlayerScene", sceneId })).rejects, undefined);
  return { roomId, dm, dmSocket, player, sceneId };
}

/** The wing's part of a scene: what its ops wrote, as the stored room holds it, revs left out. */
function wingPart(state: RoomState, sceneId: string): string {
  const chunks = Object.values(state.buildChunks)
    .filter((c) => c.sceneId === sceneId)
    .map((c) => [`${c.cx},${c.cy}`, { cells: c.cells, edges: c.edges, heights: c.heights, up: c.up }] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const on = <T extends { sceneId: string }>(r: Readonly<Record<string, T>>) => Object.values(r).filter((x) => x.sceneId === sceneId).length;
  return stableStringify({ chunks, traps: on(state.traps), stamps: on(state.stamps), lights: on(state.lights), pins: on(state.pins) });
}

async function playerView(t: Engine, tb: Table, label: string): Promise<ProjectedState> {
  const s = await t.connect(tb.roomId, tb.player);
  const snap = (await s.snapshot(label)).state as ProjectedState;
  s.close();
  return snap;
}

const firstFloor = (): [number, number] => {
  const paint = WING.ops.find((op) => op.t === "build.paint");
  assert.ok(paint && paint.t === "build.paint");
  return paint.cells[Math.floor(paint.cells.length / 2)]!.split(",").map(Number) as [number, number];
};

describe("a wing on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine({ rooms: { idleUnloadMs: 60_000, actor: { snapshotOps: 1_000, snapshotIdleMs: 60_000 } } });
  });
  after(() => t.close());

  test("DGW-B: asks taken, the wing lands whole as one Setup step that Undo setup takes back, and no ask is stored", async () => {
    const tb = await table(t, "Wing taken");
    const before = t.manager.get(tb.roomId)!.committed.state;
    const ops = fresh(WING, tb.sceneId);
    const g = uuidv7();
    assert.deepEqual(await send(tb.dmSocket, asks(ops, tb.sceneId, WING.clear), g), [], "every part taken");
    assert.equal(wingPart(t.manager.get(tb.roomId)!.committed.state, tb.sceneId), wingPart(before, tb.sceneId), "an ask lands nothing");
    assert.deepEqual(await send(tb.dmSocket, ops, g), [], "the wing is taken");
    const after = t.manager.get(tb.roomId)!.committed.state;
    assert.notEqual(wingPart(after, tb.sceneId), wingPart(before, tb.sceneId));
    const join = WING.join.edges[0]!.key;
    const chunk = Object.values(after.buildChunks).find((c) => c.sceneId === tb.sceneId && c.edges[join]);
    assert.equal(chunk?.edges[join]?.kind, "door", "the join's automatic wall became a door");
    assert.equal(Object.values(after.journal).filter((p) => p.title.endsWith("wing key")).length, 1);
    assert.equal((await tb.dmSocket.step("undo", "setup")).rejects, undefined);
    assert.equal(wingPart(t.manager.get(tb.roomId)!.committed.state, tb.sceneId), wingPart(before, tb.sceneId), "one Undo setup takes the wing back");
    const { rows } = await t.pool.query<{ op: { t: string } }>("select op from room_ops where room_id = $1", [tb.roomId]);
    assert.ok(rows.length > ops.length, "the wing's ops are stored");
    assert.ok(!rows.some((r) => r.op.t === "build.ask"), "no ask is stored");
    tb.dmSocket.close();
  });

  test("DGW-B: a token walked into the wing's floor refuses the ask as moved, and a join drawn over refuses it as changed, nothing landed", async () => {
    const tb = await table(t, "Wing refused");
    const before = wingPart(t.manager.get(tb.roomId)!.committed.state, tb.sceneId);
    const [x, y] = firstFloor();
    const tokenId = uuidv7();
    assert.equal((await tb.dmSocket.apply({ t: "token.create", token: { id: tokenId, sceneId: tb.sceneId, kind: "monster", name: "Goblin", size: "medium", x, y, actor: { inline: GOBLIN } } })).rejects, undefined);
    const ops = fresh(WING, tb.sceneId);
    const refused = await send(tb.dmSocket, asks(ops, tb.sceneId, WING.clear));
    assert.ok(refused.length > 0);
    assert.deepEqual({ code: refused[0]!.code, message: refused[0]!.message }, { code: "invalid", message: WING_MOVED }, "the first part says the wing moved");
    assert.equal((await tb.dmSocket.apply({ t: "token.move", tokenId, x: 1, y: 48 })).rejects, undefined);
    assert.deepEqual(await send(tb.dmSocket, asks(ops, tb.sceneId, WING.clear)), [], "walked off, the asks are taken");
    assert.equal((await tb.dmSocket.apply({ t: "build.edge", sceneId: tb.sceneId, edges: [{ key: WING.join.edges[0]!.key, feature: { kind: "wall" } }] })).rejects, undefined);
    const changed = await send(tb.dmSocket, asks(ops, tb.sceneId, WING.clear));
    assert.deepEqual({ code: changed[0]!.code, message: changed[0]!.message }, { code: "invalid", message: JOIN_CHANGED });
    const now = t.manager.get(tb.roomId)!.committed.state;
    const join = WING.join.edges[0]!.key;
    const chunk = Object.values(now.buildChunks).find((c) => c.sceneId === tb.sceneId && c.edges[join]);
    assert.deepEqual(chunk?.edges[join], { kind: "wall" });
    void before;
    tb.dmSocket.close();
  });

  test("DGW-B: an op landing between two parts in part 0's cells refuses the last part, by the chain's whole footprint", async () => {
    const tb = await table(t, "Wing between parts");
    const other = await t.connect(tb.roomId, tb.dm);
    await other.snapshot("other-dm");
    const ops = fresh(WING, tb.sceneId);
    const parts = asks(ops, tb.sceneId, WING.clear);
    const paint = parts.findIndex((a) => a.ops[0]!.t === "build.paint");
    assert.ok(paint >= 0 && paint < parts.length - 1, "a paint before the last part");
    const g = uuidv7();
    assert.deepEqual(await send(tb.dmSocket, parts.slice(0, paint + 1), g), [], "the parts through the paint taken");
    // Another device's token lands in that paint's cells, while the later parts are still to come.
    const cells = (parts[paint]!.ops[0] as OpOf<"build.paint">).cells;
    const [x, y] = cells[Math.floor(cells.length / 2)]!.split(",").map(Number) as [number, number];
    assert.equal((await other.apply({ t: "token.create", token: { id: uuidv7(), sceneId: tb.sceneId, kind: "monster", name: "Goblin", size: "medium", x, y, actor: { inline: GOBLIN } } })).rejects, undefined);
    const rest = parts.slice(paint + 1);
    const later = rest.filter((a) => !(a.ops[0]!.t === "build.paint" && (a.ops[0] as OpOf<"build.paint">).cells.some((c) => c === `${x},${y}`)));
    const refused = await send(tb.dmSocket, later.map((a, i) => ({ ...a, part: paint + 1 + i, ...(i < later.length - 1 ? { more: true as const } : { more: undefined }) })) as Op[], g);
    assert.ok(refused.some((r) => r.code === "invalid" && r.message === WING_MOVED), JSON.stringify(refused));
    other.close();
    tb.dmSocket.close();
  });

  test("DGW-B: on the players' scene, sight off the area, players get nothing of the wing but the join they see change", async () => {
    const tb = await table(t, "Wing unseen");
    const join = WING.join.edges[0]!.key;
    const [jx, jy] = join.split(",").map(Number) as [number, number];
    // The party sees the joined room's wall from inside: revealed by hand, the area east of it never.
    assert.equal((await tb.dmSocket.apply({ t: "fog.live", sceneId: tb.sceneId, ops: [{ id: "seen", mode: "reveal", shape: { kind: "rect", x: jx - 3, y: jy - 2, w: 3, h: 5 } }] })).rejects, undefined);
    const beforeView = await playerView(t, tb, "before");
    const held = Object.values(beforeView.buildChunks).filter((c) => c.sceneId === tb.sceneId).flatMap((c) => Object.keys(c.cells));
    assert.ok(held.includes(`${jx - 1},${jy}`), `not vacuous: the join's inside cell is shown, ${held.length} cells held`);
    const ops = fresh(WING, tb.sceneId);
    const g = uuidv7();
    assert.deepEqual(await send(tb.dmSocket, asks(ops, tb.sceneId, WING.clear), g), []);
    assert.deepEqual(await send(tb.dmSocket, ops, g), []);
    const afterView = await playerView(t, tb, "after");
    const part = (v: ProjectedState) => {
      const chunks = Object.values(v.buildChunks)
        .filter((c) => c.sceneId === tb.sceneId)
        // The join's chunk carries the join's change: its edge, and its automatic wall bit gone with the wall.
        .map(({ rev: _r, ...c }) => (c.edges[join] !== undefined || c.cells[`${jx - 1},${jy}`] !== undefined ? { ...c, auto: null, edges: Object.fromEntries(Object.entries(c.edges).filter(([k]) => k !== join)) } : c))
        .sort((p, q) => p.cx - q.cx || p.cy - q.cy);
      const on = (r: Readonly<Record<string, { sceneId: string } | undefined>> | undefined) => Object.values(r ?? {}).filter((x) => x?.sceneId === tb.sceneId).length;
      return stableStringify({ chunks, stamps: on(v.stamps), traps: on(v.traps), pins: on(v.pins) });
    };
    assert.equal(part(afterView), part(beforeView), "the players' scene projects the same with the wing as without it, but the join");
    const joinChunk = Object.values(afterView.buildChunks).find((c) => c.sceneId === tb.sceneId && c.edges[join]);
    assert.equal(joinChunk?.edges[join]?.kind, "door", "the join they see is the wing's door");
    const seen = JSON.stringify(afterView);
    for (const op of ops) if (op.t === "trap.create") assert.ok(!seen.includes(op.trap.id), "no wing trap reaches a player");
    tb.dmSocket.close();
  });
});
