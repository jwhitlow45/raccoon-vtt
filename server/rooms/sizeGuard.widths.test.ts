import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR, roundUp } from "#shared/limits.ts";
import type { RoomState, Scene, Token, Viewer } from "#shared/model.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { canApply } from "#shared/permissions.ts";
import { applyOp } from "#shared/reducer.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { actor, character, DM, entry, env, P1, randomOp, randomState, rng, room, scene, template, token, trap } from "#shared/testutil.ts";
import { farRoomBytes, farWidths, measuredStateBytes, ownHeldBytes, PIT_TOKENS_RESERVE, projectedSceneBytes } from "./sizeGuard.ts";

/*
 * D-261119-011: the fields a player's op may write on creatures and areas
 * they do not receive count at fixed widths in the far line (FAR_WIDTHS,
 * farWidths), so such a write never moves their stepped part. Twin rooms
 * apart only in records P1's copy does not hold take the same P1 op, its
 * undo, its redo and a reload, and P1's stepped parts move alike in both.
 */

const DEPS = { canUseAsset: () => true, canRestoreAsset: () => true } as never;

/** P1's stepped part of the room and of each scene before rounding and the other reserves (sizeGuard.exact.test.ts). */
function steppedParts(state: RoomState): Map<string, number> {
  const out = new Map<string, number>([["room", measuredStateBytes(state) + farWidths(state) - ownHeldBytes(state, "p1").sub]]);
  for (const s of Object.values(state.scenes)) {
    if (s.floor && s.floor.of !== s.id) continue;
    const floors = new Set(floorsOf(state, s.id).map((floor) => floor.id));
    out.set(s.id, projectedSceneBytes(state, s.id) + farWidths(state, floors) - ownHeldBytes(state, "p1", [s.id]).sub);
  }
  return out;
}

/** How each stepped part moved from one state to the next. */
function moved(before: RoomState, after: RoomState): Record<string, number> {
  const [b, a] = [steppedParts(before), steppedParts(after)];
  return Object.fromEntries([...a].map(([scope, bytes]) => [scope, bytes - (b.get(scope) ?? bytes)]));
}

function copyOf(state: RoomState): string {
  return stableStringify(projectState(state, P1, { sceneId: null }));
}

const reload = (state: RoomState): RoomState => JSON.parse(JSON.stringify(state)) as RoomState;

/** P1's op on `state`, or null when the rules refuse it. */
function apply(state: RoomState, op: Op, who: Viewer = P1): { state: RoomState; inverse: unknown } | null {
  if (who.role === "player" && !canApplyOk(op, state)) return null;
  const r = applyOp(state, op, who, env(2_000_000));
  return r.ok ? { state: r.state, inverse: r.inverse } : null;
}

const canApplyOk = (op: Op, state: RoomState) => canApply(op, P1, state, DEPS).ok;

/** P1's undo of an op as the server writes it, a restore of what the op replaced. */
const undoOf = (inverse: unknown): Op => ({ t: "sys.restore", from: "undo", deps: true, entries: inverse }) as Op;

/**
 * The records a twin adds to a room P1's copy does not hold, each about P1's
 * creature `holder`: a hidden creature on it with an area of its own, and
 * what one twin of each pair holds that the other does not.
 */
const HIDDEN_DIMS = {
  nudge: (s: RoomState) => patchToken(s, "hz1", { nudge: { x: 0.25, y: -0.25 } }),
  squeeze: (s: RoomState) => patchToken(s, "hz1", { squeeze: true }),
  "an earlier path": (s: RoomState) => patchToken(s, "hz1", { path: { turn: 1, stops: [0, 1, 2, 3, 4].map((i) => ({ x: i, y: i, elevation: 0 })) } }),
  "revs a step apart": (s: RoomState) => {
    patchToken(s, "hz1", { rev: 10 });
    s.templates.hza = { ...s.templates.hza!, rev: 100 };
    if (s.encounter) s.encounter = { ...s.encounter, rev: 10 };
  },
  "an attached area": (s: RoomState) => {
    s.templates.hzb = template("hzb", { sceneId: s.tokens.hz1!.sceneId, attachedTo: "hz1", visibility: "dm", label: "Hidden aura" });
  },
  "a link": (s: RoomState) => {
    const hz1 = s.tokens.hz1!;
    s.tokens.hz2 = token("hz2", { kind: "object", size: "tiny", visibility: "dm", sceneId: hz1.sceneId, x: hz1.x, y: hz1.y, elevation: hz1.elevation, attached: { to: hz1.attached!.to, kind: "carry" } });
  },
  "a hidden row": (s: RoomState) => {
    if (s.encounter) s.encounter = { ...s.encounter, entries: [...s.encounter.entries, entry("hzr", { tokenId: "hz1", hidden: true })] };
  },
} satisfies Record<string, (s: RoomState) => void>;
type Dim = keyof typeof HIDDEN_DIMS;

function patchToken(s: RoomState, id: string, patch: Partial<Token>): void {
  s.tokens = { ...s.tokens, [id]: { ...s.tokens[id]!, ...patch } };
}

/** A random room with a hidden creature perched on a creature P1 owns, its own hidden area beside it, revs at 9. */
function withHidden(state: RoomState, holder: Token): RoomState {
  const s = structuredClone(state);
  s.casts = {};
  s.tokens.hz1 = token("hz1", { kind: "pc", size: "tiny", visibility: "dm", sceneId: holder.sceneId, x: holder.x, y: holder.y, elevation: holder.elevation, rev: 9, attached: { to: holder.id, kind: "perch" } });
  s.templates.hza = template("hza", { sceneId: holder.sceneId, attachedTo: "hz1", visibility: "dm", rev: 99 });
  if (s.encounter) s.encounter = { ...s.encounter, rev: 9 };
  return s;
}

/** Field names a dimension's twin finds apart, with the first case of each. */
type Found = Map<Dim, string>;

/**
 * The same P1 op, its undo, its redo and a reload on `base` and on its twin
 * with `dim`: the first stage where P1's stepped parts move apart, or null.
 */
function apart(base: RoomState, dim: Dim, op: Op): string | null {
  const twin = structuredClone(base);
  HIDDEN_DIMS[dim](twin);
  if (copyOf(twin) !== copyOf(base)) return null;
  const [a, b] = [apply(base, op), apply(twin, op)];
  if ((a === null) !== (b === null)) return `${op.t}: answered apart`;
  if (!a || !b) return null;
  const stage = (name: string, [a0, a1]: [RoomState, RoomState], [b0, b1]: [RoomState, RoomState]) => {
    const [ma, mb] = [moved(a0, a1), moved(b0, b1)];
    return JSON.stringify(ma) === JSON.stringify(mb) ? null : `${op.t} ${name}: ${JSON.stringify(ma)} against ${JSON.stringify(mb)}`;
  };
  // A change of what P1's copy holds (sight) moves what the exact part holds, as D-261119-003 accepts.
  if (copyOf(a.state) !== copyOf(b.state)) return null;
  const did = stage("op", [base, a.state], [twin, b.state]);
  if (did) return did;
  const undone = (step: { state: RoomState; inverse: unknown }) => (Array.isArray(step.inverse) && step.inverse.length > 0 ? apply(step.state, undoOf(step.inverse)) : null);
  const [ua, ub] = [undone(a), undone(b)];
  if (ua && ub) {
    const undid = stage("undo", [a.state, ua.state], [b.state, ub.state]);
    if (undid) return undid;
    const [ra, rb] = [undone(ua), undone(ub)];
    if (ra && rb) {
      const redid = stage("redo", [ua.state, ra.state], [ub.state, rb.state]);
      if (redid) return redid;
    }
  }
  return stage("reload", [a.state, reload(a.state)], [b.state, reload(b.state)]);
}

/** Every dimension's twin through `seeds` random rooms, each with ops that move P1's creature and random P1 ops. */
function findApart(seeds: number): Found {
  const found: Found = new Map();
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed * 7 + 3);
    const raw = randomState(r);
    const holder = Object.values(raw.tokens).find((t) => t.ownerIds.includes("p1") && t.attached === undefined);
    if (!holder) continue;
    let state = withHidden(raw, holder);
    for (let k = 0; k < 6; k++) {
      const h = state.tokens[holder.id];
      if (!h) break;
      const step = k % 4 === 0 ? 7 : -7;
      const op: Op = k % 2 === 0 ? { t: "token.move", tokenId: h.id, x: h.x + step, y: h.y + step } : randomOp(r, state, P1);
      if (op.t === "encounter.next") continue;
      for (const dim of Object.keys(HIDDEN_DIMS) as Dim[]) {
        if (found.has(dim)) continue;
        const why = apart(state, dim, op);
        if (why) found.set(dim, `seed ${seed}: ${why}`);
      }
      const next = apply(state, op);
      if (next) state = next.state;
    }
  }
  return found;
}

/** The twin dimension that waits on a decision (D-261119-011). */
const OPEN: ReadonlySet<Dim> = new Set(["an earlier path"]);

describe("D-261119-011: what a player's op writes on what they do not receive moves their stepped part alike, whatever it holds", () => {
  const found = findApart(120);

  test("random rooms: every P1 op, its undo, its redo and a reload move P1's stepped parts alike in twins apart only in records P1 does not receive", () => {
    const closed = [...found].filter(([dim]) => !OPEN.has(dim));
    assert.deepEqual(closed, []);
  });

  test("a carried creature's earlier walk: P1's stepped parts move alike", { todo: "waits on a decision" }, () => {
    assert.equal(found.get("an earlier path"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Fixed twins at a step's edge

const GROUND = "s1";
/** An upper floor whose id is longer than the ground floor's, so a climb changes its creatures' stored floor ids' lengths. */
const UPPER = "upper-floor-of-the-tower";

function floor(id: string, level: number, name: string): Scene {
  return scene(id, { name: "Tower", order: 0, bounds: { w: 20, h: 20 }, floor: { of: GROUND, level, name, height: 10 } });
}

function run(state: RoomState, op: Op, who: Viewer = DM): RoomState {
  const r = applyOp(state, opSchema.parse(op), who, env(3_000_000));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

/** Thorn, P1's character, at 9, 9 on the ground floor below stairs to the upper floor, every rev at 9. */
function tower(): RoomState {
  const state = room({
    scenes: { [GROUND]: floor(GROUND, 0, "Ground floor"), [UPPER]: floor(UPPER, 1, "Upper floor"), s2: scene("s2", { order: 1 }) },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ speeds: { walk: 30 } }) }) },
    tokens: { thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "thorn" }, sceneId: GROUND, x: 9, y: 9, rev: 9 }) },
  });
  return run(state, { t: "floorLink.put", link: { id: "l1", pairId: "l2", sceneId: GROUND, to: UPPER, rect: { x: 9, y: 9, w: 1, h: 1 }, kind: "stairs" } } as Op);
}

/** A hidden creature on Thorn, at its widest numbers' edge, with a hidden area of its own. */
function hiddenRider(state: RoomState, over: Partial<Token> = {}): RoomState {
  const s = structuredClone(state);
  s.tokens.owl = token("owl", { kind: "pc", size: "tiny", visibility: "dm", sceneId: GROUND, x: 9, y: 9, rev: 9, attached: { to: "thorn", kind: "perch" }, ...over });
  s.templates.owlaura = template("owlaura", { sceneId: GROUND, attachedTo: "owl", visibility: "dm", rev: 9 });
  return s;
}

/** P1's room reading and each scene's but s2's, which holds the pad, at the widest. */
function readings(state: RoomState): Record<string, number> {
  const own = ownHeldBytes(state, "p1");
  const out: Record<string, number> = { room: farRoomBytes(state, true, measuredStateBytes(state), own) };
  for (const [scope, bytes] of steppedParts(state)) if (scope !== "room" && scope !== "s2") out[scope] = roundUp(bytes, FAR.byteStep) + ownHeldBytes(state, "p1", [scope]).shown;
  return out;
}

/** `state` with a DM's pad on s2 that puts P1's room stepped part on a step's edge: one more stored byte reads a step more. */
function atTheEdge(state: RoomState): RoomState {
  const padded = (n: number): RoomState => ({ ...state, tokens: { ...state.tokens, pad: token("pad", { sceneId: "s2", notes: "p".repeat(n) }) } });
  const at = readings(padded(0)).room!;
  let [lo, hi] = [0, FAR.byteStep + 1];
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (readings(padded(mid)).room === at) lo = mid;
    else hi = mid;
  }
  assert.ok(readings(padded(lo + 1)).room! > at, "one more stored byte reads a step more");
  return padded(lo);
}

/**
 * Twins apart only in what P1 does not receive, each at a step's edge, take
 * `op`: each one's stepped parts stay where they were, and P1 reads both
 * twins alike before, after and after a reload, so every later answer is
 * the same.
 */
function assertTwinsAlike(twins: [RoomState, RoomState], op: Op, who: Viewer = P1): void {
  const [a, b] = twins.map(atTheEdge) as [RoomState, RoomState];
  assert.equal(copyOf(a), copyOf(b), "P1's copies are equal");
  assert.notEqual(stableStringify(a), stableStringify(b), "the twins are apart");
  assert.deepEqual(readings(a), readings(b), "P1 reads the twins alike before");
  const [a1, b1] = [run(a, op, who), run(b, op, who)];
  assert.deepEqual(moved(a, a1), moved(b, b1), "the op moves P1's stepped parts alike");
  assert.deepEqual(readings(a1), readings(b1), "P1 reads the twins alike after");
  assert.deepEqual(readings(reload(a1)), readings(a1), "and after a reload");
  assert.deepEqual(readings(reload(b1)), readings(b1), "and after a reload");
}

const climb: Op = { t: "token.climb", tokenId: "thorn", linkId: "l1" };

describe("D-261119-011: fixed twins at a step's edge read alike through a player's op", () => {
  test("the same public climb, with a hidden rider and its area or none, onto a floor whose id is longer", () => {
    const base = tower();
    const ridden = hiddenRider(base);
    assertTwinsAlike([base, ridden], climb);
    const after = run(ridden, climb, P1);
    assert.deepEqual([after.tokens.owl!.sceneId, after.templates.owlaura!.sceneId], [UPPER, UPPER], "the rider and its area went up");
    assert.equal(after.tokens.owl!.rev, 10, "its rev crossed a digit");
  });

  test("a hidden rider with a squeeze and a placement between squares, or neither, through a climb", () => {
    assertTwinsAlike([hiddenRider(tower()), hiddenRider(tower(), { nudge: { x: 0.25, y: 0.25 }, squeeze: true })], climb);
  });

  test("a hidden creature Thorn drags, its link let go by the climb, or the same creature on no link", () => {
    const dragged = (link: boolean) => {
      const s = tower();
      s.tokens.ally = token("ally", { visibility: "dm", sceneId: GROUND, x: 9, y: 10, rev: 9, ...(link ? { attached: { to: "thorn", kind: "drag" as const } } : {}) });
      return s;
    };
    assertTwinsAlike([dragged(false), dragged(true)], climb);
    assert.equal(run(dragged(true), climb, P1).tokens.ally!.attached, undefined, "the link let go");
  });

  test("a hidden rider that is the turn's creature gets a leg on its walk, or there is none", () => {
    const fight = (s: RoomState) => ({ ...s, encounter: { rev: 0, round: 1, activeEntryId: "rowl", entries: [entry("rowl", { tokenId: "owl" })], turnStart: { entryId: "rowl", tokenId: "owl", sceneId: GROUND, x: 9, y: 9, elevation: 0, seq: 7 } } }) as RoomState;
    const base = fight(hiddenRider(tower()));
    const without = structuredClone(base);
    delete without.tokens.owl;
    delete without.templates.owlaura;
    const move: Op = { t: "token.move", tokenId: "thorn", x: 10, y: 9 };
    assert.ok(canApplyOk(move, base), "P1 may move Thorn");
    assertTwinsAlike([without, base], move);
    assert.ok((run(base, move, P1).tokens.owl!.path?.stops.length ?? 0) > 0, "the rider's walk took a leg");
  });

  test("the turn's walk counts alike whatever its lists of who saw each stop hold, as the measure counts them at the roster's widest", () => {
    const walked = (seenBy: string[]) => {
      const s = hiddenRider(tower());
      s.encounter = { rev: 0, round: 1, activeEntryId: "rowl", entries: [entry("rowl", { tokenId: "owl" })], turnStart: { entryId: "rowl", tokenId: "owl", sceneId: GROUND, x: 9, y: 9, elevation: 0, seq: 7 } };
      patchToken(s, "owl", { path: { turn: 7, stops: [{ x: 9, y: 9, elevation: 0, seenBy }, { x: 10, y: 9, elevation: 0, seenBy }] } });
      return s;
    };
    const [none, both] = [walked([]), walked(["p1", "p2"])];
    assert.ok(measuredStateBytes(both) === measuredStateBytes(none), "the measure counts the lists at the roster's widest");
    assert.equal(farWidths(both), farWidths(none));
  });

  test("P1's row moved to the top of the order, with a hidden row in tenth place or none, every row's place among ties moving on", () => {
    const order = (hidden: boolean) => {
      const s = tower();
      const rows = Array.from({ length: 9 }, (_, i) => entry(`r${i}`, { tokenId: `m${i}`, value: 20 - i, tieOrder: i }));
      for (let i = 0; i < 9; i++) s.tokens[`m${i}`] = token(`m${i}`, { sceneId: GROUND, x: 1, y: i });
      if (hidden) {
        s.tokens.ghost = token("ghost", { visibility: "dm", sceneId: GROUND, x: 15, y: 15 });
        rows.push(entry("rghost", { tokenId: "ghost", value: 11, tieOrder: 9, hidden: true }));
      }
      rows.push(entry("rthorn", { tokenId: "thorn", value: 5, tieOrder: rows.length }));
      return { ...s, encounter: { rev: 9, round: 1, activeEntryId: null, entries: rows } } as RoomState;
    };
    const top: Op = { t: "encounter.setValue", entryId: "rthorn", value: 100 };
    assertTwinsAlike([order(false), order(true)], top);
    assert.equal(run(order(true), top, P1).encounter!.entries.find((e) => e.id === "rghost")!.tieOrder, 10, "the hidden row's place crossed a digit");
  });

  test("a walk onto an armed pit, with a hidden creature on its lid or none", () => {
    const pitRoom = (victim: boolean) => {
      const s = room({ tokens: { thorn: token("thorn", { kind: "pc", ownerIds: ["p1"], x: 0, y: 4, rev: 9 }) } });
      s.scenes.s2 = scene("s2", { order: 1 });
      s.traps = { pit: trap("pit", { rig: { ...trap("x").rig!, who: "any", stops: true, pit: { floor: -10 } } }) };
      if (victim) s.tokens.vic = token("vic", { visibility: "dm", x: 5, y: 4, rev: 9 });
      return s;
    };
    const walk: Op = { t: "token.move", tokenId: "thorn", x: 9, y: 4 };
    assertTwinsAlike([pitRoom(false), pitRoom(true)], walk);
    assert.equal(run(pitRoom(true), walk, P1).tokens.vic!.elevation, -10, "the hidden creature fell");
  });
});

describe("D-261119-011: a pit scene's reserve for what its pits move", () => {
  test("a room of several pit scenes just under the far line before the widths stays under it with them", () => {
    const base = room();
    for (let i = 0; i < 6; i++) {
      const id = `pit${i}`;
      base.scenes[id] = scene(id, { order: 10 + i });
      base.traps = { ...base.traps, [id]: trap(id, { sceneId: id, rig: { ...trap("x").rig!, pit: { floor: -10 } } }) };
      for (let k = 0; k < 8; k++) base.tokens[`${id}m${k}`] = token(`${id}m${k}`, { sceneId: id, x: k, y: 1 });
    }
    // The DM's reading before the widths: the measure with every pit scene's reserve for its creatures, and no widths.
    const before = (s: RoomState) => farRoomBytes(s, true, measuredStateBytes(s) - farWidths(s));
    const line = FAR.roomBytes - 512 * 1024;
    const padded = (n: number): RoomState => ({ ...base, tokens: { ...base.tokens, pad: token("pad", { sceneId: "s2", notes: "p".repeat(n) }) } });
    let [lo, hi] = [0, line];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (before(padded(mid)) <= line) lo = mid;
      else hi = mid;
    }
    const last = padded(lo);
    const tokens = Object.keys(last.tokens).length;
    const widths = farWidths(last);
    assert.ok(widths < 0 && widths + 6 * PIT_TOKENS_RESERVE > 0, `the widths of ${tokens} creatures less 6 pit reserves: ${widths}`);
    assert.ok(before(last) <= line && farRoomBytes(last, true) <= line, `before ${before(last)}, after ${farRoomBytes(last, true)}, line ${line}`);
  });
});
