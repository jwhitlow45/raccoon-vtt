import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test, type TestContext } from "node:test";
import { autoAt } from "#shared/discoveryTestutil.ts";
import { CHUNK_CELLS, type EdgeFeature, type MemoryChunk, type Member, type PlayerChunk, type RoomState } from "#shared/model.ts";
import { privateFieldsIn } from "#shared/privateFields.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { classesOf, classOfMember, holdsAny, withoutRevs } from "#shared/secretDoorTestutil.ts";
import { chance, int, pick, rng, room, token } from "#shared/testutil.ts";
import { mapStepOps } from "./remember.ts";
import { scopeActor, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * The dungeon generator's own secret door gate (docs/design/design-v1-dungeon-generator.md,
 * phase 2 section 7, on drules lane B's contract SB1 to SB6): SB6's twin
 * test on generated dungeons from the server fixture
 * (client/features/dungeon/ops.fixture.test.ts), a Narrow and a Wide one,
 * each with a secret way round (a loop doorway) and a secret room (a leaf
 * room's only doorway). Through the room actor, as lane B's own twin test
 * runs (secretDoor.random.test.ts), since the gate reads each device's
 * projected state and each class's layers on the server at every step.
 *
 * - Room side: the party stands in the room of a loop doorway on Explore,
 *   or the DM reveals that room alone on Reveal by hand. Its twin leaves the
 *   doorway's outside squares unpainted and the door gone.
 * - Corridor side: the party stands in the corridor before a secret room's
 *   door. Its twin leaves the room unpainted, the door gone, and its stamps,
 *   lights, pins, traps and tokens with it.
 * - Before every comparison the test asserts SB6's precondition and that
 *   the class is in its audience, and the runs must compare many steps with
 *   the near square held and the door's edge an automatic wall bit there,
 *   or they test nothing.
 * - Equal is projected state: each device's whole state and each class's
 *   memory and explored layer on the server, revs left out. Frames and
 *   sequence numbers are the room's own channel (SEQ-PRIVATE-OPS).
 * - Beside SB6: a loop doorway seen from both ends reads as the automatic
 *   wall bit live and remembered, before and after the class holds both
 *   squares, a stored memory entry for a door's edge is "auto", and a door
 *   written with cover "drawn" fails the room side.
 */

type Rect = { x: number; y: number; w: number; h: number };
type FixtureDungeon = { name: string; sceneId: string; ops: Op[]; rooms: Rect[]; entrance: Rect };
const FIXTURE = JSON.parse(readFileSync(new URL("./dungeon.fixture.json", import.meta.url), "utf8")) as { dungeons: FixtureDungeon[] };
const NARROW = FIXTURE.dungeons.find((d) => d.name === "secrets")!;
const WIDE = FIXTURE.dungeons.find((d) => d.name === "secrets-wide")!;

/** The scene's id here: the test room's players' scene, which the shared twin helpers read. */
const S = "s1";
const AT = "2026-01-01T00:00:00.000Z";

const cellKey = (x: number, y: number) => `${x},${y}`;
const xy = (key: string) => key.split(",").map(Number) as [number, number];

/** The two squares a grid edge lies between: west or north first. */
function sidesOf(edge: string): [string, string] {
  const [x, y] = xy(edge);
  return edge.endsWith(",w") ? [cellKey(x - 1, y), cellKey(x, y)] : [cellKey(x, y - 1), cellKey(x, y)];
}

/** The grid edge between two squares that share a side. */
function edgeBetween(a: string, b: string): string {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  return ay === by ? `${Math.max(ax, bx)},${ay},w` : `${ax},${Math.max(ay, by)},n`;
}

function around(key: string): string[] {
  const [x, y] = xy(key);
  return [cellKey(x + 1, y), cellKey(x - 1, y), cellKey(x, y + 1), cellKey(x, y - 1)];
}

/** What the plan's ops paint and draw, read from the ops alone. */
type Plan = { painted: Set<string>; edges: Map<string, EdgeFeature>; rooms: Rect[]; entrance: Rect };

function planOf(d: FixtureDungeon): Plan {
  const painted = new Set<string>();
  const edges = new Map<string, EdgeFeature>();
  for (const op of d.ops) {
    if (op.t === "build.paint") for (const c of op.cells) painted.add(c);
    if (op.t === "build.edge") for (const e of op.edges) if (e.feature) edges.set(e.key, e.feature);
  }
  return { painted, edges, rooms: d.rooms, entrance: d.entrance };
}

/** The painted squares reached from `from` past every edge but walls and those in `shut`. */
function flood(plan: Plan, from: string, shut: ReadonlySet<string>): Set<string> {
  const seen = new Set([from]);
  const todo = [from];
  while (todo.length > 0) {
    const at = todo.pop()!;
    for (const next of around(at)) {
      if (!plan.painted.has(next) || seen.has(next)) continue;
      const e = edgeBetween(at, next);
      if (shut.has(e) || plan.edges.get(e)?.kind === "wall") continue;
      seen.add(next);
      todo.push(next);
    }
  }
  return seen;
}

const inRect = (key: string, r: Rect) => {
  const [x, y] = xy(key);
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
};

/**
 * A secret doorway: its one edge, or both of a Wide one, the squares on its
 * room's side and on its corridor's, the room it opens, and whether it is a
 * way round (the corridor side still reaches the room with every secret
 * door shut) or a secret room's only doorway.
 */
type Doorway = { edges: string[]; inside: string[]; outside: string[]; room: Rect; loop: boolean; secretRoom: Set<string> | null };

function doorways(plan: Plan): Doorway[] {
  const secret = [...plan.edges].filter(([, f]) => f.kind === "door" && f.secret).map(([k]) => k);
  const shut = new Set(secret);
  const entrance = [...plan.painted].find((c) => inRect(c, plan.entrance))!;
  const out: Doorway[] = [];
  const taken = new Set<string>();
  for (const first of secret) {
    if (taken.has(first)) continue;
    const [x, y] = xy(first);
    const mate = first.endsWith(",w") ? `${x},${y + 1},w` : `${x + 1},${y},n`;
    const edges = secret.includes(mate) ? [first, mate] : [first];
    for (const e of edges) taken.add(e);
    const pairs = edges.map(sidesOf);
    const room = plan.rooms.find((r) => pairs.every(([a, b]) => inRect(a, r) !== inRect(b, r)) && pairs.some(([a, b]) => inRect(a, r) || inRect(b, r)));
    if (!room) continue;
    const inside = pairs.map(([a, b]) => (inRect(a, room) ? a : b));
    const outside = pairs.map(([a, b]) => (inRect(a, room) ? b : a));
    const fromRoom = flood(plan, inside[0]!, shut);
    const loop = fromRoom.has(outside[0]!);
    const secretRoom = !loop && !fromRoom.has(entrance) && flood(plan, outside[0]!, shut).has(entrance) ? fromRoom : null;
    out.push({ edges, inside, outside, room, loop, secretRoom });
  }
  return out;
}

/** A gate case: which doorway, from which side, and the passage its rock twin leaves unpainted. */
type Side = { doorway: Doorway; near: string[]; passage: Set<string>; banned: Set<string>; standing: string[] };

/** The squares every class of the audience may hold on its side: the near squares, and the near side's squares away from the passage. */
function sideOf(plan: Plan, doorway: Doorway, side: "room" | "corridor"): Side {
  const near = side === "room" ? doorway.inside : doorway.outside;
  const passage = side === "room" ? new Set(doorway.outside) : new Set(doorway.secretRoom!);
  const banned = new Set(passage);
  for (const p of passage) for (const n of around(p)) if (!near.includes(n)) banned.add(n);
  // Where the party may stand: the room's own squares, or the corridor within a few steps of the door, none banned.
  const shut = new Set([...plan.edges].filter(([, f]) => f.kind === "door").map(([k]) => k));
  const reach = flood(plan, near[0]!, shut);
  const standing = [...reach].filter((c) => {
    if (banned.has(c)) return false;
    if (side === "room") return inRect(c, doorway.room);
    const [x, y] = xy(c);
    return near.some((n) => {
      const [nx, ny] = xy(n);
      return Math.abs(nx - x) + Math.abs(ny - y) <= 4;
    });
  });
  return { doorway, near, passage, banned, standing };
}

/** The squares a stamp's box covers. */
function stampCells(s: { x: number; y: number; w: number; h: number }): string[] {
  const out: string[] = [];
  for (let y = Math.floor(s.y - s.h / 2 + 1e-6); y < Math.ceil(s.y + s.h / 2 - 1e-6); y++) for (let x = Math.floor(s.x - s.w / 2 + 1e-6); x < Math.ceil(s.x + s.w / 2 - 1e-6); x++) out.push(cellKey(x, y));
  return out;
}

/**
 * The rock twin's ops: the plan's, with the passage left unpainted, the
 * doorway's edges gone, and whatever stands in the passage (heights,
 * stairs, stamps, lights, tokens, traps and pins) gone with it.
 */
function rockOps(ops: readonly Op[], passage: ReadonlySet<string>, doorEdges: readonly string[]): Op[] {
  const keep = (c: string) => !passage.has(c);
  const floorIn = (x: number, y: number) => passage.has(cellKey(Math.floor(x), Math.floor(y)));
  const out: Op[] = [];
  for (const op of ops) {
    if (op.t === "build.paint" || op.t === "build.height" || op.t === "build.stairs") {
      const cells = op.cells.filter(keep);
      if (cells.length > 0) out.push({ ...op, cells } as Op);
    } else if (op.t === "build.edge") {
      const edges = op.edges.filter((e) => !doorEdges.includes(e.key));
      if (edges.length > 0) out.push({ ...op, edges });
    } else if (op.t === "build.stamps") {
      const put = (op.put ?? []).filter((s) => !stampCells(s).some((c) => passage.has(c)));
      if (put.length > 0) out.push({ ...op, put });
    } else if (op.t === "build.lights") {
      const put = (op.put ?? []).filter((l) => !floorIn(l.x, l.y));
      if (put.length > 0) out.push({ ...op, put });
    } else if (op.t === "token.create") {
      if (!floorIn(op.token.x, op.token.y)) out.push(op);
    } else if (op.t === "trap.create") {
      const zone = op.trap.zone;
      const hit =
        "cells" in zone
          ? zone.cells.some((r) => {
              for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (passage.has(cellKey(x, y))) return true;
              return false;
            })
          : "wire" in zone
            ? floorIn(...zone.wire.a) || floorIn(...zone.wire.b)
            : "edge" in zone.door && (doorEdges.includes(zone.door.edge) || sidesOf(zone.door.edge).some((c) => passage.has(c)));
      if (!hit) out.push(op);
    } else if (op.t === "pin.put") {
      if (!floorIn(op.pin.x, op.pin.y)) out.push(op);
    } else out.push(op);
  }
  return out;
}

/** The dungeon's ops on scene s1, with every secret door's cover set to `cover` (the gate's mutation writes "drawn"). */
function onS1(d: FixtureDungeon, cover: "auto" | "drawn" = "auto"): Op[] {
  let text = JSON.stringify(d.ops).replaceAll(JSON.stringify(d.sceneId), JSON.stringify(S));
  if (cover === "drawn") text = text.replaceAll('"cover":"auto"', '"cover":"drawn"');
  return JSON.parse(text) as Op[];
}

type See = { explore: boolean; perPlayer?: boolean };

/** The test room with the ops landed on its players' scene by the shared reducer as the DM, and the party's two creatures on `start`. */
function landed(ops: readonly Op[], see: See, start: readonly string[]): RoomState {
  const base = room();
  const { s1: _, ...others } = base.scenes;
  let state: RoomState = { ...base, scenes: others };
  for (const [i, raw] of ops.entries()) {
    let op = raw;
    if (op.t === "scene.create") {
      const { vision: _v, ...scene } = op.scene;
      op = { t: "scene.create", scene: { ...scene, fogEnabled: true, ...(see.explore ? { vision: { on: true, light: "bright" as const, ...(see.perPlayer ? { perPlayer: true } : {}) } } : {}) } };
    }
    const r = applyOp(state, op, { memberId: "dm1", role: "dm" }, { seq: i + 1, at: AT });
    assert.ok(r.ok, `${op.t} refused: ${r.ok ? "" : r.message}`);
    state = r.state;
  }
  const [a, b] = [xy(start[0]!), xy(start[1] ?? start[0]!)];
  state.tokens = {
    ...state.tokens,
    a: token("a", { kind: "pc", name: "Ayla", ownerIds: ["p1"], disposition: "ally", x: a[0], y: a[1] }),
    b: token("b", { kind: "pc", name: "Bree", ownerIds: ["p2"], disposition: "ally", x: b[0], y: b[1] }),
  };
  if (see.perPlayer) state.holders = { [S]: { sceneId: S, rev: 0, entries: [{ memberId: "p1", on: true }] } };
  return { ...state, memory: {}, memoryBy: {}, playedScenes: { [S]: { sceneId: S, rev: 0 } }, memoryShared: {} };
}

type Step = "normal" | "tiny" | "throw";
/** How the next batch's map step runs, the same in both twins: capped small or failing, so layers forget whole tiles or fail closed. */
let stepMode: Step = "normal";
const mapStep: typeof mapStepOps = (input) => {
  if (stepMode === "throw") throw new Error("the gate's failing map step");
  return mapStepOps(stepMode === "tiny" ? { ...input, cap: () => 900 } : input);
};

type Device = { client: ScopeClient; read: number; view: ProjectedState | null };
type Twin = { h: Awaited<ReturnType<typeof scopeActor>>; dm: ScopeClient; devices: Map<string, Device> };
const PLAYERS = ["p1", "p2"] as const;

function members(state: RoomState): Record<"dm" | "p1" | "p2", Member> {
  return { dm: state.members.dm1!, p1: state.members.p1!, p2: state.members.p2! };
}

/** Reads what the device got since the last read into its view, and checks no frame holds anything private. */
function catchUp(d: Device): void {
  const sent = d.client.sent as ServerMessage[];
  for (; d.read < sent.length; d.read++) {
    const msg = sent[d.read]!;
    assert.deepEqual(privateFieldsIn(msg), [], `a frame to ${d.client.conn.viewer.memberId} holds something private`);
    if (msg.t === "snapshot") d.view = msg.state as ProjectedState;
    else if (msg.t === "ev" && d.view) d.view = applyChanges(d.view, msg.changes as Change[]);
  }
}

async function open(t: TestContext, state: RoomState): Promise<Twin> {
  const h = await scopeActor(t, state, { mapStep });
  const who = members(state);
  const dm = await h.connect(who.dm);
  const devices = new Map<string, Device>();
  for (const p of PLAYERS) {
    const d: Device = { client: await h.connect(who[p]), read: 0, view: null };
    catchUp(d);
    devices.set(p, d);
  }
  return { h, dm, devices };
}

/** The chunk of a device's view that files the edge. */
function chunkOf(view: ProjectedState | null, edge: string): PlayerChunk | undefined {
  const [x, y] = xy(edge);
  return view?.buildChunks[`${S}:${Math.floor(x / CHUNK_CELLS)},${Math.floor(y / CHUNK_CELLS)}`] as PlayerChunk | undefined;
}

/** What a class's layers on the server hold: its memory and its explored layer, revs left out. */
function layerOf(state: RoomState, layer: string | null): string {
  const mine = (c: { sceneId: string; memberId?: string }) => c.sceneId === S && (layer === null ? c.memberId === undefined : c.memberId === layer);
  const memory = layer === null ? Object.values(state.memory ?? {}) : Object.values(state.memoryBy ?? {});
  const explored = layer === null ? Object.values(state.exploredTiles) : Object.values(state.exploredBy ?? {});
  return stableStringify(withoutRevs({ memory: memory.filter(mine), explored: explored.filter(mine) }));
}

/** A class's stored memory entry for an edge, or undefined where it keeps none. */
function memoryEntry(state: RoomState, layer: string | null, edge: string): EdgeFeature | "auto" | null | undefined {
  const [x, y] = xy(edge);
  const chunks: MemoryChunk[] = layer === null ? Object.values(state.memory ?? {}) : Object.values(state.memoryBy ?? {});
  const chunk = chunks.find((c) => c.sceneId === S && (layer === null ? c.memberId === undefined : c.memberId === layer) && c.cx === Math.floor(x / CHUNK_CELLS) && c.cy === Math.floor(y / CHUNK_CELLS));
  return chunk?.edges?.[edge];
}

/** SB6's precondition, asserted: both door squares painted, the rule `"all"`, and no near square sharing another edge with a passage square. */
function assertPrecondition(state: RoomState, side: Side, where: string): void {
  const scene = state.scenes[S]!;
  assert.equal(scene.autoWalls ?? "all", "all", `${where}: a generated scene walls its rooms against rock`);
  const cells = new Set(Object.values(state.buildChunks).filter((c) => c.sceneId === S).flatMap((c) => Object.keys(c.cells)));
  for (const e of side.doorway.edges) for (const c of sidesOf(e)) assert.ok(cells.has(c), `${where}: door square ${c} painted`);
  for (const n of side.near) for (const p of around(n)) if (side.passage.has(p)) assert.ok(side.doorway.edges.includes(edgeBetween(n, p)), `${where}: near square ${n} meets the passage only through the door`);
}

/** A random event both twins take. */
type Event = { by: "dm" | "p1" | "p2"; op: Op; mode: Step } | { reload: "page"; who: "p1" | "p2" } | { reload: "room" };

function randomEvent(r: () => number, state: RoomState, side: Side, see: See, n: number): Event {
  const mode: Step = chance(r, 0.12) ? "tiny" : chance(r, 0.04) ? "throw" : "normal";
  const dm = (op: Op): Event => ({ by: "dm", op, mode });
  const spot = () => xy(pick(r, side.standing));
  const roll = r();
  if (roll < 0.3) {
    const [x, y] = spot();
    return dm({ t: "token.move", tokenId: pick(r, ["a", "b"]), x, y });
  }
  if (roll < 0.4) {
    const p = pick(r, PLAYERS);
    const [x, y] = spot();
    return { by: p, op: { t: "token.move", tokenId: p === "p1" ? "a" : "b", x, y }, mode };
  }
  if (roll < 0.55) {
    // Reveals only where the audience may hold, hides anywhere near.
    const reveal = chance(r, 0.6);
    const [x, y] = spot();
    const shape = reveal ? { kind: "rect" as const, x, y, w: 1, h: 1 } : { kind: "rect" as const, x: x - int(r, 0, 3), y: y - int(r, 0, 3), w: int(r, 1, 6), h: int(r, 1, 6) };
    return dm({ t: "fog.live", sceneId: S, ops: [{ id: `f${n}`, mode: reveal ? "reveal" : "hide", shape }] });
  }
  if (roll < 0.58) return dm({ t: "fog.reset", sceneId: S, to: "hidden" });
  if (roll < 0.66 && see.explore) {
    const scene = state.scenes[S]!;
    if (scene.vision?.perPlayer === true && chance(r, 0.8)) return dm({ t: "vision.holders", sceneId: S, on: PLAYERS.filter(() => chance(r, 0.5)) });
    return dm({ t: "scene.update", sceneId: S, patch: { vision: { on: true, light: "bright", perPlayer: scene.vision?.perPlayer !== true } } });
  }
  if (roll < 0.74) {
    const p = pick(r, PLAYERS);
    return { by: p, op: { t: "door.set", sceneId: S, door: { edge: pick(r, side.doorway.edges) }, state: "open", by: p === "p1" ? "a" : "b" }, mode };
  }
  if (roll < 0.95) return { reload: "page", who: pick(r, PLAYERS) };
  return { reload: "room" };
}

type Counts = { compared: number; nearHeld: number; reloads: number; forgets: number };

function rejection(event: Extract<ServerMessage, { t: "ev" }>, n: number): string {
  return event.rejects?.find((x) => x.n === n)?.code ?? "ok";
}

/** Takes one event in both twins and returns their answers. */
async function take(t: TestContext, pair: [Twin, Twin], event: Event, where: string): Promise<string[]> {
  const answers: string[] = [];
  for (const twin of pair) {
    if ("reload" in event) {
      if (event.reload === "page") {
        const old = twin.devices.get(event.who)!;
        twin.h.actor.detach(old.client.conn);
        const d: Device = { client: await twin.h.connect(members(twin.h.actor.committed.state)[event.who]), read: 0, view: null };
        catchUp(d);
        catchUp(old);
        assert.equal(stableStringify(d.view), stableStringify(old.view), `${where}: a reload gives ${event.who} what the events built`);
        twin.devices.set(event.who, d);
      } else {
        for (const d of twin.devices.values()) catchUp(d);
        const next = await open(t, twin.h.actor.committed.state);
        twin.h = next.h;
        twin.dm = next.dm;
        twin.devices = next.devices;
      }
      continue;
    }
    stepMode = event.mode;
    const client = event.by === "dm" ? twin.dm : twin.devices.get(event.by)!.client;
    answers.push(rejection(await client.send(event.op), client.n));
    stepMode = "normal";
  }
  return answers;
}

/**
 * Compares every player whose class is in the audience, after asserting it
 * is and that the precondition holds. Returns whether the twins differed for
 * any, when `expectSame` is off (the mutation's run).
 */
function compare(pair: [Twin, Twin], side: Side, where: string, counts: Counts, expectSame = true): boolean {
  const states = pair.map((p) => p.h.actor.committed.state) as [RoomState, RoomState];
  assertPrecondition(states[0], side, where);
  let differ = false;
  for (const p of PLAYERS) {
    const layer = classOfMember(states[0], p);
    assert.equal(layer, classOfMember(states[1], p), `${where}: ${p} is in one class in both twins`);
    assert.ok(classesOf(states[0]).includes(layer), `${where}: ${p}'s class exists`);
    assert.equal(holdsAny(states, layer, side.banned), false, `${where}: the ${layer ?? "party"} class is in SB6's audience`);
    const views = pair.map((twin) => {
      const d = twin.devices.get(p)!;
      catchUp(d);
      return stableStringify(withoutRevs(d.view));
    });
    const layers = states.map((s) => layerOf(s, layer));
    if (!expectSame) {
      if (views[0] !== views[1] || layers[0] !== layers[1]) differ = true;
      continue;
    }
    assert.equal(views[0], views[1], `${where}: ${p}'s device (${layer ?? "party"}) is the same in both twins`);
    assert.equal(layers[0], layers[1], `${where}: the ${layer ?? "party"} layer is the same in both twins`);
    counts.compared++;
    const view = pair[0].devices.get(p)!.view;
    if (holdsAny([states[0]], layer, new Set(side.near)) && side.doorway.edges.every((e) => autoAt(chunkOf(view, e), e))) counts.nearHeld++;
  }
  return differ;
}

/** The party's first step for a side: Ayla on a near square on Explore, or the DM revealing the room alone, or the near squares and their corridor, on Reveal by hand. */
function firstLook(side: Side, see: See, plan: Plan, kind: "room" | "corridor"): Op {
  if (see.explore) {
    const [x, y] = xy(side.near[0]!);
    return { t: "token.move", tokenId: "a", x, y };
  }
  if (kind === "room") return { t: "fog.live", sceneId: S, ops: [{ id: "room", mode: "reveal", shape: { kind: "rect", ...side.doorway.room } }] };
  const cells = side.standing.filter((c) => plan.painted.has(c));
  return { t: "fog.live", sceneId: S, ops: cells.map((c, i) => ({ id: `c${i}`, mode: "reveal" as const, shape: { kind: "rect" as const, x: xy(c)[0], y: xy(c)[1], w: 1, h: 1 } })) };
}

/**
 * Out of sight of the door: the middle of the room farthest from it, other
 * than the doorway's own room and the secret room, behind the closed doors
 * every room keeps.
 */
function awayFrom(plan: Plan, side: Side): string {
  const [nx, ny] = xy(side.near[0]!);
  const rooms = plan.rooms.filter((r) => r !== side.doorway.room && !(side.doorway.secretRoom && [...side.doorway.secretRoom].some((c) => inRect(c, r))));
  const middle = (r: Rect) => cellKey(r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
  const far = rooms.map(middle).filter((c) => plan.painted.has(c) && !side.banned.has(c)).sort((a, b) => {
    const [ax, ay] = xy(a);
    const [bx, by] = xy(b);
    return Math.abs(bx - nx) + Math.abs(by - ny) - (Math.abs(ax - nx) + Math.abs(ay - ny));
  });
  assert.ok(far[0], "a room away from the door");
  return far[0];
}

type GateCase = { name: string; dungeon: FixtureDungeon; kind: "room" | "corridor"; see: See };

function sideFor(c: GateCase): { plan: Plan; side: Side } {
  const plan = planOf(c.dungeon);
  const all = doorways(plan);
  const doorway = c.kind === "room" ? all.find((d) => d.loop) : all.find((d) => d.secretRoom !== null);
  assert.ok(doorway, `${c.name}: the fixture has a ${c.kind === "room" ? "loop doorway" : "secret room"}`);
  const wide = c.dungeon === WIDE;
  assert.equal(doorway.edges.length, wide ? 2 : 1, `${c.name}: a ${wide ? "Wide" : "Narrow"} doorway`);
  return { plan, side: sideOf(plan, doorway, c.kind) };
}

/** One gate run: the twins, the first look and its non-vacuous check, a walk away and back, then random events, until Mark found ends it. */
async function gateRun(t: TestContext, c: GateCase, seed: number, steps: number, counts: Counts, cover: "auto" | "drawn" = "auto"): Promise<{ differ: boolean }> {
  const { plan, side } = sideFor(c);
  const away = awayFrom(plan, side);
  const start = [away, away];
  const doorOps = onS1(c.dungeon, cover);
  const pair: [Twin, Twin] = [await open(t, landed(doorOps, c.see, start)), await open(t, landed(rockOps(doorOps, side.passage, side.doorway.edges), c.see, start))];
  const where = (i: number | string) => `${c.name}, seed ${seed}, step ${i}`;
  const expectSame = cover === "auto";
  let differ = compare(pair, side, where("start"), counts, expectSame);

  // The first look: the near square held and the door's edge an automatic wall bit there, before anything is compared on.
  for (const twin of pair) await twin.dm.apply(firstLook(side, c.see, plan, c.kind));
  const look = pair[0].h.actor.committed.state;
  const layer = classOfMember(look, "p1");
  assert.ok(holdsAny([look], layer, new Set(side.near)), `${where("look")}: the class holds the near square`);
  const lookView = (catchUp(pair[0].devices.get("p1")!), pair[0].devices.get("p1")!.view);
  if (expectSame) for (const e of side.doorway.edges) assert.ok(autoAt(chunkOf(lookView, e), e), `${where("look")}: ${e} is an automatic wall bit`);
  differ = compare(pair, side, where("look"), counts, expectSame) || differ;

  // Out of sight: the remembered edge reads as the automatic wall bit, and any stored entry for it is "auto".
  if (c.see.explore) {
    const [x, y] = xy(away);
    for (const twin of pair) await twin.dm.apply({ t: "token.move", tokenId: "a", x, y });
    const state = pair[0].h.actor.committed.state;
    const view = (catchUp(pair[0].devices.get("p1")!), pair[0].devices.get("p1")!.view);
    for (const e of side.doorway.edges) {
      if (expectSame) assert.ok(autoAt(chunkOf(view, e), e), `${where("away")}: remembered, ${e} is still an automatic wall bit`);
      const entry = memoryEntry(state, classOfMember(state, "p1"), e);
      if (entry !== undefined && expectSame) assert.equal(entry, "auto", `${where("away")}: the stored entry for ${e}`);
    }
    differ = compare(pair, side, where("away"), counts, expectSame) || differ;
  }

  const r = rng(seed);
  for (let i = 0; i < steps; i++) {
    const event = randomEvent(r, pair[0].h.actor.committed.state, side, c.see, seed * 1000 + i);
    const answers = await take(t, pair, event, where(i));
    if (answers.length === 2) assert.equal(answers[0], answers[1], `${where(i)}: both twins answer ${"op" in event ? event.op.t : ""} alike`);
    if ("reload" in event) counts.reloads++;
    else if (event.mode !== "normal") counts.forgets++;
    differ = compare(pair, side, where(i), counts, expectSame) || differ;
  }

  // Mark found ends the comparison: the door twin then shows the door.
  if (expectSame) {
    const twin = pair[0];
    await twin.dm.apply({ t: "door.set", sceneId: S, door: { edge: side.doorway.edges[0]! }, state: "closed", found: true });
    const [x, y] = xy(side.near[0]!);
    await twin.dm.apply({ t: "token.move", tokenId: "a", x, y });
    if (c.see.explore) {
      if (twin.h.actor.committed.state.scenes[S]!.vision?.perPlayer === true) await twin.dm.apply({ t: "scene.update", sceneId: S, patch: { vision: { on: true, light: "bright", perPlayer: false } } });
      const d = twin.devices.get("p1")!;
      catchUp(d);
      assert.deepEqual(chunkOf(d.view, side.doorway.edges[0]!)?.edges[side.doorway.edges[0]!], { kind: "door", state: "closed", secret: true, discovered: true }, `${where("found")}: found, it is the door without its cover`);
    }
  }
  return { differ };
}

const CASES: GateCase[] = [
  { name: "Narrow, a loop doorway's room side, Explore", dungeon: NARROW, kind: "room", see: { explore: true } },
  { name: "Narrow, a loop doorway's room side, Reveal by hand", dungeon: NARROW, kind: "room", see: { explore: false } },
  { name: "Narrow, a secret room's corridor side, Explore per player", dungeon: NARROW, kind: "corridor", see: { explore: true, perPlayer: true } },
  { name: "Narrow, a secret room's corridor side, Reveal by hand", dungeon: NARROW, kind: "corridor", see: { explore: false } },
  { name: "Wide, a loop doorway's room side, Explore per player", dungeon: WIDE, kind: "room", see: { explore: true, perPlayer: true } },
  { name: "Wide, a loop doorway's room side, Reveal by hand", dungeon: WIDE, kind: "room", see: { explore: false } },
  { name: "Wide, a secret room's corridor side, Explore", dungeon: WIDE, kind: "corridor", see: { explore: true } },
  { name: "Wide, a secret room's corridor side, Reveal by hand", dungeon: WIDE, kind: "corridor", see: { explore: false } },
];

describe("the dungeon generator's secret door gate (SB6 on generated plans)", () => {
  test("for every class in the audience, each device and layer is the same with the generated secret door as with rock, until it is found", async (t) => {
    const counts: Counts = { compared: 0, nearHeld: 0, reloads: 0, forgets: 0 };
    for (const [i, c] of CASES.entries()) for (let seed = 1; seed <= 2; seed++) await gateRun(t, c, i * 100 + seed, 30, counts);
    // Not vacuous: many comparisons with a near square held and the door's edge an automatic wall bit on the device.
    assert.ok(counts.compared > 600, `compared ${counts.compared}`);
    assert.ok(counts.nearHeld > 400, `compared with the near square held and the bit there ${counts.nearHeld}`);
    assert.ok(counts.reloads > 80, `reloads ${counts.reloads}`);
    assert.ok(counts.forgets > 30, `capped or failing map steps ${counts.forgets}`);
  });

  test("a door written with cover drawn fails the room side, so the gate can see what the cover hides", async (t) => {
    const counts: Counts = { compared: 0, nearHeld: 0, reloads: 0, forgets: 0 };
    for (const c of CASES.filter((x) => x.kind === "room" && x.see.explore)) {
      assert.equal((await gateRun(t, c, 7, 0, counts, "drawn")).differ, true, `${c.name}: the drawn cover told apart`);
    }
  });

  test("a loop doorway seen from both ends is an automatic wall bit at every step until found, live and remembered, before and after the class holds both squares", async (t) => {
    for (const dungeon of [NARROW, WIDE]) {
      const { plan, side } = sideFor({ name: dungeon.name, dungeon, kind: "room", see: { explore: true } });
      const corridor = sideOf(plan, side.doorway, "corridor");
      const away = awayFrom(plan, side);
      const twin = await open(t, landed(onS1(dungeon), { explore: true }, [away, away]));
      const check = (what: string, both: boolean) => {
        const state = twin.h.actor.committed.state;
        const d = twin.devices.get("p1")!;
        catchUp(d);
        assert.equal(holdsAny([state], null, new Set([...side.near, ...corridor.near])), true, `${dungeon.name}, ${what}: the party holds a door square`);
        if (both) for (const s of [...side.near, ...corridor.near]) assert.ok(holdsAny([state], null, new Set([s])), `${dungeon.name}, ${what}: the party holds ${s}`);
        for (const e of side.doorway.edges) {
          const chunk = chunkOf(d.view, e);
          assert.ok(autoAt(chunk, e), `${dungeon.name}, ${what}: ${e} is an automatic wall bit`);
          assert.equal(chunk?.edges[e], undefined, `${dungeon.name}, ${what}: ${e} is never in edges`);
          const entry = memoryEntry(state, null, e);
          if (entry !== undefined) assert.equal(entry, "auto", `${dungeon.name}, ${what}: the stored entry for ${e}`);
        }
      };
      const [ix, iy] = xy(side.near[0]!);
      await twin.dm.apply({ t: "token.move", tokenId: "a", x: ix, y: iy });
      check("the room side alone", false);
      const [ox, oy] = xy(corridor.near[0]!);
      await twin.dm.apply({ t: "token.move", tokenId: "b", x: ox, y: oy });
      check("both sides", true);
      const [fx, fy] = xy(away);
      await twin.dm.apply({ t: "token.move", tokenId: "a", x: fx, y: fy });
      await twin.dm.apply({ t: "token.move", tokenId: "b", x: fx, y: fy });
      check("remembered after both", true);
      const page = twin.devices.get("p1")!;
      twin.h.actor.detach(page.client.conn);
      twin.devices.set("p1", { client: await twin.h.connect(members(twin.h.actor.committed.state).p1), read: 0, view: null });
      check("after a reload", true);
    }
  });

  test("an edit unseen to a door the party remembers stores its entry as auto (DDO4-1)", async (t) => {
    for (const edit of ["removed", "found"] as const) {
      const { plan, side } = sideFor({ name: NARROW.name, dungeon: NARROW, kind: "room", see: { explore: true } });
      const away = awayFrom(plan, side);
      const twin = await open(t, landed(onS1(NARROW), { explore: true }, [away, away]));
      const [nx, ny] = xy(side.near[0]!);
      await twin.dm.apply({ t: "token.move", tokenId: "a", x: nx, y: ny });
      const [fx, fy] = xy(away);
      await twin.dm.apply({ t: "token.move", tokenId: "a", x: fx, y: fy });
      const e = side.doorway.edges[0]!;
      assert.ok([undefined, "auto"].includes(memoryEntry(twin.h.actor.committed.state, null, e) as string | undefined), "before the edit, any entry is auto");
      await twin.dm.apply(edit === "removed" ? { t: "build.edge", sceneId: S, edges: [{ key: e, feature: null }] } : { t: "door.set", sceneId: S, door: { edge: e }, state: "closed", found: true });
      assert.equal(memoryEntry(twin.h.actor.committed.state, null, e), "auto", `the door ${edit} out of sight: the party's memory holds what it saw`);
      const d = twin.devices.get("p1")!;
      catchUp(d);
      assert.ok(autoAt(chunkOf(d.view, e), e), `the door ${edit} out of sight: the device still reads the automatic wall`);
    }
  });
});
