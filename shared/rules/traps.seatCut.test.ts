import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token, Trap, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { keepOf } from "../reducer/hexFile.testkit.ts";
import { DM, env, member, P1, room, scene, token, trap } from "../testutil.ts";
import { hexPlacements, seatedAt } from "./attach.ts";
import { occupiedHexes } from "./footprint.ts";
import { hexKey, type HexGrid } from "./hex.ts";
import { COLUMNS, onHex, ROWS } from "./hexWalls.testkit.ts";
import { hexStandHexes, hexStandPlace } from "./movement.ts";
import { planTrapMove, trapHits, trapLandings, trapWalks } from "./traps.ts";

/**
 * A rider's dropped seat moves only her walk's end (LP40-HEX-SEAT, review
 * HEXOP-ASTRA-1): she sits where her place carries her while the mount
 * walks, so a trap that stops the mount short reads her there, hits her
 * there, and the cut op, which drops the seat, lands her there. The trap
 * step read her walk toward the seat, a square on from where the cut left
 * her, and a sphere round that square hit her though she landed outside
 * it. What rides on her, seen or hidden, goes with her.
 */

const deps = { canUseAsset: () => true };
/** A stop trap that hits `hits` for damage, so each springing leaves an occurrence naming whom it hits. */
const rig = (hits: NonNullable<Trap["rig"]>["hits"]): NonNullable<Trap["rig"]> => ({ on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits, damage: [{ formula: "1d6", type: "piercing" }], actions: [], find: [], notice: false });

/** The move applied, taken, and the trap step's landing of each token, which every token's stored pose must equal. */
function landedAsJudged(s: RoomState, op: OpOf<"token.move">, actor: Viewer, at: string): RoomState {
  assert.ok(canApply(op, actor, s, deps).ok, `${at}: taken`);
  const r = applyOp(s, op, actor, env(1));
  assert.ok(r.ok, at);
  const landed = trapLandings(op, s, actor, {});
  for (const id of Object.keys(s.tokens)) {
    const pose = landed.get(id);
    assert.ok(pose, `${at}: the trap step lands ${id}`);
    const t: Token = r.state.tokens[id]!;
    assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `${at}: ${id} where the trap step lands it`);
  }
  return r.state;
}

describe("squares: a stop short of a seated rider's walk's end (HEXOP-ASTRA-1)", () => {
  /** A Large warhorse on 2, 2, Bree riding its bottom-right square, an owl perched on her (hidden from players or not) or none, and `t`. */
  function ride(owl: "none" | "shown" | "hidden", t: Trap): RoomState {
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 20, h: 10 } }) } });
    s.tokens.horse = token("horse", { size: "large", x: 2, y: 2, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.bree = token("bree", { x: 3, y: 3, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    if (owl !== "none") s.tokens.owl = token("owl", { size: "tiny", x: 3, y: 3, name: "Owl", kind: "npc", ownerIds: ["p1"], attached: { to: "bree", kind: "perch" }, ...(owl === "hidden" ? { visibility: "dm" as const } : {}) });
    s.traps.t = t;
    return s;
  }
  const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 10, y: 2, seat: { tokenId: "bree", x: 10, y: 2 } };

  test("a stop trap on 10, 2 stops the warhorse on 9, 2: Bree lands on her own seat, 10, 3, where the trap step read her, and a sphere round 9.5, 2.5 hits the warhorse alone", () => {
    const ball = { area: { shape: "sphere" as const, size: 1, origin: { x: 9.5, y: 2.5, z: 0 }, yaw: 0, includeOrigin: true } };
    for (const owl of ["none", "shown", "hidden"] as const) {
      for (const actor of [P1, DM]) {
        const at = `owl ${owl}, ${actor.role}`;
        const s = ride(owl, trap("t", { zone: { cells: [{ x: 10, y: 2, w: 1, h: 1 }] }, rig: rig(ball) }));
        assert.notEqual(planTrapMove(op, s, actor, {}).op, op, `${at}: the trap cuts the walk`);
        const after = landedAsJudged(s, op, actor, at);
        assert.deepEqual([after.tokens.horse!.x, after.tokens.horse!.y], [9, 2], `${at}: the warhorse stopped`);
        assert.deepEqual([after.tokens.bree!.x, after.tokens.bree!.y], [10, 3], `${at}: Bree on her own seat`);
        if (owl !== "none") assert.deepEqual([after.tokens.owl!.x, after.tokens.owl!.y], [10, 3], `${at}: the owl on her`);
        const due = after.traps.t!.rig!.due ?? [];
        assert.equal(due.length, 1, `${at}: it went off`);
        assert.deepEqual(due[0]!.hits, ["horse"], `${at}: the sphere hits the warhorse alone`);
        assert.deepEqual(trapHits(s.traps.t!, after, ["horse"]), ["horse"], `${at}: as it hits them where they landed`);
        // The same op with no seat stops alike.
        const { seat: _seat, ...bare } = op;
        const plain = applyOp(s, bare, actor, env(1));
        assert.ok(plain.ok);
        assert.deepEqual(after.tokens, plain.state.tokens, `${at}: as with no seat`);
      }
    }
  });

  test("Bree dragging a goblin, by the DM's drop: a stop short lands the goblin beside her where the trap step had it too", () => {
    for (const actor of [P1, DM]) {
      const s = ride("none", trap("t", { zone: { cells: [{ x: 10, y: 2, w: 1, h: 1 }] }, rig: rig("trigger") }));
      s.tokens.gob = token("gob", { x: 4, y: 3, name: "Goblin", kind: "monster", attached: { to: "bree", kind: "drag" } });
      assert.notEqual(planTrapMove(op, s, actor, {}).op, op, `${actor.role}: the trap cuts the walk`);
      const after = landedAsJudged(s, op, actor, actor.role);
      const { seat: _seat, ...bare } = op;
      const plain = applyOp(s, bare, actor, env(1));
      assert.ok(plain.ok);
      assert.deepEqual(after.tokens, plain.state.tokens, `${actor.role}: as with no seat`);
    }
  });

  test("a stop trap the walk reaches on its last square leaves the walk whole, and Bree sits where she was dropped", () => {
    for (const owl of ["none", "shown", "hidden"] as const) {
      for (const actor of [P1, DM]) {
        const at = `owl ${owl}, ${actor.role}`;
        const s = ride(owl, trap("t", { zone: { cells: [{ x: 11, y: 2, w: 1, h: 1 }] }, rig: rig("trigger") }));
        assert.equal(planTrapMove(op, s, actor, {}).op, op, `${at}: no cut`);
        const after = landedAsJudged(s, op, actor, at);
        assert.deepEqual([after.tokens.bree!.x, after.tokens.bree!.y], [10, 2], `${at}: Bree where she was dropped`);
        if (owl !== "none") assert.deepEqual([after.tokens.owl!.x, after.tokens.owl!.y], [10, 2], `${at}: the owl on her`);
      }
    }
  });
});

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  describe(`${name}: a stop short of a seated rider's walk's end (HEXOP-ASTRA-1)`, () => {
    /**
     * The keep's open ground, the warhorse full size on 4, 6 with Bree riding its hex nearest the corridor and an owl perched on
     * her, hidden from players or not, walking to a full stand on 3, 10 with Bree dropped on a hex of it her place does not carry
     * her to, and a stop trap on a hex the warhorse enters on the way.
     */
    function cutDrop(grid: HexGrid, owl: "shown" | "hidden"): { s: RoomState; op: OpOf<"token.move"> } {
      const { s, open } = keepOf(grid, 0, 0, "horse");
      delete s.tokens.gob;
      s.tokens.horse = onHex(grid, "horse", "large", { col: 4, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
      const seat = [...occupiedHexes(grid, s.tokens.horse)].sort((a, b) => b.col - a.col || a.row - b.row)[0]!;
      s.tokens.bree = onHex(grid, "bree", "medium", seat, { name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      s.tokens.owl = onHex(grid, "owl", "tiny", seat, { name: "Owl", kind: "npc", ownerIds: ["p1"], attached: { to: "bree", kind: "perch" }, ...(owl === "hidden" ? { visibility: "dm" as const } : {}) });
      const stand = { size: "large" as const, ref: { col: 3, row: 10 }, squeezed: false };
      assert.ok(hexStandHexes(grid, stand).every(open), "the stand lies on open ground");
      const to = hexStandPlace(grid, s.tokens.horse, stand);
      const own = seatedAt(grid, s.tokens.bree, s.tokens.horse, to, false);
      const dropped = hexPlacements(grid, s.tokens.bree, occupiedHexes(grid, { ...s.tokens.horse, ...to })).map((p) => p.spot).find((p) => Math.abs(p.x - own.x) > 1e-9 || Math.abs(p.y - own.y) > 1e-9)!;
      const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", ...to, seat: { tokenId: "bree", x: dropped.x, y: dropped.y } };
      // A hex the warhorse enters a step before its stand, so the stop falls where Bree's walk toward the dropped hex had already
      // left her own seat: 4, 9 on rows, 4, 8 on columns.
      const late = grid.orient === "rows" ? { col: 4, row: 9 } : { col: 4, row: 8 };
      const spots = trapWalks(op, s, DM, {}).find((w) => w.tokenId === "horse")!.spots;
      assert.ok(spots.slice(1, -1).some((p) => occupiedHexes(grid, { ...s.tokens.horse!, ...p }).some((h) => hexKey(h) === hexKey(late))), "the warhorse enters it on the way");
      s.traps.stop = trap("stop", { grid: grid.orient === "rows" ? "hexRows" : "hexColumns", zone: { cells: [{ x: late.col, y: late.row, w: 1, h: 1 }] }, rig: rig("zone") });
      return { s, op };
    }

    test("the warhorse stops short: Bree and her owl land on her own seat on its stand there, where the trap step read and hit them, by Pat and by the DM", () => {
      for (const owl of ["shown", "hidden"] as const) {
        for (const actor of [P1, DM]) {
          const at = `owl ${owl}, ${actor.role}`;
          const { s, op } = cutDrop(g, owl);
          assert.notEqual(planTrapMove(op, s, actor, {}).op, op, `${at}: the trap cuts the walk`);
          const after = landedAsJudged(s, op, actor, at);
          const { seat: _seat, ...bare } = op;
          const plain = applyOp(s, bare, actor, env(1));
          assert.ok(plain.ok);
          assert.deepEqual(after.tokens, plain.state.tokens, `${at}: as with no seat`);
          const due = after.traps.stop!.rig!.due ?? [];
          assert.equal(due.length, 1, `${at}: it went off`);
          assert.deepEqual(due[0]!.hits, trapHits(s.traps.stop!, after, due[0]!.by), `${at}: it hits them where they landed`);
        }
      }
    });
  });
}
