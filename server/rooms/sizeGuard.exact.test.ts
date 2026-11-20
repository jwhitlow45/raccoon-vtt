import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceOp } from "#shared/dice/resolve.ts";
import { FAR_TREATMENT } from "#shared/farLine.ts";
import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op, OpType } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { entry, env, P1, randomDiceRoll, randomOp, randomState, rng, token } from "#shared/testutil.ts";
import { PLAYER_OPS as FIXED, playerTable as table, rolled } from "./playerOpsTesting.ts";
import { exactCopies, farWidths, measuredStateBytes, ownHeldBytes, projectedSceneBytes } from "./sizeGuard.ts";

/*
 * LP44-PRIV-1 (D-261116-026, D-261119-003): a player's own op never moves
 * their stepped part. Everything it writes is in their exact part
 * (sizeGuard.ts exactCopies), each own-written field past their copy at its
 * width (OWN_WRITTEN), so the stepped part keeps only what their copy hides
 * and their ops never write. Each op kind a player may send is checked here
 * on random rooms and a fixed one: their stepped parts, the room's and each
 * scene's, move only by hidden things the op took away, never by a byte it
 * added, but by the residuals the private log tracks (D-261119-019).
 */

const DEPS = { canUseAsset: () => true, canRestoreAsset: () => true } as never;

/**
 * P1's stepped part of the room and of each scene before rounding and the
 * other reserves: the measure with the far line's widths (farWidths) less
 * what P1's exact part takes out of it.
 */
function steppedParts(state: RoomState): Map<string, number> {
  const out = new Map<string, number>([["room", measuredStateBytes(state) + farWidths(state) - ownHeldBytes(state, "p1").sub]]);
  for (const scene of Object.values(state.scenes)) {
    if (scene.floor && scene.floor.of !== scene.id) continue;
    const floors = new Set(floorsOf(state, scene.id).map((floor) => floor.id));
    out.set(scene.id, projectedSceneBytes(state, scene.id) + farWidths(state, floors) - ownHeldBytes(state, "p1", [scene.id]).sub);
  }
  return out;
}

/** Whether a thing still in the room came into P1's exact part or left it: what P1's copy holds changed. */
function sightChanged(before: RoomState, after: RoomState, was: ReadonlyMap<EntityKey, unknown>, is: ReadonlyMap<EntityKey, unknown>): boolean {
  const there = (state: RoomState, key: string) => (key.startsWith("row:") ? state.encounter?.entries.some((e) => `row:${e.id}` === key) : readEntity(state, key as EntityKey) != null);
  for (const key of new Set([...was.keys(), ...is.keys()])) if (was.has(key) !== is.has(key) && there(before, key) && there(after, key)) return true;
  return false;
}

/**
 * What of P1's op moved their stepped parts other than hidden things it took
 * away or carried from one thing to another: hidden bytes it added on the
 * whole, or bytes it wrote outside their exact part. What a scene's part
 * holds from what was carried on another floor is D-261119-012's. With
 * `still`, the op takes nothing hidden away, so each part moves by that
 * alone.
 */
function strays(before: RoomState, after: RoomState, accepted: string[] = [], still = false): string[] {
  const was = exactCopies(before, "p1");
  const is = exactCopies(after, "p1");
  const out: string[] = [];
  const moved = new Map<string, { hidden: number }>();
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    const gain = (is.get(key)?.hidden ?? 0) - (was.get(key)?.hidden ?? 0);
    if (gain === 0) continue;
    const on = is.get(key)?.on ?? was.get(key)!.on;
    const at = moved.get(on) ?? { hidden: 0 };
    at.hidden += gain;
    moved.set(on, at);
  }
  const [b, a] = [steppedParts(before), steppedParts(after)];
  const whole = sum([...moved.values()], (bytes) => bytes.hidden);
  for (const [scope, after] of a) {
    const where = scope === "room" ? "the room" : `scene ${scope}`;
    const floors = scope === "room" ? null : new Set(floorsOf(before, scope).map((f) => f.id));
    let hidden = 0;
    for (const [on, bytes] of moved) {
      if (scope !== "room" && on !== "room" && !floors!.has(on)) continue;
      hidden += bytes.hidden;
    }
    const carried = Math.max(0, Math.min(hidden, hidden - whole));
    if (carried > 0) accepted.push(`${carried} hidden bytes carried into ${where}`);
    if (hidden - carried > 0 || (still && hidden !== carried)) out.push(`${hidden - carried} hidden bytes in ${where}`);
    const outside = after - (b.get(scope) ?? after) - hidden;
    if (outside !== 0) out.push(`${outside} bytes outside P1's exact part in ${where}`);
  }
  return out;
}

const sum = <T>(items: readonly T[], of: (item: T) => number) => items.reduce((total, item) => total + of(item), 0);

/** Every thing's rev at 9, 99 or 999 in some rooms, so a player's op carries it across a digit. */
function revsAcross(state: RoomState, r: () => number): void {
  const at = () => [0, 9, 99, 999][Math.floor(r() * 4)]!;
  for (const name of ["tokens", "templates", "drawings", "characters", "members", "rolls", "casts", "companionBlocks"] as const) {
    const things = state[name] as Record<string, { rev: number }>;
    for (const [id, thing] of Object.entries(things)) things[id] = { ...thing, rev: at() };
  }
}

/** The op kinds the random rooms reach a player with. */
const RANDOM_KINDS = new Set<OpType>();

describe("LP44-PRIV-1: a player's own op never moves their stepped part", () => {
  test("random rooms: every op a player may send moves P1's stepped parts only by hidden things it took away", () => {
    const apart: string[] = [];
    const accepted: string[] = [];
    let sight = 0;
    let checked = 0;
    for (let seed = 1; seed <= 1_500; seed++) {
      const r = rng(seed);
      let state = randomState(r);
      if (seed % 3 === 0) revsAcross(state, r);
      // A random room's asks may name creatures no one owns, which any op then settles away.
      state.casts = {};
      for (let k = 0; k < 8; k++) {
        // Now and then a roll of several dice whose rolls reach different readers.
        const op = k % 4 === 3 ? randomDiceRoll(r, state, P1) : randomOp(r, state, P1);
        if (FAR_TREATMENT[op.t] === "deletion" || FAR_TREATMENT[op.t] === "server" || !canApply(op, P1, state, DEPS).ok) continue;
        // Late line ids, so the op's lines are the newest, as a live op's are.
        const result = applyOp(state, op, P1, env(1_000_000 + seed * 10 + k));
        if (!result.ok) continue;
        RANDOM_KINDS.add(op.t);
        const next = result.state;
        if (op.t !== "encounter.next") {
          if (sightChanged(state, next, exactCopies(state, "p1"), exactCopies(next, "p1"))) sight++;
          else {
            checked++;
            for (const stray of strays(state, next, accepted)) apart.push(`${op.t} (seed ${seed}): ${stray}`);
          }
        }
        state = next;
      }
    }
    assert.deepEqual(apart.slice(0, 10), [], `${apart.length} of ${checked} ops moved P1's stepped part`);
    assert.ok(checked > 5 * sight, `${checked} ops checked, ${sight} changed what P1's copy holds`);
    assert.ok(accepted.length < checked / 50, `${accepted.length} ops carried hidden bytes into other scenes`);
  });

  for (const [kind, fixed] of Object.entries(FIXED)) {
    test(`${kind}: moves P1's stepped part by nothing it adds`, () => {
      const state = table();
      fixed.room?.(state);
      const op = fixed.op(state);
      const decision = canApply(op, P1, state, DEPS);
      assert.ok(decision.ok, `P1 may send it: ${JSON.stringify(decision)}`);
      const result = applyOp(state, op, P1, env(1_000_000));
      assert.ok(result.ok, result.ok ? "" : result.message);
      assert.ok(measuredStateBytes(result.state) !== measuredStateBytes(state), "it writes the room");
      assert.deepEqual(strays(state, result.state, [], true), []);
    });
  }

  test("a dice line of P1's with a roll for a creature of theirs players do not see beside one they do: P1's stepped parts stay as they were, line after line", () => {
    let state = table();
    state.tokens.pet = { ...state.tokens.pet!, visibility: "dm" };
    for (let i = 0; i < 3; i++) {
      const op = rolled(state, { t: "dice.roll", tag: `t${i}`, to: "all", rolls: [{ formula: "1d20", label: "Bite", creature: { tokenId: "pet" } }, { formula: "1d20", label: "Strike", creature: { tokenId: "hero" } }] } as DiceOp);
      assert.ok(canApply(op, P1, state, DEPS).ok);
      const result = applyOp(state, op, P1, env(1_000_000 + i));
      assert.ok(result.ok, result.ok ? "" : result.message);
      const line = result.state.log.at(-1)!;
      assert.ok(line.parts?.rolls?.some((readers) => readers !== null), "the line names who read a roll");
      assert.deepEqual(strays(state, result.state, [], true), []);
      state = result.state;
    }
  });

  test("a dice line with two rolls for one creature beside one for a creature P1 does not see: only that roll stays in the stepped part", () => {
    const state = table();
    state.tokens.ghost = token("ghost", { visibility: "dm", x: 9, y: 9 });
    const roll = (label: string, tokenId: string, total: number) => ({ formula: "1d20", faces: [total], total, label, tokenId, ...(tokenId === "hero" ? { seen: true } : {}) });
    const hidden = roll("Roll 2", "ghost", 10);
    state.log = [{ id: "900:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "dice", by: "p1", to: "all", rolls: [roll("Roll 1", "hero", 18), hidden, roll("Roll 3", "hero", 16)] }, parts: { rolls: [null, [], null] } } as never];
    assert.equal(exactCopies(state, "p1").get(keys.log("900:0"))!.hidden, JSON.stringify(hidden).length + 1);
  });

  test("a stored field past its width keeps the rest in the stepped part, so the exact part never counts less than it takes out", () => {
    const state = table();
    const vitals = { hp: { cur: 20, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } };
    const anchors = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`row${i}`, { round: 1, entryId: `row${i}`, at: "start" }]));
    state.log = [{ id: "900:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", tokenId: "pet", seen: true, change: "damage", amount: 3, label: "Healthy", left: { cur: 17, max: 20, temp: 0 }, revert: { before: vitals, after: vitals, anchors } } as never }];
    state.buildChunks["s1:0,0"]!.edges["3,2,w"] = { kind: "door", state: "x".repeat(40), secret: false, discovered: false } as never;
    const copies = exactCopies(state, "p1");
    const line = copies.get("log:900:0" as EntityKey);
    const door = [...copies].find(([key]) => key.startsWith("chunk:"))?.[1];
    assert.ok(line && door, "P1's exact part holds the line and the door");
    assert.ok(line.shown >= line.sub, `the line: ${line.shown} shown, ${line.sub} taken out`);
    assert.ok(door.shown >= door.sub, `the door: ${door.shown} shown, ${door.sub} taken out`);
  });

  test("what a walk took on floors its creature left counts at its width for a creature P1 moves but does not own", () => {
    const walked = (moved: number) => {
      const state = table();
      state.meta.settings = { ...state.meta.settings, playersMoveAny: "all" };
      state.tokens.wolf = token("wolf", { x: 6, y: 6, path: { turn: 7, prior: { moved, cost: moved, diag: [1, 0], seenDiag: [1, 0] }, stops: [{ x: 6, y: 6, elevation: 0, seen: true }] } });
      state.encounter = { rev: 0, round: 1, activeEntryId: "rwolf", entries: [entry("rwolf", { tokenId: "wolf" })], turnStart: { entryId: "rwolf", tokenId: "wolf", sceneId: "s1", x: 6, y: 6, elevation: 0, seen: true, seq: 7 } };
      return exactCopies(state, "p1").get("token:wolf" as EntityKey);
    };
    const [near, far] = [walked(5), walked(50_000)];
    assert.ok(near && far, "P1's exact part holds the wolf");
    assert.equal(far.hidden, near.hidden, "nothing of it stays in the stepped part");
    assert.equal(far.shown, near.shown, "and it counts alike");
  });

  /**
   * Kinds the room above stands for: a recharge roll or a turn prompt
   * writes the actor of the player's creature as a use does, a roll ask the
   * server rolls writes their answer and line as an answer and a dice line
   * do, a change ask writes their target of a roll request as an answer
   * does, a climb or a detach poses their creature as a move does, and
   * their Undo and Redo put back their own lines and poses as a restore
   * does (design 7.7).
   */
  const SAME_AS: Partial<Record<OpType, OpType>> = {
    "roll.dice": "roll.answer",
    "sys.dice": "dice.roll",
    "actor.rechargeRoll": "actor.use",
    "actor.prompt": "actor.use",
    "roll.change": "roll.answer",
    "token.climb": "token.move",
    "token.detach": "token.move",
    undo: "sys.restore",
    redo: "sys.restore",
  };

  test("every op kind a player may send that can write the room is checked, or the DM's alone", () => {
    const state = table();
    const unchecked: string[] = [];
    for (const kind of Object.keys(FAR_TREATMENT) as OpType[]) {
      if (FAR_TREATMENT[kind] === "deletion" || FAR_TREATMENT[kind] === "server") continue;
      if (RANDOM_KINDS.has(kind) || kind in FIXED || kind === "encounter.next") continue;
      const same = SAME_AS[kind];
      if (same !== undefined && (RANDOM_KINDS.has(same) || same in FIXED)) continue;
      // The DM's alone: a player's op of the kind is forbidden before any of its fields is read.
      let decision: ReturnType<typeof canApply> | null = null;
      try {
        decision = canApply({ t: kind } as Op, P1, state, DEPS);
      } catch {
        decision = null;
      }
      if (decision?.ok === false && decision.code === "forbidden") continue;
      unchecked.push(kind);
    }
    assert.deepEqual(unchecked, []);
  });
});
