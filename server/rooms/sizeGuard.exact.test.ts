import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceOp } from "#shared/dice/resolve.ts";
import { FAR_TREATMENT } from "#shared/farLine.ts";
import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import { BOOKKEEPING_RESERVE, FAR, LIMITS, ROOM_FULL, serializedBytes } from "#shared/limits.ts";
import type { Effect, EncounterSnapshot, RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op, OpType } from "#shared/protocol.ts";
import { projectState, seatView, stableStringify } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { keptHistory } from "#shared/reducer/encounter.ts";
import { memberRing } from "#shared/logRings.ts";
import { floorsOf, ownedBy } from "#shared/rules/floors.ts";
import { turnUnderWay } from "#shared/rules/path.ts";
import { actor, character, DM, effect, entry, env, P1, randomDiceRoll, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { PLAYER_OPS as FIXED, playerTable as table, rolled } from "./playerOpsTesting.ts";
import { UndoTable } from "./undoTesting.ts";
import { GROUND, UPPER, fallCard, trapdoor, tower as floorsTower, tower, withFalls, withOpening, withStairs } from "#shared/floorLinksTestutil.ts";
import { farAnswer, parked, placeName } from "./copyTwinsTesting.ts";
import { exactCopies, farRoomBytes, farWidths, measuredStateBytes, ownHeldBytes, projectedSceneBytes, type ExactCopy } from "./sizeGuard.ts";

/*
 * LP44-PRIV-1 (D-261116-026, D-261119-003): a player's own op writes
 * nothing into their stepped part. Everything it writes is in their exact
 * part (sizeGuard.ts exactCopies), each own-written field past their copy at
 * its width (OWN_WRITTEN), so the stepped part keeps only what their copy
 * hides and their ops never write. Each op kind a player may send is checked
 * here on random rooms and a fixed one: their stepped parts, the room's and
 * each scene's, move only by hidden things the op took away, never by a byte
 * it added, nor by anything still in the room leaving their exact part, an
 * op that changes what their copy holds included. The exceptions are the
 * residuals the private log tracks (D-261119-019), one of which this test
 * allows: a creature they do not own, with the lines naming it, coming into
 * or leaving their sight. A walk of the turn under way counts in the room's
 * walk pool, and one of another turn at its stored bytes in the stepped
 * part, which an op may only take away (D-261121-120).
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

const there = (state: RoomState, key: string) => (key.startsWith("row:") ? state.encounter?.entries.some((e) => `row:${e.id}` === key) : readEntity(state, key as EntityKey) != null);

/** Whether a thing still in the room came into P1's exact part or left it: what P1's copy holds changed. */
function sightChanged(before: RoomState, after: RoomState, was: ReadonlyMap<EntityKey, unknown>, is: ReadonlyMap<EntityKey, unknown>): boolean {
  for (const key of new Set([...was.keys(), ...is.keys()])) if (was.has(key) !== is.has(key) && there(before, key) && there(after, key)) return true;
  return false;
}

/**
 * Whether a thing still in the room that came into P1's exact part or left
 * it is one the private log tracks as a residual (D-261116-069): a creature
 * P1 does not own, which P1 sees come or go and whose bytes are the DM's
 * (the sight residual), or a roll request the DM made for a creature P1's op
 * deleted, which leaves once with it (residual 3). A shared line never
 * leaves (D-261120-010).
 */
function residualMove(before: RoomState, after: RoomState, key: string): boolean {
  if (!there(before, key) || !there(after, key)) return false;
  if (key.startsWith("token:")) {
    const token = before.tokens[key.slice("token:".length)];
    return token !== undefined && !ownedBy(before, "p1", token);
  }
  return namesDeleted(before, after, key);
}

/** Whether the op deleted a creature. */
const deletes = (before: RoomState, after: RoomState) => Object.keys(before.tokens).some((id) => after.tokens[id] === undefined);

/** Whether a roll request names a creature the op deleted. */
function namesDeleted(before: RoomState, after: RoomState, key: string): boolean {
  if (!key.startsWith("roll:")) return false;
  const targets = (readEntity(before, key as EntityKey) as { targets?: { tokenId?: string }[] } | null)?.targets ?? [];
  return targets.some((target) => target.tokenId !== undefined && before.tokens[target.tokenId] !== undefined && after.tokens[target.tokenId] === undefined);
}

/**
 * The bytes on each floor of the walks a room kept from another turn than
 * the one under way, which the stepped part holds as stored until a turn's
 * end takes them off (D-261121-120): an op may take one away, and never
 * adds one.
 */
function otherTurnWalks(state: RoomState): Map<string, number> {
  const seq = turnUnderWay(state.encounter)?.seq;
  const out = new Map<string, number>();
  for (const token of Object.values(state.tokens)) {
    if (token.path === undefined || (seq !== undefined && token.path.turn === seq)) continue;
    const lists = token.path.stops.filter((stop) => stop.seenBy !== undefined);
    // As the measures count it: each list of who saw at the roster's widest (sizeGuard.ts tokenLists).
    const bytes = serializedBytes({ path: token.path }) - 1 - sum(lists, (stop) => serializedBytes(stop.seenBy) - 2) + lists.length * widestList(state);
    const on = placeName({ kind: "floor", id: token.sceneId });
    out.set(on, (out.get(on) ?? 0) + bytes);
  }
  return out;
}

/** A list of who saw at the roster's widest, as the measures count one beyond `[]`: its six longest ids. */
function widestList(state: RoomState): number {
  const ids = Object.keys(state.members).map((id) => serializedBytes(id)).sort((x, y) => y - x).slice(0, 6);
  return ids.length === 0 ? 0 : sum(ids, (bytes) => bytes) + ids.length - 1;
}

/**
 * What of P1's op moved their stepped parts other than hidden things it took
 * away or carried from one thing to another: hidden bytes it added on the
 * whole, or bytes outside their exact part, which it wrote there or which
 * left the exact part while still in the room. What a scene's part holds
 * from what was carried on another floor is D-261119-012's. With `still`,
 * the op takes nothing hidden away, so each part moves by that alone.
 */
function strays(before: RoomState, after: RoomState, accepted: string[] = [], still = false): string[] {
  const was = exactCopies(before, "p1");
  const is = exactCopies(after, "p1");
  const out: string[] = [];
  const moved = new Map<string, { hidden: number; walks: number }>();
  const residual = new Map<string, number>();
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    if (was.has(key) !== is.has(key) && residualMove(before, after, key)) {
      // What it takes out of the stepped part: its bytes and, for a creature, its fields' widths (FAR_WIDTHS).
      const taken = (copies: ReadonlyMap<EntityKey, ExactCopy>) => copies.get(key as EntityKey)?.sub ?? 0;
      const on = placeName((is.get(key) ?? was.get(key))!.on);
      residual.set(on, (residual.get(on) ?? 0) + taken(was) - taken(is));
      accepted.push(`${key} ${is.has(key) ? "came into" : "left"} P1's exact part`);
      continue;
    }
    const gain = (is.get(key)?.hidden ?? 0) - (was.get(key)?.hidden ?? 0);
    if (gain === 0) continue;
    if (gain > 0 && namesDeleted(before, after, key)) {
      // Residual 3: the answer for a creature the op deleted leaves the copy of a roll request the DM made, once.
      residual.set(placeName({ kind: "room" }), (residual.get(placeName({ kind: "room" })) ?? 0) + gain);
      accepted.push(`${key} keeps ${gain} bytes for a creature the op deleted`);
      continue;
    }
    const on = placeName(is.get(key)?.on ?? was.get(key)!.on);
    const at = moved.get(on) ?? { hidden: 0, walks: 0 };
    at.hidden += gain;
    moved.set(on, at);
  }
  // A walk of another turn the op took away, which the stepped part held as stored.
  const [walksBefore, walksAfter] = [otherTurnWalks(before), otherTurnWalks(after)];
  for (const on of new Set([...walksBefore.keys(), ...walksAfter.keys()])) {
    const taken = (walksAfter.get(on) ?? 0) - (walksBefore.get(on) ?? 0);
    if (taken > 0) continue;
    const at = moved.get(on) ?? { hidden: 0, walks: 0 };
    at.walks += taken;
    moved.set(on, at);
    if (taken < 0) accepted.push(`${-taken} bytes of a walk of another turn taken off on ${on}`);
  }
  const [b, a] = [steppedParts(before), steppedParts(after)];
  const whole = sum([...moved.values()], (bytes) => bytes.hidden);
  const deleted = deletes(before, after);
  for (const [scope, after] of a) {
    const where = scope === "room" ? "the room" : `scene ${scope}`;
    const floors = scope === "room" ? null : new Set(floorsOf(before, scope).map((f) => f.id));
    const holds = (on: string) => scope === "room" || on === placeName({ kind: "room" }) || [...floors!].some((id) => on === placeName({ kind: "floor", id }));
    let hidden = 0;
    let allowed = 0;
    for (const [on, bytes] of moved) {
      if (!holds(on)) continue;
      hidden += bytes.hidden;
      allowed += bytes.walks;
    }
    for (const [on, bytes] of residual) if (holds(on)) allowed += bytes;
    const carried = Math.max(0, Math.min(hidden, hidden - whole));
    if (carried > 0) accepted.push(`${carried} hidden bytes carried into ${where}`);
    if (hidden - carried > 0 || (still && hidden !== carried)) out.push(`${hidden - carried} hidden bytes in ${where}`);
    const outside = after - (b.get(scope) ?? after) - hidden - allowed;
    // Residual 3: a deletion takes what names the creature it deleted off things outside P1's exact part, which only falls.
    if (outside < 0 && deleted) accepted.push(`${-outside} bytes naming what the op deleted taken away in ${where}`);
    else if (outside !== 0) out.push(`${outside} bytes outside P1's exact part in ${where}`);
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

describe("LP44-PRIV-1: a player's own op writes nothing into their stepped part", () => {
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
        // A deletion too (LP44FIX item d): it takes away what it deletes, and nothing else of P1's may leave the exact part.
        if (FAR_TREATMENT[op.t] === "server" || !canApply(op, P1, state, DEPS).ok) continue;
        // Late line ids, so the op's lines are the newest, as a live op's are.
        const result = applyOp(state, op, P1, env(1_000_000 + seed * 10 + k));
        if (!result.ok) continue;
        RANDOM_KINDS.add(op.t);
        const next = result.state;
        if (op.t !== "encounter.next") {
          // An op that changes what P1's copy holds is checked as any other (LP44-FABLE-4).
          if (sightChanged(state, next, exactCopies(state, "p1"), exactCopies(next, "p1"))) sight++;
          checked++;
          for (const stray of strays(state, next, accepted)) apart.push(`${op.t} (seed ${seed}): ${stray}`);
        }
        state = next;
      }
    }
    assert.deepEqual(apart.slice(0, 10), [], `${apart.length} of ${checked} ops moved P1's stepped part`);
    assert.ok(sight > 0, `${sight} of ${checked} ops changed what P1's copy holds`);
    const carried = accepted.filter((why) => why.includes("carried"));
    assert.ok(carried.length < checked / 50, `${carried.length} ops carried hidden bytes into other scenes`);
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

  test("an HP line keeps in the stepped part only the conditions hidden from players, whatever players are not shown of the rest", () => {
    // Its vitals at their widest and a dozen conditions of each shape, so no slack in the width covers a part left out.
    const vitals = { hp: { cur: 100_000, max: 100_000, temp: 100_000 }, life: "stable" as const, deathSaves: { ok: 3, fail: 3 } };
    const many = (make: (i: number) => Effect) => Array.from({ length: 12 }, (_, i) => make(i));
    const shapes = {
      "a save's DC and occurrence": many((i) => effect(`s${i}`, { key: "custom", label: "Held", save: { ability: "wis", dc: 50 }, due: { id: "123456789012345678:123456", state: "dismissed" } })),
      "a span's end and clock": many((i) => effect(`e${i}`, { key: "blessed", ends: { span: 600, at: 9_007_199_254_740_991, clock: "c".repeat(64) } })),
      "a Ready action's trigger": many((i) => effect(`r${i}`, { key: "readied", label: "\u20ac".repeat(80) })),
    };
    const hidden = effect("e-hidden", { key: "poisoned", hiddenFromPlayers: true });
    for (const [what, shown] of Object.entries(shapes)) {
      const state = table();
      state.log = [{ id: "900:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", tokenId: "pet", seen: true, change: "damage", amount: 3, label: "Dying", left: vitals.hp, revert: { before: vitals, after: vitals, added: [...shown, hidden] } } as never }];
      assert.equal(exactCopies(state, "p1").get(keys.log("900:0"))!.hidden, JSON.stringify(hidden).length + 1, what);
    }
  });

  test("an HP line counts a span's end and clock as players are shown them: as stored while their view holds that clock, at their widest otherwise", () => {
    const shownOf = (held: boolean) => {
      const state = table();
      state.clock = { id: "clk1", rev: 1, t: 0, shown: held, calendar: { kind: "days" } };
      const vitals = { hp: { cur: 5, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } };
      const ends = effect("e-ends", { key: "blessed", ends: { span: 600, at: 1000, clock: "clk1" } });
      state.log = [{ id: "900:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", tokenId: "pet", seen: true, change: "damage", amount: 3, label: "Bloodied", left: vitals.hp, revert: { before: vitals, after: vitals, removed: [ends] } } as never }];
      return exactCopies(state, "p1").get(keys.log("900:0"))!.shown;
    };
    assert.ok(shownOf(false) - shownOf(true) > 300, `${shownOf(false)} against ${shownOf(true)}`);
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

  /** P1's ops in order on `state`, each taken, numbered from `from`, so their line ids are the same whatever the room holds. */
  const played = (state: RoomState, ops: readonly Op[], check?: (before: RoomState, after: RoomState, op: Op) => void, from = 2_000_000): RoomState => {
    ops.forEach((op, i) => {
      const result = applyOp(state, op, P1, env(from + i));
      assert.ok(result.ok, result.ok ? "" : `${op.t}: ${result.message}`);
      check?.(state, result.state, op);
      state = result.state;
    });
    return state;
  };

  /** P1's chat lines of `sizes` characters, then enough of their whispers to themselves to fill their ring of whispers. */
  const chatThenWhispers = (state: RoomState, sizes: readonly number[]): Op[] => [
    ...sizes.map((size) => ({ t: "log.chat", text: "x".repeat(size) }) as Op),
    ...Array.from({ length: memberRing("whisper", Object.keys(state.members).length).lines + 1 }, () => ({ t: "log.whisper", to: ["p1"], text: "w" }) as Op),
  ];

  test("P1's own whispers, which move where their live log starts past their own shared lines, leave P1's stepped parts as they were", () => {
    const start = room();
    const after = played(start, chatThenWhispers(start, [300]), (before, next, op) => assert.deepEqual(strays(before, next, [], true), [], op.t));
    const chat = after.log.find((line) => line.kind === "chat")!.id;
    assert.ok(!projectState(after, P1, { sceneId: null }).log.some((line) => line.id === chat), "P1's live log starts past their chat line");
    assert.ok(exactCopies(after, "p1").has(keys.log(chat)), "which stays in P1's exact part");
  });

  test("twins apart in one character of a DM's note P1 never receives read alike after P1's own chat and whispers just as before", () => {
    const twin = (note: number): RoomState => {
      const state = room();
      state.tokens.npc = token("npc", { sceneId: "s2", actor: { inline: actor({ dmNotes: "n".repeat(note) }) } });
      return state;
    };
    const ops = chatThenWhispers(twin(0), [1_000, 326]);
    const padded = (state: RoomState, n: number): RoomState => ({ ...state, tokens: { ...state.tokens, pad: token("pad", { sceneId: "s2", notes: "p".repeat(n) }) } });
    const reading = (state: RoomState) => farRoomBytes(state, true, measuredStateBytes(state), ownHeldBytes(state, "p1"));
    // The DM's pad that puts the shorter twin, after P1's ops, on a step's edge: one more stored byte reads a step more.
    const after = played(twin(1_000), ops);
    const at = reading(padded(after, 0));
    let [lo, hi] = [0, FAR.byteStep + 1];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (reading(padded(after, mid)) === at) lo = mid;
      else hi = mid;
    }
    assert.ok(reading(padded(after, lo + 1)) > at, "one more stored byte reads a step more");
    const [a, b] = [twin(1_000), twin(1_001)].map((state) => padded(state, lo)) as [RoomState, RoomState];
    const [a1, b1] = [played(a, ops), played(b, ops)];
    const copyOf = (state: RoomState) => stableStringify(projectState(state, P1, { sceneId: null }));
    assert.equal(copyOf(a1), copyOf(b1), "P1's copies are equal");
    assert.equal(reading(a1) === reading(b1), reading(a) === reading(b), `P1 reads ${reading(a)} and ${reading(b)} before, ${reading(a1)} and ${reading(b1)} after`);
  });

  /**
   * Two floors and stairs between them, with Thorn, P1's, on the ground
   * floor and a goblin of the DM's upstairs. The DM hid Thorn, so no climb of
   * theirs opens a floor: P1 holds the upper floor only while Thorn stands
   * on it.
   */
  const tower = (): RoomState => {
    const floor = (id: string, level: number) => scene(id, { name: "Tower", order: 0, bounds: { w: 20, h: 20 }, floor: { of: "s1", level, name: `Floor ${level}`, height: 10 } });
    const state = room({
      scenes: { s1: floor("s1", 0), up: floor("up", 1), s2: scene("s2", { order: 1 }) },
      characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ speeds: { walk: 30 } }) }) },
      tokens: {
        thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "thorn" }, sceneId: "s1", x: 9, y: 9, visibility: "dm" }),
        gob: token("gob", { name: "Goblin", sceneId: "up", x: 4, y: 4 }),
      },
    });
    const linked = applyOp(state, { t: "floorLink.put", link: { id: "l1", pairId: "l2", sceneId: "s1", to: "up", rect: { x: 9, y: 9, w: 1, h: 1 }, kind: "stairs" } } as Op, DM, env(1_900_000));
    assert.ok(linked.ok, linked.ok ? "" : linked.message);
    return linked.state;
  };
  const [climbUp, climbDown] = [{ t: "token.climb", tokenId: "thorn", linkId: "l1" }, { t: "token.climb", tokenId: "thorn", linkId: "l2" }] as [Op, Op];
  const still = (before: RoomState, next: RoomState, op: Op) => assert.deepEqual(strays(before, next, [], true), [], op.t);
  /** An area of P1's on the upper floor, loose or on the goblin. */
  const areaOf = (id: string, attachedTo?: string): Op =>
    ({ t: "template.create", template: { id, sceneId: "up", shape: "sphere", size: 10, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: false, color: "#ff0000", ownerId: "p1", visibility: "all", label: "L".repeat(60), ...(attachedTo ? { attachedTo } : {}) } }) as Op;

  test("P1's climb off the floor their drawing, ask and area stand on, and back, leaves P1's stepped parts as they were", () => {
    const up = played(tower(), [climbUp], still);
    const made = played(
      up,
      [
        { t: "drawing.create", drawing: { id: "d1", sceneId: "up", kind: "free", ownerId: "p1", visibility: "all", style: { stroke: "#ff0000", width: 2, opacity: 1 }, points: Array.from({ length: 400 }, (_, i) => i % 97) } },
        areaOf("a1"),
        { t: "cast.ask", cast: { id: "c1", caster: "thorn", sceneId: "up", spell: "S".repeat(60), targets: ["thorn"] } },
      ] as Op[],
      still,
    );
    const theirs = ["drawing:d1", "template:a1", "cast:c1"] as EntityKey[];
    const down = played(made, [climbDown], still);
    assert.ok(!seatView(down, "p1").holds("up"), "P1 no longer holds the upper floor");
    assert.deepEqual(theirs.filter((key) => !exactCopies(down, "p1").has(key)), [], "their things stay in P1's exact part");
    played(down, [climbUp], still);
  });

  test("P1's area the DM hid reads as one the DM deleted through P1's climb, loose on a floor and on a creature (D-261120-012)", () => {
    for (const [id, area] of [["a1", areaOf("a1")], ["a2", areaOf("a2", "gob")]] as const) {
      const made = played(played(tower(), [climbUp]), [area]);
      const [hidden, deleted] = [{ t: "template.update", templateId: id, patch: { visibility: "dm" } }, { t: "template.delete", templateId: id }].map((op) => {
        const result = applyOp(made, op as Op, DM, env(1_950_000));
        assert.ok(result.ok, result.ok ? "" : result.message);
        return result.state;
      }) as [RoomState, RoomState];
      const shown = (state: RoomState) => Object.fromEntries([...exactCopies(state, "p1")].map(([key, part]) => [key, `${part.shown} B on ${placeName(part.shownOn ?? part.on)}`]));
      const copyOf = (state: RoomState) => stableStringify(projectState(state, P1, { sceneId: null }));
      const [hiddenDown, deletedDown] = [played(hidden, [climbDown]), played(deleted, [climbDown])];
      assert.equal(copyOf(hidden), copyOf(deleted), `${id}: P1's copies are alike`);
      assert.equal(copyOf(hiddenDown), copyOf(deletedDown), `${id}: and after P1's climb`);
      assert.deepEqual(shown(hiddenDown), shown(deletedDown), `${id}: P1's exact parts are alike after the climb`);
      const moved = (before: RoomState, after: RoomState) => [...steppedParts(after)].map(([scope, bytes]) => [scope, bytes - steppedParts(before).get(scope)!]);
      assert.deepEqual(moved(hidden, hiddenDown), moved(deleted, deletedDown), `${id}: the climb moves P1's stepped parts alike`);
    }
  });

  /** P1's companion Hoot, made by P1's own op. */
  const hoot = (): Op => FIXED["token.create"]!.op(table());

  test("P1's lines about their companion stay in their exact part as they read them when P1 dismisses it, whatever their labels", () => {
    for (const label of ["L", "L".repeat(80)]) {
      const state = played(table(), [hoot()], still);
      const roll = rolled(state, { t: "dice.roll", tag: "hoot", to: "all", rolls: [{ formula: "1d20", label, creature: { tokenId: "pet2" } }] } as DiceOp);
      const rolledState = played(state, [roll], still, 2_100_000);
      const line = rolledState.log.at(-1)!.id;
      const gone = played(rolledState, [{ t: "token.delete", tokenId: "pet2" } as Op], still, 2_200_000);
      assert.equal(projectState(gone, P1, { sceneId: null }).log.some((entry) => entry.id === line), false, "P1's copy no longer holds the line");
      assert.ok(exactCopies(gone, "p1").has(keys.log(line)), "P1's exact part still does");
    }
  });

  test("P1's own deletions leave the lines naming what they deleted in P1's exact part as P1 read them: a row's turn, an area's line and a use", () => {
    const state = table();
    const at = "2026-10-12T20:00:00.000Z";
    state.log = [
      { id: "900:0", at, kind: "event", data: { type: "turn", entryId: "rhero", round: 1, seen: true } },
      { id: "900:1", at, kind: "event", data: { type: "area", templateId: "a1", tokenId: "hero", trigger: "enter", area: "Bless", seen: true } },
      { id: "900:2", at, kind: "event", data: { type: "use", tokenId: "pet", seen: true, what: "ability", name: "Breath", cost: 1, left: 2, max: 3 } },
    ] as never;
    const held = (st: RoomState) => [...exactCopies(st, "p1")].filter(([key]) => key.startsWith("log:"));
    assert.equal(held(state).length, 3, "P1 holds the three lines");
    for (const op of [{ t: "encounter.remove", entryIds: ["rhero"] }, { t: "template.delete", templateId: "a1" }, { t: "token.delete", tokenId: "pet" }] as Op[]) {
      const after = played(state, [op], still);
      assert.deepEqual(held(after), held(state), op.t);
    }
  });

  test("a DM's hide of a creature a shared line names leaves the line in P1's exact part as P1 read it", () => {
    const state = table();
    state.tokens.gob = token("gob", { x: 5, y: 5, actor: { inline: actor({ dmNotes: "" }) } });
    const hp = applyOp(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 3 } } as Op, DM, env(1_970_000));
    assert.ok(hp.ok, hp.ok ? "" : hp.message);
    const line = hp.state.log.at(-1)!.id;
    const hidden = applyOp(hp.state, { t: "token.update", tokenId: "gob", patch: { visibility: "dm" } } as Op, DM, env(1_970_001));
    assert.ok(hidden.ok, hidden.ok ? "" : hidden.message);
    assert.equal(projectState(hidden.state, P1, { sceneId: null }).log.some((entry) => entry.id === line), false, "P1's copy no longer holds the line");
    assert.deepEqual(exactCopies(hidden.state, "p1").get(keys.log(line)), exactCopies(hp.state, "p1").get(keys.log(line)));
  });

  test("a blackout leaves the shared lines in P1's exact part as P1 read them, a line of the fight's among them", () => {
    const ended = applyOp(table(), { t: "encounter.end" } as Op, DM, env(1_974_000));
    assert.ok(ended.ok, ended.ok ? "" : ended.message);
    const dark = applyOp(ended.state, { t: "view.blackout", blackout: true } as Op, DM, env(1_975_000));
    assert.ok(dark.ok, dark.ok ? "" : dark.message);
    const lines = (state: RoomState) => [...exactCopies(state, "p1")].filter(([key]) => key.startsWith("log:"));
    assert.ok(lines(ended.state).some(([key]) => (readEntity(ended.state, key) as { data?: { type?: string } }).data?.type === "encounter"), "P1 holds the fight's line");
    assert.deepEqual(lines(dark.state), lines(ended.state));
  });

  test("a member who joins later holds exactly only the shared lines written since, as they read them then", () => {
    const state = table();
    const before = applyOp(state, { t: "log.chat", text: "x".repeat(300) } as Op, DM, env(1_980_000));
    assert.ok(before.ok, before.ok ? "" : before.message);
    const joined = applyOp(before.state, { t: "sys.memberJoin", member: { id: "p3", name: "Pip", color: "#3366ff", kind: "player", createdAt: "2026-10-12T20:00:00.000Z" } } as Op, DM, env(1_980_001));
    assert.ok(joined.ok, joined.ok ? "" : joined.message);
    const after = applyOp(joined.state, { t: "log.chat", text: "y".repeat(300) } as Op, DM, env(1_980_002));
    assert.ok(after.ok, after.ok ? "" : after.message);
    const [old, recent] = [before.state.log.at(-1)!.id, after.state.log.at(-1)!.id];
    assert.ok(projectState(after.state, { memberId: "p3", role: "player" }, { sceneId: null }).log.some((entry) => entry.id === old), "P3's copy holds the older line");
    const held = exactCopies(after.state, "p3");
    assert.equal(held.has(keys.log(old)), false, "which their exact part leaves in the stepped part");
    assert.ok(held.has(keys.log(recent)), "and holds the newer one");
    assert.ok(exactCopies(after.state, "p1").has(keys.log(old)), "P1, on the roster then, holds both");
    // Removed and back: a line written while they were away stays in the stepped part.
    const away = applyOp(after.state, { t: "sys.memberRemove", memberId: "p3" } as Op, DM, env(1_980_003));
    assert.ok(away.ok, away.ok ? "" : away.message);
    const between = applyOp(away.state, { t: "log.chat", text: "z".repeat(300) } as Op, DM, env(1_980_004));
    assert.ok(between.ok, between.ok ? "" : between.message);
    const back = applyOp(between.state, { t: "sys.memberJoin", member: { id: "p3", name: "Pip", color: "#3366ff", kind: "player", createdAt: "2026-10-12T20:00:00.000Z" } } as Op, DM, env(1_980_005));
    assert.ok(back.ok, back.ok ? "" : back.message);
    const again = exactCopies(back.state, "p3");
    assert.deepEqual([old, recent, between.state.log.at(-1)!.id].map((id) => again.has(keys.log(id))), [false, true, false]);
  });

  test("a drawing the DM makes under P1's id and hides from players is not in P1's exact part (D-261120-012)", () => {
    const state = table();
    const made = applyOp(state, { t: "drawing.create", drawing: { id: "dmd", sceneId: "s1", kind: "free", ownerId: "p1", visibility: "dm", style: { stroke: "#ff0000", width: 2, opacity: 1 }, points: [1, 1, 2, 2] } } as Op, DM, env(1_960_000));
    assert.ok(made.ok, made.ok ? "" : made.message);
    assert.equal(stableStringify(projectState(made.state, P1, { sceneId: null })), stableStringify(projectState(state, P1, { sceneId: null })), "P1's copy is as it was");
    assert.ok(!exactCopies(made.state, "p1").has("drawing:dmd" as EntityKey));
  });

  /** How each of P1's stepped parts moved from one state to the next. */
  const movedBy = (before: RoomState, after: RoomState) => {
    const was = steppedParts(before);
    return Object.fromEntries([...steppedParts(after)].map(([scope, bytes]) => [scope, bytes - (was.get(scope) ?? bytes)]));
  };
  const endTurn = (entry: string): Op => ({ t: "encounter.next", from: { entry, round: 1 } }) as Op;

  /**
   * A fight on Hero's turn, with a goblin of the DM's last, and what P1
   * chose by their own ops: a companion of a name and a place, its row
   * after Hero's, Hero's walk this turn and a condition on Hero that ends
   * with it. With `ghost`, a hidden row of the DM's after every other.
   */
  const fightOf = (chose: { name: number; x: number; stops: number; label: number }, ghost = false): RoomState => {
    const state = table();
    state.tokens.gob = token("gob", { x: 9, y: 9, actor: { inline: actor({ dmNotes: "" }) } });
    state.encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })], turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 2, y: 2, elevation: 0, seen: true, seq: 7 } };
    if (ghost) {
      state.tokens.ghost = token("ghost", { visibility: "dm", x: 15, y: 15 });
      state.encounter.entries.push(entry("rghost", { tokenId: "ghost", value: 1, hidden: true }));
    }
    const create = hoot() as Extract<Op, { t: "token.create" }>;
    return played(state, [
      { ...create, token: { ...create.token, name: "N".repeat(chose.name), x: chose.x } } as Op,
      { t: "encounter.add", entries: [{ id: "rpet2", tokenId: "pet2", value: 15 }] } as Op,
      ...Array.from({ length: chose.stops }, (_, i) => ({ t: "token.move", tokenId: "hero", x: 2, y: 3 + i }) as Op),
      { t: "actor.effect.add", target: { characterId: "c1" }, effect: { id: "e9", key: "custom", label: "L".repeat(chose.label), duration: { mode: "turnEnd", of: { tokenId: "hero" } } } } as Op,
    ], undefined, 2_300_000);
  };

  test("P1's End Turn, the turn after it and their companion's dismissal move P1's stepped parts alike whatever P1 chose: a name, a place, a walk and a condition (D-261120-060)", () => {
    let [a, b] = [fightOf({ name: 1, x: 3, stops: 1, label: 1 }), fightOf({ name: 60, x: 13, stops: 6, label: 60 })];
    for (const [i, op] of [endTurn("rhero"), endTurn("rpet2"), { t: "token.delete", tokenId: "pet2" } as Op].entries()) {
      const [a1, b1] = [played(a, [op], undefined, 2_400_000 + i), played(b, [op], undefined, 2_400_000 + i)];
      assert.deepEqual(movedBy(a, a1), movedBy(b, b1), op.t);
      [a, b] = [a1, b1];
    }
    assert.equal(b.encounterHistory.length, 2, "the fight kept both steps");
    // From change format 65 the walk ends with its turn, and the turn's step keeps it (D-261120-100).
    assert.equal(b.tokens.hero!.path, undefined, "Hero's walk left with its turn");
    assert.ok(b.encounterHistory[0]!.walks!.find((walk) => walk.tokenId === "hero")!.path.stops.length > 6, "and its step keeps it");
  });

  test("P1's End Turn with a hidden row of the DM's after every other, or none, moves P1's stepped parts alike (D-261120-060)", () => {
    const chose = { name: 4, x: 3, stops: 2, label: 4 };
    const [a, b] = [fightOf(chose), fightOf(chose, true)];
    assert.equal(stableStringify(projectState(a, P1, { sceneId: null })), stableStringify(projectState(b, P1, { sceneId: null })), "P1's copies are equal");
    assert.deepEqual(movedBy(a, played(a, [endTurn("rhero")])), movedBy(b, played(b, [endTurn("rhero")])));
  });

  test("on a Per player scene with fog, P1's walk of Hero by a route of 1 bend or 19 through ground their fog hides, and their End Turn, move P1's stepped parts alike (D-261120-090)", () => {
    const walked = (bends: number) => {
      const state = room({ scenes: { s1: scene("s1", { fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } }), s2: scene("s2", { order: 1 }) } });
      state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ speeds: { walk: 300 } }) });
      state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
      state.tokens.gob = token("gob", { x: 25, y: 20 });
      state.encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })], turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 2, y: 2, elevation: 0, seq: 7 } };
      const route = [...Array.from({ length: bends }, (_, i) => [2 + ((i + 1) * 20) / (bends + 1), i % 2 === 0 ? 6 : 2, 0, 0]), [22, 2, 0, 0]].map(([x, y, e, s]) => [Math.round(x! * 2) / 2, y, e, s]);
      const move = { t: "token.move", tokenId: "hero", x: 22, y: 2, route } as Op;
      assert.ok(canApply(move, P1, state, DEPS).ok, `P1 may walk Hero by ${bends} bends`);
      const moved = played(state, [move], undefined, 2_800_000);
      const ended = played(moved, [endTurn("rhero")], undefined, 2_800_001);
      const bendsOf = (s: RoomState) => sum(s.tokens.hero!.path!.stops, (stop) => (stop.via?.length ?? 0) / 2);
      return { stored: bendsOf(moved), held: (seatView(moved, "p1").copy("token", "hero") as Token).path!.stops.some((stop) => stop.via !== undefined), moves: [movedBy(state, moved), movedBy(moved, ended)] };
    };
    const [one, many] = [walked(1), walked(19)];
    assert.ok(one.stored >= 1 && many.stored >= 19 && !many.held, `${one.stored} and ${many.stored} bends stored, none in P1's copy`);
    assert.deepEqual(many.moves, one.moves);
    // The same walk past its turn, kept from before change format 65, with 1 bend or 40 off P1's ground: P1's copies and
    // exact parts are equal, and the stepped parts hold the walk at its stored bytes until a turn's end takes it off.
    const kept = (corners: number) => {
      const state = room({ scenes: { s1: scene("s1", { fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } }), s2: scene("s2", { order: 1 }) } });
      state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor() });
      const via = Array.from({ length: corners }, (_, i) => [3 + i * 0.5, 4]).flat();
      state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 22, y: 2, path: { turn: 7, stops: [{ x: 2, y: 2, elevation: 0 }, { x: 22, y: 2, elevation: 0, via, moved: 100, cost: 100 }] } });
      return state;
    };
    const [a, b] = [kept(1), kept(40)];
    assert.equal(stableStringify(projectState(a, P1, { sceneId: null })), stableStringify(projectState(b, P1, { sceneId: null })), "P1's copies are equal");
    assert.deepEqual(Object.fromEntries([...exactCopies(b, "p1")].map(([key, part]) => [key, part.shown])), Object.fromEntries([...exactCopies(a, "p1")].map(([key, part]) => [key, part.shown])));
    const corners = serializedBytes(b.tokens.hero!.path) - serializedBytes(a.tokens.hero!.path);
    const [sa, sb] = [steppedParts(a), steppedParts(b)];
    assert.deepEqual(Object.fromEntries([...sb].map(([scope, bytes]) => [scope, bytes - (scope === "s2" ? 0 : corners)])), Object.fromEntries(sa));
  });

  test("where players may apply damage, P1's hits on a goblin and on P2's hero, and the DM hiding both, move P1's stepped parts alike whatever P1 chose: the amount, a drop to 0 and the damage types (D-261120-061)", () => {
    const hit = (amount: number, types: string[]) => {
      const state = table();
      state.meta.settings = { ...state.meta.settings, playersApplyDamage: true, monstersDieAtZero: false };
      state.tokens.gob = token("gob", { x: 9, y: 9, actor: { inline: actor({ hp: { cur: 100, max: 100, temp: 50 }, dmNotes: "" }) } });
      state.characters.c2 = character("c2", { ownerIds: ["p2"], actor: actor({ hp: { cur: 100, max: 100, temp: 50 }, notes: "", dmNotes: "" }) });
      state.tokens.bree = token("bree", { kind: "pc", actor: { ref: "c2" }, ownerIds: ["p2"], x: 8, y: 8 });
      const steps: Array<[Op, typeof P1]> = [
        [{ t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount, types } } as Op, P1],
        [{ t: "actor.hp", target: { tokenId: "bree" }, change: { kind: "damage", amount, types } } as Op, P1],
        [{ t: "token.update", tokenId: "gob", patch: { visibility: "dm" } } as Op, DM],
        [{ t: "token.update", tokenId: "bree", patch: { visibility: "dm" } } as Op, DM],
      ];
      const moves: Record<string, number>[] = [];
      let before = state;
      for (const [i, [op, who]] of steps.entries()) {
        if (who === P1) assert.ok(canApply(op, P1, before, DEPS).ok, `P1 may send ${op.t}`);
        const result = applyOp(before, op, who, env(2_500_000 + i));
        assert.ok(result.ok, result.ok ? "" : result.message);
        moves.push(movedBy(before, result.state));
        before = result.state;
      }
      assert.ok(!exactCopies(before, "p1").has(keys.token("gob")) && !exactCopies(before, "p1").has(keys.character("c2")), "both left P1's exact part");
      const gob = before.tokens.gob!.actor;
      return { moves, life: ["inline" in gob ? gob.inline.life : undefined, before.characters.c2!.actor.life] };
    };
    const [light, heavy] = [hit(1, ["fire"]), hit(150, ["bludgeoning", "piercing", "lightning"])];
    assert.deepEqual(heavy.life, ["dying", "dying"], "the heavy hits drop both to 0");
    assert.deepEqual(heavy.moves, light.moves);
  });

  test("where players may apply damage and monsters die at 0, P1's hit that kills a goblin or leaves it, and one hit or two on P2's hero, read alike once the DM hides both (D-261120-061)", () => {
    const hits = (ops: Array<[string, number]>) => {
      const state = table();
      state.meta.settings = { ...state.meta.settings, playersApplyDamage: true, monstersDieAtZero: true };
      state.tokens.gob = token("gob", { x: 9, y: 9, actor: { inline: actor({ hp: { cur: 20, max: 20, temp: 0 }, dmNotes: "" }) } });
      state.characters.c2 = character("c2", { ownerIds: ["p2"], rev: 8, actor: actor({ hp: { cur: 100, max: 100, temp: 0 }, notes: "", dmNotes: "" }) });
      state.tokens.bree = token("bree", { kind: "pc", actor: { ref: "c2" }, ownerIds: ["p2"], x: 8, y: 8 });
      let after = state;
      for (const [i, [tokenId, amount]] of ops.entries()) {
        const op = { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount } } as Op;
        assert.ok(canApply(op, P1, after, DEPS).ok, `P1 may hit ${tokenId}`);
        const result = applyOp(after, op, P1, env(2_600_000 + i));
        assert.ok(result.ok, result.ok ? "" : result.message);
        after = result.state;
      }
      for (const [i, tokenId] of ["gob", "bree"].entries()) {
        const result = applyOp(after, { t: "token.update", tokenId, patch: { visibility: "dm" } } as Op, DM, env(2_700_000 + i));
        assert.ok(result.ok, result.ok ? "" : result.message);
        after = result.state;
      }
      const gob = after.tokens.gob!.actor;
      return { moved: movedBy(state, after), life: "inline" in gob ? gob.inline.life : undefined, rev: after.characters.c2!.rev };
    };
    const [left, killed] = [hits([["gob", 5], ["bree", 10]]), hits([["gob", 30], ["bree", 5], ["bree", 5]])];
    assert.deepEqual([left.life, killed.life, left.rev, killed.rev], ["alive", "dead", 9, 10], "the goblin's life and the hero's rev come apart");
    assert.deepEqual(killed.moved, left.moved);
  });

  test("a fight's history kept to its bound and a turn start at its widest read as none of either, in the room's reading and each scene's (D-261120-060)", () => {
    const fight = (full: boolean): RoomState => {
      const state = table();
      const encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero", value: 20 })] };
      state.encounter = encounter;
      if (!full) return state;
      let history: EncounterSnapshot[] = [];
      for (let i = 0; i < 20; i++) history = keptHistory(history, { encounter: { ...encounter, entries: [entry(`r${i}`, { label: "x".repeat(52_000) })] }, effects: {}, revealed: [], at: "2026-10-12T20:00:00.000Z" });
      state.encounterHistory = history;
      const widest = "\u0001".repeat(64);
      const n = -1.2345678901234567e-300;
      state.encounter = { ...encounter, turnStart: { entryId: widest, tokenId: widest, sceneId: "s1", x: n, y: n, elevation: n, seen: true, seenBy: ["p1"], seq: Number.MAX_SAFE_INTEGER, mounts: Array.from({ length: LIMITS.turnMounts }, () => widest) } };
      return state;
    };
    const full = fight(true);
    assert.equal(full.encounterHistory.length, 20, "the history keeps 20 steps");
    assert.ok(serializedBytes(full.encounterHistory) > 1_040_000, "near its bound");
    assert.deepEqual(Object.fromEntries(steppedParts(full)), Object.fromEntries(steppedParts(fight(false))));
  });

  /**
   * A floors room (docs/design/design-v1-floors.md phase 4) for P1's own
   * falls, drops, flights and climbs: the tower's opening from Upper floor
   * down to Ground floor, its stairs, a trapdoor upstairs that stops a
   * walker or lets it on, and by the seed P1's area and companion on Thorn,
   * a hidden owl on Thorn, a hidden goblin on the trapdoor, the DM's cards,
   * Thorn's turn, Players move any token, and Upper floor reached or not.
   * One DM op settles the floors' marks, as every live room has them.
   */
  const floorsRoom = (r: () => number): RoomState => {
    let s = withStairs(withOpening(floorsTower()));
    s.traps = { td1: trapdoor("td1", { zone: { cells: [{ x: 10, y: 6, w: 2, h: 2 }] }, rig: { ...trapdoor().rig!, stops: r() < 0.5, foundOnSpring: false } }) };
    s.tokens.thorn = { ...s.tokens.thorn!, sceneId: r() < 0.7 ? UPPER : GROUND, x: [4, 8, 3][Math.floor(r() * 3)]!, y: 6 };
    const th = s.tokens.thorn;
    if (r() < 0.5) s.templates.aura = template("aura", { sceneId: th.sceneId, ownerId: "p1", attachedTo: "thorn", label: "Aura of Protection", rev: 9 });
    if (r() < 0.4) s.tokens.pet = token("pet", { name: "Hoot", size: "tiny", ownerIds: ["p1"], sceneId: th.sceneId, x: th.x, y: th.y, rev: 9, attached: { to: "thorn", kind: "perch" } });
    if (r() < 0.5) s.tokens.owl = token("owl", { kind: "pc", size: "tiny", visibility: "dm", sceneId: th.sceneId, x: th.x, y: th.y, rev: 9, attached: { to: "thorn", kind: "perch" } });
    if (r() < 0.5) s.tokens.gob = token("gob", { visibility: "dm", sceneId: UPPER, x: 11, y: 7, rev: 99 });
    if (r() < 0.5) s = withFalls(s, ...Array.from({ length: Math.floor(r() * 11) }, (_, i) => fallCard({ id: `${40 + i}:0`, made: 40 + i, tokenId: `gone${i}` })));
    if (r() < 0.3) s.meta = { ...s.meta, settings: { ...s.meta.settings, playersMoveAny: "all" } };
    if (r() < 0.4) s.encounter = { rev: 9, round: 1, activeEntryId: "rthorn", entries: [entry("rthorn", { tokenId: "thorn" })], turnStart: { entryId: "rthorn", tokenId: "thorn", sceneId: th.sceneId, x: th.x, y: th.y, elevation: 0, seen: true, seq: 7 } };
    const settled = applyOp(s, { t: "token.create", token: { id: "pad", sceneId: "s2", kind: "npc", layer: "token", name: "Pad", size: "medium", x: 1, y: 1, visibility: "dm", ownerIds: [], actor: { inline: actor() } } } as Op, DM, env(2_900_000));
    assert.ok(settled.ok, settled.ok ? "" : settled.message);
    return r() < 0.5 ? settled.state : { ...settled.state, openFloors: { [GROUND]: { sceneId: GROUND, rev: 1 } } };
  };

  test("floors rooms: P1's falls, drops, flights and climbs, with their undo and redo, move P1's stepped parts only by hidden things they took away", () => {
    const apart: string[] = [];
    const accepted: string[] = [];
    const seen = { fall: 0, drop: 0, flight: 0, climb: 0, undo: 0, redo: 0 };
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(seed * 17 + 3);
      const table = new UndoTable(floorsRoom(r));
      table.seq = 3_000_000 + seed * 100;
      let undone = false;
      for (let k = 0; k < 8; k++) {
        const before = table.state;
        const th = before.tokens.thorn;
        if (!th) break;
        const ops: Op[] = [
          { t: "token.move", tokenId: "thorn", x: 6, y: 6 },
          { t: "token.move", tokenId: "thorn", x: 13, y: 6, route: [[th.x, th.y, 0, 0], [10, 6, 0, 0], [13, 6, 0, 0]] } as Op,
          { t: "token.move", tokenId: "thorn", x: 10, y: 6 },
          { t: "token.move", tokenId: "thorn", x: 6, y: 6, elevation: 10 },
          { t: "token.climb", tokenId: "thorn", linkId: th.sceneId === UPPER ? "o1" : "o2" },
          { t: "token.climb", tokenId: "thorn", linkId: th.sceneId === GROUND ? "l1" : "l2" },
          { t: "token.move", tokenId: "thorn", x: 3, y: 3 },
          { t: "log.chat", text: "Mind the hole" },
        ];
        const hovering = th.x === 6 && th.y === 6 && th.elevation > 0;
        const roll = r();
        // An undo now and then, and its redo often after it.
        const step: "undo" | "redo" | Op = undone && roll < 0.5 ? "redo" : roll < 0.15 ? "undo" : hovering && r() < 0.7 ? ops[4]! : ops[Math.floor(r() * ops.length)]!;
        const answer: string = step === "undo" ? table.undo(P1) : step === "redo" ? table.redo(P1) : table.play(P1, step);
        undone = step === "undo" && answer === "ok";
        if (answer !== "ok") continue;
        const after = table.state;
        const card = Object.keys(after.falls ?? {}).some((id) => before.falls?.[id] === undefined);
        if (typeof step === "string") seen[step]++;
        else if (step.t === "token.climb" && after.tokens.thorn?.sceneId !== th.sceneId) seen[step.linkId.startsWith("o") ? "flight" : "climb"]++;
        else if (card) seen[after.tokens.thorn?.sceneId !== th.sceneId && step.t === "token.move" && step.x === 6 ? "fall" : "drop"]++;
        for (const stray of strays(before, after, accepted)) apart.push(`${typeof step === "string" ? step : step.t} (seed ${seed}): ${stray}`);
      }
    }
    assert.deepEqual(apart.slice(0, 10), [], `${apart.length} moved P1's stepped part`);
    assert.ok(Object.values(seen).every((n) => n >= 5), JSON.stringify(seen));
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

describe("LP44-PATH-TRIM: a walk ends with its turn (D-261120-100)", () => {
  /**
   * The DM's wolf on its own turn, which P1 walks under Players move any
   * token to 9,12 by 1 leg or by 6, the stops P1's choice and every one in
   * P1's sight.
   */
  const wolfWalked = (legs: 1 | 6): RoomState => {
    let state = table();
    state.meta.settings = { ...state.meta.settings, playersMoveAny: "all" };
    state.tokens.wolf = token("wolf", { x: 9, y: 9, actor: { inline: actor({ dmNotes: "" }) } });
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "rwolf",
      entries: [entry("rwolf", { tokenId: "wolf", value: 20 }), entry("rhero", { tokenId: "hero", value: 5 })],
      turnStart: { entryId: "rwolf", tokenId: "wolf", sceneId: "s1", x: 9, y: 9, elevation: 0, seen: true, seq: 7 },
    };
    const route = legs === 1 ? [[9, 12]] : [[10, 9], [11, 10], [11, 11], [10, 12], [10, 13], [9, 12]];
    route.forEach(([x, y], i) => {
      const op = { t: "token.move", tokenId: "wolf", x, y } as Op;
      assert.ok(canApply(op, P1, state, DEPS).ok, `P1 may walk the wolf to ${x},${y}`);
      const result = applyOp(state, op, P1, env(2_900_000 + i));
      assert.ok(result.ok, result.ok ? "" : result.message);
      state = result.state;
    });
    assert.equal(state.tokens.wolf!.path?.stops.length, legs + 1, `the wolf's walk holds ${legs + 1} stops`);
    return state;
  };

  /** What P1 reads of a room: their copy, their exact part as it counts, and their stepped parts. */
  const reading = (state: RoomState) => ({
    copy: stableStringify(projectState(state, P1, { sceneId: null })),
    exact: Object.fromEntries([...exactCopies(state, "p1")].map(([key, part]) => [key, part.shown])),
    stepped: Object.fromEntries(steppedParts(state)),
  });

  test("P1's walk of the DM's wolf by 1 leg or 6 on its turn: P1's exact parts and stepped parts are equal, the walk in the pool", () => {
    const [a, b] = [wolfWalked(1), wolfWalked(6)];
    assert.deepEqual(reading(b).exact, reading(a).exact);
    assert.deepEqual(reading(b).stepped, reading(a).stepped);
  });

  const ends: [string, Op][] = [
    ["the DM's Next", { t: "encounter.next" } as Op],
    ["the fight's end", { t: "encounter.end" } as Op],
    ["the removal of the wolf's row", { t: "encounter.remove", entryIds: ["rwolf"] } as Op],
  ];
  for (const [name, op] of ends) {
    test(`P1's walk of the DM's wolf by 1 leg or 6 on its turn, then ${name}: P1's copies, exact parts and stepped parts are equal`, () => {
      const [a, b] = [wolfWalked(1), wolfWalked(6)].map((state) => {
        const result = applyOp(state, op, DM, env(2_950_000));
        assert.ok(result.ok, result.ok ? "" : result.message);
        return result.state;
      });
      assert.equal(b!.tokens.wolf!.path, undefined, "the turn's end took the walk off");
      assert.deepEqual(reading(b!), reading(a!));
    });
  }
});

/*
 * Design 1.6, taken past the line (D-261121-121, 129, 130): a player's
 * moves, walks, climbs and getting on and off grow nothing their reading
 * counts, so past the room's line itself each is taken as on main. Their
 * End Turn writes the turn's line, which the line itself still has room
 * for inside the bookkeeping reserve, where creates stop.
 */
describe("taken past the line", () => {
  /** `ops` in turn on `state` parked `offset` from the room's line, each P1's answer. */
  const answers = (state: RoomState, ops: readonly Op[], offset: number) => {
    const [parkedState] = [structuredClone(state)];
    parked([parkedState], "room", Object.values(parkedState.tokens).find((t) => t.ownerIds.includes("p1"))!.sceneId, offset);
    let now = parkedState;
    return ops.map((op, i) => {
      const a = farAnswer(now, op, P1, 3_100_000 + i);
      if (a.next) now = a.next;
      return `${op.t}: ${a.said}`;
    });
  };
  const past = FAR.byteStep / 2;
  const insideReserve = -BOOKKEEPING_RESERVE.room / 2;
  /** Pip's turn on the warhorse it steers, named 7, P1's. */
  const ride = (): RoomState => {
    const state = room({
      tokens: {
        pip: token("pip", { name: "Pip", kind: "pc", size: "small", ownerIds: ["p1"], x: 4, y: 4, elevation: 5, attached: { to: "horse", kind: "ride", steer: true } }),
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
        gob: token("gob", { x: 9, y: 9, actor: { inline: actor({ dmNotes: "" }) } }),
      },
    });
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "rpip",
      entries: [entry("rpip", { tokenId: "pip", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })],
      turnStart: { entryId: "rpip", tokenId: "pip", sceneId: "s1", x: 4, y: 4, elevation: 0, seen: true, seq: 7, mounts: ["horse"] },
    };
    return state;
  };
  const taken = (ops: readonly Op[]) => ops.map((op) => `${op.t}: taken`);

  test("an own walk on its own turn, to two-digit squares, and an elevation change from 5 to 10", () => {
    const state = ride();
    state.tokens.pip = { ...state.tokens.pip!, attached: undefined, elevation: 5 };
    state.encounter = { ...state.encounter!, turnStart: { ...state.encounter!.turnStart!, mounts: undefined } };
    const ops: Op[] = [
      { t: "token.move", tokenId: "pip", x: 6, y: 4 },
      { t: "token.move", tokenId: "pip", x: 8, y: 6 },
      { t: "token.move", tokenId: "pip", x: 12, y: 10, elevation: 10 },
    ];
    assert.deepEqual(answers(state, ops, past), taken(ops));
    // Off its turn too: a move to two-digit squares.
    const off = structuredClone(state);
    off.encounter = null;
    assert.deepEqual(answers(off, [{ t: "token.move", tokenId: "pip", x: 14, y: 12 }], past), ["token.move: taken"]);
  });

  test("under Players move any token, the DM's goblin moved from x 9 to 10, and climbed", () => {
    const state = withStairs(tower());
    state.meta.settings = { ...state.meta.settings, playersMoveAny: "all" };
    state.tokens.gob = token("gob", { sceneId: GROUND, x: 9, y: 3, actor: { inline: actor({ dmNotes: "" }) } });
    const ops: Op[] = [{ t: "token.move", tokenId: "gob", x: 10, y: 3 }, { t: "token.move", tokenId: "gob", x: 3, y: 3 }, { t: "token.climb", tokenId: "gob", linkId: "l1" } as Op];
    assert.deepEqual(answers(state, ops, past), taken(ops));
  });

  test("a climb with an area on the climber, between floor ids of 2 characters and of 40", () => {
    const long = "u".repeat(40);
    const state = tower();
    state.scenes[long] = { ...state.scenes[UPPER]!, id: long };
    delete state.scenes[UPPER];
    const linked = withStairs(state, { to: long });
    linked.templates.aura = template("aura", { sceneId: GROUND, ownerId: "p1", attachedTo: "thorn", label: "Aura" });
    const up: Op = { t: "token.climb", tokenId: "thorn", linkId: "l1" } as Op;
    assert.deepEqual(answers(linked, [up], past), ["token.climb: taken"]);
  });

  test("a dismount, and a mount, dismount and remount on one turn", () => {
    const ops: Op[] = [
      { t: "token.move", tokenId: "horse", x: 8, y: 4 },
      { t: "token.detach", tokenId: "pip", x: 10, y: 4 },
      { t: "token.attach", tokenId: "pip", to: "horse", kind: "ride", steer: true, x: 8, y: 4, elevation: 0 },
      { t: "token.move", tokenId: "horse", x: 8, y: 9 },
      { t: "token.detach", tokenId: "pip", x: 10, y: 9 },
    ] as Op[];
    assert.deepEqual(answers(ride(), ops, past), taken(ops));
  });

  test("End Turn onto a creature a hidden mount joins, inside the bookkeeping reserve, as a create there is refused", () => {
    const state = ride();
    state.tokens.rider = token("rider", { x: 12, y: 12, visibility: "dm", attached: { to: "steed", kind: "ride", steer: true } });
    state.tokens.steed = token("steed", { x: 12, y: 12, size: "large", visibility: "dm" });
    state.encounter = { ...state.encounter!, entries: [entry("rpip", { tokenId: "pip", value: 20 }), entry("rrider", { tokenId: "rider", value: 10, hidden: true }), entry("rgob", { tokenId: "gob", value: 5 })] };
    const end: Op = { t: "encounter.next", from: { entry: "rpip", round: 1 } } as Op;
    const create: Op = { t: "drawing.create", drawing: { id: "d-in", sceneId: "s1", kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op;
    const said = answers(state, [end, create], insideReserve);
    assert.deepEqual(said, ["encounter.next: taken", `drawing.create: quota: ${ROOM_FULL}`]);
  });
});
