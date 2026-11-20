import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "../discoveryTestutil.ts";
import type { LogEvent, RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { linkHolds, overlaps } from "../rules/attach.ts";
import { SQUARES } from "../rules/grid.ts";
import { planWalks, wayOf, type MovedToken } from "../rules/moveLeg.ts";
import type { RoutePoint } from "../rules/route.ts";
import { trapLandings, trapMoments } from "../rules/traps.ts";
import { chance, DM, entry, env, int, member, P1, pick, rng, room, scene, template, token, trap } from "../testutil.ts";
import { sweptAlong } from "./areaTriggers.ts";

/**
 * Every reader of a moved token's way reads it through one reader
 * (moveLeg.ts wayOf, reviews HEXOP-ASTRA-1 to 3): a rider a dropped seat
 * moves at the walk's end rides on her own seat until then, and what she
 * drags walks as her place carries her. An area's sweep read the rider on
 * her walk toward the seat, so she entered a sphere her own seat never
 * met, and the wall test of the goblin she drags read the goblin's walk
 * toward the seat beside it, so a drag through a wall was taken.
 */

const deps = { canUseAsset: () => true };

/** A Large warhorse on 2, 2, Pat's Bree riding its bottom-right square, and the goblin she drags on 3, 4, hidden from players or not, or none. */
function ride(goblin: "none" | "shown" | "hidden" = "none"): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 20, h: 10 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  s.tokens.horse = token("horse", { size: "large", x: 2, y: 2, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.bree = token("bree", { x: 3, y: 3, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
  if (goblin !== "none") s.tokens.gob = token("gob", { x: 3, y: 4, name: "Goblin", kind: "monster", attached: { to: "bree", kind: "drag" }, ...(goblin === "hidden" ? { visibility: "dm" as const } : {}) });
  return s;
}
const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 10, y: 2, seat: { tokenId: "bree", x: 10, y: 2 } };
const { seat: _seat, ...bare } = op;

describe("an area's sweep reads a seated rider on her own seat until she arrives (HEXOP-ASTRA-2)", () => {
  /** `s` in Bree's turn, with a 1 ft sphere at `at` that reminds on entering. */
  function fight(s: RoomState, at: { x: number; y: number }): RoomState {
    s.templates.ball = template("ball", { shape: "sphere", size: 1, origin: { ...at, z: 0 }, includeOrigin: true, triggers: ["enter"] });
    s.encounter = { rev: 0, round: 1, activeEntryId: "e-bree", entries: [entry("e-bree", { tokenId: "bree", value: 15 }), entry("e-horse", { tokenId: "horse", value: 10, tieOrder: 1 })] };
    return s;
  }
  const entered = (s: RoomState, move: OpOf<"token.move">, actor: Viewer, opVersion?: number): string[] => {
    const r = applyOp(s, move, actor, { ...env(1), ...(opVersion === undefined ? {} : { opVersion }) });
    assert.ok(r.ok, r.ok ? "" : r.message);
    return r.log.flatMap((e) => (e.data?.type === "area" && (e.data as Extract<LogEvent, { type: "area" }>).trigger === "enter" ? [(e.data as Extract<LogEvent, { type: "area" }>).tokenId] : [])).sort();
  };

  test("a sphere round 8.5, 2.5, which the warhorse crosses and Bree's own seat passes under, reminds for the warhorse alone, as with no seat", () => {
    for (const actor of [P1, DM]) {
      const s = fight(ride(), { x: 8.5, y: 2.5 });
      assert.deepEqual(entered(s, op, actor), ["horse"], `${actor.role}: the warhorse alone`);
      assert.deepEqual(entered(s, bare, actor), ["horse"], `${actor.role}: as with no seat`);
      assert.deepEqual(entered(s, op, actor, 62), ["horse"], `${actor.role}: op 62, which ignores the seat`);
    }
  });

  test("a sphere round 10.5, 2.5, on the seat she arrives on, reminds for her, where her own seat at the walk's end lies outside it", () => {
    for (const actor of [P1, DM]) {
      const s = fight(ride(), { x: 10.5, y: 2.5 });
      assert.deepEqual(entered(s, op, actor), ["bree", "horse"], `${actor.role}: she arrives in it`);
      assert.deepEqual(entered(s, bare, actor), ["horse"], `${actor.role}: on her own seat she never meets it`);
    }
  });
});

describe("the path Bree's turn records reads her way (HEXOP-OPUS2-1)", () => {
  test("carried to the seat, the leg counts the 40 ft her own seat was carried, as with no seat, and ends on the seat", () => {
    const s = ride();
    s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-bree", { tokenId: "bree", value: 15 }), entry("e-horse", { tokenId: "horse", value: 10, tieOrder: 1 })] };
    const started = applyOp(s, { t: "encounter.next" }, DM, env(1));
    assert.ok(started.ok);
    const leg = (move: OpOf<"token.move">) => {
      const r = applyOp(started.state, move, P1, env(2));
      assert.ok(r.ok);
      return r.state.tokens.bree!.path!.stops.at(-1)!;
    };
    const seated = leg(op);
    const plain = leg(bare);
    assert.deepEqual([seated.x, seated.y, seated.moved], [10, 2, 40], "on the seat, 40 ft carried");
    assert.deepEqual([plain.x, plain.y, plain.moved], [11, 3, 40], "with no seat, on her own");
    assert.equal(seated.routeSeen, plain.routeSeen, "seen alike on the way");
  });
});

describe("what a seated rider drags (HEXOP-ASTRA-3, HEXOP-OPUS2-2)", () => {
  /** A wall from 8, 4.5 to 8, 5 across the goblin's row. */
  const walled = (s: RoomState): RoomState => {
    wall(s, "seatwall0001", [8, 4.5], [8, 5]);
    return s;
  };
  const at = (s: RoomState, id: string) => [s.tokens[id]!.x, s.tokens[id]!.y];

  test("a goblin the actor sees keeps her on the seat her place carries her to, as the device that sends one does: the move is as with no seat, refused alike across the wall", () => {
    for (const actor of [P1, DM]) {
      const s = ride("shown");
      const seated = applyOp(s, op, actor, env(1));
      const plain = applyOp(s, bare, actor, env(1));
      assert.ok(seated.ok && plain.ok);
      assert.deepEqual(seated.state.tokens, plain.state.tokens, `${actor.role}: as with no seat`);
      assert.deepEqual(at(seated.state, "bree"), [11, 3], `${actor.role}: Bree on her own seat`);
    }
    // The DM sees a hidden goblin, so the DM's seat goes too.
    const hidden = ride("hidden");
    const dm = applyOp(hidden, op, DM, env(1));
    const dmPlain = applyOp(hidden, bare, DM, env(1));
    assert.ok(dm.ok && dmPlain.ok);
    assert.deepEqual(dm.state.tokens, dmPlain.state.tokens, "the DM's drop with a goblin hidden from players");
    const s = walled(ride("shown"));
    const plain = canApply(bare, P1, s, deps);
    assert.equal(plain.ok, false, "across the wall, refused with no seat");
    assert.deepEqual(canApply(op, P1, s, deps), plain, "and in the same words with it");
  });

  test("Pat's drop with a goblin players cannot see: Bree sits on the seat, the goblin lands off the warhorse in her reach, and every player's copy is the one with no goblin", () => {
    for (const [seat, wallAt] of [
      [{ x: 10, y: 2 }, null],
      [{ x: 11, y: 2 }, null],
      [{ x: 11, y: 2 }, [[12, 2], [12, 3]]],
    ] as const) {
      const where = `seat ${seat.x}, ${seat.y}${wallAt ? ", a wall on x 12" : ""}`;
      const s = ride("hidden");
      s.tokens.gob = { ...s.tokens.gob!, x: 4, y: 3 };
      if (wallAt) wall(s, "seatwall0002", [...wallAt[0]], [...wallAt[1]]);
      const move: OpOf<"token.move"> = { ...op, seat: { tokenId: "bree", ...seat } };
      assert.ok(canApply(move, P1, s, deps).ok, `${where}: taken`);
      const r = applyOp(s, move, P1, env(1));
      assert.ok(r.ok);
      const after = r.state;
      assert.deepEqual(at(after, "bree"), [seat.x, seat.y], `${where}: Bree on the seat`);
      const g = SQUARES;
      assert.ok(!overlaps(g, after.tokens.gob!, after.tokens.horse!), `${where}: the goblin off the warhorse, on ${at(after, "gob")}`);
      assert.ok(!overlaps(g, after.tokens.gob!, after.tokens.bree!), `${where}: and off Bree`);
      assert.equal(after.tokens.gob!.attached?.to, "bree", `${where}: still dragged`);
      assert.ok(linkHolds(g, after.meta.settings, "drag", after.tokens.gob!, after.tokens.bree!), `${where}: in her reach`);
      // The twin with no goblin: the same bytes for Pat.
      const alone = structuredClone(s);
      delete alone.tokens.gob;
      const twin = applyOp(alone, move, P1, env(1));
      assert.ok(twin.ok);
      assert.equal(stableStringify(projectState(after, P1, { sceneId: "s1" })), stableStringify(projectState(twin.state, P1, { sceneId: "s1" })), `${where}: Pat's copy`);
    }
  });

  test("a goblin players cannot see stopped at the wall in the private pass stays where it stopped, alike with the seat and without it, and the move is taken", () => {
    const s = walled(ride("hidden"));
    assert.ok(canApply(bare, P1, s, deps).ok, "taken with no seat");
    assert.ok(canApply(op, P1, s, deps).ok, "and with it");
    const plain = applyOp(s, bare, P1, env(1));
    const seated = applyOp(s, op, P1, env(1));
    assert.ok(plain.ok && seated.ok);
    assert.deepEqual(seated.state.tokens.gob, plain.state.tokens.gob, "the goblin where it stopped unseen");
  });
});

describe("squares, random seated drops: each reader's pose at each moment is the way's (moveLeg.ts wayOf)", () => {
  /** Where the way puts `m` at fraction `f` of piece `i` (1 the first) of a walk on squares, at its last point once stopped short. */
  const poseOn = (m: MovedToken, i: number, f: number): { x: number; y: number } => {
    const way = wayOf(m).route;
    if (i >= way.length) return way[way.length - 1]!;
    const a: RoutePoint = way[i - 1]!;
    const b: RoutePoint = way[i]!;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };

  test("the trap step at every corner and end, the area sweep at every point, and the landing, for Pat and the DM, with what rides on her, what she drags, a stop trap and a wall", () => {
    let moves = 0;
    let seated = 0;
    let cut = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed * 977 + 5);
      const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 24, h: 16 }, blockMovement: true, autoWalls: "off" }) } });
      s.buildChunks = {};
      const big = pick(r, ["large", "large", "huge"] as const);
      const n = big === "large" ? 2 : 3;
      const mx = int(r, 2, 6);
      const my = int(r, 2, 10);
      s.tokens.horse = token("horse", { size: big, x: mx, y: my, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const bx = mx + int(r, 0, n - 1);
      const by = my + int(r, 0, n - 1);
      s.tokens.bree = token("bree", { x: bx, y: by, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      if (chance(r, 0.5)) s.tokens.owl = token("owl", { size: "tiny", x: bx, y: by, name: "Owl", kind: "npc", ownerIds: ["p1"], attached: { to: "bree", kind: "perch" }, ...(chance(r, 0.3) ? { visibility: "dm" as const } : {}) });
      // A goblin dragged by Bree or by the owl on her, which players may not see. One they see under a hidden owl walks as itself.
      if (chance(r, 0.4)) s.tokens.gob = token("gob", { x: mx + n, y: by, name: "Goblin", kind: "monster", attached: { to: s.tokens.owl && chance(r, 0.5) ? "owl" : "bree", kind: "drag" }, ...(chance(r, 0.3) ? { visibility: "dm" as const } : {}) });
      if (chance(r, 0.3)) wall(s, "seatwall0001", [int(r, 9, 14), int(r, 1, 14) + 0.5], [int(r, 9, 14), int(r, 1, 14) + 1]);
      const turn = { x: int(r, 8, 12), y: int(r, 1, 12) };
      const to = { x: int(r, 14, 19), y: int(r, 1, 12) };
      if (chance(r, 0.4)) s.traps.t = trap("t", { zone: { cells: [{ x: int(r, 8, 18), y: int(r, 1, 13), w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits: "zone", damage: [{ formula: "1d6", type: "fire" }], actions: [], find: [], notice: false } });
      s.templates.ball = template("ball", { shape: "sphere", size: 5, origin: { x: int(r, 6, 20) + 0.5, y: int(r, 1, 14) + 0.5, z: 0 }, includeOrigin: true, triggers: ["enter"] });
      s.encounter = { rev: 0, round: 1, activeEntryId: "e-bree", entries: [entry("e-bree", { tokenId: "bree", value: 15 })] };
      const seats = Array.from({ length: n * n }, (_, k) => ({ x: to.x + (k % n), y: to.y + Math.floor(k / n) })).filter((p) => p.x !== to.x + (bx - mx) || p.y !== to.y + (by - my));
      const seat = pick(r, seats);
      const move: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to, route: [[turn.x, turn.y, 0, 0], [to.x, to.y, 0, 0]], seat: { tokenId: "bree", ...seat } };
      for (const actor of [P1, DM]) {
        const at = `seed ${seed}, ${actor.role}`;
        if (!canApply(move, actor, s, deps).ok) continue;
        moves++;
        const result = applyOp(s, move, actor, env(1));
        assert.ok(result.ok, at);
        const after = result.state;
        const walks = planWalks(move, s, actor, {});
        if (walks.some((m) => m.carried)) seated++;
        // Every token lands where the trap step had it.
        const landed = trapLandings(move, s, actor, {});
        for (const id of Object.keys(s.tokens)) {
          const pose = landed.get(id);
          if (!pose) continue;
          assert.deepEqual([after.tokens[id]!.x, after.tokens[id]!.y], [pose.x, pose.y], `${at}: ${id} where the trap step lands it`);
        }
        if (after.tokens.horse!.x !== to.x || after.tokens.horse!.y !== to.y) {
          cut++;
          continue;
        }
        // The trap step at the walk's corner and end, and the area sweep at every point before it lands.
        const moment = trapMoments(move, s, actor, {});
        for (const [p, i] of [
          [[1, 0, 1], 1],
          [[1, 1, 1], 2],
        ] as const) {
          const tokens = moment(p);
          for (const m of walks) {
            const want = i === 2 ? m.to : wayOf(m).route[i]!;
            assert.deepEqual([tokens[m.tokenId]!.x, tokens[m.tokenId]!.y], [want.x, want.y], `${at}: the trap step has ${m.tokenId} at point ${i}`);
          }
        }
        for (const point of sweptAlong(move, s, after, actor, {})) {
          for (const m of walks) {
            const t: Token | undefined = point.room.tokens[m.tokenId];
            if (!t || m.from.x === m.to.x && m.from.y === m.to.y && !m.carried) continue;
            const want = poseOn(m, point.piece, point.f);
            assert.ok(Math.abs(t.x - want.x) < 1e-9 && Math.abs(t.y - want.y) < 1e-9, `${at}: the sweep has ${m.tokenId} at ${t.x}, ${t.y} at piece ${point.piece} ${point.f}, where its way has ${want.x}, ${want.y}`);
          }
        }
      }
    }
    // About 570 moves, 420 seated, 54 cut by a trap.
    assert.ok(moves >= 500 && seated >= 350 && cut >= 40, `moves ${moves}, seated ${seated}, cut ${cut}`);
  });
});
