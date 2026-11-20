import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp, type DiceOp } from "#shared/dice/resolve.ts";
import { FAR_TREATMENT } from "#shared/farLine.ts";
import { readEntity, type EntityKey } from "#shared/keys.ts";
import { serializedBytes } from "#shared/limits.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import type { Op, OpType } from "#shared/protocol.ts";
import { seatView } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { actor, character, drawing, entry, env, P1, randomDiceRoll, randomOp, randomState, rng, room, template, token } from "#shared/testutil.ts";
import { exactCopies, farWidths, measuredStateBytes, ownHeldBytes, projectedSceneBytes } from "./sizeGuard.ts";

/*
 * LP44-PRIV-1 (D-261116-026, D-261119-003): a player's own op never moves
 * their stepped part. Everything it writes is in their exact part
 * (sizeGuard.ts exactCopies), each own-written field past their copy at its
 * width (OWN_WRITTEN), so the stepped part keeps only what their copy hides
 * and their ops never write. Each op kind a player may send is checked here
 * on random rooms and a fixed one: their stepped parts, the room's and each
 * scene's, move only by hidden things the op took away, never by a byte it
 * added. The turn's end, which writes the DM's history and every row's
 * marks, a change of what their copy holds (sight), the stops their copy
 * leaves out of a walk under Players move any token, and a hidden thing
 * carried into the room-level part, which other scenes' parts hold too,
 * are the exceptions, all accepted (D-261119-003).
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
 * The one accepted way a player's own op adds hidden bytes (D-261119-003):
 * a walk of a creature they move but do not own, under Players move any
 * token, keeps the stops players could not see, which their copy leaves out.
 * These are those stops' bytes: each stored stop P1's copy does not hold,
 * matched in order by place. Every other field of the walk counts at its width.
 */
function unseenStopBytes(state: RoomState, key: string): number {
  if (!key.startsWith("token:")) return 0;
  const id = key.slice("token:".length);
  const stored = state.tokens[id];
  if (stored === undefined || stored.ownerIds.includes("p1")) return 0;
  const held = (seatView(state, "p1").copy("token", id) as Token | null)?.path?.stops ?? [];
  let next = 0;
  let bytes = 0;
  for (const stop of stored.path?.stops ?? []) {
    const kept = held[next];
    if (kept !== undefined && kept.x === stop.x && kept.y === stop.y && kept.elevation === stop.elevation) next++;
    else bytes += serializedBytes(stop) + 1;
  }
  return bytes;
}

/**
 * What of P1's op moved their stepped parts other than hidden things it took
 * away or carried from one thing to another: hidden bytes it added on the
 * whole, or bytes it wrote outside their exact part. A hidden thing carried
 * from a floor into the room-level part, such as a condition the DM hid that
 * an HP change ended into its line, joins every other scene's part, which
 * holds the room-level part too (D-261119-003, accepted). With `still`, the
 * op takes nothing hidden away, so each part moves by that alone.
 */
function strays(before: RoomState, after: RoomState, accepted: string[] = [], still = false): string[] {
  const was = exactCopies(before, "p1");
  const is = exactCopies(after, "p1");
  const out: string[] = [];
  const moved = new Map<string, { hidden: number; accepted: number }>();
  for (const key of new Set([...was.keys(), ...is.keys()])) {
    const gain = (is.get(key)?.hidden ?? 0) - (was.get(key)?.hidden ?? 0);
    if (gain === 0) continue;
    const on = is.get(key)?.on ?? was.get(key)!.on;
    const at = moved.get(on) ?? { hidden: 0, accepted: 0 };
    const unseen = gain > 0 ? Math.min(gain, unseenStopBytes(after, key) - unseenStopBytes(before, key)) : 0;
    if (unseen > 0) accepted.push(`${key} keeps ${unseen} bytes of unseen stops`);
    at.accepted += Math.max(0, unseen);
    at.hidden += gain - Math.max(0, unseen);
    moved.set(on, at);
  }
  const [b, a] = [steppedParts(before), steppedParts(after)];
  const whole = sum([...moved.values()], (bytes) => bytes.hidden);
  for (const [scope, after] of a) {
    const where = scope === "room" ? "the room" : `scene ${scope}`;
    const floors = scope === "room" ? null : new Set(floorsOf(before, scope).map((f) => f.id));
    let hidden = 0;
    let kept = 0;
    for (const [on, bytes] of moved) {
      if (scope !== "room" && on !== "room" && !floors!.has(on)) continue;
      hidden += bytes.hidden;
      kept += bytes.accepted;
    }
    const carried = Math.max(0, Math.min(hidden, hidden - whole));
    if (carried > 0) accepted.push(`${carried} hidden bytes carried into ${where}`);
    if (hidden - carried > 0 || (still && hidden !== carried)) out.push(`${hidden - carried} hidden bytes in ${where}`);
    const outside = after - (b.get(scope) ?? after) - hidden - kept;
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
    assert.ok(accepted.length < checked / 50, `${accepted.length} walks kept unseen stops`);
  });

  /** A room where P1 plays Hero (c1) with a companion, a creature the DM lent them, an area, a line, a row and a door, every rev at 9. */
  function table(): RoomState {
    const state = room();
    state.characters.c1 = character("c1", { ownerIds: ["p1"], rev: 9, actor: actor({ notes: "", dmNotes: "" }) });
    state.tokens.hero = token("hero", { kind: "pc", rev: 9, actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
    state.tokens.pet = token("pet", { rev: 9, companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], x: 3, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
    state.tokens.lent = token("lent", { rev: 9, ownerIds: ["p1"], x: 4, y: 2, actor: { inline: actor({ dmNotes: "" }) } });
    state.templates.a1 = template("a1", { rev: 9 });
    state.drawings.d1 = drawing("d1", { rev: 9 });
    state.members.p1 = { ...state.members.p1!, rev: 9 };
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("rhero", { tokenId: "hero" })] };
    state.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 9, cells: {}, edges: { "3,2,w": { kind: "door", state: "closed", secret: false, discovered: false } } } };
    return state;
  }

  /** A server's dice for a player's ask, each the die's highest face. */
  const rolled = (state: RoomState, op: DiceOp): Op => {
    const resolved = resolveDiceOp(op, state, { draw: (sides) => sides, batch: "AbCdEfGhIjKlMnOp" });
    assert.ok(resolved.ok, resolved.ok ? "" : resolved.message);
    return resolved.op;
  };

  const FIXED: Partial<Record<OpType, { op: (state: RoomState) => Op; room?: (state: RoomState) => void }>> = {
    "member.update": { op: () => ({ t: "member.update", memberId: "p1", name: "Pat the Bold" }) as Op },
    "character.create": { op: () => ({ t: "character.create", character: { id: "c9", name: "Cade", size: "medium", ownerIds: ["p1"], actor: actor({ notes: "A second hero", dmNotes: "" }) } }) as Op },
    "character.update": { op: () => ({ t: "character.update", characterId: "c1", patch: { actor: { notes: "n".repeat(400), sheetUrl: "https://example.com/sheet" } } }) as Op },
    "template.create": { op: () => ({ t: "template.create", template: { id: "a2", sceneId: "s1", shape: "sphere", size: 10, origin: { x: 2.5, y: 2.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "p1", visibility: "all", label: "Bless" } }) as Op },
    "template.update": { op: () => ({ t: "template.update", templateId: "a1", patch: { label: "Spirit Guardians", attachedTo: "hero" } }) as Op },
    "encounter.add": { op: () => ({ t: "encounter.add", entries: [{ id: "rpet", tokenId: "pet" }] }) as Op },
    "encounter.setValue": { op: () => ({ t: "encounter.setValue", entryId: "rhero", value: 100 }) as Op },
    "actor.effect.update": {
      room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, effects: [{ id: "e1", key: "custom", label: "short" }] } }),
      op: () => ({ t: "actor.effect.update", target: { characterId: "c1" }, effectId: "e1", patch: { label: "a much longer label for the effect" } }) as Op,
    },
    "actor.effect.remove": {
      room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, effects: [{ id: "e1", key: "custom", label: "short" }] } }),
      op: () => ({ t: "actor.effect.remove", target: { characterId: "c1" }, effectId: "e1" }) as Op,
    },
    "actor.deathSave": {
      room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, hp: { cur: 0, max: 20, temp: 0 }, life: "dying" } }),
      op: () => ({ t: "actor.deathSave", target: { characterId: "c1" }, ok: 1, fail: 2 }) as Op,
    },
    "actor.deathRoll": {
      room: (s) => (s.characters.c1 = { ...s.characters.c1!, actor: { ...s.characters.c1!.actor, hp: { cur: 0, max: 20, temp: 0 }, life: "dying" } }),
      op: (s) => rolled(s, { t: "actor.deathRoll", tag: "t1", target: { characterId: "c1" } } as DiceOp),
    },
    "dice.roll": { op: (s) => rolled(s, { t: "dice.roll", tag: "t1", to: "all", rolls: [{ formula: "1d20", label: "Bite", creature: { tokenId: "pet" } }] } as DiceOp) },
    "token.moveMany": { op: () => ({ t: "token.moveMany", moves: [{ tokenId: "pet", x: 13, y: 12 }, { tokenId: "lent", x: 14, y: 12 }] }) as Op },
    "token.update": { op: () => ({ t: "token.update", tokenId: "lent", patch: { notes: "A borrowed wolf" } }) as Op },
    "door.set": { op: () => ({ t: "door.set", sceneId: "s1", door: { edge: "3,2,w" }, state: "open", by: "hero" }) as Op },
    // An HP change that drops their companion to 0, ending its concentrations, some hidden from players, into its line.
    "actor.hp": {
      room: (s) => {
        const conc = (id: string, hiddenFromPlayers?: true) => ({ id, key: "concentrating" as const, spell: `${id} `.repeat(60), ...(hiddenFromPlayers ? { hiddenFromPlayers } : {}) });
        const pet = s.tokens.pet!;
        if ("inline" in pet.actor) s.tokens.pet = { ...pet, actor: { inline: { ...pet.actor.inline, effects: [conc("c1"), conc("c2"), conc("c3"), conc("h1", true), conc("h2", true)] } } };
      },
      op: () => ({ t: "actor.hp", target: { tokenId: "pet" }, change: { kind: "damage", amount: 50 } }) as Op,
    },
    // A Long Rest stamps their character by the room's clock.
    "actor.rest": {
      room: (s) => (s.clock = { id: "k1", rev: 0, t: 86_400, shown: true, calendar: { kind: "days" } }),
      op: () => ({ t: "actor.rest", target: { characterId: "c1" }, kind: "long" }) as Op,
    },
    "token.create": { op: () => ({ t: "token.create", token: { id: "pet2", sceneId: "s1", kind: "npc", layer: "token", name: "Hoot", size: "small", x: 1, y: 2, companion: { of: "c1", turn: "own" }, ownerIds: ["p1"], actor: { inline: actor({ hp: { cur: 5, max: 5, temp: 0 }, dmNotes: "" }) } } }) as Op },
    // A player's Undo of their line's delete, as the server builds it from their own history (design 7.7).
    "sys.restore": { op: () => ({ t: "sys.restore", from: "undo", deps: true, entries: [{ key: "drawing:d2", value: drawing("d2", { points: [1, 1, 4, 4, 6, 2] }), expectRev: null }] }) as Op },
  };

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
