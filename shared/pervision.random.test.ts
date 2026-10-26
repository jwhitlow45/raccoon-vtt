import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, type EntityKey } from "./keys.ts";
import { lineAudience, linesPastStart } from "./logRings.ts";
import type { LogEntry, PathStop, RoomState, Token, Viewer } from "./model.ts";
import { exploreFor, foggedFor, givenTo, holds, perPlayerOp, perPlayerState, playersOf, playerSees, cellsFor, withCellVision } from "./perPlayerTestutil.ts";
import { opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { allKeys, applyChanges, changedSightKeys, dependents, diffProjection, heldOf, ownsToken, perPlayerScene, projectEntity, projectState, stableStringify, viewerSceneId, type HeldEntry, type ProjectedState } from "./project.ts";
import { applyOp, type ApplyResult } from "./reducer.ts";
import { legOnGround, seenWhole } from "./rules/path.ts";
import { DM, chance, env, pick, rng } from "./testutil.ts";

/**
 * The property test of per-player vision (docs/design-v1-per-player-vision.md
 * section 10, lane PV1): random rooms of 1 to 8 players, per-player scenes
 * and whole-party ones, under random ops and their undo, with the server's
 * explore step after each, by the stub rules of perPlayerTestutil.ts. After
 * every batch, for every viewer, these hold:
 *
 * - E1, events: the changes the fan-out's rule finds, applied to each
 *   viewer's last projection, give the fresh projection, the DMs', each
 *   player's and a table display's.
 * - O1, the oracle: each player and a display hold exactly the creatures,
 *   labels, stamps, pins and traps their own sight, fog and journal access
 *   give them, worked out from nothing.
 * - O2, route corners: an owner gets a leg's corners on a per-player scene
 *   with fog only for a leg every player saw whole or one on ground their
 *   own fog reveals, and anyone else only for a leg every player saw whole.
 * - M1, lists: a list written by the batch names only holders whose entry
 *   is on and who do not own the creature, sorted.
 * - M2, reach: a log line about a creature reaches a player only when they
 *   own it or saw it, by the oracle, before or after the op.
 * - M3, no list outlives its op in the log.
 * - P1, players' data: no list, holder list, holder layer or joined layer
 *   in any player's or display's data, and `sightAll` and `fogAll` the same
 *   for every viewer.
 * - F1, the switch: nothing but the Sight row itself, an undo, a copy or a
 *   new scene changes a scene's `perPlayer`.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

type Connection = { viewer: Viewer; sceneId: string; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function connect(state: RoomState, viewer: Viewer, sceneId: string): Connection {
  const view = projectState(state, viewer, { sceneId });
  return { viewer, sceneId, held: heldOf(view), view };
}

/** The fan-out's candidates (server/rooms/fanout.ts candidateKeys), without its sharing of values between players. */
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

function dump(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** The connections a room has: the DM on each scene, every player and a table display. Members who joined since get one. */
function connections(state: RoomState, held: Connection[]): Connection[] {
  const out = held.filter((c) => c.viewer.role === "dm" || c.viewer === DISPLAY || state.members[c.viewer.memberId]?.kind === "player");
  for (const p of playersOf(state)) if (!out.some((c) => c.viewer.memberId === p.memberId)) out.push(connect(state, p, "s1"));
  return out;
}

const seenText = (value: unknown) => stableStringify(value);

/** The stored stops a reader who does not own the creature gets, by their place in the path (rules/path.ts stopsForNonOwners). */
function readerStops(stops: readonly PathStop[], reader: string): number[] {
  return stops.flatMap((s, i) => (s.seen === true || s.seenBy?.includes(reader) ? [i] : []));
}

function checkViews(where: string, state: RoomState, conns: readonly Connection[]): void {
  const players = conns.filter((c) => c.viewer.role === "player");
  // By the scene each viewer holds: a DM may view another.
  const sightAll = new Map<string | null, Set<string>>();
  const fogAll = new Set<string>();
  for (const c of conns) {
    const view = c.view;
    const text = seenText(view);
    if (c.viewer.role === "player") {
      // P1.
      assert.ok(!text.includes('"seenBy"') && !text.includes('"toSeenBy"'), `${where}: ${c.viewer.memberId} holds a list of who saw`);
      assert.equal(view.holders, undefined, `${where}: ${c.viewer.memberId} holds a holder list`);
      assert.equal(view.exploredBy, undefined, `${where}: ${c.viewer.memberId} holds a holder layer`);
      assert.equal(view.exploredAny, undefined, `${where}: ${c.viewer.memberId} holds the holders' layers joined`);
      assert.deepEqual(view.exploredTiles, {}, `${where}: ${c.viewer.memberId} holds the party's layer`);
      fogAll.add(seenText(view.fogAll ?? null));
    }
    const scene = viewerSceneId(state, c.viewer, { sceneId: c.sceneId });
    if (!sightAll.has(scene)) sightAll.set(scene, new Set());
    sightAll.get(scene)!.add(seenText(view.sightAll ?? null));
  }
  for (const [scene, held] of sightAll) assert.ok(held.size <= 1, `${where}: viewers of ${scene} hold different shared sights`);
  assert.ok(fogAll.size <= 1, `${where}: players hold different shared fog`);
  for (const c of players) {
    const id = c.viewer.memberId;
    const view = c.view;
    // O1.
    const got = {
      tokens: Object.keys(view.tokens).sort(),
      labels: Object.keys(view.labels).sort(),
      stamps: Object.keys(view.stamps).sort(),
      pins: Object.keys(view.pins).sort(),
      traps: Object.keys(view.traps).sort(),
    };
    assert.deepEqual(got, givenTo(state, id), `${where}: ${id} holds what their own sight and fog do not give, or lacks what they do`);
    // O2.
    for (const [tokenId, t] of Object.entries(view.tokens)) {
      const stops = t.path?.stops;
      const real = state.tokens[tokenId];
      const stored = real?.path?.stops;
      if (!stops || !real || !stored) continue;
      const owner = ownsToken(state, c.viewer, real);
      const places = owner ? stored.map((_, i) => i) : readerStops(stored, id);
      const scene = state.scenes[real.sceneId];
      const fogged = foggedFor(state, real.sceneId, id);
      stops.forEach((stop, k) => {
        if (stop.via === undefined) return;
        const i = places[k]!;
        const whole = seenWhole(stored, i, true);
        if (whole) return;
        assert.ok(owner, `${where}: ${id} gets the corners of a leg of ${tokenId} not every player saw whole`);
        if (perPlayerScene(scene) && scene?.fogEnabled) {
          assert.ok(legOnGround(real, stored[i - 1]!, stored[i]!, (x, y) => !fogged(x, y)), `${where}: ${id} gets corners of ${tokenId} off ground they remember`);
        }
      });
    }
  }
}

/** The tokens of an event line, or none. */
function tokensOf(line: LogEntry): string[] {
  const data = line.data;
  if (!data) return [];
  if (data.type === "dice") return data.rolls.flatMap((r) => (r.tokenId !== undefined ? [r.tokenId] : []));
  if (data.type === "area" || data.type === "turn" || data.type === "trap" || data.type === "trapSeen" || data.type === "trapNotice") return [];
  return "tokenId" in data && data.tokenId !== undefined ? [data.tokenId] : [];
}

function checkMarks(where: string, before: RoomState, after: RoomState, result: Extract<ApplyResult, { ok: true }>): void {
  // M1: the lists the batch wrote.
  const holdersOf = (sceneId: string) => new Set(playersOf(after).filter((p) => holds(after, sceneId, p.memberId)).map((p) => p.memberId));
  const listOk = (list: readonly string[] | undefined, token: Token | undefined, what: string) => {
    if (list === undefined || !token) return;
    assert.deepEqual([...list].sort(), list, `${where}: ${what}'s list is not sorted`);
    const on = holdersOf(token.sceneId);
    for (const id of list) {
      assert.ok(on.has(id), `${where}: ${what}'s list names ${id}, who holds no sight there`);
      assert.ok(!ownsToken(after, { memberId: id, role: "player" }, token), `${where}: ${what}'s list names its owner ${id}`);
    }
  };
  const start = after.encounter?.turnStart;
  if (start && seenText(start) !== seenText(before.encounter?.turnStart)) listOk(start.seenBy, after.tokens[start.tokenId], "a turn's start");
  for (const t of Object.values(after.tokens)) {
    const was = before.tokens[t.id]?.path?.stops ?? [];
    const now = t.path?.stops ?? [];
    for (const [i, stop] of now.entries()) if (seenText(stop) !== seenText(was[i])) listOk(stop.seenBy, t, `a stop of ${t.id}`);
  }
  // M3.
  for (const line of after.log) assert.ok(!seenText(line.data ?? null).includes('"seenBy"') && !seenText(line.data ?? null).includes('"toSeenBy"'), `${where}: line ${line.id} keeps a list`);
  // M2.
  for (const line of result.log) {
    if (line.kind !== "event") continue;
    const audience = lineAudience(line);
    const readers = audience === "party" ? [line.to![0]!] : audience === "shared" ? playersOf(after).map((p) => p.memberId) : [];
    for (const tokenId of tokensOf(line)) {
      for (const reader of readers) {
        const saw = [before, after].some((state) => {
          const t = state.tokens[tokenId];
          if (!t) return false;
          const sceneId = state.meta.playerSceneId;
          if (state.meta.view?.blackout === true || sceneId === null || t.sceneId !== sceneId) return ownsToken(state, { memberId: reader, role: "player" }, t);
          return ownsToken(state, { memberId: reader, role: "player" }, t) || playerSees(state, reader, t, cellsFor(state, sceneId, reader), foggedFor(state, sceneId, reader));
        });
        assert.ok(saw, `${where}: line ${line.id} (${line.data?.type}) about ${tokenId} reaches ${reader}, who neither owns nor saw it`);
      }
    }
  }
}

/** Whether an op may change a scene's `perPlayer` (F1). */
function switches(op: Op): boolean {
  return (op.t === "scene.update" && op.patch.vision?.perPlayer !== undefined) || op.t === "sys.restore" || op.t === "scene.create" || op.t === "scene.duplicate";
}

function run(seed: number, steps: number): { applied: number; perPlayer: number; lists: number; copies: number; holders: number } {
  const r = rng(seed);
  let state = perPlayerState(r);
  let conns = connections(state, [connect(state, DM, "s1"), connect(state, DM, "s2"), connect(state, DISPLAY, "s1")]);
  let undo: RestoreEntry[] | null = null;
  let applied = 0;
  let perPlayer = 0;
  let lists = 0;
  let copies = 0;
  let holders = 0;
  const batch = (op: Op, who: Viewer, seq: number, where: string): boolean => {
    const result = applyOp(state, op, who, env(seq));
    if (!result.ok) return false;
    const before = state;
    const after = result.state;
    if (!switches(op)) for (const [id, s] of Object.entries(after.scenes)) assert.equal(s.vision?.perPlayer, before.scenes[id]?.vision?.perPlayer, `${where}: ${op.t} changed whether ${id} is per player`);
    checkMarks(where, before, after, result);
    conns = connections(after, conns);
    const candidates = candidatesFor(before, after, result, conns);
    for (const c of conns) {
      const next = new Map<EntityKey, unknown>();
      for (const key of candidates) next.set(key, projectEntity(key, after, c.viewer, { sceneId: c.sceneId }));
      const diff = diffProjection(c.held, next);
      c.held = diff.held;
      c.view = applyChanges(c.view, diff.changes);
      const fresh = projectState(after, c.viewer, { sceneId: c.sceneId });
      // E1.
      if (stableStringify(c.view) !== stableStringify(fresh)) assert.deepEqual(dump(c.view), dump(fresh), `${where}: ${c.viewer.memberId}@${c.sceneId} misses a change`);
      c.view = fresh;
      c.held = heldOf(fresh);
    }
    checkViews(where, after, conns);
    if (op.t === "scene.update" && op.patch.vision?.perPlayer !== undefined) undo = result.inverse;
    if (seenText(after).includes('"seenBy"')) lists++;
    copies += result.log.filter((l) => lineAudience(l) === "party" && l.to !== undefined && tokensOf(l).some((id) => perPlayerScene(after.scenes[after.tokens[id]?.sceneId ?? ""]))).length;
    holders = Math.max(holders, ...Object.keys(after.scenes).map((id) => playersOf(after).filter((p) => holds(after, id, p.memberId)).length));
    state = after;
    return true;
  };
  for (let i = 0; i < steps; i++) {
    const players = playersOf(state);
    const who: Viewer = i % 4 === 3 && players.length > 0 ? pick(r, players) : DM;
    const raw: Op = undo && chance(r, 0.1) ? { t: "sys.restore", entries: undo, from: "undo" } : perPlayerOp(r, state, who);
    if (raw.t === "sys.restore") undo = null;
    const parsed = opSchema.safeParse(raw);
    assert.ok(parsed.success, `seed ${seed} op ${i}: the generator made an invalid ${raw.t}: ${parsed.success ? "" : parsed.error.message}`);
    const where = `seed ${seed} op ${i} (${raw.t} by ${who.memberId})`;
    if (!batch(parsed.data, who, 100 + 2 * i, where)) continue;
    applied++;
    if (Object.values(state.scenes).some((s) => perPlayerScene(s))) perPlayer++;
    const explore = exploreFor(state);
    if (explore) assert.ok(batch(opSchema.parse(explore), DM, 101 + 2 * i, `${where}, then its explore`), `${where}: the explore step was refused`);
  }
  return { applied, perPlayer, lists, copies, holders };
}

describe("per-player vision over random rooms (docs/design-v1-per-player-vision.md section 10)", () => {
  test("events, the oracle, route corners, marks, players' data and the switch hold after every batch", () => {
    withCellVision(() => {
      let applied = 0;
      let perPlayer = 0;
      let lists = 0;
      let copies = 0;
      let full = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const got = run(seed, 50);
        applied += got.applied;
        perPlayer += got.perPlayer;
        lists += got.lists;
        copies += got.copies;
        if (got.holders === 6) full++;
      }
      // Enough of each to mean something: per-player scenes, lists of who saw, party lines' copies and full holder lists.
      assert.ok(applied > 2000, `only ${applied} ops applied`);
      assert.ok(perPlayer > applied / 2, `only ${perPlayer} of ${applied} ops met a per-player scene`);
      assert.ok(lists > 30, `only ${lists} states held a list of who saw`);
      assert.ok(copies > 25, `only ${copies} lines about a creature on a per-player scene reached only some players`);
      assert.ok(full > 3, `only ${full} rooms filled a holder list`);
    });
  });
});
