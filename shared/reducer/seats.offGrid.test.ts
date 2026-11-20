import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { seatsFromSnappedFull } from "../migrate.ts";
import type { RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { SQUARES } from "../rules/grid.ts";
import { planMove, wayOf } from "../rules/moveLeg.ts";
import { seatShift } from "../rules/route.ts";
import { env, member, P1, P2, room, scene, token } from "../testutil.ts";

/**
 * A mount that stands full size half a square off the grid of squares, as a
 * Large creature's walk on half squares leaves it, stands on its snapped
 * box, and its riders sit on that box's squares (RIDER-LED-HALF-SEAT, op
 * version 41). A warhorse at 1.5, 8 stands on 2, 8 to 4, 10, with Brom on
 * its left column at 2, 9. A walk by half a square to 6, 8 carried Brom by
 * the stored box to 6.5, 9, which rounds onto the right column, so the
 * prisoner he leads by his place at 4.5 squares off fell out of reach, and
 * a rider on the right column rounded off the mount's box. From 41 the
 * seats go by the snapped box, so each keeps its square, and older ops
 * replay as they were written.
 */

function field(riders: readonly [string, number, number, Partial<Token>?][], mount: Partial<Token> = { x: 1.5, y: 8 }): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 26, h: 18 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  s.tokens.horse = token("horse", { size: "large", name: "Warhorse", kind: "npc", ownerIds: ["p1"], ...mount });
  for (const [id, x, y, over] of riders) s.tokens[id] = token(id, { x, y, name: id, kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride" }, ...over });
  return s;
}

function leading(s: RoomState, rider: string, x: number, y: number): RoomState {
  return { ...s, tokens: { ...s.tokens, led: token("led", { x, y, name: "Prisoner", kind: "npc", attached: { to: rider, kind: "drag" } }) } };
}

const STEP: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 6, y: 8, route: [[6, 8, 1, 0]] };

function moved(s: RoomState, op: OpOf<"token.move">, opVersion?: number): RoomState {
  const allowed = canApply(op, P1, s, { canUseAsset: () => true });
  assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
  const r = applyOp(s, op, P1, { ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

const pose = (s: RoomState, id: string) => [s.tokens[id]!.x, s.tokens[id]!.y, s.tokens[id]!.attached?.to];

describe("squares: a mount full size off its grid carries its riders by its snapped box (RIDER-LED-HALF-SEAT)", () => {
  test("Brom keeps the left column on a walk by half a square, and the prisoner he leads stays in tow", () => {
    const s = leading(field([["brom", 2, 9]]), "brom", 0.5, 9);
    const after = moved(s, STEP, 63);
    assert.deepEqual(pose(after, "brom"), [6, 9, "horse"], "on the left column of the box at 6, 8 to 8, 10");
    assert.deepEqual(pose(after, "led"), [4.5, 9, "brom"], "beside him as before, in reach");
    // From change format 64 the prisoner, half a square off its grid, lands on the nearest square of its own in his reach (D-261120-006).
    const now = moved(s, STEP);
    assert.deepEqual([pose(now, "brom"), pose(now, "led")], [[6, 9, "horse"], [5, 9, "brom"]]);
  });

  test("a rider on the right column stays on the mount, which the stored box rounded it off", () => {
    const after = moved(field([["brom", 3, 9]]), STEP);
    assert.deepEqual(pose(after, "brom"), [7, 9, "horse"]);
  });

  test("along the axis the mount starts on its grid, its offset still carries them", () => {
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 6, y: 8.5, route: [[6, 8.5, 1, 0]] };
    const after = moved(field([["brom", 2, 9]]), op);
    assert.deepEqual(pose(after, "brom"), [6, 9.5, "horse"], "by the snapped box across, by the stored one down");
  });

  test("an op stored before version 41 carries them by the stored box, so it replays as it was written", () => {
    const led = moved(leading(field([["brom", 2, 9]]), "brom", 0.5, 9), STEP, 40);
    assert.deepEqual([pose(led, "brom"), pose(led, "led")], [[6.5, 9, "horse"], [5, 9, undefined]], "the prisoner let go");
    assert.deepEqual(pose(moved(field([["brom", 3, 9]]), STEP, 40), "brom"), [7.5, 9, undefined], "off the mount's box");
    assert.deepEqual([seatsFromSnappedFull(40), seatsFromSnappedFull(41), seatsFromSnappedFull(undefined)], [false, true, true]);
  });

  test("a device's route search and cut read the reducer's seat for the rider and what he leads (route.ts seatShift)", () => {
    const s = leading(field([["brom", 2, 9]]), "brom", 0.5, 9);
    // Where each one's walk ends (moveLeg.ts wayOf), which from change format 64 a drag that cannot end there leaves on arriving.
    const walks = planMove(STEP, s, P1, {});
    const horse = { ...s.tokens.horse!, id: "horse" };
    for (const id of ["brom", "led"]) {
      const by = seatShift(SQUARES, horse, (m) => s.tokens[m], id, { x: 6, y: 8 }, false);
      const start = s.tokens[id]!;
      const way = wayOf(walks.find((m) => m.tokenId === id)!).route;
      assert.deepEqual([6 + start.x - 1.5 + by.x, 8 + start.y - 8 + by.y], [way.at(-1)!.x, way.at(-1)!.y], id);
    }
  });

  test("a mount that starts on the grid seats them by their offset as before, every point of its walk", () => {
    const s = field([["brom", 3, 9]], { x: 2, y: 8 });
    const op: OpOf<"token.move"> = { t: "token.move", tokenId: "horse", x: 6.5, y: 8, route: [[4.5, 8, 0, 0], [6.5, 8, 0, 0]] };
    for (const opVersion of [40, undefined]) assert.deepEqual(pose(moved(s, op, opVersion), "brom"), [7.5, 9, "horse"], `op version ${opVersion}`);
    // So a device's walk reads no seat of its own at a point half a square off the grid either.
    const horse = { ...s.tokens.horse!, id: "horse" };
    for (const at of [{ x: 4.5, y: 8 }, { x: 6.5, y: 8 }]) assert.deepEqual(seatShift(SQUARES, horse, (m) => s.tokens[m], "brom", at, false), { x: 0, y: 0 }, `${at.x}, ${at.y}`);
  });

  test("a seat reads its own rider and the mount alone, so a rider players cannot see changes nothing they are sent", () => {
    const shown = leading(field([["brom", 2, 9]]), "brom", 0.5, 9);
    const both = leading(field([["brom", 2, 9], ["shade", 3, 8, { kind: "npc", ownerIds: [], visibility: "dm" }]]), "brom", 0.5, 9);
    const a = moved(shown, STEP);
    const b = moved(both, STEP);
    assert.deepEqual(pose(b, "shade"), [7, 8, "horse"], "the hidden rider keeps its square too");
    for (const viewer of [P1, P2]) assert.equal(stableStringify(projectState(b, viewer, { sceneId: "s1" }).tokens), stableStringify(projectState(a, viewer, { sceneId: "s1" }).tokens), viewer.memberId);
  });
});
