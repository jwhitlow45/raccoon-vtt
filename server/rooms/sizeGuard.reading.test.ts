import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BOOKKEEPING_RESERVE, FAR, farReading, ROOM_FULL, SCENE_FULL } from "#shared/limits.ts";
import { keys } from "#shared/keys.ts";
import type { Effect, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { MAX_LOG } from "#shared/logRings.ts";
import { DM, actor, character, effect, entry, env, P1, rng, room, scene, token, trap } from "#shared/testutil.ts";
import { GROUND, UPPER, tower, withStairs } from "#shared/floorLinksTestutil.ts";
import { farAnswer, hiddenCreatures, knownBy, OMITTED, parked, readingsApart, twinBase, type Past } from "./copyTwinsTesting.ts";
import { scopeFixture } from "./undoScopeTesting.ts";
import { exactCopies, farWidths, growthBound, ownHeldBytes, playerReadings, projectedSceneBytes, SizeGuard } from "./sizeGuard.ts";

/*
 * D-261121-060, 074, 121: past the far line a player's op is refused only
 * when it grew and their reading after, over one membership (what their
 * exact part held before and what the op made that their copy holds), is
 * past the line. Twins apart only in what P1's copy leaves out, parked past
 * a line or within one op under it, must answer alike, except where hidden
 * bytes carried a stepped part across a step in one twin only (residual
 * 1), or where the op's result in P1's own copy differs between them
 * (residual 2), each recorded by name.
 */

const MIB = 1024 * 1024;
let seq = 1_000;

/** P1's answer to `op`, or the DM's op applied as the DM gives it, the near lines out of the way. */
const answer = (state: RoomState, op: Op, who: Viewer = P1) => {
  if (who.role === "dm") {
    const r = applyOp(state, op, who, env(++seq));
    return r.ok ? { said: "taken", next: r.state } : { said: `${r.code}: ${r.message}`, next: null };
  }
  return farAnswer(state, op, who, ++seq);
};

/** A walk of `stops` stops on turn `turn`. */
const walkOf = (turn: number, stops: number) => ({ turn, stops: Array.from({ length: stops }, (_, i) => ({ x: 4 + (i % 5), y: 4 + Math.floor(i / 5), elevation: 0 })) });

/** The hidden creatures every room here holds, which walked on turns gone by in one twin. */
const GHOSTS = 240;

/**
 * Twins' differences beyond OMITTED (copyTwinsTesting.ts) that the turn's
 * end reads: walks a room kept from before change format 65 on hidden
 * creatures, one or more than a step's worth, which a turn's end takes off
 * with growth of P1's own (FLR4-OPUS-13), and the walk of a hidden mount
 * sharing the turn under way (FLR4-SOL-21).
 */
const TURN_OMITTED: Record<string, (s: RoomState) => boolean> = {
  "a hidden creature's walk of a turn gone by": (s) => {
    const t = hiddenCreatures(s).find((c) => c.id !== "mount");
    if (t) s.tokens[t.id] = { ...t, path: walkOf(1, 30) };
    return t !== undefined;
  },
  "hidden creatures' walks of turns gone by, more than a step of them": (s) => {
    for (let i = 0; i < GHOSTS; i++) s.tokens[`ghost-${i}`] = { ...s.tokens[`ghost-${i}`]!, path: walkOf(1 + (i % 4), 50) };
    return true;
  },
  "a hidden mount's walk on the turn under way": (s) => {
    const turn = s.encounter?.turnStart?.seq;
    if (s.tokens.mount && turn !== undefined && s.encounter?.turnStart?.mounts?.includes("mount")) s.tokens.mount = { ...s.tokens.mount, path: walkOf(turn, 50) };
    return s.tokens.mount?.path !== undefined;
  },
};

/** Eight visible conditions on P1's hero that end with its turn, as FLR4-SOL-21's room held. */
const ending = (): Effect[] => Array.from({ length: 8 }, (_, i) => ({ id: `end-${i}`, key: "custom", label: `Ward ${i}`, duration: { remaining: 1, boundary: "turnEnd", anchor: { tokenId: "p1-hero" } } }));

/**
 * twinBase's room with P1's hero in the fight: its row, a token's or (a
 * quarter of the time) its character's alone (FLR4-SOL-20), has the turn
 * in two rooms of three, with a hidden mount riding it and conditions
 * ending with it.
 */
function base(seed: number, r: () => number): RoomState {
  const state = twinBase(seed);
  const sceneId = state.meta.playerSceneId ?? Object.keys(state.scenes)[0]!;
  state.characters["p1-char"] = character("p1-char", { ownerIds: ["p1"], name: "Wren", actor: actor({ effects: ending() }) });
  state.tokens["p1-hero"] = token("p1-hero", { sceneId, kind: "pc", name: "Wren", x: 4, y: 4, actor: { ref: "p1-char" } });
  state.tokens.mount = token("mount", { sceneId, name: "Shadow", x: 4, y: 4, visibility: "dm" });
  for (let i = 0; i < GHOSTS; i++) state.tokens[`ghost-${i}`] = token(`ghost-${i}`, { sceneId, name: "Ghost", x: 20 + (i % 10), y: 20 + Math.floor(i / 10), visibility: "dm" });
  const characterOnly = seed % 4 === 0;
  const row = characterOnly ? entry("p1-row", { characterId: "p1-char" }) : entry("p1-row", { tokenId: "p1-hero" });
  const encounter = state.encounter!;
  const entries = characterOnly ? [row] : [...encounter.entries, row];
  if (characterOnly || r() < 2 / 3) {
    state.encounter = { ...encounter, entries, activeEntryId: "p1-row", turnStart: { entryId: "p1-row", tokenId: "p1-hero", sceneId, x: 4, y: 4, elevation: 0, seq: 5, mounts: ["mount"] } };
    state.tokens["p1-hero"] = { ...state.tokens["p1-hero"]!, path: walkOf(5, 3) };
  } else state.encounter = { ...encounter, entries };
  return state;
}

/** One of P1's ops, or one of the DM's turn changes, at random. */
function nextOp(r: () => number, state: RoomState): { op: Op; who: Viewer } {
  const pick = r();
  const encounter = state.encounter;
  if (pick < 0.1) return { op: { t: "encounter.prev" }, who: DM };
  if (pick < 0.17) return { op: { t: "encounter.next" }, who: DM };
  if (pick < 0.45 && encounter?.activeEntryId) return { op: { t: "encounter.next", from: { entry: encounter.activeEntryId, round: encounter.round } } as Op, who: P1 };
  if (pick < 0.5) return { op: { t: "encounter.next" }, who: P1 };
  if (pick < 0.55) return { op: { t: "encounter.remove", entryIds: ["p1-row"] }, who: P1 };
  if (pick < 0.62) return { op: { t: "drawing.create", drawing: { id: `p1-line-${++seq}`, sceneId: state.tokens["p1-hero"]!.sceneId, kind: "line", points: [1, 1, 3, 3], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op, who: P1 };
  if (pick < 0.67) return { op: { t: "character.update", characterId: "p1-char", patch: { actor: { notes: "w".repeat(Math.floor(r() * 400)) } } } as Op, who: P1 };
  if (pick < 0.82) return { op: { t: "log.chat", text: "c".repeat(1 + Math.floor(r() * 600)) }, who: P1 };
  return { op: { t: "token.move", tokenId: "p1-hero", x: 2 + Math.floor(r() * 9), y: 2 + Math.floor(r() * 9) }, who: P1 };
}

/**
 * Runs `steps` on twins, P1's ops answered and the DM's applied, and
 * returns each difference of P1's answers nothing recorded explains, with
 * the residuals it met and P1's answers by kind.
 */
function runTwins(twins: [RoomState, RoomState], steps: ReadonlyArray<{ op: Op; who: Viewer }> | ((state: RoomState) => { op: Op; who: Viewer } | null), what: string) {
  const failures: string[] = [];
  const recorded = { "own copy": 0, step: 0 };
  const said: string[] = [];
  const list = typeof steps === "function" ? null : steps;
  for (let i = 0; list ? i < list.length : i < 4; i++) {
    const next = list ? list[i]! : (steps as (state: RoomState) => { op: Op; who: Viewer } | null)(twins[0]);
    if (!next) break;
    const { op, who } = next;
    const [a, b] = [answer(twins[0], op, who), answer(twins[1], op, who)];
    if (who.role === "player") said.push(`${op.t}: ${a.said.split(":")[0]}`);
    if (who.role === "player" && b.said !== a.said) said.push(`${op.t}: ${b.said.split(":")[0]}`);
    if (a.said !== b.said) {
      if (who.role === "dm") break;
      const took = (state: RoomState) => applyOp(state, op, who, env(++seq));
      const [ta, tb] = [took(twins[0]), took(twins[1])];
      const why = ta.ok && tb.ok ? readingsApart([twins[0], ta.state], [twins[1], tb.state]) : null;
      if (why) recorded[why]++;
      else failures.push(`${what}, ${op.t}: ${a.said} against ${b.said}`);
      break;
    }
    if (!a.next || !b.next) continue;
    twins = [a.next, b.next];
  }
  return { failures, recorded, said };
}

describe("D-261121-060 and 121: past the far line a player's answer reads their own reading over one membership", () => {
  test("random twins apart only in what P1's copy leaves out, parked past the room's line, a scene's or the room's on sight alone, or within one op under it, answer P1's turn ends, removals, chat and moves alike", (t) => {
    const differences = { ...OMITTED, ...TURN_OMITTED };
    const failures: string[] = [];
    const recorded = { "own copy": 0, step: 0 };
    const said = new Map<string, number>();
    const pairs = new Map<string, number>();
    for (let seed = 1; seed <= 24; seed++) {
      for (const [n, name] of Object.keys(differences).entries()) {
        const r = rng(seed * 7_919 + n);
        const one = base(seed, rng(seed * 7_919));
        // Both twins behind the blackout, or neither: only what it hides differs.
        if (name === "P1's things behind a blackout") one.meta = { ...one.meta, view: { ...one.meta.view, blackout: true } };
        const other = structuredClone(one);
        if (!differences[name]!(other) || knownBy(one, "p1") !== knownBy(other, "p1")) continue;
        const past: Past = (["room", "scene", "sight"] as const)[(seed + n) % 3]!;
        // Past the line, or within one op under it, near the line an exempt op reads or the lower one a create reads.
        const lower = r() < 0.3 ? BOOKKEEPING_RESERVE[past === "scene" ? "scene" : "room"] : 0;
        const offset = (seed % 2 === 0 ? FAR.byteStep / 2 : -2_000) - lower;
        parked([one, other], past, one.tokens["p1-hero"]!.sceneId, offset);
        pairs.set(name, (pairs.get(name) ?? 0) + 1);
        const run = runTwins([one, other], (state) => nextOp(r, state), `seed ${seed} (${past}, ${name})`);
        failures.push(...run.failures);
        recorded["own copy"] += run.recorded["own copy"];
        recorded.step += run.recorded.step;
        for (const kind of run.said) said.set(kind, (said.get(kind) ?? 0) + 1);
      }
    }
    const counts = Object.fromEntries([...said].sort());
    const compared = [...said.values()].reduce((sum, n) => sum + n, 0);
    t.diagnostic(`${compared} answers compared, residuals ${JSON.stringify(recorded)}: ${JSON.stringify(counts)}; twins ${JSON.stringify(Object.fromEntries(pairs))}`);
    assert.deepEqual(failures, []);
    for (const name of Object.keys(differences)) assert.ok((pairs.get(name) ?? 0) >= 4, `${name}: ${pairs.get(name) ?? 0} twins`);
    assert.ok([...said.keys()].some((k) => k.endsWith(": taken")) && [...said.keys()].some((k) => k.endsWith(": quota")), `both answers met: ${JSON.stringify(counts)}`);
    assert.ok(recorded["own copy"] + recorded.step <= compared / 10, `residuals ${JSON.stringify(recorded)} of ${compared}`);
  });
});

/**
 * Named twins of design 1.6, each apart only in what P1's copy leaves out,
 * with the ops that read them: P1's, and the DM's applied to both alike.
 */
type Named = { twins: () => [RoomState, RoomState]; steps: (state: RoomState) => Array<{ op: Op; who: Viewer }>; scene?: (state: RoomState) => string };

/** P1's table with a fight on Hero's turn, the DM's goblin last in it. */
function fightTable(): RoomState {
  const state = room();
  state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ notes: "", dmNotes: "", speeds: { walk: 300 } }) });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "c1" }, ownerIds: ["p1"], x: 2, y: 2 });
  state.tokens.gob = token("gob", { x: 9, y: 9, actor: { inline: actor({ dmNotes: "" }) } });
  state.encounter = { rev: 0, round: 1, activeEntryId: "rhero", entries: [entry("rhero", { tokenId: "hero", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })], turnStart: { entryId: "rhero", tokenId: "hero", sceneId: "s1", x: 2, y: 2, elevation: 0, seen: true, seq: 7 } };
  return state;
}

const endTurn = (entryId: string, round = 1): Op => ({ t: "encounter.next", from: { entry: entryId, round } }) as Op;
const p1 = (op: Op) => ({ op, who: P1 });
const dm = (op: Op) => ({ op, who: DM });
const line = (id: string, sceneId = "s1"): Op => ({ t: "drawing.create", drawing: { id, sceneId, kind: "line", points: [1, 1, 3, 3], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } }) as Op;
const twinOf = (state: RoomState, differ: (s: RoomState) => void): [RoomState, RoomState] => {
  const other = structuredClone(state);
  differ(other);
  return [state, other];
};

const NAMED: Record<string, Named> = {
  "SOL-20: P1's End Turn with a hidden row's walk of a turn gone by in one twin": {
    twins: () => twinOf(fightTable(), (s) => (s.tokens.ghost = token("ghost", { visibility: "dm", x: 15, y: 15, path: walkOf(3, 40) }))),
    steps: () => [p1({ t: "token.move", tokenId: "hero", x: 2, y: 5 }), p1(endTurn("rhero")), p1(line("l1"))],
  },
  "SOL-20, character only: P1's row by their character alone, End Turn": {
    twins: () =>
      twinOf(fightTable(), (s) => (s.tokens.ghost = token("ghost", { visibility: "dm", x: 15, y: 15, path: walkOf(3, 40) }))).map((s) => {
        s.encounter = { ...s.encounter!, entries: [entry("rc1", { characterId: "c1", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })], activeEntryId: "rc1", turnStart: { ...s.encounter!.turnStart!, entryId: "rc1" } };
        return s;
      }) as [RoomState, RoomState],
    steps: () => [p1(endTurn("rc1")), p1(line("l1"))],
  },
  "SOL-21: a hidden mount sharing the turn with a walk in one twin": {
    twins: () => {
      const state = fightTable();
      state.tokens.horse = token("horse", { visibility: "dm", x: 2, y: 2, size: "large" });
      state.encounter = { ...state.encounter!, turnStart: { ...state.encounter!.turnStart!, mounts: ["horse"] } };
      return twinOf(state, (s) => (s.tokens.horse = { ...s.tokens.horse!, path: walkOf(7, 50) }));
    },
    steps: () => [p1({ t: "token.move", tokenId: "hero", x: 3, y: 2 }), p1(endTurn("rhero")), p1(line("l2"))],
  },
  "OPUS-13 of floors: P1's End Turn takes more than a step of hidden walks of turns gone by off in one twin": {
    twins: () =>
      twinOf(fightTable(), (s) => {
        for (let i = 0; i < GHOSTS; i++) s.tokens[`ghost-${i}`] = token(`ghost-${i}`, { visibility: "dm", x: 20 + (i % 10), y: 20 + Math.floor(i / 10), path: walkOf(1 + (i % 4), 50) });
      }),
    steps: () => [p1(endTurn("rhero")), p1(line("l3"))],
  },
  "FABLE-3: P1's torch lit with a hidden creature in the dark, its notes apart": {
    twins: () => {
      const state = fightTable();
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
      state.tokens.lurker = token("lurker", { x: 4, y: 2, visibility: "all", actor: { inline: actor({ dmNotes: "" }) } });
      return twinOf(state, (s) => {
        const lurker = s.tokens.lurker!;
        if ("inline" in lurker.actor) s.tokens.lurker = { ...lurker, actor: { inline: { ...lurker.actor.inline, dmNotes: "d".repeat(9_000) } } };
      });
    },
    steps: () => [p1({ t: "token.update", tokenId: "hero", patch: { light: { bright: 20, dim: 20 } } } as Op), p1(line("l4"))],
  },
  "FABLE-3 without the torch: P1's own create beside a creature in the dark": {
    twins: () => {
      const state = fightTable();
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
      state.tokens.lurker = token("lurker", { x: 4, y: 2, visibility: "all", actor: { inline: actor({ dmNotes: "" }) } });
      return twinOf(state, (s) => {
        const lurker = s.tokens.lurker!;
        if ("inline" in lurker.actor) s.tokens.lurker = { ...lurker, actor: { inline: { ...lurker.actor.inline, dmNotes: "d".repeat(9_000) } } };
      });
    },
    steps: () => [p1(line("l5")), p1({ t: "token.move", tokenId: "hero", x: 3, y: 3 })],
  },
  "a climb onto a floor P1's copy does not hold, its hidden creatures apart": {
    twins: () => {
      const state = withStairs(tower());
      state.tokens.upstairs = token("upstairs", { sceneId: UPPER, x: 9, y: 9, visibility: "dm", notes: "u".repeat(200) });
      return twinOf(state, (s) => (s.tokens.upstairs = { ...s.tokens.upstairs!, notes: "u".repeat(12_000) }));
    },
    steps: () => [p1({ t: "token.climb", tokenId: "thorn", linkId: "l1" } as Op), p1(line("l6", UPPER))],
    scene: () => GROUND,
  },
  "a creature taken out of P1's view by their own move, its hidden notes apart": {
    twins: () => {
      const state = fightTable();
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
      state.tokens.hero = { ...state.tokens.hero!, light: { bright: 20, dim: 20 } };
      state.tokens.gob = { ...state.tokens.gob!, x: 4, y: 3 };
      return twinOf(state, (s) => {
        const gob = s.tokens.gob!;
        if ("inline" in gob.actor) s.tokens.gob = { ...gob, actor: { inline: { ...gob.actor.inline, dmNotes: "g".repeat(6_000) } } };
      });
    },
    steps: () => [p1({ t: "token.move", tokenId: "hero", x: 28, y: 28 }), p1(line("l7"))],
  },
  "P1's create and delete, the DM's hidden notes apart": {
    twins: () => twinOf(fightTable(), (s) => (s.tokens.hidden = token("hidden", { visibility: "dm", x: 30, y: 30, notes: "h".repeat(20_000) }))),
    steps: () => [p1(line("l8")), p1({ t: "drawing.delete", drawingId: "l8" } as Op), p1(line("l9"))],
  },
  "FABLE-1's pit: P1 walks onto a hidden pit whose name is apart": {
    twins: () => {
      const state = fightTable();
      state.traps = { t1: trap("t1", { sceneId: "s1", zone: { cells: [{ x: 5, y: 2, w: 1, h: 1 }] }, name: "Pit" }) };
      return twinOf(state, (s) => (s.traps!.t1 = { ...s.traps!.t1!, name: "P".repeat(80) }));
    },
    steps: () => [p1({ t: "token.move", tokenId: "hero", x: 5, y: 2 }), p1(line("l10"))],
  },
  "FABLE-2's notes cut: P1 cuts their own notes, the DM's hidden notes apart": {
    twins: () => {
      const state = fightTable();
      state.characters.c1 = { ...state.characters.c1!, actor: { ...state.characters.c1!.actor, notes: "n".repeat(30_000) } };
      return twinOf(state, (s) => (s.tokens.hidden = token("hidden", { visibility: "dm", x: 30, y: 30, notes: "h".repeat(40_000) })));
    },
    steps: () => [p1({ t: "character.update", characterId: "c1", patch: { actor: { notes: "n".repeat(100) } } } as Op), p1(line("l11"))],
  },
  "a hidden mount joining the turn P1's End Turn hands on": {
    twins: () => {
      const state = fightTable();
      state.tokens.rider = token("rider", { x: 9, y: 9, visibility: "dm" });
      state.encounter = { ...state.encounter!, entries: [...state.encounter!.entries, entry("rrider", { tokenId: "rider", value: 10, hidden: true })] };
      state.encounter.entries.sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
      return twinOf(state, (s) => (s.tokens.steed = token("steed", { x: 9, y: 9, visibility: "dm", size: "large" })));
    },
    steps: () => [p1(endTurn("rhero")), p1(line("l12"))],
  },
};

describe("design 1.6's twins, parked past each line and within one op under it", () => {
  for (const [name, named] of Object.entries(NAMED)) {
    test(name, () => {
      const failures: string[] = [];
      const said: string[] = [];
      for (const past of ["room", "scene", "sight"] as const) {
        for (const offset of [FAR.byteStep / 2, -2_000]) {
          const twins = named.twins();
          assert.equal(knownBy(twins[0], "p1"), knownBy(twins[1], "p1"), "P1 holds the twins alike");
          parked(twins, past, named.scene?.(twins[0]) ?? "s1", offset);
          const run = runTwins(twins, named.steps(twins[0]), `${past} at ${offset}`);
          failures.push(...run.failures);
          said.push(...run.said.map((s) => `${past} ${offset > 0 ? "past" : "under"}: ${s}`));
        }
      }
      assert.deepEqual(failures, []);
      assert.ok(said.some((s) => s.includes("past") && s.endsWith("quota")), `a growing op past the line is refused: ${said.join("; ")}`);
    });
  }
});

describe("D-261121-129, 130: the exact part reads only the copy and constants", () => {
  const exactShown = (state: RoomState) => Object.fromEntries([...exactCopies(state, "p1")].map(([key, part]) => [key, part.shown]));

  test("a hidden scene's id of 20 characters or 64: P1's exact parts are equal, and so are their answers parked past the room's line", () => {
    const [a, b] = [20, 64].map((n) => {
      const state = fightTable();
      state.meta.settings = { ...state.meta.settings, playersMoveAny: "all" };
      const id = "h".repeat(n);
      state.scenes[id] = scene(id, { order: 5 });
      state.tokens.lost = token("lost", { sceneId: id, visibility: "dm" });
      return state;
    }) as [RoomState, RoomState];
    assert.deepEqual(exactShown(b), exactShown(a));
    for (const offset of [FAR.byteStep / 2, -2_000]) {
      const twins: [RoomState, RoomState] = [structuredClone(a), structuredClone(b)];
      parked(twins, "room", "s1", offset);
      const run = runTwins(twins, [p1({ t: "token.move", tokenId: "gob", x: 10, y: 9 }), p1({ t: "token.move", tokenId: "hero", x: 12, y: 2 }), p1(line("l13"))], `at ${offset}`);
      assert.deepEqual(run.failures, []);
    }
  });

  test("under apply damage, hidden HP of 7 of 7 or 30000 of 30000 under a label, and a hidden condition or none: P1's exact parts are equal", () => {
    const at = (hp: number, hidden: boolean) => {
      const state = fightTable();
      state.meta.settings = { ...state.meta.settings, playersApplyDamage: true };
      const gob = state.tokens.gob!;
      const effects: Effect[] = hidden ? [effect("e-hid", { key: "poisoned", hiddenFromPlayers: true })] : [];
      if ("inline" in gob.actor) state.tokens.gob = { ...gob, hpVisibility: "label", actor: { inline: { ...gob.actor.inline, hp: { cur: hp, max: hp, temp: 0 }, effects } } };
      return state;
    };
    assert.deepEqual(exactShown(at(30_000, false)), exactShown(at(7, false)));
    assert.deepEqual(exactShown(at(7, true)), exactShown(at(7, false)));
    // P1's damage on the goblin leaves its exact bytes as they were, and the answer is the HP line's, as on main.
    const hit: Op = { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 3 } } as Op;
    for (const hp of [7, 30_000]) {
      const before = at(hp, false);
      const after = applyOp(before, hit, P1, env(++seq));
      assert.ok(after.ok, after.ok ? "" : after.message);
      assert.equal(exactCopies(after.state, "p1").get(keys.token("gob"))!.shown, exactCopies(before, "p1").get(keys.token("gob"))!.shown, `${hp} HP`);
    }
    const twins: [RoomState, RoomState] = [at(7, false), at(30_000, true)];
    parked(twins, "room", "s1", FAR.byteStep / 2);
    const [x, y] = [answer(twins[0], hit), answer(twins[1], hit)];
    assert.equal(x.said, y.said);
    assert.match(x.said, /^quota/, "past the line the HP line grows the log");
  });
});

describe("D-261121-120 and 125: no fight's start or end, and no walk, moves a reading", () => {
  test("a fight started and ended behind a blackout in one twin: P1's answers are equal, and every P1 reading moves by the fight's own few KiB only", () => {
    for (const past of ["room", "scene"] as const) {
      for (const offset of [FAR.byteStep / 2, -2_000]) {
        const state = fightTable();
        state.encounter = null;
        state.meta = { ...state.meta, view: { ...state.meta.view, blackout: true } };
        const twins: [RoomState, RoomState] = [state, structuredClone(state)];
        parked(twins, past, "s1", offset);
        const start: Op = { t: "encounter.start", entries: [{ id: "rgob", tokenId: "gob", value: 20 }, { id: "rhero", tokenId: "hero", value: 10 }] } as Op;
        const started = applyOp(twins[0], start, DM, env(++seq));
        assert.ok(started.ok, started.ok ? "" : started.message);
        const fought: [RoomState, RoomState] = [started.state, twins[1]];
        const apart = (a: RoomState, b: RoomState) => {
          const [ra, rb] = [playerReadings(a, a, "p1"), playerReadings(b, b, "p1")];
          return Math.max(...[...ra.keys()].map((scope) => Math.abs(ra.get(scope)!.after.stepped + ra.get(scope)!.after.exact - (rb.get(scope)?.after.stepped ?? 0) - (rb.get(scope)?.after.exact ?? 0))));
        };
        assert.ok(apart(...fought) < 8 * 1024, `the fight moves a reading by ${apart(...fought)} bytes`);
        const run = runTwins(fought, [p1({ t: "log.chat", text: "in the dark" }), p1(line("l-dark")), p1({ t: "token.move", tokenId: "hero", x: 5, y: 5 })], `${past} at ${offset}`);
        assert.deepEqual(run.failures, []);
        const ended = applyOp(fought[0], { t: "encounter.end" } as Op, DM, env(++seq));
        assert.ok(ended.ok);
        assert.ok(apart(ended.state, fought[1]) < 8 * 1024, `its end leaves ${apart(ended.state, fought[1])} bytes`);
      }
    }
  });

  test("FABLE-3: under Players move any token, P1's torch lit with a creature entering view, within one op under the scene's line, is taken in both twins", () => {
    for (const past of ["room", "scene"] as const) {
      const state = fightTable();
      state.meta.settings = { ...state.meta.settings, playersMoveAny: "all" };
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
      state.tokens.lurker = token("lurker", { x: 4, y: 2, name: "L".repeat(80), visibility: "all", notes: "x".repeat(2_000), actor: { inline: actor({ dmNotes: "" }) } });
      const twins = twinOf(state, (s) => {
        const lurker = s.tokens.lurker!;
        if ("inline" in lurker.actor) s.tokens.lurker = { ...lurker, actor: { inline: { ...lurker.actor.inline, dmNotes: "d".repeat(9_000) } } };
      });
      // A light is no exempt kind, so it reads the line less the bookkeeping reserve.
      parked(twins, past, "s1", -BOOKKEEPING_RESERVE[past] - 1_000);
      const torch: Op = { t: "token.update", tokenId: "hero", patch: { light: { bright: 20, dim: 20 } } } as Op;
      const [a, b] = [answer(twins[0], torch), answer(twins[1], torch)];
      assert.ok(a.next, a.said);
      assert.ok(exactCopies(a.next, "p1").has(keys.token("lurker")) && !exactCopies(twins[0], "p1").has(keys.token("lurker")), "the lurker came into P1's copy");
      assert.deepEqual([a.said, b.said], ["taken", "taken"], past);
    }
  });
});

describe("LP44O-FABLE-1: a chat line that drops a shared line with hidden bytes", () => {
  test("P1's chat line that drops the oldest shared line, an HP line on a goblin whose numbers P1 does not read, answers alike whatever its hidden maximum, past P1's scene's line", () => {
    const f = scopeFixture();
    const p1v: Viewer = { memberId: f.player.id, role: "player" };
    for (let i = 0; i * 4_000 < FAR.sceneBytes; i++) f.state.tokens[`n${i}`] = token(`n${i}`, { sceneId: f.sceneId, visibility: "dm", notes: "n".repeat(4_000) });
    const [plain, wide] = [30, 30_000].map((max) => {
      let state = structuredClone(f.state);
      const goblin = state.tokens[f.goblin]!;
      if (!("inline" in goblin.actor)) assert.fail("an inline goblin");
      state.tokens[f.goblin] = { ...goblin, hpVisibility: "hidden", actor: { inline: { ...goblin.actor.inline, hp: { cur: max, max, temp: 0 } } } };
      const ops: Op[] = [{ t: "actor.hp", target: { tokenId: f.goblin }, change: { kind: "damage", amount: 3 } } as Op];
      for (let i = 1; i < MAX_LOG; i++) ops.push({ t: "log.chat", text: `Onward ${i}` });
      for (const [i, op] of ops.entries()) {
        const r = applyOp(state, op, { memberId: f.dm.id, role: "dm" }, env(100 + i));
        assert.ok(r.ok, r.ok ? "" : r.message);
        state = r.state;
      }
      return state;
    }) as [RoomState, RoomState];
    assert.equal(knownBy(wide, f.player.id), knownBy(plain, f.player.id), "the twins look alike to P1");
    assert.equal(plain.log[0]?.kind, "event", "the HP line is the shared ring's oldest");
    const chat = (n: number): Op => ({ t: "log.chat", text: "c".repeat(n) });
    // P1's scene's whole measure with the far line's widths, unrounded: what the scene's comparison read before the rule.
    const raw = (state: RoomState) => projectedSceneBytes(state, f.sceneId) + farWidths(state, new Set([f.sceneId]));
    const grows = (state: RoomState, op: Op) => {
      const r = applyOp(state, op, p1v, env(1_000));
      assert.ok(r.ok);
      return raw(r.state) - raw(state);
    };
    // Every length where the raw comparison splits them: the wider maximum's longer line, dropped, outweighs P1's line in
    // that twin alone.
    const split = Array.from({ length: 600 }, (_, i) => i + 1).filter((n) => grows(plain, chat(n)) > 0 && grows(wide, chat(n)) <= 0);
    assert.ok(split.length >= 8, `lengths the raw comparison splits: ${split.join(", ")}`);
    for (const n of split) {
      seq = 999;
      const said = answer(plain, chat(n), p1v).said;
      seq = 999;
      assert.equal(answer(wide, chat(n), p1v).said, said, `a line of ${n} characters`);
    }
  });
});

describe("D-261121-073 and 075: what hidden bytes may still decide, and no stored bound", () => {
  /** The fixture with P1's scene `past` its line by the DM's hidden notes, or the room past its own by notes on scenes of their own. */
  const pastTheLine = (where: "scene" | "room", extra = 0) => {
    const f = scopeFixture();
    const per = 4_000;
    for (let i = 0; i * per < (where === "scene" ? FAR.sceneBytes : FAR.roomBytes) + extra; i++) {
      const sceneId = where === "scene" ? f.sceneId : `fill${Math.floor(i / 100)}`;
      if (where === "room") f.state.scenes[sceneId] ??= scene(sceneId, { order: 10 + Math.floor(i / 100) });
      f.state.tokens[`n${i}`] = token(`n${i}`, { sceneId, visibility: "dm", notes: "n".repeat(per) });
    }
    return f;
  };

  test("hidden bytes an op of P1's adds past the scene's line are taken while the stepped part stays within its step, and refused once they carry it across", () => {
    const f = pastTheLine("scene");
    const before = f.state;
    const held = ownHeldBytes(before, f.player.id, [f.sceneId]);
    const stepped = projectedSceneBytes(before, f.sceneId) + farWidths(before, new Set([f.sceneId])) - held.sub;
    const left = Math.ceil(stepped / FAR.byteStep) * FAR.byteStep - stepped;
    assert.ok(left > 200, `${left} bytes left in the step`);
    // What the op adds, as the DM's hidden note on a creature: the guard reads only the room before and after.
    const grown = (bytes: number): RoomState => ({ ...before, tokens: { ...before.tokens, n0: { ...before.tokens.n0!, notes: `${before.tokens.n0!.notes}${"m".repeat(bytes)}` } } });
    const said = (next: RoomState) => new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB }).check(next, [f.sceneId], growthBound(before, next, ["token:n0" as never]), before, "player", "widest", true, f.player.id);
    assert.deepEqual(said(grown(left - 100)), { ok: true }, "within the step");
    assert.equal(said(grown(left + 100)).ok, false, "across it");
  });

  test("P1's End Turn that takes more than a step of hidden walks off past the scene's line is refused, since their exact part grew (FLR4-OPUS-13)", () => {
    const f = pastTheLine("scene");
    let state = structuredClone(f.state);
    for (const [i, op] of ([{ t: "encounter.start", entries: [{ id: "p1-row", tokenId: f.pc, value: 10 }] }, { t: "encounter.next" }] as Op[]).entries()) {
      const r = applyOp(state, op, { memberId: f.dm.id, role: "dm" }, env(100 + i));
      assert.ok(r.ok, r.ok ? "" : r.message);
      state = r.state;
    }
    for (let i = 0; i < GHOSTS; i++) state.tokens[`ghost-${i}`] = token(`ghost-${i}`, { sceneId: f.sceneId, x: 20 + (i % 10), y: 20 + Math.floor(i / 10), visibility: "dm", path: walkOf(1, 50) });
    const p1v: Viewer = { memberId: f.player.id, role: "player" };
    const op: Op = { t: "encounter.next", from: { entry: "p1-row", round: state.encounter!.round } } as Op;
    const r = applyOp(state, op, p1v, env(200));
    assert.ok(r.ok);
    const reading = playerReadings(state, r.state, f.player.id).get(f.sceneId)!;
    const whole = (parts: { stepped: number; exact: number }) => farReading(parts.stepped, parts.exact);
    assert.ok(reading.after.exact > reading.before!.exact && whole(reading.after) < whole(reading.before!), `the turn's line grows the exact part and the walks' end lowers the whole: ${JSON.stringify(reading)}`);
    assert.equal(answer(state, op, p1v).said, `quota: ${SCENE_FULL}`);
  });

  test("twins apart in 15,000 bytes of the DM's notes, past the room's line by a step or by 6 MiB, take P1's move that adds nothing alike, and refuse their create alike (FLR4-SOL-23, D-261121-075)", () => {
    for (const extra of [FAR.byteStep, 6 * MIB]) {
      const f = pastTheLine("room", extra);
      f.state.scenes[f.sceneId] = { ...f.state.scenes[f.sceneId]!, fogEnabled: true, vision: { on: true, light: "bright" } };
      const p1v: Viewer = { memberId: f.player.id, role: "player" };
      const twin = (state: RoomState) => ({ ...state, tokens: { ...state.tokens, n0: { ...state.tokens.n0!, notes: `${state.tokens.n0!.notes}${"m".repeat(15_000)}` } } });
      const move: Op = { t: "token.move", tokenId: f.pc, x: 19, y: 0 };
      const create: Op = { t: "drawing.create", drawing: { id: "d-past", sceneId: f.sceneId, kind: "line", points: [0, 0, 2, 2], style: { stroke: "#ff0000", width: 2, opacity: 1 }, ownerId: f.player.id, visibility: "all" } } as Op;
      for (const state of [f.state, twin(f.state)]) {
        assert.equal(answer(state, move, p1v).said, "taken", `a move past the line by ${extra}`);
        assert.equal(answer(state, create, p1v).said, `quota: ${ROOM_FULL}`, `a create past the line by ${extra}`);
      }
    }
  });
});
