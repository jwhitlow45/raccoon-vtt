import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, heights, lift, paint, remember, stairs, wall } from "./discoveryTestutil.ts";
import { keys, type EntityKey } from "./keys.ts";
import { CHUNK_CELLS, type BuildChunk, type FreeWall, type Label, type PlayerChunk, type RememberedWall, type RoomState, type Scene, type TerrainId, type Viewer, type WallFeature } from "./model.ts";
import { exploreFor, perPlayerOp, perPlayerState, playersOf, withCellVision } from "./perPlayerTestutil.ts";
import { allKeys, applyChanges, changedSightKeys, dependents, diffProjection, heldOf, projectChunkForPlayer, projectEntity, projectState, stableStringify, stampCells, viewerSceneId, type HeldEntry, type ProjectedState } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp, type ApplyResult } from "./reducer.ts";
import { labelCells } from "./rules/fog.ts";
import { decodeHeights } from "./rules/heights.ts";
import { sceneGrid } from "./rules/grid.ts";
import { fogClassOf, groundOf, wallSpans, type Ground } from "./rules/held.ts";
import { landing, ownWalk } from "./rules/movement.ts";
import { linesPastStart } from "./logRings.ts";
import { DM, P1, chance, comparable, deepClone, env, int, pick, rng } from "./testutil.ts";

/**
 * The property tests of map discovery (docs/design-v1-map-discovery.md
 * section 13, lane MD2): random rooms of 1 to 8 players, per-player scenes
 * and whole-party ones, with random builds (painted rooms on chunk borders
 * beside unbuilt chunks, walls, doors, secret doors and windows, free walls
 * crossing chunks, heights, stair runs, labels and stamps, both automatic
 * walls rules), under random ops by the DM and players (sight, reveals,
 * hides, resets, the Sight switch, DM edits in and out of sight, moved
 * labels, undo, blackouts, members joining and leaving), with the explore
 * step after each, by perPlayerTestutil.ts's stub sight. After every batch:
 *
 * - MX1: no player or display holds any piece of geometry on a cell their
 *   class never held, by an oracle that records every cell each one ever
 *   held, but visible free doors, labels and stamps by their box, and a
 *   rounded end's sliver. At the end, the room and a twin whose build
 *   differs only two cells or more from anything any of them ever held
 *   give every one of them the same bytes.
 * - MX3: the changes the fan-out's rule finds, applied to each viewer's
 *   last projection, give the fresh projection.
 * - MX4: on a player's live ground, where nothing near is a free wall's
 *   piece, a walk lands on their device where it lands on the server.
 * - MX5: no player's projection holds memory or its marks, and replaying
 *   the ops rebuilds the same room.
 * - MX6: on a scene with fog off, players get today's chunks, and the
 *   scene's own automatic walls rule.
 *
 * MX2's selection, each element's live or remembered value by decision 6,
 * a free wall per cell, is checked over random memory below: the memory a
 * layer writes is the map step's (server/rooms/explore.ts), which the
 * server's lane tests against its sight.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const TERRAINS: TerrainId[] = ["stone", "wood", "grass"];

/** A random build on a scene: rooms on and across chunk borders, their walls and doors, free walls, heights, stairs and rough ground. */
function randomBuild(r: () => number, state: RoomState, sceneId: string): void {
  const scene = state.scenes[sceneId]!;
  const { w, h } = scene.bounds;
  if (chance(r, 0.5)) scene.autoWalls = pick(r, ["floor", "off"] as const);
  const at = (s: RoomState) => s;
  for (let i = 0; i < int(r, 2, 6); i++) {
    // Rooms often straddle the chunk line at 16, so a stub or a neighbor holds their far wall.
    const x = chance(r, 0.5) ? CHUNK_CELLS - int(r, 1, 4) : int(r, 0, w - 4);
    const y = chance(r, 0.5) ? CHUNK_CELLS - int(r, 1, 4) : int(r, 0, h - 4);
    const rw = Math.min(int(r, 2, 7), w - x);
    const rh = Math.min(int(r, 2, 7), h - y);
    paintIn(at(state), sceneId, { x, y, w: rw, h: rh }, pick(r, TERRAINS));
    for (let k = x; k < x + rw; k++) {
      edgeIn(state, sceneId, `${k},${y},n`, randomFeature(r));
      if (y + rh < h) edgeIn(state, sceneId, `${k},${y + rh},n`, randomFeature(r));
    }
    for (let k = y; k < y + rh; k++) {
      edgeIn(state, sceneId, `${x},${k},w`, randomFeature(r));
      if (x + rw < w) edgeIn(state, sceneId, `${x + rw},${k},w`, randomFeature(r));
    }
  }
  for (let i = 0; i < int(r, 1, 8); i++) {
    const ax = int(r, 0, (w - 1) * 64) / 64;
    const ay = int(r, 0, (h - 1) * 64) / 64;
    const len = int(r, 32, 7 * 64) / 64;
    const angle = r() * 2 * Math.PI;
    const bx = Math.min(w, Math.max(0, Math.round((ax + len * Math.cos(angle)) * 64) / 64));
    const by = Math.min(h, Math.max(0, Math.round((ay + len * Math.sin(angle)) * 64) / 64));
    if (bx === ax && by === ay) continue;
    wall(state, `w${i}${int(r, 0, 1e6)}`.padEnd(12, "x").slice(0, 12), [ax, ay], [bx, by], randomWallFeature(r), sceneId);
  }
  if (sceneId === "s1") {
    for (let i = 0; i < int(r, 0, 3); i++) heights(state, { x: int(r, 0, w - 3), y: int(r, 0, h - 3), w: int(r, 1, 3), h: int(r, 1, 3) }, pick(r, [5, 10, -5]));
    if (chance(r, 0.5)) {
      const x = int(r, 1, w - 6);
      const y = int(r, 1, h - 2);
      stairs(state, [0, 1, 2, 3].map((k): [number, number] => [x + k, y]), "a");
    }
  }
}

function randomFeature(r: () => number): BuildChunk["edges"][string] {
  const roll = r();
  if (roll < 0.6) return { kind: "wall" };
  if (roll < 0.85) return { kind: "door", state: pick(r, ["open", "closed", "locked"] as const), secret: chance(r, 0.3), discovered: chance(r, 0.5) };
  return { kind: "window" };
}

function randomWallFeature(r: () => number): WallFeature {
  return randomFeature(r) as WallFeature;
}

/* The fixtures write scene s1 by default: these take the scene. */
function paintIn(state: RoomState, sceneId: string, rect: { x: number; y: number; w: number; h: number }, terrain: TerrainId): void {
  if (sceneId === "s1") paint(state, rect, terrain);
  else for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) chunkOf(state, sceneId, x, y).cells[`${x},${y}`] = terrain;
}

function edgeIn(state: RoomState, sceneId: string, key: string, feature: BuildChunk["edges"][string]): void {
  if (sceneId === "s1") return edge(state, key, feature);
  const [x, y] = key.split(",").map(Number) as [number, number];
  chunkOf(state, sceneId, x, y).edges[key] = feature;
}

function chunkOf(state: RoomState, sceneId: string, x: number, y: number): BuildChunk {
  const cx = Math.floor(x / CHUNK_CELLS);
  const cy = Math.floor(y / CHUNK_CELLS);
  const key = `${sceneId}:${cx},${cy}`;
  const old = state.buildChunks[key];
  const chunk: BuildChunk = old ? { ...old, cells: { ...old.cells }, edges: { ...old.edges } } : { sceneId, cx, cy, rev: 1, cells: {}, edges: {} };
  state.buildChunks = { ...state.buildChunks, [key]: chunk };
  return chunk;
}

/** A random room for map discovery: perPlayerState's, its scenes per player or whole party, fog on most often, walls stopping moves, and a build. */
function discoveryState(r: () => number): RoomState {
  const state = perPlayerState(r);
  for (const scene of Object.values(state.scenes)) {
    scene.fogEnabled = chance(r, 0.8);
    scene.blockMovement = chance(r, 0.7);
    if (scene.vision && chance(r, 0.4)) scene.vision = { on: scene.vision.on, light: scene.vision.light };
    else if (!scene.vision && chance(r, 0.6)) scene.vision = { on: true, light: pick(r, ["bright", "dim", "dark"] as const) };
    randomBuild(r, state, scene.id);
  }
  // Ground the DM revealed and the party explored, beside what perPlayerState left.
  for (let i = 0; i < int(r, 0, 3); i++) lift(state, pick(r, ["dm", "party"] as const), { x: int(r, 0, 28), y: int(r, 0, 28), w: int(r, 1, 8), h: int(r, 1, 8) });
  return state;
}

/**
 * A random op: perPlayerOp's, or by the DM a build edit on and across the
 * chunk lines at 16, in sight or out of it: free walls whose held pieces
 * are filed in a neighbor's position, border edges and cells, heights, and
 * labels moved.
 */
function discoveryOp(r: () => number, state: RoomState, who: Viewer): Op {
  if (who.role !== "dm" || chance(r, 0.6)) return perPlayerOp(r, state, who);
  const sceneId = pick(r, ["s1", "s1", "s2"]);
  const scene = state.scenes[sceneId];
  if (!scene) return perPlayerOp(r, state, who);
  const near = (n: number) => Math.min(n - 1, Math.max(0, CHUNK_CELLS + int(r, -3, 3)));
  switch (int(r, 0, 5)) {
    case 0:
    case 1: {
      // Across a chunk line, its midpoint on either side.
      const vertical = chance(r, 0.5);
      const at = int(r, 1, Math.min(scene.bounds.w, scene.bounds.h) - 2);
      const a = CHUNK_CELLS * 64 - int(r, 8, 200);
      const b = CHUNK_CELLS * 64 + int(r, 8, 200);
      const off = int(r, -40, 40);
      const p = (u: number, v: number): [number, number] => (vertical ? [Math.min(scene.bounds.w, u / 64), Math.min(scene.bounds.h, v)] : [Math.min(scene.bounds.w, v), Math.min(scene.bounds.h, u / 64)]);
      const w: FreeWall = { id: `cw${int(r, 0, 1e6)}`.padEnd(12, "c").slice(0, 12), a: p(a, at + 0.25), b: p(b, at + 0.25 + off / 64), f: randomWallFeature(r) };
      const existing = Object.values(state.buildChunks).flatMap((c) => (c.sceneId === sceneId ? (c.walls ?? []).map((x) => ({ cx: c.cx, cy: c.cy, id: x.id })) : []));
      return chance(r, 0.25) && existing.length > 0 ? { t: "build.walls", sceneId, remove: [pick(r, existing)] } : { t: "build.walls", sceneId, put: [w] };
    }
    case 2:
      return { t: "build.edge", sceneId, edges: [{ key: `${near(scene.bounds.w)},${int(r, 0, scene.bounds.h - 1)},${pick(r, ["n", "w"])}`, feature: chance(r, 0.2) ? null : randomFeature(r) }] };
    case 3:
      return { t: "build.paint", sceneId, terrain: pick(r, TERRAINS), cells: [`${near(scene.bounds.w)},${near(scene.bounds.h)}`, `${int(r, 0, scene.bounds.w - 1)},${int(r, 0, scene.bounds.h - 1)}`] };
    case 4:
      return { t: "build.height", sceneId, cells: [`${near(scene.bounds.w)},${int(r, 0, scene.bounds.h - 1)}`], height: pick(r, [0, 5, 10]) };
    default: {
      const ids = Object.values(state.labels).filter((l) => l.sceneId === sceneId).map((l) => l.id);
      const id = ids.length > 0 && chance(r, 0.7) ? pick(r, ids) : `lb${int(r, 0, 1e6)}`;
      return { t: "build.label", sceneId, labelId: id, label: chance(r, 0.85) ? { x: int(r, 0, scene.bounds.w - 1) + 0.5, y: int(r, 0, scene.bounds.h - 1) + 0.5, text: "Here", size: 1 } : null };
    }
  }
}

// ---------------------------------------------------------------------------
// The oracle of held ground

/** Every cell each viewer's class ever held, by viewer and scene: the DM's reveals, the party's layer and their own, at any moment. */
type EverHeld = Map<string, Map<string, Set<string>>>;

function viewersOf(state: RoomState): Viewer[] {
  return [...playersOf(state), DISPLAY];
}

function groundFor(state: RoomState, sceneId: string, viewer: Viewer): Ground | null {
  return groundOf(state, sceneId, viewer === DISPLAY ? null : fogClassOf(state, sceneId, viewer.memberId));
}

function recordHeld(state: RoomState, ever: EverHeld): void {
  for (const viewer of viewersOf(state)) {
    let byScene = ever.get(viewer.memberId);
    if (!byScene) ever.set(viewer.memberId, (byScene = new Map()));
    for (const scene of Object.values(state.scenes)) {
      if (!scene.fogEnabled) continue;
      const ground = groundFor(state, scene.id, viewer)!;
      let cells = byScene.get(scene.id);
      if (!cells) byScene.set(scene.id, (cells = new Set()));
      for (let y = 0; y < scene.bounds.h; y++) for (let x = 0; x < scene.bounds.w; x++) if (ground.held(x, y)) cells.add(`${x},${y}`);
    }
  }
}

/** Whether a point lies in a held cell, or within 2/10000 cell of one, as a rounded end may. */
function nearHeld(cells: ReadonlySet<string>, x: number, y: number): boolean {
  const d = 2.5e-4;
  for (const [dx, dy] of [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]] as const) if (cells.has(`${Math.floor(x + dx)},${Math.floor(y + dy)}`)) return true;
  return false;
}

function visibleDoor(f: WallFeature): boolean {
  return f.kind === "door" && !(f.secret && !f.discovered);
}

/** MX1 for one viewer: every element of their copy of each scene with fog on lies on cells they ever held. */
function checkHeld(where: string, state: RoomState, view: ProjectedState, viewer: Viewer, ever: EverHeld): void {
  const byScene = ever.get(viewer.memberId);
  for (const raw of Object.values(view.buildChunks)) {
    const chunk = raw as PlayerChunk;
    const scene = state.scenes[chunk.sceneId];
    if (!scene?.fogEnabled) continue;
    const cells = byScene?.get(chunk.sceneId) ?? new Set<string>();
    const at = `${where}: ${viewer.memberId}'s chunk ${chunk.cx},${chunk.cy}`;
    for (const key of Object.keys(chunk.cells)) assert.ok(cells.has(key), `${at} holds cell ${key}`);
    for (const key of Object.keys(chunk.edges)) {
      const [xs, ys, side] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      const other = side === "n" ? `${x},${y - 1}` : `${x - 1},${y}`;
      assert.ok(cells.has(`${x},${y}`) || cells.has(other), `${at} holds edge ${key}`);
    }
    const local = (k: number) => `${chunk.cx * CHUNK_CELLS + (k % CHUNK_CELLS)},${chunk.cy * CHUNK_CELLS + Math.floor(k / CHUNK_CELLS)}`;
    const heightsOf = decodeHeights(chunk.heights);
    if (heightsOf) heightsOf.forEach((v, k) => v !== 0 && assert.ok(cells.has(local(k)), `${at} holds a height at ${local(k)}`));
    for (const [field, value] of [["up", chunk.up], ["rough", chunk.rough], ["upDir", chunk.upDir]] as const) {
      if (value === undefined) continue;
      for (let k = 0; k < value.length; k++) if (value[k] !== ".") assert.ok(cells.has(local(k)), `${at} holds ${field} at ${local(k)}`);
    }
    if (chunk.known) {
      const bytes = Buffer.from(chunk.known, "base64");
      for (let k = 0; k < CHUNK_CELLS * CHUNK_CELLS; k++) if ((bytes[k >> 3]! >> (k & 7)) & 1) assert.ok(cells.has(local(k)), `${at} knows ${local(k)}`);
    }
    for (const w of chunk.walls ?? []) {
      if (visibleDoor(w.f)) continue;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const x = w.a[0] + (w.b[0] - w.a[0]) * t;
        const y = w.a[1] + (w.b[1] - w.a[1]) * t;
        assert.ok(nearHeld(cells, x, y), `${at} holds a piece of ${JSON.stringify([w.a, w.b])} at ${x},${y} past held ground`);
      }
    }
  }
  const touches = (sceneId: string, box: { x0: number; y0: number; x1: number; y1: number }) => {
    const cells = byScene?.get(sceneId) ?? new Set<string>();
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) if (cells.has(`${x},${y}`)) return true;
    return false;
  };
  for (const label of Object.values(view.labels) as Label[]) {
    if (state.scenes[label.sceneId]?.fogEnabled) assert.ok(touches(label.sceneId, labelCells(label)), `${where}: ${viewer.memberId} holds label ${label.id} off held ground`);
  }
  for (const stamp of Object.values(view.stamps)) {
    if (state.scenes[stamp.sceneId]?.fogEnabled) assert.ok(touches(stamp.sceneId, stampCells(stamp)), `${where}: ${viewer.memberId} holds stamp ${stamp.id} off held ground`);
  }
}

/** MX5 and MX6 for one viewer's copy. */
function checkCopy(where: string, state: RoomState, view: ProjectedState, viewer: Viewer, sceneId: string): void {
  const record = view as unknown as Record<string, unknown>;
  for (const field of ["memory", "memoryBy", "played", "memoryShared", "playedScenes"]) assert.equal(record[field], undefined, `${where}: ${viewer.memberId} holds ${field}`);
  const scene = state.scenes[sceneId];
  if (!scene || scene.fogEnabled || viewerSceneId(state, viewer, { sceneId }) !== sceneId) return;
  // MX6: today's chunks, each the old flattening of its stored chunk, and no position past them.
  const today: Record<string, unknown> = {};
  for (const chunk of Object.values(state.buildChunks)) {
    if (chunk.sceneId !== sceneId) continue;
    const out = projectChunkForPlayer(state.buildChunks, chunk, scene.autoWalls);
    if (out) today[`${chunk.cx},${chunk.cy}`] = out;
  }
  const got: Record<string, unknown> = {};
  for (const chunk of Object.values(view.buildChunks)) if (chunk.sceneId === sceneId) got[`${chunk.cx},${chunk.cy}`] = chunk;
  assert.equal(stableStringify(got), stableStringify(today), `${where}: ${viewer.memberId} gets other chunks than today's with fog off`);
  assert.equal(view.scenes[sceneId]?.autoWalls, scene.autoWalls, `${where}: the scene copy changed its automatic walls rule with fog off`);
}

// ---------------------------------------------------------------------------
// The fan-out's events (MX3)

type Connection = { viewer: Viewer; sceneId: string; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function connect(state: RoomState, viewer: Viewer, sceneId: string): Connection {
  const view = projectState(state, viewer, { sceneId });
  return { viewer, sceneId, held: heldOf(view), view };
}

function candidatesFor(before: RoomState, after: RoomState, result: Extract<ApplyResult, { ok: true }>, connections: readonly Connection[]): Set<EntityKey> {
  if (result.global) return new Set([...allKeys(before), ...allKeys(after)]);
  const watched = connections.flatMap((c) => {
    const s = viewerSceneId(after, c.viewer, { sceneId: c.sceneId });
    return s === null ? [] : [s];
  });
  const all = [...result.touched, ...changedSightKeys(before, after, watched)];
  const passed = linesPastStart(before, after, connections.map((c) => c.viewer)).map((id) => keys.log(id));
  return new Set([...all, ...dependents(before, all), ...dependents(after, all), ...passed]);
}

function connections(state: RoomState, held: Connection[]): Connection[] {
  const out = held.filter((c) => c.viewer.role === "dm" || c.viewer === DISPLAY || state.members[c.viewer.memberId]?.kind === "player");
  for (const p of playersOf(state)) if (!out.some((c) => c.viewer.memberId === p.memberId)) out.push(connect(state, p, "s1"));
  return out;
}

// ---------------------------------------------------------------------------
// The device and the server (MX4)

/** Walks a player's creature toward random spots and compares the device's landing with the server's where the player sees all of it. */
function checkWalks(r: () => number, where: string, state: RoomState, counts: { walks: number }): void {
  for (const viewer of playersOf(state)) {
    const sceneId = viewerSceneId(state, viewer, { sceneId: "s1" });
    const scene = sceneId === null ? undefined : state.scenes[sceneId];
    if (!scene || sceneId === null || !scene.fogEnabled || scene.blockMovement !== true) continue;
    const view = projectState(state, viewer, { sceneId }) as unknown as RoomState;
    const ground = groundFor(state, sceneId, viewer)!;
    const mine = Object.values(state.tokens).filter((t) => t.sceneId === sceneId && t.ownerIds.includes(viewer.memberId) && !t.attached && t.size !== "custom" && view.tokens[t.id] !== undefined);
    for (const real of mine.slice(0, 2)) {
      const t = view.tokens[real.id]!;
      const to: { x: number; y: number; elevation: number } = { x: Math.min(scene.bounds.w - 1, Math.max(0, Math.round(real.x) + int(r, -4, 4))), y: Math.min(scene.bounds.h - 1, Math.max(0, Math.round(real.y) + int(r, -4, 4))), elevation: real.elevation };
      // Every cell the walk could read, its footprint at both ends and a cell more, on the player's live ground, and no piece of a free wall near.
      const x0 = Math.floor(Math.min(real.x, to.x)) - 2;
      const y0 = Math.floor(Math.min(real.y, to.y)) - 2;
      const x1 = Math.ceil(Math.max(real.x, to.x)) + 6;
      const y1 = Math.ceil(Math.max(real.y, to.y)) + 6;
      let live = true;
      for (let y = y0; y < y1 && live; y++) for (let x = x0; x < x1 && live; x++) if (x >= 0 && y >= 0 && x < scene.bounds.w && y < scene.bounds.h && !ground.live(x, y)) live = false;
      if (!live) continue;
      const pieces = Object.values(view.buildChunks).flatMap((c) => (c.sceneId === sceneId ? (c.walls ?? []) : []));
      if (pieces.some((w) => Math.max(w.a[0], w.b[0]) >= x0 && Math.min(w.a[0], w.b[0]) <= x1 && Math.max(w.a[1], w.b[1]) >= y0 && Math.min(w.a[1], w.b[1]) <= y1)) continue;
      const device = landing(view, ownWalk(t), to, "walk");
      const server = landing(state, ownWalk(real), to, "walk");
      assert.deepEqual([device.x, device.y, device.squeeze, device.stopped?.blocker ?? null], [server.x, server.y, server.squeeze, server.stopped?.blocker ?? null], `${where}: ${viewer.memberId}'s ${t.id} toward ${to.x},${to.y} lands elsewhere on their device`);
      counts.walks++;
    }
  }
}

// ---------------------------------------------------------------------------
// The runs

/** A twin of the room whose build differs only on cells two or more from anything any viewer ever held, with fog on (MX1's pairs). */
function twin(r: () => number, state: RoomState, ever: EverHeld): RoomState | null {
  const out = deepClone(state);
  const scene = out.scenes.s1;
  if (!scene?.fogEnabled) return null;
  const near = new Set<string>();
  for (const byScene of ever.values()) for (const key of byScene.get("s1") ?? []) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) near.add(`${x + dx},${y + dy}`);
  }
  const far: [number, number][] = [];
  for (let y = 0; y < scene.bounds.h; y++) for (let x = 0; x < scene.bounds.w; x++) if (!near.has(`${x},${y}`)) far.push([x, y]);
  // Nothing of a stair run, which a held stair's direction reads, and no change to a cell beside held ground, which an automatic wall on a held edge reads.
  const free = far.filter(([x, y]) => !Object.values(out.buildChunks).some((c) => c.sceneId === "s1" && c.up !== undefined && Math.abs(Math.floor(x / CHUNK_CELLS) - c.cx) <= 1 && Math.abs(Math.floor(y / CHUNK_CELLS) - c.cy) <= 1));
  if (free.length < 4) return null;
  for (let i = 0; i < int(r, 1, 6); i++) {
    const [x, y] = pick(r, free);
    const roll = int(r, 0, 3);
    if (roll === 0) chunkOf(out, "s1", x, y).cells[`${x},${y}`] = pick(r, TERRAINS);
    else if (roll === 1) chunkOf(out, "s1", x, y).edges[`${x},${y},${pick(r, ["n", "w"])}`] = randomFeature(r);
    else if (roll === 2 && free.some(([fx, fy]) => fx === x + 1 && fy === y)) wall(out, `t${i}`.padEnd(12, "z"), [x + 0.25, y + 0.5], [x + 1.75, y + 0.5], randomWallFeature(r), "s1");
    else out.labels[`twin-${i}`] = { id: `twin-${i}`, rev: 0, sceneId: "s1", x: x + 0.5, y: y + 0.5, text: "X", size: 1 };
  }
  return out;
}

function run(seed: number, steps: number, counts: { applied: number; fogged: number; walks: number; twins: number }): void {
  const r = rng(seed * 104729);
  const start = discoveryState(r);
  let state = start;
  let conns = connections(state, [connect(state, DM, "s1"), connect(state, DM, "s2"), connect(state, DISPLAY, "s1")]);
  const ever: EverHeld = new Map();
  recordHeld(state, ever);
  const done: { op: Op; who: Viewer; seq: number }[] = [];
  const batch = (op: Op, who: Viewer, seq: number, where: string): boolean => {
    const result = applyOp(state, op, who, env(seq));
    if (!result.ok) return false;
    done.push({ op, who, seq });
    const before = state;
    const after = result.state;
    recordHeld(after, ever);
    conns = connections(after, conns);
    const candidates = candidatesFor(before, after, result, conns);
    for (const c of conns) {
      const next = new Map<EntityKey, unknown>();
      for (const key of candidates) next.set(key, projectEntity(key, after, c.viewer, { sceneId: c.sceneId }));
      const diff = diffProjection(c.held, next);
      const applied = applyChanges(c.view, diff.changes);
      const fresh = projectState(after, c.viewer, { sceneId: c.sceneId });
      // MX3.
      if (stableStringify(applied) !== stableStringify(fresh)) assert.deepEqual(JSON.parse(JSON.stringify(applied)), JSON.parse(JSON.stringify(fresh)), `${where}: ${c.viewer.memberId}@${c.sceneId} misses a change`);
      c.view = fresh;
      c.held = heldOf(fresh);
      if (c.viewer.role === "player") {
        checkHeld(where, after, fresh, c.viewer, ever);
        checkCopy(where, after, fresh, c.viewer, c.sceneId);
      }
    }
    state = after;
    return true;
  };
  let undo: Extract<ApplyResult, { ok: true }>["inverse"] = null;
  for (let i = 0; i < steps; i++) {
    const players = playersOf(state);
    const who: Viewer = i % 4 === 3 && players.length > 0 ? pick(r, players) : DM;
    const raw: Op = undo && chance(r, 0.15) ? { t: "sys.restore", entries: undo, from: "undo" } : discoveryOp(r, state, who);
    if (raw.t === "sys.restore") undo = null;
    const parsed = opSchema.safeParse(raw);
    if (!parsed.success) continue;
    const where = `seed ${seed} op ${i} (${raw.t} by ${who.memberId})`;
    const before = state;
    if (!batch(parsed.data, who, 100 + 2 * i, where)) continue;
    counts.applied++;
    if (Object.values(state.scenes).some((s) => s.fogEnabled)) counts.fogged++;
    if (who.role === "dm" && raw.t !== "sys.restore") {
      const result = applyOp(before, parsed.data, who, env(100 + 2 * i));
      if (result.ok && result.inverse) undo = result.inverse;
    }
    const explore = exploreFor(state);
    if (explore) assert.ok(batch(opSchema.parse(explore), DM, 101 + 2 * i, `${where}, then its explore`), `${where}: the explore step was refused`);
    checkWalks(r, where, state, counts);
  }
  // MX1's pairs.
  const other = twin(r, state, ever);
  if (other) {
    counts.twins++;
    for (const viewer of viewersOf(state)) {
      const a = projectState(state, viewer, { sceneId: "s1" });
      const b = projectState(other, viewer, { sceneId: "s1" });
      assert.equal(stableStringify(b.buildChunks), stableStringify(a.buildChunks), `seed ${seed}: ${viewer.memberId}'s chunks tell the twin apart`);
      assert.equal(stableStringify(b.labels), stableStringify(a.labels), `seed ${seed}: ${viewer.memberId}'s labels tell the twin apart`);
    }
  }
  // MX5: replay rebuilds the room.
  let again = start;
  for (const { op, who, seq } of done) {
    const result = applyOp(again, op, who, env(seq));
    assert.ok(result.ok, `seed ${seed}: a replayed ${op.t} was refused`);
    again = result.state;
  }
  assert.deepEqual(comparable(again), comparable(state), `seed ${seed}: replay built another room`);
}

describe("map discovery over random rooms (MX1, MX3 to MX6)", () => {
  test("no player holds what they never held, events match, devices land where the server does, fog off is today's", () => {
    withCellVision(() => {
      const counts = { applied: 0, fogged: 0, walks: 0, twins: 0 };
      for (let seed = 1; seed <= 24; seed++) run(seed, 36, counts);
      assert.ok(counts.applied > 500 && counts.fogged > 400 && counts.walks > 20 && counts.twins > 10, JSON.stringify(counts));
    });
  });
});

/**
 * MX1's pairs at the side between live and remembered cells (D-261026-29
 * item 16): a wall that stops on that side, and the same wall the DM ran
 * on into the remembered cells out of sight, with the version the map
 * step keeps there, give the player the same bytes. Random lines and
 * lengths on the 1/64 lattice, across the side x = 6 or y = 6.
 */
describe("MX1's pairs where live ground meets remembered ground", () => {
  test("a wall ending on the side and the same wall run on out of sight read the same", () => {
    let compared = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 6007);
      const across = chance(r, 0.5);
      // Along the side's normal it steps a whole cell or two, along the side by any lattice amount, so it meets the side on the lattice.
      const m = int(r, 1, 3);
      const du = int(r, 1, 2) * 64;
      const dv = int(r, -96, 96);
      const start = 6 * 64 - m * du;
      const v0 = int(r, 2 * 64, 9 * 64);
      const at = (k: number): [number, number] => {
        const u = (start + k * du) / 64;
        const v = (v0 + k * dv) / 64;
        return across ? [u, v] : [v, u];
      };
      const world = (extended: boolean) => {
        const s = fogRoom({ vision: true, bounds: { w: 16, h: 16 } });
        lift(s, "party", { x: 0, y: 0, w: 16, h: 16 });
        lift(s, "dm", across ? { x: 0, y: 0, w: 6, h: 16 } : { x: 0, y: 0, w: 16, h: 6 });
        const old: FreeWall = { id: "abcdefghijkl", a: at(0), b: at(m), f: { kind: "wall" } };
        if (!extended) wall(s, old.id, old.a, old.b);
        else {
          const ran = wall(s, old.id, old.a, at(m + int(r, 1, 2)));
          // The map step's version over the remembered cells the new wall crosses: the wall as the party last saw it.
          const cells = wallSpans(sceneGrid(s.scenes["s1"]!), ran).map((span) => span.cell).filter((key) => {
            const [x, y] = key.split(",").map(Number) as [number, number];
            return across ? x >= 6 : y >= 6;
          });
          if (cells.length > 0) {
            const home = Object.values(s.buildChunks).find((c) => c.walls?.some((w) => w.id === old.id))!;
            remember(s, null, home.cx, home.cy, { walls: { [old.id]: [{ wall: old, cells }] } });
          }
        }
        return s;
      };
      const a = world(false);
      const b = world(true);
      if (a.buildChunks === undefined) continue;
      assert.equal(stableStringify(projectState(b, P1, { sceneId: "s1" }).buildChunks), stableStringify(projectState(a, P1, { sceneId: "s1" }).buildChunks), `seed ${seed}: the wall from ${JSON.stringify(at(0))} tells its run on`);
      compared++;
    }
    assert.ok(compared > 250, `only ${compared} pairs`);
  });
});

// ---------------------------------------------------------------------------
// MX2: the selection over random memory

/** The value an element shows a viewer by decision 6: live where it touches live ground, else their own layer's entry where it holds a touched cell, else the party's, else live. */
function expected<T>(ground: Ground, touched: readonly [number, number][], now: T, own: T | undefined, party: T | undefined): T {
  if (touched.some(([x, y]) => ground.live(x, y))) return now;
  if (ground.holder !== null && touched.some(([x, y]) => ground.own(x, y))) return own !== undefined ? own : now;
  return party !== undefined ? party : now;
}

describe("the live or remembered value of every element (MX2, decision 6)", () => {
  test("cells, edges, labels and free walls per cell, for the party and its holders, over random memory", () => {
    withCellVision(() => {
      let checked = 0;
      let remembered = 0;
      for (let seed = 1; seed <= 80; seed++) {
        const r = rng(seed * 7919);
        const s = discoveryState(r);
        const scene: Scene = s.scenes.s1!;
        scene.fogEnabled = true;
        scene.vision = { on: true, light: pick(r, ["bright", "dark"] as const), ...(chance(r, 0.5) ? { perPlayer: true } : {}) };
        s.meta.playerSceneId = "s1";
        s.meta.view = { ...s.meta.view, blackout: false };
        lift(s, "party", { x: 0, y: 0, w: 32, h: 32 });
        const holders = playersOf(s).map((p) => p.memberId).filter((id) => s.holders.s1?.entries.some((e) => e.on && e.memberId === id));
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        for (const id of holders) {
          if (!chance(r, 0.7)) continue;
          const rect = { x: int(r, 0, 20), y: int(r, 0, 20), w: int(r, 2, 12), h: int(r, 2, 12) };
          lift(s, { holder: id }, rect);
          rects.push(rect);
        }
        // Random entries in each layer: cells, edges, a label and free-wall versions over the cells they cover, half of them on a holder's own ground.
        for (const layer of [null, ...holders]) {
          for (let i = 0; i < int(r, 4, 24); i++) {
            const inOwn = rects.length > 0 && chance(r, 0.5) ? pick(r, rects) : null;
            const x = inOwn ? inOwn.x + int(r, 0, inOwn.w - 1) : int(r, 0, 31);
            const y = inOwn ? inOwn.y + int(r, 0, inOwn.h - 1) : int(r, 0, 31);
            const cx = Math.floor(x / CHUNK_CELLS);
            const cy = Math.floor(y / CHUNK_CELLS);
            const roll = int(r, 0, 3);
            if (roll === 0) remember(s, layer, cx, cy, { cells: { [`${x},${y}`]: chance(r, 0.3) ? null : pick(r, TERRAINS) } });
            else if (roll === 1) remember(s, layer, cx, cy, { edges: { [`${x},${y},${pick(r, ["n", "w"])}`]: chance(r, 0.3) ? null : chance(r, 0.2) ? "auto" : randomFeature(r) } });
            else if (roll === 2) {
              const label: Label = { id: `ml-${i}`, rev: 0, sceneId: "s1", x: x + 0.5, y: y + 0.5, text: "Old", size: 1 };
              remember(s, layer, Math.floor(label.x / CHUNK_CELLS), Math.floor(label.y / CHUNK_CELLS), { labels: { [label.id]: chance(r, 0.3) ? null : label } });
            } else {
              const real = Object.values(s.buildChunks).flatMap((c) => (c.sceneId === "s1" ? (c.walls ?? []) : []));
              if (real.length === 0) continue;
              const w = pick(r, real);
              const version: FreeWall | null = chance(r, 0.4) ? null : { ...w, f: randomWallFeature(r) };
              const cells = wallCells(w).filter(() => chance(r, 0.6));
              if (cells.length === 0) continue;
              const versions: RememberedWall[] = [{ wall: version, cells }];
              const home = Object.values(s.buildChunks).find((c) => c.walls?.some((o) => o.id === w.id))!;
              remember(s, layer, home.cx, home.cy, { walls: { [w.id]: versions } });
            }
          }
        }
        for (const viewer of viewersOf(s)) {
          const ground = groundFor(s, "s1", viewer)!;
          const view = projectState(s, viewer, { sceneId: "s1" });
          const holder = ground.holder;
          const memOf = (cx: number, cy: number, layer: string | null) => (layer === null ? s.memory?.[`s1:${cx},${cy}`] : s.memoryBy?.[`s1:${layer}:${cx},${cy}`]);
          const chunkAt = (cx: number, cy: number) => view.buildChunks[`s1:${cx},${cy}`] as PlayerChunk | undefined;
          const realAt = (cx: number, cy: number) => s.buildChunks[`s1:${cx},${cy}`];
          for (let y = 0; y < 32; y++) {
            for (let x = 0; x < 32; x++) {
              if (!ground.held(x, y)) continue;
              const cx = Math.floor(x / CHUNK_CELLS);
              const cy = Math.floor(y / CHUNK_CELLS);
              const key = `${x},${y}`;
              const own = holder === null ? undefined : memOf(cx, cy, holder)?.cells?.[key];
              const party = memOf(cx, cy, null)?.cells?.[key];
              const want = expected(ground, [[x, y]], realAt(cx, cy)?.cells[key] ?? null, own, party);
              assert.equal(chunkAt(cx, cy)?.cells[key] ?? null, want, `seed ${seed}: ${viewer.memberId}'s cell ${key}`);
              checked++;
              if (own !== undefined || party !== undefined) remembered++;
            }
          }
          for (const layer of [null, ...holders]) {
            for (const mem of Object.values((layer === null ? s.memory : s.memoryBy) ?? {})) {
              if (mem.sceneId !== "s1" || (layer !== null && mem.memberId !== layer)) continue;
              for (const key of Object.keys(mem.edges ?? {})) {
                const [xs, ys, side] = key.split(",");
                const x = Number(xs);
                const y = Number(ys);
                const touched: [number, number][] = side === "n" ? [[x, y], [x, y - 1]] : [[x, y], [x - 1, y]];
                if (!touched.some(([a, b]) => ground.held(a, b))) continue;
                const shown = chunkAt(mem.cx, mem.cy)?.edges[key];
                const ownEntry = holder === null ? undefined : memOf(mem.cx, mem.cy, holder)?.edges?.[key];
                const partyEntry = memOf(mem.cx, mem.cy, null)?.edges?.[key];
                const want = expected<unknown>(ground, touched, "live", ownEntry, partyEntry);
                if (want === "live") continue;
                // A remembered feature shows as it was, a remembered absence or automatic wall as no drawn feature.
                if (want === null || want === "auto") assert.equal(shown, undefined, `seed ${seed}: ${viewer.memberId}'s remembered edge ${key}`);
                else assert.deepEqual(shown, want, `seed ${seed}: ${viewer.memberId}'s remembered edge ${key}`);
                checked++;
              }
              for (const id of Object.keys(mem.labels ?? {})) {
                if (!id.startsWith("ml-")) continue;
                const find = (layerId: string | null) => Object.values((layerId === null ? s.memory : s.memoryBy) ?? {}).find((m) => m.sceneId === "s1" && (layerId === null || m.memberId === layerId) && m.labels?.[id] !== undefined)?.labels?.[id];
                const own = holder === null ? undefined : find(holder);
                const party = find(null);
                const now = s.labels[id]?.sceneId === "s1" ? s.labels[id]! : null;
                const cellsOf = (l: Label) => {
                  const box = labelCells(l);
                  const out: [number, number][] = [];
                  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) out.push([x, y]);
                  return out;
                };
                const some = (cells: [number, number][], on: (x: number, y: number) => boolean) => cells.some(([a, b]) => on(a, b));
                // Decision 6 by the label's boxes, the live one and each layer's: live where the live box is in sight, else the own entry where the own layer holds any box, else the party's, an entry shown only where its box is held and out of sight.
                let want: Label | null;
                if (now && some(cellsOf(now), ground.live)) want = now;
                else {
                  const boxes = [now, party, own].filter((v): v is Label => !!v).flatMap(cellsOf);
                  const entry = holder !== null && some(boxes, ground.own) ? own : party;
                  if (entry === undefined) want = now && some(cellsOf(now), ground.held) ? now : null;
                  else if (entry === null) want = null;
                  else want = some(cellsOf(entry), ground.live) || !some(cellsOf(entry), ground.held) ? null : entry;
                }
                assert.deepEqual(view.labels[id] ?? null, want, `seed ${seed}: ${viewer.memberId}'s remembered label ${id}`);
                checked++;
              }
            }
          }
          checked += checkWallsPerCell(`seed ${seed}: ${viewer.memberId}`, s, view, ground, memOf);
        }
      }
      assert.ok(checked > 20000 && remembered > 100, JSON.stringify({ checked, remembered }));
    });
  });
});

/** The cells a free wall crosses, by sampling it: enough for a random version's cover. */
function wallCells(w: Pick<FreeWall, "a" | "b">): string[] {
  const out = new Set<string>();
  for (let i = 1; i < 64; i++) {
    const t = i / 64;
    out.add(`${Math.floor(w.a[0] + (w.b[0] - w.a[0]) * t)},${Math.floor(w.a[1] + (w.b[1] - w.a[1]) * t)}`);
  }
  return [...out];
}

/**
 * Free walls per cell (decision 6, 5.2): inside each held cell, away from
 * its sides, every point of a projected piece lies on the version that cell
 * selects of some wall, and every such point of a selected version lies on
 * a piece of its kind. The pieces' rounding tilts them by 2/10000 cell at
 * most, which the tolerance takes.
 */
function checkWallsPerCell(where: string, s: RoomState, view: ProjectedState, ground: Ground, memOf: (cx: number, cy: number, layer: string | null) => { walls?: Record<string, RememberedWall[]> } | undefined): number {
  const real = Object.values(s.buildChunks).flatMap((c) => (c.sceneId === "s1" ? (c.walls ?? []).map((w) => ({ w, cx: c.cx, cy: c.cy })) : []));
  const pieces = Object.values(view.buildChunks).flatMap((c) => (c.sceneId === "s1" ? (c.walls ?? []) : []));
  const kindOf = (f: WallFeature) => (f.kind === "door" && f.secret && !f.discovered ? "wall" : f.kind);
  const version = (id: string, cx: number, cy: number, layer: string | null, cell: string): FreeWall | null | undefined => memOf(cx, cy, layer)?.walls?.[id]?.find((v) => v.cells.includes(cell))?.wall;
  const selected = (entry: { w: FreeWall; cx: number; cy: number }, x: number, y: number): FreeWall | null => {
    const cell = `${x},${y}`;
    const own = ground.holder === null ? undefined : version(entry.w.id, entry.cx, entry.cy, ground.holder, cell);
    const party = version(entry.w.id, entry.cx, entry.cy, null, cell);
    return expected<FreeWall | null>(ground, [[x, y]], entry.w, own, party);
  };
  const distance = (px: number, py: number, w: Pick<FreeWall, "a" | "b">) => {
    const ex = w.b[0] - w.a[0];
    const ey = w.b[1] - w.a[1];
    const t = Math.max(0, Math.min(1, ((px - w.a[0]) * ex + (py - w.a[1]) * ey) / (ex * ex + ey * ey)));
    return Math.hypot(px - (w.a[0] + ex * t), py - (w.a[1] + ey * t));
  };
  const inside = (v: number) => v - Math.floor(v) > 1e-3 && v - Math.floor(v) < 1 - 1e-3;
  let n = 0;
  for (const piece of pieces) {
    // A visible door goes whole, by its own rule (decision 2).
    if (visibleDoor(piece.f)) continue;
    for (let i = 1; i < 16; i++) {
      const t = i / 16;
      const x = piece.a[0] + (piece.b[0] - piece.a[0]) * t;
      const y = piece.a[1] + (piece.b[1] - piece.a[1]) * t;
      if (!inside(x) || !inside(y)) continue;
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      const ok = real.some((e) => {
        const v = selected(e, cx, cy);
        return v !== null && kindOf(v.f) === kindOf(piece.f) && distance(x, y, v) < 3e-4;
      });
      assert.ok(ok, `${where}: a piece at ${x},${y} lies on no wall as that cell shows it`);
      n++;
    }
  }
  for (const e of real) {
    for (const cell of wallCells(e.w)) {
      const [x, y] = cell.split(",").map(Number) as [number, number];
      if (!ground.held(x, y)) continue;
      const v = selected(e, x, y);
      if (v === null || visibleDoor(v.f)) continue;
      for (let i = 1; i < 32; i++) {
        const t = i / 32;
        const px = v.a[0] + (v.b[0] - v.a[0]) * t;
        const py = v.a[1] + (v.b[1] - v.a[1]) * t;
        if (Math.floor(px) !== x || Math.floor(py) !== y || !inside(px) || !inside(py)) continue;
        assert.ok(
          pieces.some((p) => kindOf(p.f) === kindOf(v.f) && distance(px, py, p) < 3e-4),
          `${where}: ${e.w.id} as cell ${cell} shows it has no piece at ${px},${py}`,
        );
        n++;
      }
    }
  }
  return n;
}
