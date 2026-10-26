import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, tileKey } from "./keys.ts";
import { LIMITS } from "./limits.ts";
import { FOG_SUBCELLS, type FogTile, type RoomState, type SightHolder } from "./model.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { decodeTile, getBit, rasterizeFogOps, TILE_CELLS } from "./rules/fog.ts";
import { DM, chance, env, int, member, pick, rng, room, scene } from "./testutil.ts";

/**
 * The holder list's joins and picks, every layer under hides and resets,
 * and the fold, over many random sequences of ops
 * (docs/design-v1-per-player-vision.md 6.1 and 6.3, lane PV1). Each
 * applied op is checked against these invariants:
 *
 * - L1, the list: no player twice, at most 6 on, only members on the
 *   roster, and a list only on a per-player scene.
 * - L2, the layers: each under its own key, only on a per-player scene,
 *   and only for a member whose entry is on.
 * - J1, joins: `sys.explore`'s join appends, in its order, each player who
 *   has no entry, on while fewer than 6 are, and changes no entry already
 *   there. An explore with no join leaves the list the very same.
 * - P1, picks: `vision.holders` turns on exactly the players it names,
 *   appends those with no entry, and a holder it turns off forgets their
 *   layer.
 * - H1, hides: no layer of the scene reveals any part of a hide's
 *   rectangle afterward, and nothing outside it changes.
 * - R1, resets: one to hidden leaves no layer on the scene, one to revealed
 *   changes none.
 * - F1, the fold: a scene going back to Whole party has no list and no
 *   holder layer, and the party's layer holds every bit any layer held.
 * - S1, the switch on: a scene going to Per player starts with no list and
 *   no holder layer.
 * - U1, undo never splits: undoing an op leaves no holder layer it did not
 *   find, so a fold stays pooled.
 * - M1, removal: a member removed is on no list and holds no layer.
 * - G1, refusals: a refused op changes nothing.
 */

const SCENES = ["s1", "s2"] as const;
const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

type Rect = { x: number; y: number; w: number; h: number };

function start(r: () => number): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), ...Object.fromEntries(PLAYERS.slice(0, chance(r, 0.5) ? 8 : int(r, 2, 7)).map((id) => [id, member(id)])) } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", ...(chance(r, 0.7) ? { perPlayer: true as const } : {}) } });
  s.scenes.s2 = scene("s2", { order: 1, fogEnabled: true, vision: { on: chance(r, 0.5), light: "bright", ...(chance(r, 0.5) ? { perPlayer: true as const } : {}) } });
  return s;
}

function rect(r: () => number): Rect {
  const w = int(r, 1, 18);
  const h = int(r, 1, 14);
  return { x: int(r, 0, 40 - w), y: int(r, 0, 30 - h), w, h };
}

function tilesOf(sceneId: string, at: Rect): { tx: number; ty: number; bits: string }[] {
  const out: { tx: number; ty: number; bits: string }[] = [];
  for (const tile of Object.values(rasterizeFogOps({}, sceneId, { w: 40, h: 30 }, [{ id: "r", mode: "reveal", shape: { kind: "rect", ...at } }]))) if (tile) out.push({ tx: tile.tx, ty: tile.ty, bits: tile.bits });
  return out;
}

function onIds(state: RoomState, sceneId: string): string[] {
  return (state.holders[sceneId]?.entries ?? []).filter((e) => e.on).map((e) => e.memberId);
}

function opFor(r: () => number, state: RoomState): Op {
  const sceneId = pick(r, SCENES);
  const ids = [...Object.keys(state.members), "p9", "gone"];
  const roll = r();
  if (roll < 0.2) {
    const n = chance(r, 0.4) ? 6 + (chance(r, 0.15) ? 1 : 0) : int(r, 0, 6);
    const players = Object.values(state.members).filter((m) => m.kind === "player").map((m) => m.id);
    const from = chance(r, 0.85) && players.length > 0 ? players : ids;
    const on = [...new Set(Array.from({ length: n * 2 }, () => pick(r, from)))].slice(0, n);
    return { t: "vision.holders", sceneId, on };
  }
  if (roll < 0.45) {
    const tiles = chance(r, 0.6) ? tilesOf(sceneId, rect(r)) : [];
    const holders = onIds(state, sceneId);
    const pool = chance(r, 0.15) ? ids : holders;
    const members = [...new Set(Array.from({ length: int(r, 0, 3) }, () => pool.length > 0 ? pick(r, pool) : "p1"))].map((memberId) => ({ memberId, tiles: tilesOf(sceneId, rect(r)) }));
    // Mostly players with no entry yet, as the step finds them, so the cap of 6 is met.
    const listed = new Set((state.holders[sceneId]?.entries ?? []).map((e) => e.memberId));
    const fresh = ids.filter((id) => !listed.has(id));
    const join = [...new Set(Array.from({ length: chance(r, 0.4) ? int(r, 1, 6) : 0 }, () => pick(r, fresh.length > 0 && chance(r, 0.8) ? fresh : ids)))].map((memberId) => ({ memberId, on: chance(r, 0.8) }));
    const op = { t: "sys.explore" as const, sceneId, tiles, ...(members.length > 0 ? { members } : {}), ...(join.length > 0 ? { join } : {}) };
    return op.tiles.length === 0 && !op.members && !op.join ? { ...op, tiles: tilesOf(sceneId, rect(r)) } : op;
  }
  if (roll < 0.6) return { t: "fog.live", sceneId, ops: [{ id: "f", mode: chance(r, 0.6) ? "hide" : "reveal", shape: { kind: "rect", ...rect(r) } }] };
  if (roll < 0.65) return { t: "fog.reset", sceneId, to: chance(r, 0.7) ? "hidden" : "revealed" };
  if (roll < 0.77) {
    const on = chance(r, 0.6);
    return { t: "scene.update", sceneId, patch: { vision: { on: chance(r, 0.7), light: pick(r, ["bright", "dim", "dark"] as const), perPlayer: on } } };
  }
  if (roll < 0.82) return { t: "scene.update", sceneId, patch: { vision: { on: chance(r, 0.5), light: "dim" } } };
  if (roll < 0.88) return { t: "sys.memberRemove", memberId: pick(r, PLAYERS) };
  if (roll < 0.93) {
    const id = pick(r, PLAYERS);
    return { t: "sys.memberJoin", member: { id, name: id, color: "#123456", kind: "player", createdAt: "2026-10-01T00:00:00.000Z" } };
  }
  return { t: "sys.memberSetKind", memberId: pick(r, PLAYERS), kind: chance(r, 0.5) ? "dm" : "player" };
}

/** The bits of a layer's tile, or none. */
function bitsAt(layer: Readonly<Record<string, FogTile>>, key: string): Uint8Array | null {
  const tile = layer[key];
  return tile ? decodeTile(tile.bits) : null;
}

const SIDE = TILE_CELLS * FOG_SUBCELLS;

function bit(bits: Uint8Array | null, sx: number, sy: number): boolean {
  return bits !== null && getBit(bits, sx, sy);
}

/** Every layer of a scene, the party's and each holder's, keyed as its tiles are. */
function layersOf(state: RoomState, sceneId: string): Map<string, Record<string, FogTile>> {
  const out = new Map<string, Record<string, FogTile>>([["party", {}]]);
  for (const t of Object.values(state.exploredTiles)) if (t.sceneId === sceneId) out.get("party")![tileKey(sceneId, t.tx, t.ty)] = t;
  for (const t of Object.values(state.exploredBy)) {
    if (t.sceneId !== sceneId) continue;
    if (!out.has(t.memberId)) out.set(t.memberId, {});
    out.get(t.memberId)![tileKey(sceneId, t.tx, t.ty)] = t;
  }
  return out;
}

function holderLayerCount(state: RoomState, sceneId: string): number {
  return Object.values(state.exploredBy).filter((t) => t.sceneId === sceneId).length;
}

function expectedJoin(before: readonly SightHolder[], join: readonly { memberId: string; on: boolean }[], state: RoomState): SightHolder[] {
  const out = before.map((e) => ({ ...e }));
  for (const j of join) {
    if (out.some((e) => e.memberId === j.memberId) || state.members[j.memberId]?.kind !== "player") continue;
    out.push({ memberId: j.memberId, on: j.on && out.filter((e) => e.on).length < LIMITS.sightHoldersPerScene });
  }
  return out;
}

const covered = { capped: 0, folds: 0, pooledBits: 0, hides: 0, holderBitsHidden: 0, joins: 0, picksForgot: 0, undoneFolds: 0, removedHolders: 0, refused: 0 };

function check(before: RoomState, op: Op, after: RoomState, undone: boolean, where: string): void {
  // L1 and L2.
  for (const [sceneId, list] of Object.entries(after.holders)) {
    assert.equal(list.sceneId, sceneId, `${where} L1: the list's own scene`);
    assert.equal(after.scenes[sceneId]?.vision?.perPlayer, true, `${where} L1: a list only on a per-player scene`);
    const ids = list.entries.map((e) => e.memberId);
    assert.equal(new Set(ids).size, ids.length, `${where} L1: no player twice`);
    assert.ok(list.entries.filter((e) => e.on).length <= LIMITS.sightHoldersPerScene, `${where} L1: at most 6 on`);
    for (const id of ids) assert.ok(after.members[id], `${where} L1: ${id} is on the roster`);
  }
  for (const [key, tile] of Object.entries(after.exploredBy)) {
    assert.equal(key, holderTileKey(tile.sceneId, tile.memberId, tile.tx, tile.ty), `${where} L2: a layer tile under its own key`);
    assert.equal(after.scenes[tile.sceneId]?.vision?.perPlayer, true, `${where} L2: a layer only on a per-player scene`);
    assert.ok(onIds(after, tile.sceneId).includes(tile.memberId), `${where} L2: ${tile.memberId}'s layer on ${tile.sceneId} needs their entry on`);
  }
  for (const sceneId of SCENES) {
    const was = before.scenes[sceneId]?.vision?.perPlayer === true;
    const is = after.scenes[sceneId]?.vision?.perPlayer === true;
    if (was && !is && after.scenes[sceneId]) {
      // F1.
      assert.equal(after.holders[sceneId], undefined, `${where} F1: the list empties`);
      assert.equal(holderLayerCount(after, sceneId), 0, `${where} F1: no holder layer`);
      const pooled = layersOf(after, sceneId).get("party")!;
      for (const [who, layer] of layersOf(before, sceneId)) {
        for (const key of Object.keys(layer)) {
          const was = bitsAt(layer, key);
          const now = bitsAt(pooled, key);
          for (let i = 0; was && i < was.length; i++) {
            assert.equal(was[i]! & ~(now?.[i] ?? 0), 0, `${where} F1: the party's layer keeps ${who}'s bits at ${key}`);
            if (who !== "party" && was[i]! !== 0) covered.pooledBits++;
          }
        }
      }
      covered.folds++;
      if (undone) covered.undoneFolds++;
    }
    if (!was && is) {
      // S1.
      assert.equal(after.holders[sceneId], undefined, `${where} S1: no list`);
      assert.equal(holderLayerCount(after, sceneId), 0, `${where} S1: no holder layer`);
    }
  }
  // U1.
  if (undone) {
    for (const key of Object.keys(after.exploredBy)) assert.ok(before.exploredBy[key], `${where} U1: an undo brings back no layer`);
  }
  switch (op.t) {
    case "sys.explore": {
      const list = before.holders[op.sceneId]?.entries ?? [];
      // J1.
      if (!op.join) assert.equal(after.holders[op.sceneId], before.holders[op.sceneId], `${where} J1: an explore with no join leaves the list the very same`);
      else {
        const join = op.join;
        const expected = expectedJoin(list, join, before);
        assert.deepEqual(after.holders[op.sceneId]?.entries ?? [], expected, `${where} J1: the joins`);
        if (expected.length > list.length) covered.joins++;
        // A join that asked to be on and found 6 on already.
        if (expected.slice(list.length).some((e) => !e.on && join.find((j) => j.memberId === e.memberId)?.on === true)) covered.capped++;
      }
      break;
    }
    case "vision.holders": {
      // P1.
      const list = before.holders[op.sceneId]?.entries ?? [];
      const named = new Set(op.on);
      const expected = list.map((e) => ({ memberId: e.memberId, on: named.has(e.memberId) }));
      for (const id of op.on) if (!expected.some((e) => e.memberId === id)) expected.push({ memberId: id, on: true });
      assert.deepEqual(after.holders[op.sceneId]?.entries ?? [], expected, `${where} P1: exactly the players named`);
      for (const e of list) {
        if (!e.on || named.has(e.memberId)) continue;
        assert.equal(Object.values(after.exploredBy).some((t) => t.sceneId === op.sceneId && t.memberId === e.memberId), false, `${where} P1: ${e.memberId} forgets their map`);
        if (Object.values(before.exploredBy).some((t) => t.sceneId === op.sceneId && t.memberId === e.memberId)) covered.picksForgot++;
      }
      break;
    }
    case "fog.live": {
      const shape = op.ops[0]!;
      if (shape.mode !== "hide" || shape.shape.kind !== "rect") break;
      // H1.
      const { x, y, w, h } = shape.shape;
      const inside = (gx: number, gy: number) => gx >= x * FOG_SUBCELLS && gx < (x + w) * FOG_SUBCELLS && gy >= y * FOG_SUBCELLS && gy < (y + h) * FOG_SUBCELLS;
      const now = layersOf(after, op.sceneId);
      for (const [who, layer] of layersOf(before, op.sceneId)) {
        const kept = now.get(who) ?? {};
        for (const key of new Set([...Object.keys(layer), ...Object.keys(kept)])) {
          const tile = layer[key] ?? kept[key]!;
          const was = bitsAt(layer, key);
          const is = bitsAt(kept, key);
          for (let sy = 0; sy < SIDE; sy++) {
            for (let sx = 0; sx < SIDE; sx++) {
              const gx = tile.tx * SIDE + sx;
              const gy = tile.ty * SIDE + sy;
              if (inside(gx, gy)) {
                assert.equal(bit(is, sx, sy), false, `${where} H1: ${who}'s layer reveals part of the hide`);
                if (who !== "party" && bit(was, sx, sy)) covered.holderBitsHidden++;
              } else assert.equal(bit(is, sx, sy), bit(was, sx, sy), `${where} H1: ${who}'s layer changed outside the hide`);
            }
          }
        }
      }
      covered.hides++;
      break;
    }
    case "fog.reset": {
      // R1.
      if (op.to === "hidden") {
        assert.equal(holderLayerCount(after, op.sceneId), 0, `${where} R1: no holder layer`);
        assert.equal(Object.values(after.exploredTiles).some((t) => t.sceneId === op.sceneId), false, `${where} R1: no party layer`);
      } else {
        for (const [key, tile] of Object.entries(before.exploredBy)) if (tile.sceneId === op.sceneId) assert.equal(after.exploredBy[key], tile, `${where} R1: a reset to revealed keeps every layer`);
      }
      break;
    }
    case "sys.memberRemove": {
      // M1.
      for (const list of Object.values(after.holders)) assert.ok(!list.entries.some((e) => e.memberId === op.memberId), `${where} M1: off every list`);
      assert.ok(!Object.values(after.exploredBy).some((t) => t.memberId === op.memberId), `${where} M1: no layer`);
      if (Object.values(before.holders).some((l) => l.entries.some((e) => e.memberId === op.memberId))) covered.removedHolders++;
      break;
    }
  }
}

describe("the holder list, the layers and the fold over random sequences (6.1, 6.3)", () => {
  test("L1, L2, J1, P1, H1, R1, F1, S1, U1, M1 and G1 hold after every op", () => {
    for (let seed = 1; seed <= 250; seed++) {
      const r = rng(seed * 7919);
      let state = start(r);
      const undo: { entries: NonNullable<Extract<ReturnType<typeof applyOp>, { ok: true }>["inverse"]> }[] = [];
      for (let i = 0; i < 60; i++) {
        const undoing = undo.length > 0 && chance(r, 0.12);
        const op: Op = undoing ? { t: "sys.restore", entries: undo.pop()!.entries, from: "undo" } : opFor(r, state);
        const where = `seed ${seed} op ${i} (${op.t})`;
        if (!opSchema.safeParse(op).success) continue;
        const was = JSON.stringify(state);
        const result = applyOp(state, op, DM, env(10 + i));
        if (!result.ok) {
          assert.equal(JSON.stringify(state), was, `${where} G1: a refusal changes nothing`);
          covered.refused++;
          continue;
        }
        check(state, op, result.state, undoing, where);
        if (!undoing && result.inverse && result.inverse.length > 0) undo.push({ entries: result.inverse });
        state = result.state;
      }
    }
    assert.ok(covered.folds > 40 && covered.pooledBits > 200, `folds with holder bits: ${JSON.stringify(covered)}`);
    assert.ok(covered.undoneFolds > 3, `folds by undo: ${JSON.stringify(covered)}`);
    assert.ok(covered.hides > 100 && covered.holderBitsHidden > 200, `hides over holder layers: ${JSON.stringify(covered)}`);
    assert.ok(covered.capped > 10, `joins past the cap: ${JSON.stringify(covered)}`);
    assert.ok(covered.joins > 40 && covered.picksForgot > 15 && covered.removedHolders > 10, `joins, forgetting picks and removed holders: ${JSON.stringify(covered)}`);
  });
});
