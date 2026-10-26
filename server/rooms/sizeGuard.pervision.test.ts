import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkOps, serverApply, type Applier } from "#shared/differential.ts";
import { holderTileKey, tileKey } from "#shared/keys.ts";
import { serializedBytes } from "#shared/limits.ts";
import type { Encounter, ExploredTile, FogTile, PathStop, RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { encodeTile, fullTileBits, tilesAcross } from "#shared/rules/fog.ts";
import { sightEntryMaxBytes } from "#shared/rules/vision.ts";
import { DM, entry, env, member, room, scene, token } from "#shared/testutil.ts";
import { growthBound, measuredFromStored, measuredStateBytes, PER_PLAYER_FULL, projectedSceneBytes, roomLevelBytes, sceneOwnBytes, SizeGuard, touchedScenes } from "./sizeGuard.ts";

/**
 * The size guard on per-player vision (docs/design-v1-per-player-vision.md
 * 6.8, lane PV3): no measure reads a list of who saw or a layer's
 * contents, each counts at its widest instead, the widest covers the real
 * bytes, the switch to Per player is refused in the DM's words when the
 * room cannot hold it, and a pair of rooms a few bytes under the limit
 * answer another player's ops alike whatever one player explored.
 */

const BITS = encodeTile(fullTileBits());
const WIDE = Number.MAX_SAFE_INTEGER;

/** Ids as long as the schema allows, so every widest count is met. */
const longId = (n: number) => `${String(n).padStart(2, "0")}${"x".repeat(62)}`;

type Fill = "empty" | "full";

/**
 * A per-player room of `players` players, all seeing for themselves, with
 * a 40 by 30 scene's layers and every list of who saw empty or as full as
 * they can be: every tile of the party's layer and each holder's at the
 * widest rev, and every list naming the six longest ids.
 */
function perPlayerRoom(fill: Fill, players: string[], visionOn = false): RoomState {
  const state = room({ members: { dm1: member("dm1", "dm"), ...Object.fromEntries(players.map((id) => [id, member(id)])) } });
  state.scenes = { s1: scene("s1", { bounds: { w: 40, h: 30 }, fogEnabled: true, vision: { on: visionOn, light: "bright", perPlayer: true } }), s2: scene("s2", { order: 1 }) };
  state.holders = { s1: { sceneId: "s1", rev: 3, entries: players.slice(0, 6).map((memberId) => ({ memberId, on: true })) } };
  const names = fill === "full" ? [...players].sort((a, b) => b.length - a.length).slice(0, 6).sort() : [];
  for (let ty = 0; ty < tilesAcross(30); ty++) {
    for (let tx = 0; tx < tilesAcross(40); tx++) {
      if (fill === "empty") continue;
      state.exploredTiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: WIDE, bits: BITS } satisfies FogTile;
      for (const memberId of players.slice(0, 6)) state.exploredBy[holderTileKey("s1", memberId, tx, ty)] = { sceneId: "s1", tx, ty, rev: WIDE, bits: BITS, memberId } satisfies ExploredTile;
    }
  }
  const stops: PathStop[] = Array.from({ length: 12 }, (_, i) => ({ x: 2 + i, y: 3, elevation: 0, seenBy: names }));
  state.tokens.gob = token("gob", { sceneId: "s1", path: { turn: 7, stops } });
  const fight = (): Encounter => ({ rev: 0, round: 2, activeEntryId: "e1", entries: [entry("e1", { tokenId: "gob" })], turnStart: { entryId: "e1", tokenId: "gob", sceneId: "s1", x: 2, y: 3, elevation: 0, seq: 7, seenBy: names } });
  state.encounter = fight();
  state.encounterHistory = [{ encounter: fight(), effects: {}, revealed: [], at: "2026-10-25T00:00:00.000Z" }];
  return state;
}

const PLAYERS = [1, 2, 3, 4, 5, 6, 7].map(longId);

/** The stored state as it was counted before per-player vision: exactly, every layer and list as it is. */
function storedAsItIs(state: RoomState): number {
  return serializedBytes({ ...state, traps: {}, trapLog: [], trapSeen: [], reminded: undefined });
}

describe("the size guard's per-player reserves", () => {
  test("no measure reads a layer's contents or whom a list names", () => {
    const empty = perPlayerRoom("empty", PLAYERS);
    const full = perPlayerRoom("full", PLAYERS);
    assert.ok(storedAsItIs(full) - storedAsItIs(empty) > 6 * 6 * 700, "the rooms differ by every layer and list");
    assert.equal(measuredStateBytes(full), measuredStateBytes(empty), "the stored state");
    assert.equal(measuredFromStored(serializedBytes(full), full), measuredFromStored(serializedBytes(empty), empty), "the stored state from a snapshot's bytes");
    assert.equal(measuredFromStored(serializedBytes(full), full), measuredStateBytes(full));
    assert.equal(sceneOwnBytes(full, "s1"), sceneOwnBytes(empty, "s1"), "the scene's own part");
    assert.equal(roomLevelBytes(full), roomLevelBytes(empty), "the room-level part");
    assert.equal(projectedSceneBytes(full, "s1"), projectedSceneBytes(empty, "s1"), "the scene's whole measure");
  });

  test("the widest covers every byte the full room stores and its DM projection holds", () => {
    const full = perPlayerRoom("full", PLAYERS);
    const measure = measuredStateBytes(full);
    assert.ok(storedAsItIs(full) <= measure, `stored ${storedAsItIs(full)} within the measure ${measure}`);
    // A few bytes over at most: each map counts one comma more than it holds.
    assert.ok(measure - storedAsItIs(full) < 64, `the measure is ${measure - storedAsItIs(full)} bytes over`);
    const projected = serializedBytes({ ...projectState(full, DM, { sceneId: "s1" }), companionBlocks: {} });
    // Vision is off, so the projection holds no sight: the rest of the measure alone must hold it.
    const sight = tilesAcross(40) * tilesAcross(30) * sightEntryMaxBytes("s1");
    assert.ok(projected <= projectedSceneBytes(full, "s1") - sight, `the DM's projection ${projected} within the scene's measure less its sight, ${projectedSceneBytes(full, "s1") - sight}`);
    const party = projectState(full, DM, { sceneId: "s1" });
    assert.equal(Object.keys(party.fogAll ?? {}).length, 6, "the shared fog holds every tile");
    assert.equal(Object.keys(party.exploredAny ?? {}).length, 6, "and so does every holder's layer joined");
  });

  test("a whole-party room measures as it always did", () => {
    const state = perPlayerRoom("full", PLAYERS);
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: false, light: "bright" } };
    state.holders = {};
    state.exploredBy = {};
    state.tokens.gob = { ...state.tokens.gob!, path: { turn: 7, stops: state.tokens.gob!.path!.stops.map(({ seenBy: _s, ...stop }) => stop) } };
    const strip = (e: Encounter): Encounter => {
      const { seenBy: _s, ...start } = e.turnStart!;
      return { ...e, turnStart: start };
    };
    state.encounter = strip(state.encounter!);
    state.encounterHistory = state.encounterHistory.map((snap) => ({ ...snap, encounter: strip(snap.encounter) }));
    assert.equal(measuredStateBytes(state), storedAsItIs(state));
  });

  test("a list counts as wide as the roster's six longest ids, so a longer id joining grows every measure", () => {
    const short = ["a", "b", "c"];
    const before = perPlayerRoom("empty", short);
    const after = { ...before, members: { ...before.members, [longId(9)]: member(longId(9)) } };
    // 12 stops, the fight's turn start and the saved step's: 14 lists, each one id wider, and one more holder layer to hold.
    const grown = measuredStateBytes(after) - measuredStateBytes(before);
    assert.ok(grown > 14 * (66 + 1), `grew by ${grown}`);
    assert.equal(roomLevelBytes(after) - roomLevelBytes(before) - (serializedBytes(after.members) - serializedBytes(before.members)), 2 * (66 + 1), "the two turn starts' lists, one id wider each");
    assert.ok(growthBound(before, after, ["member:" + longId(9)]) >= grown, "the growth bound covers it");
  });
});

/**
 * The switch to Per player in a room a little over what its maps need: the
 * guard refuses it in the DM's words, and the switch back passes.
 */
describe("the switch to Per player and the room's limits", () => {
  function nearlyFull(limit: "state" | "scene"): { guard: SizeGuard; state: RoomState } {
    const state = perPlayerRoom("empty", PLAYERS);
    state.scenes.s1 = { ...state.scenes.s1!, vision: { on: false, light: "bright" } };
    state.holders = {};
    for (const t of Object.values(state.tokens)) delete t.path;
    state.encounter = null;
    state.encounterHistory = [];
    const room = measuredStateBytes(state);
    const sceneBytes = projectedSceneBytes(state, "s1");
    const guard = new SizeGuard(limit === "state" ? { stateLimit: room + 10_000 } : { sceneLimit: sceneBytes + 10_000 });
    assert.ok(guard.check(state, [], 0).ok);
    return { guard, state };
  }

  for (const limit of ["state", "scene"] as const) {
    test(`a ${limit} too full for each player's map refuses the switch in the DM's words`, () => {
      const { guard, state } = nearlyFull(limit);
      const op = { t: "scene.update" as const, sceneId: "s1", patch: { vision: { on: false, light: "bright" as const, perPlayer: true } } };
      const result = applyOp(state, op, DM, env(2));
      assert.ok(result.ok);
      const answer = guard.check(result.state, touchedScenes(state, result.state, result.touched), growthBound(state, result.state, result.touched), state);
      assert.deepEqual(answer, { ok: false, code: "quota", message: PER_PLAYER_FULL });
      // A label in the same room passes: only the switch needs the maps' room.
      const label = applyOp(state, { t: "build.label", sceneId: "s1", labelId: "l1", label: { x: 3, y: 3, text: "Hall", size: 1 } }, DM, env(3));
      assert.ok(label.ok);
      assert.ok(guard.check(label.state, touchedScenes(state, label.state, label.touched), growthBound(state, label.state, label.touched), state).ok);
    });
  }
});

/**
 * The differential measure row (docs/design-v1-per-player-vision.md
 * section 10): two rooms a few bytes under the room's limit that differ
 * only in what Thorn's player explored and whom their lists name. Bree's
 * player's ops get the same answers in both, refusals included.
 */
describe("the measure row", () => {
  test("ops by another player get the same answers a few bytes under the limit, whatever one holder explored", () => {
    const players = ["p1", "p2", "p3"];
    const a = perPlayerRoom("full", players);
    const b = perPlayerRoom("empty", players);
    // Only p1 sees for themselves in both, and only what p1 explored and saw differs: every list names p1 in one room and no one in the other.
    for (const [s, names] of [
      [a, ["p1"]],
      [b, []],
    ] as const) {
      s.holders.s1 = { sceneId: "s1", rev: 3, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: false }] };
      for (const key of Object.keys(s.exploredBy)) if (!key.includes(":p1:")) delete s.exploredBy[key];
      s.exploredTiles = {};
      s.fogTiles = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: BITS } };
      s.tokens.gob = { ...s.tokens.gob!, path: { turn: 7, stops: s.tokens.gob!.path!.stops.map((stop) => ({ ...stop, seenBy: [...names] })) } };
      const named = (e: Encounter): Encounter => ({ ...e, turnStart: { ...e.turnStart!, seenBy: [...names] } });
      s.encounter = named(s.encounter!);
      s.encounterHistory = s.encounterHistory.map((snap) => ({ ...snap, encounter: named(snap.encounter) }));
    }
    assert.equal(measuredStateBytes(a), measuredStateBytes(b));
    const limit = measuredStateBytes(a) + 300;
    const guards = new WeakMap<RoomState, SizeGuard>();
    for (const s of [a, b]) guards.set(s, new SizeGuard({ stateLimit: limit }));
    const guarded: Applier = (state, op, who, seq) => {
      const guard = guards.get(state)!;
      const r = serverApply(state, op, who, seq);
      if (!r.ok) return r;
      const result = applyOp(state, op, who, env(seq));
      if (!result.ok) return result;
      const size = guard.check(result.state, touchedScenes(state, result.state, result.touched), growthBound(state, result.state, result.touched), state);
      if (!size.ok) return size;
      guards.set(r.state, guard);
      return r;
    };
    const bree: Viewer = { memberId: "p2", role: "player" };
    const steps = Array.from({ length: 8 }, (_, i) => ({ who: bree, op: { t: "log.chat" as const, text: `${"a".repeat(60)} ${i}` }, note: `chat ${i}` }));
    const { a: endA } = checkOps({ name: "a few bytes under the limit", a, b, steps }, guarded);
    assert.ok(endA.log.length < 8, "the limit refused some of the chats, alike in both rooms");
  });
});

/**
 * A per-player scene the DM shrinks (review PV3-ASTRA-1): the widest
 * reserve counts every tile inside the bounds, so no layer may keep a tile
 * past them, where no reserve would count it and the measure would leave
 * it out. The DM's own fog keeps its tiles there, and the shared fog the
 * DM's projection holds over them counts at its widest too.
 */
describe("a per-player scene that shrinks", () => {
  /** The full room, the DM's fog revealed on every tile, then the scene shrunk to one cell, or to one row of cells. */
  function shrunk(bounds = { w: 1, h: 1 }, visionOn = true): { before: RoomState; after: RoomState } {
    const before = perPlayerRoom("full", PLAYERS, visionOn);
    for (const key of Object.keys(before.exploredTiles)) before.fogTiles[key] = { ...before.exploredTiles[key]!, rev: 1 };
    const result = applyOp(before, { t: "scene.update", sceneId: "s1", patch: { bounds } }, DM, env(2));
    assert.ok(result.ok);
    return { before, after: result.state };
  }

  test("forgets only the shrunk scene's tiles: another per-player scene keeps its tiles past those bounds (review PV3-SEC-3)", () => {
    const before = perPlayerRoom("full", PLAYERS, true);
    const holder = PLAYERS[0]!;
    before.scenes.s2 = scene("s2", { order: 1, bounds: { w: 40, h: 30 }, fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true } });
    before.holders.s2 = { sceneId: "s2", rev: 0, entries: [{ memberId: holder, on: true }] };
    before.exploredTiles[tileKey("s2", 2, 1)] = { sceneId: "s2", tx: 2, ty: 1, rev: 1, bits: BITS };
    before.exploredBy[holderTileKey("s2", holder, 2, 1)] = { sceneId: "s2", tx: 2, ty: 1, rev: 1, bits: BITS, memberId: holder };
    const result = applyOp(before, { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 1, h: 1 } } }, DM, env(2));
    assert.ok(result.ok);
    assert.ok(result.state.exploredTiles[tileKey("s2", 2, 1)], "s2's party tile stays");
    assert.ok(result.state.exploredBy[holderTileKey("s2", holder, 2, 1)], "s2's holder tile stays");
    assert.equal(result.state.exploredTiles[tileKey("s1", 2, 1)], undefined, "s1's goes");
  });

  test("forgets every layer's tiles past its bounds, and the DM's fog keeps its own", () => {
    const { before, after } = shrunk();
    assert.deepEqual(Object.keys(after.exploredTiles), [tileKey("s1", 0, 0)]);
    assert.deepEqual(Object.keys(after.exploredBy).sort(), PLAYERS.slice(0, 6).map((id) => holderTileKey("s1", id, 0, 0)).sort());
    assert.deepEqual(Object.keys(after.fogTiles), Object.keys(before.fogTiles), "the DM's fog is the DM's");
  });

  for (const [bounds, visionOn] of [
    [{ w: 1, h: 1 }, true],
    [{ w: 40, h: 1 }, false],
  ] as const) {
  test(`the measures still hold every byte the room stores and the DM's projection holds, before and after a reload, shrunk to ${bounds.w} by ${bounds.h}`, () => {
    // With vision off the DM's projection holds no sight, whose reserve would otherwise leave room to spare.
    const { after } = shrunk(bounds, visionOn);
    const stored = storedAsItIs(after);
    const measure = measuredStateBytes(after);
    assert.ok(stored <= measure, `stored ${stored} within the measure ${measure}`);
    assert.equal(measuredFromStored(serializedBytes(after), after), measure, "a snapshot's bytes measure alike");
    const projected = serializedBytes({ ...projectState(after, DM, { sceneId: "s1" }), companionBlocks: {} });
    assert.ok(projected <= projectedSceneBytes(after, "s1"), `the DM's projection ${projected} within the scene's measure ${projectedSceneBytes(after, "s1")}`);
    // A room loaded from that snapshot, with limits just under what it holds, is refused.
    assert.equal(new SizeGuard({ stateLimit: stored - 1 }).check(after, [], 0).ok, false, "the room's limit");
    assert.equal(new SizeGuard({ sceneLimit: projected - 1 }).check(after, ["s1"], 0).ok, false, "the scene's limit");
  });
  }

  for (const bounds of [
    { w: 200, h: 16 },
    { w: 16, h: 200 },
  ]) {
    test(`the shared fog over the DM's fog past the bounds counts at its widest, a 200 by 200 scene shrunk to ${bounds.w} by ${bounds.h}`, () => {
      // Far more of the DM's fog lies past the bounds than any reserve inside them could hide.
      const state = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") } });
      state.scenes = { s1: scene("s1", { bounds: { w: 200, h: 200 }, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } }) };
      for (let ty = 0; ty < tilesAcross(200); ty++) for (let tx = 0; tx < tilesAcross(200); tx++) state.fogTiles[tileKey("s1", tx, ty)] = { sceneId: "s1", tx, ty, rev: WIDE, bits: BITS };
      const result = applyOp(state, { t: "scene.update", sceneId: "s1", patch: { bounds } }, DM, env(2));
      assert.ok(result.ok);
      const projected = projectState(result.state, DM, { sceneId: "s1" });
      assert.equal(Object.keys(projected.fogAll ?? {}).length, tilesAcross(200) ** 2, "the shared fog keeps a tile over each of the DM's");
      const bytes = serializedBytes({ ...projected, companionBlocks: {} });
      assert.ok(bytes <= projectedSceneBytes(result.state, "s1"), `the DM's projection ${bytes} within the scene's measure ${projectedSceneBytes(result.state, "s1")}`);
    });
  }

  test("a scene shrunk while it shared sight with the party keeps its layer, and loses it past the bounds when it turns per player", () => {
    const whole = perPlayerRoom("full", PLAYERS);
    whole.scenes.s1 = { ...whole.scenes.s1!, vision: { on: false, light: "bright" } };
    whole.holders = {};
    whole.exploredBy = {};
    const small = applyOp(whole, { t: "scene.update", sceneId: "s1", patch: { bounds: { w: 1, h: 1 } } }, DM, env(2));
    assert.ok(small.ok);
    assert.equal(Object.keys(small.state.exploredTiles).length, 6, "a whole-party scene remembers past its bounds, as it always did");
    const switched = applyOp(small.state, { t: "scene.update", sceneId: "s1", patch: { vision: { on: false, light: "bright", perPlayer: true } } }, DM, env(3));
    assert.ok(switched.ok);
    assert.deepEqual(Object.keys(switched.state.exploredTiles), [tileKey("s1", 0, 0)]);
    assert.ok(storedAsItIs(switched.state) <= measuredStateBytes(switched.state));
  });
});

/**
 * The growth bound on lists of who saw (review PV3-OPUS-2): the measures
 * count each list at its widest, so the bound must count a token, the
 * fight and its saved steps without the names their lists hold. Otherwise
 * a move that joins away a corner naming a player and adds a stop naming
 * none grows the measure while the room's bytes shrink, and the guard's
 * fast path both lets the room past its limit and answers by whom the
 * lists named.
 */
describe("the growth bound and lists of who saw", () => {
  /** Two rooms whose goblin's full path names the six longest ids in one and no one in the other, with no layer, so every new stop names no one. */
  function pathRooms(): { named: RoomState; nobody: RoomState } {
    const make = (names: string[]) => {
      const state = perPlayerRoom("empty", PLAYERS);
      const stops: PathStop[] = Array.from({ length: 50 }, (_, i) => ({ x: 2 + (i % 2), y: 3 + Math.floor(i / 2), elevation: 0, seenBy: [...names] }));
      state.tokens.gob = { ...state.tokens.gob!, x: stops.at(-1)!.x, y: stops.at(-1)!.y, path: { turn: 7, stops } };
      return state;
    };
    return { named: make([...PLAYERS].slice(0, 6).sort()), nobody: make([]) };
  }

  const move = (state: RoomState, i: number) => ({ t: "token.move" as const, tokenId: "gob", x: 20 + (i % 2), y: 3 + i });

  test("covers the measure's growth when a move joins away a corner whose list named players", () => {
    const { named } = pathRooms();
    let state = named;
    for (let i = 0; i < 12; i++) {
      const result = applyOp(state, move(state, i), DM, env(10 + i));
      assert.ok(result.ok, result.ok ? "" : result.message);
      assert.equal(result.state.tokens.gob!.path!.stops.length, 50, "the path stays full");
      const grown = measuredStateBytes(result.state) - measuredStateBytes(state);
      const bound = growthBound(state, result.state, result.touched);
      assert.ok(bound >= grown, `move ${i}: the bound ${bound} covers the measure's growth ${grown}`);
      state = result.state;
    }
  });

  test("covers the measure's growth when the fight or a saved step trades a list naming players for one naming none", () => {
    const before = perPlayerRoom("full", PLAYERS);
    // Each grows by a new entry while its turn start's list goes from six names to none.
    const renamed = (e: Encounter): Encounter => ({ ...e, entries: [...e.entries, entry("e2", { tokenId: "gob" })], turnStart: { ...e.turnStart!, seenBy: [] } });
    const fight = { ...before, encounter: renamed(before.encounter!) };
    const history = { ...before, encounterHistory: before.encounterHistory.map((snap) => ({ ...snap, encounter: renamed(snap.encounter) })) };
    for (const [after, key] of [
      [fight, "encounter"],
      [history, "encounterHistory"],
    ] as const) {
      const grown = measuredStateBytes(after) - measuredStateBytes(before);
      assert.ok(grown > 0, `${key} grew by ${grown}`);
      assert.ok(growthBound(before, after, [key]) >= grown, `${key}: the bound ${growthBound(before, after, [key])} covers ${grown}`);
    }
  });

  test("the DM's moves get the same answers a few bytes under the limit, whoever the path's lists name", () => {
    const { named, nobody } = pathRooms();
    assert.equal(measuredStateBytes(named), measuredStateBytes(nobody));
    // The first move grows the measure by 77 bytes and each later one by about 24, so six fit.
    const limit = measuredStateBytes(named) + 200;
    const guards = new WeakMap<RoomState, SizeGuard>();
    for (const s of [named, nobody]) {
      const guard = new SizeGuard({ stateLimit: limit });
      assert.ok(guard.check(s, [], 0).ok);
      guards.set(s, guard);
    }
    const guarded: Applier = (state, op, who, seq) => {
      const guard = guards.get(state)!;
      const r = serverApply(state, op, who, seq);
      if (!r.ok) return r;
      const result = applyOp(state, op, who, env(seq));
      if (!result.ok) return result;
      const size = guard.check(result.state, touchedScenes(state, result.state, result.touched), growthBound(state, result.state, result.touched), state);
      if (!size.ok) return size;
      guards.set(r.state, guard);
      return r;
    };
    const steps = Array.from({ length: 12 }, (_, i) => ({ who: DM, op: move(named, i), note: `move ${i}` }));
    const { a: end } = checkOps({ name: "the DM's moves a few bytes under the limit", a: named, b: nobody, steps }, guarded);
    assert.equal(end.tokens.gob!.y, 3 + 5, "six moves fit and the limit refused the rest, alike in both rooms");
  });
});
