import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceOp } from "#shared/dice/resolve.ts";
import { FAR_TREATMENT } from "#shared/farLine.ts";
import { keys, readEntity, type EntityKey } from "#shared/keys.ts";
import { FAR, serializedBytes } from "#shared/limits.ts";
import type { Effect, RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op, OpType } from "#shared/protocol.ts";
import { projectState, seatView, stableStringify } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { memberRing } from "#shared/logRings.ts";
import { floorsOf, ownedBy } from "#shared/rules/floors.ts";
import { actor, character, DM, effect, entry, env, P1, randomDiceRoll, randomOp, randomState, rng, room, scene, template, token } from "#shared/testutil.ts";
import { PLAYER_OPS as FIXED, playerTable as table, rolled } from "./playerOpsTesting.ts";
import { exactCopies, farRoomBytes, farWidths, farWidthsByFloor, measuredStateBytes, ownHeldBytes, projectedSceneBytes, type ExactCopy } from "./sizeGuard.ts";

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
 * residuals the private log tracks (D-261119-019), two of which this test
 * allows: a walk's bytes the copy leaves out, and a creature they do not
 * own, with the lines naming it, coming into or leaving their sight.
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
 * it is a creature P1 does not own, or a line naming one: the sight residual
 * the private log tracks (D-261116-069), whose bytes are the DM's and which
 * P1 sees come or go.
 */
function othersInSight(before: RoomState, after: RoomState, key: string): boolean {
  if (!there(before, key) || !there(after, key)) return false;
  const others = (id: unknown) => typeof id === "string" && before.tokens[id] !== undefined && !ownedBy(before, "p1", before.tokens[id]!);
  if (key.startsWith("token:")) return others(key.slice("token:".length));
  if (!key.startsWith("log:")) return false;
  const data = (readEntity(before, key as EntityKey) as { data?: { tokenId?: unknown; rolls?: { tokenId?: unknown }[] } } | null)?.data;
  return others(data?.tokenId) || (data?.rolls?.some((roll) => others(roll.tokenId)) ?? false);
}

/**
 * The bytes of a walk P1's copy leaves out, of a creature P1 may move but
 * does not own, off the turn their copy shows: the move-any residual the
 * private log tracks (D-261120-003), which stays in the stepped part.
 */
function walkUnseen(state: RoomState, key: string): number {
  if (!key.startsWith("token:")) return 0;
  const id = key.slice("token:".length);
  const stored = state.tokens[id];
  if (stored?.path === undefined || stored.ownerIds.includes("p1")) return 0;
  const copy = seatView(state, "p1").copy("token", id) as Token | null;
  return serializedBytes({ path: stored.path }) - serializedBytes(copy?.path === undefined ? {} : { path: copy.path });
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
  const sighted = new Map<string, number>();
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    if (was.has(key) !== is.has(key) && othersInSight(before, after, key)) {
      // What it takes out of the stepped part: its bytes and, for a creature, its fields' widths (farWidthsByFloor).
      const taken = (copies: ReadonlyMap<EntityKey, ExactCopy>, state: RoomState) =>
        (copies.get(key as EntityKey)?.sub ?? 0) + (copies.has(key as EntityKey) ? sum([...farWidthsByFloor(state, (k) => k === key).values()], (bytes) => bytes) : 0);
      const on = (is.get(key) ?? was.get(key))!.on;
      sighted.set(on, (sighted.get(on) ?? 0) + taken(was, before) - taken(is, after));
      accepted.push(`${key} ${is.has(key) ? "came into" : "left"} P1's sight`);
      continue;
    }
    const gain = (is.get(key)?.hidden ?? 0) - (was.get(key)?.hidden ?? 0);
    if (gain === 0) continue;
    const walks = gain > 0 ? Math.max(0, Math.min(gain, walkUnseen(after, key) - walkUnseen(before, key))) : 0;
    if (walks > 0) accepted.push(`${key} keeps ${walks} bytes of its walk P1's copy leaves out`);
    const on = is.get(key)?.on ?? was.get(key)!.on;
    const at = moved.get(on) ?? { hidden: 0, walks: 0 };
    at.hidden += gain - walks;
    at.walks += walks;
    moved.set(on, at);
  }
  const [b, a] = [steppedParts(before), steppedParts(after)];
  const whole = sum([...moved.values()], (bytes) => bytes.hidden);
  for (const [scope, after] of a) {
    const where = scope === "room" ? "the room" : `scene ${scope}`;
    const floors = scope === "room" ? null : new Set(floorsOf(before, scope).map((f) => f.id));
    const holds = (on: string) => scope === "room" || on === "room" || floors!.has(on);
    let hidden = 0;
    let allowed = 0;
    for (const [on, bytes] of moved) {
      if (!holds(on)) continue;
      hidden += bytes.hidden;
      allowed += bytes.walks;
    }
    for (const [on, bytes] of sighted) if (holds(on)) allowed += bytes;
    const carried = Math.max(0, Math.min(hidden, hidden - whole));
    if (carried > 0) accepted.push(`${carried} hidden bytes carried into ${where}`);
    if (hidden - carried > 0 || (still && hidden !== carried)) out.push(`${hidden - carried} hidden bytes in ${where}`);
    const outside = after - (b.get(scope) ?? after) - hidden - allowed;
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
        if (FAR_TREATMENT[op.t] === "deletion" || FAR_TREATMENT[op.t] === "server" || !canApply(op, P1, state, DEPS).ok) continue;
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

  /** P1's ops in order on `state`, each taken, with the same line ids whatever the room holds. */
  const played = (state: RoomState, ops: readonly Op[], check?: (before: RoomState, after: RoomState, op: Op) => void): RoomState => {
    ops.forEach((op, i) => {
      const result = applyOp(state, op, P1, env(2_000_000 + i));
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

  test("P1's climb off the floor their drawing, ask and area stand on, and back, leaves P1's stepped parts as they were", () => {
    const floor = (id: string, level: number) => scene(id, { name: "Tower", order: 0, bounds: { w: 20, h: 20 }, floor: { of: "s1", level, name: `Floor ${level}`, height: 10 } });
    // Thorn, whom the DM hid, so no climb of theirs opens a floor: P1 holds the upper floor only while Thorn stands on it.
    const state = room({
      scenes: { s1: floor("s1", 0), up: floor("up", 1), s2: scene("s2", { order: 1 }) },
      characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ speeds: { walk: 30 } }) }) },
      tokens: { thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "thorn" }, sceneId: "s1", x: 9, y: 9, visibility: "dm" }) },
    });
    const linked = applyOp(state, { t: "floorLink.put", link: { id: "l1", pairId: "l2", sceneId: "s1", to: "up", rect: { x: 9, y: 9, w: 1, h: 1 }, kind: "stairs" } } as Op, DM, env(1_900_000));
    assert.ok(linked.ok, linked.ok ? "" : linked.message);
    const still = (before: RoomState, next: RoomState, op: Op) => assert.deepEqual(strays(before, next, [], true), [], op.t);
    const up = played(linked.state, [{ t: "token.climb", tokenId: "thorn", linkId: "l1" } as Op], still);
    const made = played(
      up,
      [
        { t: "drawing.create", drawing: { id: "d1", sceneId: "up", kind: "free", ownerId: "p1", visibility: "all", style: { stroke: "#ff0000", width: 2, opacity: 1 }, points: Array.from({ length: 400 }, (_, i) => i % 97) } },
        { t: "template.create", template: { id: "a1", sceneId: "up", shape: "sphere", size: 10, origin: { x: 1, y: 1, z: 0 }, yaw: 0, includeOrigin: false, color: "#ff0000", ownerId: "p1", visibility: "all", label: "L".repeat(60) } },
        { t: "cast.ask", cast: { id: "c1", caster: "thorn", sceneId: "up", spell: "S".repeat(60), targets: ["thorn"] } },
      ] as Op[],
      still,
    );
    const theirs = ["drawing:d1", "template:a1", "cast:c1"] as EntityKey[];
    const down = played(made, [{ t: "token.climb", tokenId: "thorn", linkId: "l2" } as Op], still);
    assert.ok(!seatView(down, "p1").holds("up"), "P1 no longer holds the upper floor");
    assert.deepEqual(theirs.filter((key) => !exactCopies(down, "p1").has(key)), [], "their things stay in P1's exact part");
    played(down, [{ t: "token.climb", tokenId: "thorn", linkId: "l1" } as Op], still);
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
