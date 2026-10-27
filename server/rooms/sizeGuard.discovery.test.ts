import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, tileKey, wallChunk, chunkKey } from "#shared/keys.ts";
import { exploredReserve, LIMITS, serializedBytes } from "#shared/limits.ts";
import { mapDiscoveryUpgrade } from "#shared/migrate.ts";
import type { BuildChunk, FreeWall, Member, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { DM, env, member, room, scene, token } from "#shared/testutil.ts";
import { capRoom, perPlayerRoom } from "../../scripts/bench-vision.ts";
import { MEMORY_CAP } from "./memorySize.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";
import {
  discoveryReserve,
  growthBound,
  MEMORY_FULL,
  measuredFromStored,
  measuredStateBytes,
  memoryReserves,
  memoryShare,
  memoryStateReserve,
  PER_PLAYER_FULL,
  projectedSceneBytes,
  SCENE_MAPS_FULL,
  SizeGuard,
} from "./sizeGuard.ts";

/**
 * Map discovery's sizes (docs/design-v1-map-discovery.md 5.5): players'
 * copies of a scene with fog on hold each free wall at most at its largest
 * form and every chunk position at its widest, players' memory is
 * reserved at its cap on every marked scene with fog and party vision on,
 * scenes marked at the upgrade share the room's free space, and no measure
 * reads a memory or an explored layer (rule 8).
 */

const MIB = 1024 * 1024;
const SCENE_LIMIT = LIMITS.projectedSceneBytes;

/** A whole stored room around one of bench-vision.ts's scenes, its scene marked played, with a DM and these players. */
function stored(partial: RoomState, players: readonly string[]): RoomState {
  const members: Record<string, Member> = { dm1: member("dm1", "dm") };
  for (const id of players) members[id] = member(id);
  const sceneId = Object.keys(partial.scenes)[0]!;
  return {
    ...room(),
    ...partial,
    members,
    fogTiles: {},
    exploredTiles: {},
    exploredBy: {},
    holders: {},
    labels: {},
    stamps: {},
    memory: {},
    memoryBy: {},
    playedScenes: { [sceneId]: { sceneId, rev: 0 } },
    memoryShared: {},
  };
}

/** A deterministic stream of numbers in [0, 1). */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q64 = (v: number) => Math.round(v * 64) / 64;

/** Files free walls into a room's chunks by their midpoints, as the reducer does. */
function withWalls(state: RoomState, sceneId: string, walls: readonly FreeWall[], replace = false): RoomState {
  const chunks: Record<string, BuildChunk> = { ...state.buildChunks };
  if (replace) for (const [key, c] of Object.entries(chunks)) if (c.sceneId === sceneId) chunks[key] = { ...c, walls: [] };
  for (const w of walls) {
    const { cx, cy } = wallChunk(w);
    const key = chunkKey(sceneId, cx, cy);
    const c = chunks[key] ?? { sceneId, cx, cy, rev: 0, cells: {}, edges: {} };
    chunks[key] = { ...c, walls: [...(c.walls ?? []), w] };
  }
  return { ...state, buildChunks: chunks };
}

function wallCount(state: RoomState): number {
  return Object.values(state.buildChunks).reduce((n, c) => n + (c.walls?.length ?? 0), 0);
}

function id(k: number): string {
  return `w${String(k).padStart(11, "0")}`;
}

describe("players' copies at the caps fit 3 MiB (5.5, LK-36, ASTRA-32)", () => {
  const measure = (state: RoomState) => projectedSceneBytes(state, Object.keys(state.scenes)[0]!, MEMORY_CAP);

  test("the bench scene, whole party and per player, at the numbers of 5.5", () => {
    const party = stored(capRoom("dark").state, ["p1"]);
    assert.equal(wallCount(party), 1814);
    const perPlayer = stored(perPlayerRoom("dark").state, ["h1", "h2", "h3", "h4", "h5", "h6"]);
    // 2.05 MiB and 2.59 MiB in the design's scratch measure.
    assert.ok(Math.abs(measure(party) / MIB - 2.05) < 0.05, `whole party ${(measure(party) / MIB).toFixed(3)} MiB`);
    assert.ok(Math.abs(measure(perPlayer) / MIB - 2.59) < 0.05, `per player ${(measure(perPlayer) / MIB).toFixed(3)} MiB`);
    for (const state of [party, perPlayer]) assert.ok(measure(state) <= SCENE_LIMIT);
    // A DM's first edit there passes.
    const guard = new SizeGuard();
    assert.deepEqual(guard.check(party, ["bench"], 1_000, party), { ok: true });
  });

  test("4,000 free walls on Reveal by hand, 4,000 8-cell diagonals, and 4,000 short doors in place of the bench's walls", () => {
    const r = stream(2026);
    const bench = stored(capRoom("dark").state, ["p1"]);
    const extra: FreeWall[] = [];
    for (let k = wallCount(bench); k < LIMITS.freeWallsPerScene; k++) {
      const ax = q64(r() * 190 + 2);
      const ay = q64(r() * 190 + 2);
      const len = 2 + r() * 6;
      const angle = r() * 2 * Math.PI;
      extra.push({ id: id(k), a: [ax, ay], b: [q64(Math.min(199, Math.max(1, ax + len * Math.cos(angle)))), q64(Math.min(199, Math.max(1, ay + len * Math.sin(angle))))], f: { kind: "wall" } });
    }
    const reveal = withWalls(bench, "bench", extra);
    reveal.scenes = { bench: { ...reveal.scenes.bench!, vision: { on: false, light: "dark" } } };
    assert.equal(wallCount(reveal), LIMITS.freeWallsPerScene);
    // An empty 200 x 200 scene on Reveal by hand: no creatures, lights, sight or memory.
    const empty = stored({ ...capRoom("dark").state, buildChunks: {}, tokens: {}, lights: {} }, ["p1"]);
    empty.scenes = { bench: { ...empty.scenes.bench!, vision: { on: false, light: "dark" } } };
    // 8-cell walls at any slope, from anywhere: a 45-degree one from no corner crosses the most cells, 13, and gives 8 pieces.
    const diagonals: FreeWall[] = [];
    const steep: FreeWall[] = [];
    for (let k = 0; k < LIMITS.freeWallsPerScene; k++) {
      const ax = q64(r() * 186 + 6);
      const ay = q64(r() * 186 + 6);
      const angle = r() * 2 * Math.PI;
      diagonals.push({ id: id(k), a: [ax, ay], b: [q64(ax + 7.99 * Math.cos(angle)), q64(ay + 7.99 * Math.sin(angle))], f: { kind: "wall" } });
      steep.push({ id: id(k), a: [ax, ay], b: [ax + 5.65625, ay + 5.65625], f: { kind: "wall" } });
    }
    const crossed = withWalls(empty, "bench", diagonals);
    const worst = withWalls(empty, "bench", steep);
    const doors: FreeWall[] = [];
    for (let k = 0; k < LIMITS.freeWallsPerScene; k++) {
      const x = 2 + (k % 63) * 3;
      const y = 2 + Math.floor(k / 63) * 3;
      doors.push({ id: id(k), a: [x + 0.25, y + 0.25], b: [x + 0.75, y + 0.75], f: { kind: "door", state: "closed", secret: false, discovered: false } });
    }
    const doored = withWalls(bench, "bench", doors, true);
    const numbers = { reveal: measure(reveal) / MIB, crossed: measure(crossed) / MIB, worst: measure(worst) / MIB, doored: measure(doored) / MIB };
    // The design's scratch measure gave 2.54, 2.73 (the 45-degree walls) and 1.40 MiB, the last on a lighter bench room.
    // This one, every wall at its own bound, commits these.
    assert.ok(Math.abs(numbers.reveal - 2.56) < 0.03, JSON.stringify(numbers));
    assert.ok(Math.abs(numbers.crossed - 2.6) < 0.03, JSON.stringify(numbers));
    assert.ok(Math.abs(numbers.worst - 2.74) < 0.03, JSON.stringify(numbers));
    assert.ok(Math.abs(numbers.doored - 1.81) < 0.03, JSON.stringify(numbers));
    for (const state of [reveal, crossed, worst, doored]) assert.ok(measure(state) <= SCENE_LIMIT, JSON.stringify(numbers));
  });

  test("a large cave map's imported walls, cut into lattice walls of up to 8 cells, fit with room to edit", () => {
    // A Universal VTT cave's walls as the import stores them: long winding polylines, each leg on the 1/64 lattice.
    const r = stream(77);
    const walls: FreeWall[] = [];
    let k = 0;
    for (let line = 0; line < 120 && k < LIMITS.freeWallsPerScene; line++) {
      let x = q64(5 + r() * 190);
      let y = q64(5 + r() * 190);
      let heading = r() * 2 * Math.PI;
      for (let leg = 0; leg < 30 && k < LIMITS.freeWallsPerScene; leg++) {
        heading += (r() - 0.5) * 1.2;
        const len = 0.5 + r() * 2.5;
        const nx = q64(Math.min(199, Math.max(1, x + len * Math.cos(heading))));
        const ny = q64(Math.min(199, Math.max(1, y + len * Math.sin(heading))));
        if (nx === x && ny === y) continue;
        walls.push({ id: id(k++), a: [x, y], b: [nx, ny], f: { kind: "wall" } });
        x = nx;
        y = ny;
      }
    }
    const cave = withWalls(stored({ ...capRoom("dark").state, buildChunks: {} }, ["p1"]), "bench", walls);
    cave.scenes = { bench: { ...cave.scenes.bench!, autoWalls: "off" } };
    assert.ok(measure(cave) <= SCENE_LIMIT - 512 * 1024, `${(measure(cave) / MIB).toFixed(3)} MiB`);
  });
});

/** Two scenes with fog and party vision on, marked at the upgrade so they share the room, in a room whose limit leaves `spare` bytes beyond them. */
function sharedRoom(spare: number): { state: RoomState; limit: number } {
  const base = room();
  base.scenes = {
    s1: scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } }),
    s2: scene("s2", { order: 1, fogEnabled: true, vision: { on: true, light: "dark" } }),
  };
  const state = mapDiscoveryUpgrade(base);
  const limit = measuredStateBytes(state) + exploredReserve(state) + spare;
  return { state, limit };
}

describe("the room-wide share (5.5, MD-O-14)", () => {
  test("a room near full at the upgrade loads and takes edits, its shares shrunk room-wide", () => {
    const { state, limit } = sharedRoom(50_000);
    assert.deepEqual(memoryReserves(state), { whole: 0, sharing: 2 });
    const guard = new SizeGuard({ stateLimit: limit });
    guard.stateMeasured(measuredStateBytes(state), state);
    assert.equal(guard.share, 25_000, "the free space split over both layers");
    assert.ok(guard.share < MEMORY_CAP);
    const edit: Op = { t: "token.create", token: token("t1", { notes: "n".repeat(4_000) }) };
    const r = applyOp(state, edit, DM, env(2));
    assert.ok(r.ok);
    assert.deepEqual(guard.check(r.state, ["s1"], growthBound(state, r.state, r.touched), state), { ok: true });
    assert.ok(guard.share < 25_000, "an exact measure lowered the share");
    assert.ok(guard.takeShareLowered() && !guard.takeShareLowered(), "the actor is told once");
    assert.ok(measuredStateBytes(r.state) + exploredReserve(r.state) + memoryStateReserve(r.state, guard.share) <= limit);
  });

  test("the share is a function of the stored state and its exact measure, so a reload gives the same", () => {
    const { state, limit } = sharedRoom(70_000);
    const running = new SizeGuard({ stateLimit: limit });
    running.stateMeasured(measuredStateBytes(state), state);
    let s = state;
    for (let i = 0; i < 5; i++) {
      const r = applyOp(s, { t: "token.create", token: token(`t${i}`, { notes: "n".repeat(3_000) }) }, DM, env(2 + i));
      assert.ok(r.ok);
      assert.ok(running.check(r.state, ["s1"], growthBound(s, r.state, r.touched), s).ok);
      s = r.state;
    }
    // The share takes the room's whole free space, so each growing op measures, and the share is the exact one, never the bound's.
    assert.equal(running.share, memoryShare(limit, measuredStateBytes(s), exploredReserve(s), memoryReserves(s)), "a share lowered only on an exact measure");
    // A snapshot measures exactly, as a reload does from the stored bytes.
    running.stateMeasured(measuredFromStored(serializedBytes(s), s), s);
    const reloaded = new SizeGuard({ stateLimit: limit });
    reloaded.stateMeasured(measuredFromStored(serializedBytes(s), s), s);
    assert.equal(running.share, reloaded.share);
    assert.equal(running.share, memoryShare(limit, measuredStateBytes(s), exploredReserve(s), memoryReserves(s)));
  });

  test("a marked per-player scene that folds keeps the party's share, and the room's measure falls", () => {
    const { state } = sharedRoom(0);
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: true, light: "dark", perPlayer: true } };
    const before = memoryReserves(state);
    assert.equal(before.sharing, 1 + 2 + 1, "the party's and a layer for each of the two players, and the other scene's");
    const folded = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: false } } }, DM, env(2));
    assert.ok(folded.ok);
    assert.ok(folded.state.memoryShared?.s1, "the fold keeps the share mark");
    assert.equal(memoryReserves(folded.state).sharing, 2);
    assert.ok(memoryStateReserve(folded.state, 1_000) < memoryStateReserve(state, 1_000));
  });

  test("after a fold, a switch back to Per player takes the holders' whole caps while the party keeps its share, through a reload and an import (MD3-ASTRA-4)", () => {
    const base = room();
    base.scenes = { s1: scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } }) };
    const up = mapDiscoveryUpgrade(base);
    assert.deepEqual(memoryReserves(up), { whole: 0, sharing: 3 }, "at the upgrade the party's layer and both players' share");
    const vision = (perPlayer: boolean) => ({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer } } }) as Op;
    const folded = applyOp(up, vision(false), DM, env(2));
    assert.ok(folded.ok);
    assert.equal(folded.state.memoryShared?.s1?.party, true, "the fold keeps the party's share alone");
    assert.deepEqual(memoryReserves(folded.state), { whole: 0, sharing: 1 });
    const back = applyOp(folded.state, vision(true), DM, env(3));
    assert.ok(back.ok);
    assert.deepEqual(memoryReserves(back.state), { whole: 2 * MEMORY_CAP, sharing: 1 }, "the holders' layers take whole caps");
    // Room for 1,000 bytes of memory: the switch back is refused in the DM's words, as it would be on a scene that never shared.
    const limit = measuredStateBytes(folded.state) + exploredReserve(folded.state) + 1_000;
    const answer = new SizeGuard({ stateLimit: limit }).check(back.state, ["s1"], growthBound(folded.state, back.state, back.touched), folded.state);
    assert.equal(answer.ok ? "" : answer.message, PER_PLAYER_FULL);
    // The mark is stored state: a reload and an import keep the distinction.
    const stored = parseRoomState(JSON.parse(JSON.stringify(back.state)));
    assert.ok(stored.ok);
    assert.deepEqual(memoryReserves(stored.state), memoryReserves(back.state));
    // The import makes every member a player until a DM claims it, so its roster has one more holder layer, at a whole cap too.
    const imported = remapState(back.state, { assets: new Map() });
    assert.equal(Object.values(imported.memoryShared ?? {})[0]?.party, true);
    assert.deepEqual(memoryReserves(imported), { whole: 3 * MEMORY_CAP, sharing: 1 });
    // Undoing the fold is a switch back too: the mark is bookkeeping no undo restores, so the holders' layers take whole caps.
    const undone = applyOp(folded.state, { t: "sys.restore", entries: folded.inverse!, from: "undo" } as Op, DM, env(4));
    assert.ok(undone.ok);
    assert.deepEqual(memoryReserves(undone.state), { whole: 2 * MEMORY_CAP, sharing: 1 });
  });

  test("a whole cap where the scene does not share, and none where memory is not reserved", () => {
    const { state } = sharedRoom(0);
    const fresh = { ...state, memoryShared: {} };
    assert.deepEqual(memoryReserves(fresh), { whole: 2 * MEMORY_CAP, sharing: 0 });
    const off = { ...fresh, scenes: { ...fresh.scenes, s2: { ...fresh.scenes.s2!, vision: { on: false, light: "dark" as const } } } };
    assert.deepEqual(memoryReserves(off), { whole: MEMORY_CAP, sharing: 0 });
    // A scene neither the players' nor played reserves nothing, whatever its explored layer holds.
    const unplayed = { ...fresh, playedScenes: {} };
    assert.deepEqual(memoryReserves(unplayed), { whole: MEMORY_CAP, sharing: 0 }, "the players' scene still reserves");
  });
});

describe("no measure reads a memory or an explored layer (rule 8)", () => {
  test("memory counts at its cap, not its size", () => {
    const { state } = sharedRoom(0);
    const remembering: RoomState = { ...state, memory: { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone", "2,2": null } } } };
    assert.equal(measuredStateBytes(remembering), measuredStateBytes(state));
    assert.equal(measuredFromStored(serializedBytes(remembering), remembering), measuredStateBytes(state));
    assert.equal(projectedSceneBytes(remembering, "s1", 5_000), projectedSceneBytes(state, "s1", 5_000));
  });

  test("two rooms differing by one private explored tile on a per-player scene the players left give the same measures and answers", () => {
    const base = room();
    base.members.p3 = member("p3");
    base.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    base.holders = { s2: { sceneId: "s2", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    const a = mapDiscoveryUpgrade(base);
    const b: RoomState = { ...a, exploredBy: { [holderTileKey("s2", "p1", 0, 0)]: { sceneId: "s2", tx: 0, ty: 0, rev: 3, bits: encodeTile(fullTileBits()), memberId: "p1" } } };
    assert.equal(measuredStateBytes(a), measuredStateBytes(b));
    assert.equal(projectedSceneBytes(a, "s2"), projectedSceneBytes(b, "s2"));
    const P1: Viewer = { memberId: "p1", role: "player" };
    for (const limit of [measuredStateBytes(a) + 200_000, measuredStateBytes(a) + 300_000, measuredStateBytes(a) + 1_000_000]) {
      const answers = [a, b].map((s) => {
        const r = applyOp(s, { t: "drawing.create", drawing: { id: "d1", sceneId: "s1", kind: "pen", points: [1, 1, 2, 2], color: "#ffffff", width: 2 } as never }, P1, env(9));
        if (!r.ok) return r.message;
        return JSON.stringify(new SizeGuard({ stateLimit: limit }).check(r.state, ["s1"], growthBound(s, r.state, r.touched), s, "player"));
      });
      assert.equal(answers[0], answers[1], `at ${limit}`);
    }
  });

  test("paired rooms at the limit, a wall out of sight in one: a player's op may be refused for size, in words that name no place (risk 2)", () => {
    const a = mapDiscoveryUpgrade(room());
    a.scenes.s1 = { ...a.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
    const wall: FreeWall = { id: "hiddenwall01", a: [150.25, 150.25], b: [157.25, 150.25], f: { kind: "wall" } };
    const b = withWalls(a, "s1", [wall]);
    const P1: Viewer = { memberId: "p1", role: "player" };
    const op: Op = { t: "drawing.create", drawing: { id: "d1", sceneId: "s1", kind: "pen", points: [1, 1, 2, 2], color: "#ffffff", width: 2 } as never };
    const answer = (s: RoomState, limit: number) => {
      const r = applyOp(s, op, P1, env(9));
      assert.ok(r.ok);
      return new SizeGuard({ stateLimit: limit }).check(r.state, ["s1"], growthBound(s, r.state, r.touched), s, "player");
    };
    const full = (s: RoomState) => measuredStateBytes(s) + exploredReserve(s) + memoryStateReserve(s) + 200;
    const limit = full(a);
    assert.ok(full(b) > limit, "the wall takes room");
    assert.deepEqual(answer(a, limit), { ok: true });
    const refused = answer(b, limit);
    assert.ok(!refused.ok);
    assert.equal(refused.message, `the room is full: it is at its ${Math.floor(limit / MIB)} MiB size limit`, "the room-full words every op risks");
    assert.ok(!/150|157|s1|hiddenwall/.test(refused.message), "nothing says where the wall is");
  });

  test("a legacy scene marked at the upgrade reserves memory once its vision goes on, though the players are elsewhere (ASTRA-27)", () => {
    const legacy = room();
    legacy.scenes.s2 = scene("s2", { order: 1, fogEnabled: true });
    legacy.exploredTiles = { [tileKey("s2", 0, 0)]: { sceneId: "s2", tx: 0, ty: 0, rev: 0, bits: encodeTile(fullTileBits()) } };
    const upgraded = mapDiscoveryUpgrade(legacy);
    assert.equal(memoryReserves(upgraded).whole, 0);
    const on = applyOp(upgraded, { t: "scene.update", sceneId: "s2", patch: { vision: { on: true, light: "dark" } } }, DM, env(2));
    assert.ok(on.ok);
    assert.equal(memoryReserves(on.state).whole, MEMORY_CAP);
  });
});

describe("the DM's words where players' maps do not fit (5.5)", () => {
  test("turning party vision on where the room cannot hold its memory says so, and a switch to per player says PER_PLAYER_FULL", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    const marked = { ...state, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memory: {}, memoryBy: {}, memoryShared: {} };
    const on = applyOp(marked, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark" } } }, DM, env(2));
    assert.ok(on.ok);
    // Room for the explored layer and a few bytes, not for players' memory.
    const tight = measuredStateBytes(on.state) + exploredReserve(on.state) + 1_000;
    const answer = new SizeGuard({ stateLimit: tight }).check(on.state, ["s1"], growthBound(marked, on.state, on.touched), marked);
    assert.deepEqual(answer, { ok: false, code: "quota", message: MEMORY_FULL });
    const perPlayer = applyOp(marked, { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", perPlayer: true } } }, DM, env(2));
    assert.ok(perPlayer.ok);
    const roomy = measuredStateBytes(perPlayer.state) + MEMORY_CAP + 1_000;
    const switched = new SizeGuard({ stateLimit: roomy }).check(perPlayer.state, ["s1"], growthBound(marked, perPlayer.state, perPlayer.touched), marked);
    assert.equal(switched.ok ? "" : switched.message, PER_PLAYER_FULL);
  });

  test("Duplicate with Fog of a played scene and Move players to a scene with party vision say MEMORY_FULL where only memory does not fit", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
    state.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: true, light: "dark" } });
    const marked: RoomState = { ...state, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memory: {}, memoryBy: {}, memoryShared: {} };
    const copy = applyOp(marked, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: true, drawings: false } }, DM, env(2));
    assert.ok(copy.ok && copy.state.playedScenes?.s3, "the copy carries the played mark");
    const tight = (s: RoomState) => measuredStateBytes(s) + exploredReserve(s) + memoryStateReserve(s) - 1_000;
    const copied = new SizeGuard({ stateLimit: tight(copy.state) }).check(copy.state, ["s3"], growthBound(marked, copy.state, copy.touched), marked);
    assert.deepEqual(copied, { ok: false, code: "quota", message: MEMORY_FULL });
    // Without fog the copy keeps no mark, so it reserves nothing more and fits.
    const plain = applyOp(marked, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: false } }, DM, env(2));
    assert.ok(plain.ok && !plain.state.playedScenes?.s3);
    assert.ok(new SizeGuard({ stateLimit: tight(copy.state) }).check(plain.state, ["s3"], growthBound(marked, plain.state, plain.touched), marked).ok);
    const moved = applyOp(marked, { t: "room.setPlayerScene", sceneId: "s2" }, DM, env(2));
    assert.ok(moved.ok && moved.state.playedScenes?.s2, "moving the players marks the scene");
    const movedAnswer = new SizeGuard({ stateLimit: tight(moved.state) }).check(moved.state, ["s2"], growthBound(marked, moved.state, moved.touched), marked);
    assert.deepEqual(movedAnswer, { ok: false, code: "quota", message: MEMORY_FULL });
  });

  test("a scene over its limit only by players' maps keeps working: edits that do not grow it pass, a DM's growing edit gets the note, a player's op is judged as before", () => {
    const bench = stored(capRoom("dark").state, ["p1"]);
    const reserve = discoveryReserve(bench, bench.scenes.bench!, MEMORY_CAP);
    const legacy = projectedSceneBytes(bench, "bench", MEMORY_CAP, "player");
    // A limit the scene fits without what players' copies may add, and not with it.
    const sceneLimit = legacy + Math.floor(reserve / 2);
    const guard = () => new SizeGuard({ sceneLimit });
    const grow = applyOp(bench, { t: "token.create", token: token("big", { sceneId: "bench", notes: "n".repeat(2_000) }) }, DM, env(2));
    assert.ok(grow.ok);
    assert.deepEqual(guard().check(grow.state, ["bench"], growthBound(bench, grow.state, grow.touched), bench), { ok: false, code: "quota", message: SCENE_MAPS_FULL });
    const shrink = applyOp(bench, { t: "token.delete", tokenId: "m0" }, DM, env(2));
    assert.ok(shrink.ok);
    assert.deepEqual(guard().check(shrink.state, ["bench"], growthBound(bench, shrink.state, shrink.touched), bench), { ok: true });
    assert.deepEqual(guard().check(grow.state, ["bench"], growthBound(bench, grow.state, grow.touched), bench, "player"), { ok: true });
  });
});
