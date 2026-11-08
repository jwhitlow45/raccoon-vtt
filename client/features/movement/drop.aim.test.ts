import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights, wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { canApply } from "#shared/permissions.ts";
import { footprintRect, occupiedHexes, placedOnHex } from "#shared/rules/footprint.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexAt, hexCenter, hexKey, sceneHexes, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { findRouteOn } from "#shared/rules/hexWalk.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { ownWalk } from "#shared/rules/movement.ts";
import { groupWalkWorld } from "#shared/rules/walkWorld.ts";
import { applyOp } from "#shared/reducer.ts";
import { apply, env, P1, room, scene, token } from "#shared/testutil.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { RoomScope } from "../../state/scope.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { cutRoute, moveOpsOf, planGroup, planOne, pressedAim, routeTarget, stopText, walkersStop, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";
import { holdSlot } from "./store.ts";
import { seenRoom } from "./testing.ts";

/**
 * Where a rider's drag aims its mount (live play LP25-A-RIDE-2,
 * D-261029-57): at the stand that keeps the rider's dropped middle on it,
 * the full stand where it fits, else the squeezed stand whose squares or
 * hexes hold that middle. The mount's box at the pointer's offset lay
 * across the corridor's wall on squares and on the rock beside it on
 * hexes, from every seat but the lead one, so the drag stopped at the
 * corridor's mouth. The walking ruler from the rider reads the same aim.
 */

/** Rock from x 8 to 16 but for a corridor along rows 10 to 10 + `wide`, walled round, each wall at most 8 squares long as the protocol takes one, the warhorse in the hall west of it. */
function squareCorridor(wide: 1 | 2): RoomState {
  const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  const bottom = 10 + wide;
  const below = (bottom + 20) / 2;
  const runs: [[number, number], [number, number]][] = [
    ...[8, 16].flatMap((x): [[number, number], [number, number]][] => [[[x, 0], [x, 5]], [[x, 5], [x, 10]], [[x, bottom], [x, below]], [[x, below], [x, 20]]]),
    [[8, 10], [16, 10]],
    [[8, bottom], [16, bottom]],
  ];
  runs.forEach(([a, b], i) => wall(s, `fu36aa${String(i).padStart(6, "0")}`, a, b));
  s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  return s;
}

function riding(s: RoomState, at: { x: number; y: number }): RoomState {
  return { ...s, tokens: { ...s.tokens, brom: token("brom", { ...at, name: "Brom", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }) } };
}

/** The mount's aim with Brom's box dropped so his middle is at `middle`: its box by the pointer's offset, and his middle. */
function aimFor(s: RoomState, middle: { x: number; y: number }) {
  const view = seenRoom(s);
  const horse = s.tokens.horse!;
  const brom = s.tokens.brom!;
  const box = { x: middle.x - 0.5 + horse.x - brom.x, y: middle.y - 0.5 + horse.y - brom.y };
  return { view, horse, aim: pressedAim(view, horse, brom, box) };
}

const searchFrom = (s: RoomState, to: { x: number; y: number }) => findRouteOn(groupWalkWorld(s, ownWalk(s.tokens.horse!), { role: "player" }).input, to);
const offsets = [0.1, 0.5, 0.9];
const SQUARE_SEATS: [number, number][] = [[3, 9], [4, 9], [3, 10], [4, 10]];

describe("squares: a rider's drag aims its mount at the stand that keeps the rider's middle on it", () => {
  test("into a corridor one square wide from every seat: the squeezed square under the rider's middle, which the route search reaches", () => {
    for (const seat of SQUARE_SEATS) {
      const s = riding(squareCorridor(1), { x: seat[0], y: seat[1] });
      for (const fx of offsets) {
        for (const fy of offsets) {
          const middle = { x: 12 + fx, y: 10 + fy };
          const { view, horse, aim } = aimFor(s, middle);
          assert.ok(Math.abs(aim.seat!.x - middle.x) < 1e-9 && Math.abs(aim.seat!.y - middle.y) < 1e-9, "the rider's dropped middle");
          const target = routeTarget(view, horse, aim);
          assert.equal(target.squeeze, true, `seat ${seat}: squeezed`);
          assert.deepEqual(footprintRect(SQUARES, { ...horse, x: target.x, y: target.y, squeeze: true }), { x: 12, y: 10, w: 1, h: 1 }, `seat ${seat}, middle ${middle.x}, ${middle.y}: on the rider's square`);
          assert.notEqual(searchFrom(s, target), "none", `seat ${seat}: the search finds the corridor`);
        }
      }
    }
  });

  test("into a corridor two squares wide from a lower seat: the full stand in the corridor that holds the rider's middle", () => {
    const s = riding(squareCorridor(2), { x: 3, y: 10 });
    const { view, horse, aim } = aimFor(s, { x: 12.5, y: 10.5 });
    const target = routeTarget(view, horse, aim);
    assert.deepEqual(target, { x: 12, y: 10, squeeze: false }, "full size, in the corridor's two rows");
    assert.notEqual(searchFrom(s, target), "none");
  });

  test("a Huge mount into a corridor two squares wide from every seat: the squeezed two by two in the corridor that holds the rider's middle", () => {
    const base = squareCorridor(2);
    const huge = { ...base, tokens: { ...base.tokens, horse: { ...base.tokens.horse!, size: "huge" as const, x: 2, y: 8 } } };
    for (const y of [8, 9, 10]) {
      for (const x of [2, 3, 4]) {
        const s = riding(huge, { x, y });
        for (const middle of [{ x: 12.5, y: 10.5 }, { x: 12.5, y: 11.5 }]) {
          const { view, horse, aim } = aimFor(s, middle);
          const target = routeTarget(view, horse, aim);
          const r = footprintRect(SQUARES, { ...horse, x: target.x, y: target.y, squeeze: true });
          assert.equal(target.squeeze, true, `seat ${x}, ${y}`);
          assert.ok(r.y === 10 && r.h === 2 && r.x <= middle.x && middle.x < r.x + 2, `seat ${x}, ${y}, middle ${middle.x}, ${middle.y}: ${JSON.stringify(r)} in the corridor under the rider`);
          assert.notEqual(searchFrom(s, target), "none", `seat ${x}, ${y}: the search finds the corridor`);
        }
      }
    }
  });

  test("on open ground the full stand where the mount was dropped, as a drag without a rider lands it", () => {
    for (const seat of SQUARE_SEATS) {
      const s = riding(squareCorridor(1), { x: seat[0], y: seat[1] });
      const { view, horse, aim } = aimFor(s, { x: 4.4, y: 4.7 });
      const plain = planOne(view, horse, { x: aim.x, y: aim.y }, "free").moves[0]!;
      const aimed = planOne(view, horse, aim, "free").moves[0]!;
      assert.deepEqual([aimed.x, aimed.y, aimed.squeeze], [plain.x, plain.y, plain.squeeze], `seat ${seat}`);
    }
  });

  test("only a token sitting on the lead aims it: one it drags beside it, or the lead itself, aims by the box alone", () => {
    const s = riding(squareCorridor(1), { x: 4, y: 10 });
    const owl = token("owl", { size: "tiny", x: 4.5, y: 10.5, name: "Pip", kind: "npc", attached: { to: "brom", kind: "perch" } });
    const gob = token("gob", { x: 5, y: 9, name: "Goblin", attached: { to: "brom", kind: "drag" } });
    const view = seenRoom({ ...s, tokens: { ...s.tokens, owl, gob } });
    const horse = view.tokens.horse!;
    assert.deepEqual(pressedAim(view, horse, owl, { x: 10, y: 9 }).seat, { x: 10 + 1.5 + 0.25, y: 9 + 1.5 + 0.25 }, "a perch on the rider, two deep");
    assert.equal(pressedAim(view, horse, gob, { x: 10, y: 9 }).seat, undefined, "a creature dragged beside the rider");
    assert.equal(pressedAim(view, horse, horse, { x: 10, y: 9 }).seat, undefined, "the mount itself");
    assert.equal(pressedAim(view, horse, null, { x: 10, y: 9 }).seat, undefined);
  });

  test("the drag's stops aim the mount by the token it was pressed on: a drop from the far seat goes into the corridor", () => {
    const s = riding(squareCorridor(1), { x: 4, y: 10 });
    const horse = s.tokens.horse!;
    const brom = s.tokens.brom!;
    // Brom's box dropped with his middle on the corridor's square 12, 10, the warhorse's node at the same offset.
    const node = { x: () => 12.12 - 0.5 + horse.x - brom.x, y: () => 10.18 - 0.5 + horse.y - brom.y, position: () => {} };
    const drop = (pressed?: Token, framed = true): DropPlan => {
      const b = board(s);
      b.stops.start(horse.id, pressed);
      if (framed) b.stops.frame(node, horse);
      let plan: DropPlan | null = null;
      b.stops.drop(node, horse, [horse], (p) => (plan = p));
      for (let i = 0; i < 50 && !plan; i++) b.frames.frame();
      assert.ok(plan, "the drop landed");
      return plan;
    };
    for (const framed of [true, false]) {
      const aimed = drop(brom, framed).moves.find((m) => m.tokenId === "horse")!;
      assert.equal(aimed.squeeze, true);
      assert.deepEqual(footprintRect(SQUARES, { ...horse, x: aimed.x, y: aimed.y, squeeze: true }), { x: 12, y: 10, w: 1, h: 1 }, `in the corridor, Brom's square, ${framed ? "after a frame" : "dropped at once"}`);
    }
    // Pressed on the warhorse itself the same box goes as it lies, which keeps Brom's dropped middle on no square of it.
    const plain = drop().moves.find((m) => m.tokenId === "horse");
    assert.ok(!plain || plain.squeeze !== true || footprintRect(SQUARES, { ...horse, x: plain.x, y: plain.y, squeeze: true }).x !== 12, "not by Brom's middle");
  });

  test("the walking ruler from the rider, as every player reads it, walks into the corridor from every seat", () => {
    for (const seat of SQUARE_SEATS) {
      const s = riding(squareCorridor(1), { x: seat[0], y: seat[1] });
      const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "brom" }, { x: 12.5, y: 10.5 }], viewer: { role: "player" }, everything: false })!;
      const leg = m.legs[0]!;
      assert.equal(leg.none, false, `seat ${seat}: a way in`);
      assert.deepEqual([leg.to.x, leg.to.y], [12, 10], `seat ${seat}: the leg ends on the stop's square, where Brom sits`);
    }
  });
});

/**
 * A mount dragging a creature into a corridor one square wide stops where
 * every walker may stand (live play LP28-B-RIDE-1): the goblin cannot
 * follow, so the walk is cut short, and the cut lands full size, so it
 * stands where a lone drop's walk would, on the mount's own whole squares.
 * It stopped at x 4.5, across the corridor's west wall, and the server took
 * it. The corridor runs along row 6 through rock from x 6 to 14.
 */
function dragCorridor(): RoomState {
  const s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 12 }, blockMovement: true, autoWalls: "off" }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [[[6, 0], [6, 6]], [[6, 7], [6, 12]], [[14, 0], [14, 6]], [[14, 7], [14, 12]], [[6, 6], [14, 6]], [[6, 7], [14, 7]]];
  runs.forEach(([a, b], i) => wall(s, `fu44ba${String(i).padStart(6, "0")}`, a, b));
  s.tokens.horse = token("horse", { size: "large", x: 2, y: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  return s;
}

const takes = (s: RoomState, plan: DropPlan) => moveOpsOf(plan.moves).every((op) => canApply(op, P1, s, { canUseAsset: () => true }).ok);

/** The drag of the mount, pressed on `pressed` or on the mount, dropped with its box at `box`, as the board plans it, and whether the picture held it before the drop. */
function dropOf(s: RoomState, box: { x: number; y: number }, pressed?: Token, role: DragDeps["role"] = "player"): { plan: DropPlan | null; held: boolean } {
  const node = { x: () => box.x, y: () => box.y, position: () => {} };
  const b = board(s, role);
  const horse = s.tokens.horse!;
  b.stops.start(horse.id, pressed);
  for (let i = 0; i < 50; i++) {
    b.stops.frame(node, horse);
    b.frames.frame();
  }
  const held = b.hold() !== null;
  let plan: DropPlan | null = null;
  b.stops.drop(node, horse, [horse], (p) => (plan = p));
  for (let i = 0; i < 50 && !plan; i++) b.frames.frame();
  return { plan, held };
}

describe("squares: a mount dragging a goblin into a corridor one square wide (LP28-B-RIDE-1, D-261101-250)", () => {
  test("ridden or not, pressed on the rider or the mount, from on the grid or half a square off it, the goblin follows it in single file and the server takes it", () => {
    for (const x of [2, 2.5]) for (const ridden of [true, false]) {
      const base = dragCorridor();
      base.tokens.horse = { ...base.tokens.horse!, x };
      base.tokens.gob = token("gob", { x: x - 1, y: 6, name: "Goblin", kind: "npc", attached: { to: "horse", kind: "drag" } });
      const s = ridden ? riding(base, { x, y: 5 }) : base;
      for (const box of [{ x: 9.5, y: 5.5 }, { x: 10.2, y: 5.7 }, { x: 11.6, y: 5.9 }]) {
        for (const pressed of ridden ? [s.tokens.brom, undefined] : [undefined]) {
          const at = `from ${x}, ridden ${ridden}, pressed ${pressed?.id ?? "horse"}, box ${box.x}, ${box.y}`;
          const { plan, held } = dropOf(s, box, pressed);
          assert.ok(plan, `${at}: the drop landed`);
          assert.equal(held, false, `${at}: the picture holds it nowhere on the way`);
          const landed = plan.moves.find((m) => m.tokenId === "horse");
          assert.ok(landed && landed.squeeze === true && landed.y === 5.5 && landed.x > 6, `${at}: squeezed in the corridor, ${JSON.stringify(landed)}`);
          assert.equal(plan.stop, null, `${at}: nothing holds it`);
          assert.ok(takes(s, plan), `${at}: the server takes it`);
          const op = moveOpsOf(plan.moves)[0]!;
          const r = applyOp(s, op, P1, env(1));
          assert.ok(r.ok);
          // Its squeezed square starts half a square into its box, so the goblin's square is the one before it.
          assert.deepEqual([r.state.tokens.gob!.x, r.state.tokens.gob!.y, r.state.tokens.gob!.attached?.to], [landed.x - 0.5, 6, "horse"], `${at}: the goblin right behind it`);
        }
      }
    }
  });
});

describe("squares: two goblins the mount drags, where the corridor has room in reach for one (D-261101-397, review FU45BR-OPUS-1)", () => {
  test("the drop holds at the corridor's mouth and names the one the file would leave out of reach, and what it sends keeps both", () => {
    const s = dragCorridor();
    s.tokens.gob = token("gob", { x: 1, y: 7, name: "Goblin", kind: "npc", attached: { to: "horse", kind: "drag" } });
    s.tokens.imp = token("imp", { x: 3, y: 7, name: "Imp", kind: "npc", attached: { to: "horse", kind: "drag" } });
    const { plan } = dropOf(s, { x: 9.5, y: 5.5 });
    assert.ok(plan, "the drop landed");
    const horse = plan.moves.find((m) => m.tokenId === "horse");
    assert.ok(horse && horse.squeeze === undefined && horse.x < 6, `held short of the corridor, full size: ${JSON.stringify(horse)}`);
    // The imp is the nearer, so first in line, and the goblin behind it would end 10 ft from the horse.
    assert.equal(plan.stop && stopText(plan.stop), "Goblin can't follow through there.");
    assert.ok(takes(s, plan), "the server takes it");
    const r = applyOp(s, moveOpsOf(plan.moves)[0]!, P1, env(1));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.gob!.attached?.to, r.state.tokens.imp!.attached?.to], ["horse", "horse"], "both still in tow");
  });
});

describe("squares: heights in single file (review FU45B-ASTRA-02)", () => {
  /** The horse drags an ogre in the air, which drags a goblin, over ground the goblin's offset would read under the ogre, and a low ledge on the goblin's own walk in the file. */
  function nested(): RoomState {
    const s = dragCorridor();
    heights(s, { x: 2, y: 4, w: 7, h: 1 }, 10);
    heights(s, { x: 2, y: 7, w: 1, h: 1 }, 2);
    s.tokens.ogre = token("ogre", { size: "large", x: 0, y: 5, elevation: 5, name: "Ogre", kind: "npc", attached: { to: "horse", kind: "drag" } });
    s.tokens.gob = token("gob", { x: 1, y: 7, elevation: 5, name: "Goblin", kind: "npc", attached: { to: "ogre", kind: "drag" } });
    return s;
  }

  test("the drop's own check of the file reads each holder where it walks, so the goblin meets the ledge and the walk is cut", () => {
    const s = nested();
    const points = [{ x: 2, y: 5, elevation: 0 }, { x: 2.5, y: 5.5, elevation: 0 }, { x: 4, y: 5.5, elevation: 0 }, { x: 9.5, y: 5.5, elevation: 0 }];
    // Cut by their places once one cannot follow in the file (D-261101-371), so short of the corridor.
    const cut = walkersStop(s, ownWalk(s.tokens.horse!), points, [s.tokens.ogre!, s.tokens.gob!], { squeeze: true });
    assert.ok(cut && cut.at.x < 6, `cut short of the corridor: ${JSON.stringify(cut)}`);
  });

  test("a goblin an ogre drags behind the horse takes its height from where the ogre walks in the file, as the server does, so the drop is one the server takes", () => {
    const s = nested();
    const { plan } = dropOf(s, { x: 9.5, y: 5.5 });
    assert.ok(plan, "the drop landed");
    assert.ok(takes(s, plan), `the server takes what the drop sends: ${JSON.stringify(plan.moves)}, stop ${JSON.stringify(plan.stop)}`);
    // The whole way in is the server's to refuse: the goblin, on its own ground behind an ogre on its own, meets the ledge.
    const whole = { t: "token.move" as const, tokenId: "horse", x: 9.5, y: 5.5, squeeze: true as const, route: [[2.5, 5.5, 1, 0], [4, 5.5, 1, 0], [9.5, 5.5, 2, 0]] as [number, number, number, 0 | 1][] };
    assert.deepEqual(canApply(whole, P1, s, { canUseAsset: () => true }), { ok: false, code: "forbidden", message: "A ledge is in the way." });
    assert.deepEqual([plan.moves.map((m) => [m.tokenId, m.x, m.y, m.squeeze]), plan.stop && stopText(plan.stop)], [[["horse", 3, 5, undefined]], "Goblin can't follow through there."], "so the drop stops short and names it");
  });
});

describe("squares: a walk that ends squeezed where a creature it drags cannot fall in behind (D-261101-250)", () => {
  test("is cut, by their places, since a cut lands full, even where their places would walk the whole way", () => {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 12 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    // On the goblin's line straight onto the horse's, short of the horse's core and of the goblin's walk beside it.
    wall(s, "fu45bc000000", [2, 6.25], [2, 418 / 64]);
    s.tokens.horse = token("horse", { size: "large", x: 2, y: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.gob = token("gob", { x: 1, y: 6, name: "Goblin", kind: "npc", attached: { to: "horse", kind: "drag" } });
    const points = [{ x: 2, y: 5, elevation: 0 }, { x: 6.5, y: 5.5, elevation: 0 }];
    assert.equal(walkersStop(s, ownWalk(s.tokens.horse), points, [s.tokens.gob], { squeeze: false }), null, "by its place it walks the whole way");
    const cut = walkersStop(s, ownWalk(s.tokens.horse), points, [s.tokens.gob], { squeeze: true });
    assert.ok(cut && cut.blocker === "wall" && cut.at.x < 6.5, `cut short: ${JSON.stringify(cut)}`);
  });
});

describe("squares: a walk that ends full size where its box would reach through a wall stops short of it (LP28-B-RIDE-1)", () => {
  test("ridden or not, pressed on the rider or the mount, from on the grid or half a square off it, a goblin that cannot fall in behind stops the walk at 4, 5 west of the rock and is named", () => {
    // At 4.5 its core is clear of the rock and its box reaches over the wall at x 6.
    for (const x of [2, 2.5]) for (const ridden of [true, false]) {
      const base = dragCorridor();
      base.tokens.horse = { ...base.tokens.horse!, x };
      // Above its left side, and a stub across the goblin's way down onto the mount's line, clear of the mount's core and of the goblin's walk beside it.
      base.tokens.gob = token("gob", { x: x - 1, y: 4, name: "Goblin", kind: "npc", attached: { to: "horse", kind: "drag" } });
      wall(base, "fu45bs000000", [x + 0.25, 5.625], [x + 0.625, 5.25]);
      const s = ridden ? riding(base, { x, y: 5 }) : base;
      const horse = s.tokens.horse!;
      for (const box of [{ x: 9.5, y: 5.5 }, { x: 10.2, y: 5.7 }, { x: 11.6, y: 5.9 }]) {
        for (const pressed of ridden ? [s.tokens.brom, undefined] : [undefined]) {
          const node = { x: () => box.x, y: () => box.y, position: () => {} };
          const b = board(s);
          b.stops.start(horse.id, pressed);
          b.stops.frame(node, horse);
          let plan: DropPlan | null = null;
          b.stops.drop(node, horse, [horse], (p) => (plan = p));
          for (let i = 0; i < 50 && !plan; i++) b.frames.frame();
          const at = `from ${x}, ridden ${ridden}, pressed ${pressed?.id ?? "horse"}, box ${box.x}, ${box.y}`;
          assert.ok(plan, `${at}: the drop landed`);
          const landed = (plan as DropPlan).moves.find((m) => m.tokenId === "horse");
          assert.ok(landed, `${at}: the mount moved`);
          assert.deepEqual([landed.x, landed.y, landed.squeeze], [4, 5, undefined], `${at}: the last whole square before the rock, full size`);
          assert.equal(stopText((plan as DropPlan).stop!), "Goblin can't follow through there.", at);
          assert.ok(takes(s, plan as DropPlan), `${at}: the server takes it`);
        }
      }
    }
  });

  test("in the open a cut half a square off the grid still stands where the box is clear: a goblin a short wall stops lands the mount at 7.5, 5", () => {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 12 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    // Only in the goblin's row, below the warhorse's box: the goblin's middle meets it once the warhorse reaches x 8.
    wall(s, "fu44bo000000", [7.5, 7.25], [7.5, 8]);
    s.tokens.horse = token("horse", { size: "large", x: 2, y: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.gob = token("gob", { x: 1, y: 7, name: "Goblin", kind: "npc", attached: { to: "horse", kind: "drag" } });
    const cut = walkersStop(s, ownWalk(s.tokens.horse), [{ x: 2, y: 5, elevation: 0 }, { x: 12, y: 5, elevation: 0 }], [s.tokens.gob]);
    assert.deepEqual([cut?.at.x, cut?.at.y], [7.5, 5], "on the walk's half-square lattice, clear of every wall");
  });

  test("a mount that stands half a square off the grid, walked into the rock's face, stops where its box is clear of the wall, not half through it", () => {
    const base = dragCorridor();
    const s = { ...base, tokens: { horse: { ...base.tokens.horse!, x: 2.5, y: 9.5 } } };
    const view = seenRoom(s);
    const plan = planOne(view, view.tokens.horse!, { x: 10, y: 9.5 }, "walk");
    assert.deepEqual(plan.moves.map((m) => [m.x, m.y, m.squeeze]), [[3.5, 9.5, undefined]], "its core stays clear a square further, at 4.5, where its box would reach over the wall at x 6");
    assert.deepEqual(plan.stop?.at, { x: 3.5, y: 9.5 });
    assert.ok(takes(s, plan));
  });

  test("a creature the walker drags stands where the walk ends as the server takes it: a Large brute off the grid is never left with a wall through its box (review FU44-OPUS-1)", () => {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 16 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    // The brute half a square east of its holder's grid, so a square east it stands at 17.5, its box over this wall and its core clear.
    wall(s, "fu44fd000000", [19, 14], [19, 16]);
    s.tokens.pc = token("pc", { x: 16, y: 13, name: "Pc", kind: "pc", ownerIds: ["p1"] });
    s.tokens.brute = token("brute", { size: "large", x: 16.5, y: 14, name: "Brute", kind: "npc", attached: { to: "pc", kind: "drag" } });
    const cut = walkersStop(s, ownWalk(s.tokens.pc), [{ x: 16, y: 13, elevation: 0 }, { x: 20, y: 13, elevation: 0 }], [s.tokens.brute]);
    assert.deepEqual([cut?.at.x, cut?.at.y, cut?.blocker], [16, 13, "wall"], "held where it stands");
    const view = seenRoom(s);
    const group = planGroup(view, [view.tokens.pc!], 1, 0, "walk", () => [view.tokens.brute!]);
    assert.deepEqual([group.moves.length, group.held.map((h) => h.token.id)], [0, ["pc"]], "a group drag a square east holds it");
    const north = planGroup(view, [view.tokens.pc!], 0, -1, "walk", () => [view.tokens.brute!]);
    assert.deepEqual(north.moves.map((m) => [m.x, m.y]), [[16, 12]]);
    assert.ok(takes(s, north) && !canApply({ t: "token.moveMany", moves: [{ tokenId: "pc", x: 17, y: 13 }] }, P1, s, { canUseAsset: () => true }).ok, "as the server judges both");
  });

  test("a walk past 64 pieces from half a square off the grid is cut where the mount's box is clear of the wall, on a player's walk", () => {
    const base = dragCorridor();
    const s = { ...base, tokens: { horse: { ...base.tokens.horse!, x: 2.5, y: 9.5 } } };
    // Back and forth along row 9.5, the 64th piece ending at 4.5, where the box would reach over the wall at x 6.
    const pieces = Array.from({ length: 65 }, (_, i): [number, number, number, 0 | 1] => [i % 2 === 0 ? 3.5 : 4.5, 9.5, 0, 0]);
    const player = cutRoute(seenRoom(s), s.tokens.horse!, pieces);
    assert.deepEqual([player?.at, player?.pieces.length], [{ x: 3.5, y: 9.5, squeeze: false }, 63]);
    const dm = cutRoute(seenRoom(s, "dm"), s.tokens.horse!, pieces);
    assert.deepEqual([dm?.at, dm?.pieces.length], [{ x: 4.5, y: 9.5, squeeze: false }, 64], "the DM's walk meets no walls");
  });
});

for (const [name, g] of [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const) {
  // Along the corridor and across it, by orientation: hex columns read rows' columns as rows.
  const at = (along: number, across: number): Hex => (g.orient === "rows" ? { col: along, row: across } : { col: across, row: along });
  const solid = (h: Hex) => {
    const along = g.orient === "rows" ? h.col : h.row;
    const across = g.orient === "rows" ? h.row : h.col;
    return along >= 6 && along <= 12 && across !== 6;
  };
  const wide = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };
  const corridor = (): RoomState => {
    const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", wide.w, wide.h, wallsRound(g as HexGrid, wide, solid));
    s.tokens.horse = onHex(g, "horse", "large", at(2, 5), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    return s;
  };

  describe(`${name}: a rider's drag aims its mount at the stand that keeps the rider's middle on it`, () => {
    test("into a corridor one hex wide from every seat: the squeezed hex under the rider's middle, which the route search reaches", () => {
      const base = corridor();
      for (const seatHex of occupiedHexes(g, base.tokens.horse!)) {
        const s = { ...base, tokens: { ...base.tokens, brom: onHex(g, "brom", "medium", seatHex, { name: "Brom", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }) } };
        for (const [dx, dy] of [[0, 0], [0.2, 0.15], [-0.25, 0.1], [0.1, -0.3]] as const) {
          const c = hexCenter(g, at(9, 6));
          const middle = { x: c.x + dx, y: c.y + dy };
          assert.equal(hexKey(hexAt(g, middle)), hexKey(at(9, 6)));
          const { view, horse, aim } = aimFor(s, middle);
          const target = routeTarget(view, horse, aim);
          assert.equal(target.squeeze, true, `seat ${hexKey(seatHex)}: squeezed`);
          assert.deepEqual(occupiedHexes(g, { ...horse, x: target.x, y: target.y, squeeze: true }).map(hexKey), [hexKey(at(9, 6))], `seat ${hexKey(seatHex)}: on the rider's hex`);
          assert.notEqual(searchFrom(s, target), "none", `seat ${hexKey(seatHex)}: the search finds the corridor`);
        }
      }
    });

    test("into a corridor two hexes wide: a Large mount stands full size on the stand in it that holds the rider's middle, a Huge one squeezed onto three hexes", () => {
      const two = (h: Hex) => {
        const along = g.orient === "rows" ? h.col : h.row;
        const across = g.orient === "rows" ? h.row : h.col;
        return along >= 6 && along <= 12 && across !== 6 && across !== 7;
      };
      const inCorridor = (h: Hex) => (g.orient === "rows" ? h.row : h.col) === 6 || (g.orient === "rows" ? h.row : h.col) === 7;
      for (const size of ["large", "huge"] as const) {
        const base = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", wide.w, wide.h, wallsRound(g as HexGrid, wide, two));
        base.tokens.horse = onHex(g, "horse", size, at(2, 6), { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
        for (const seatHex of occupiedHexes(g, base.tokens.horse!)) {
          const s = { ...base, tokens: { ...base.tokens, brom: onHex(g, "brom", "medium", seatHex, { name: "Brom", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }) } };
          for (const goal of [at(9, 6), at(9, 7)]) {
            const { view, horse, aim } = aimFor(s, hexCenter(g, goal));
            const target = routeTarget(view, horse, aim);
            assert.equal(target.squeeze, size === "huge", `${size} from ${hexKey(seatHex)}: ${size === "huge" ? "squeezed" : "full size"}`);
            const hexes = occupiedHexes(g, { ...horse, x: target.x, y: target.y, ...(target.squeeze ? { squeeze: true } : {}) });
            assert.ok(hexes.some((h) => hexKey(h) === hexKey(goal)), `${size} from ${hexKey(seatHex)}: holds the rider's hex`);
            assert.ok(hexes.every(inCorridor), `${size} from ${hexKey(seatHex)} to ${hexKey(goal)}: ${hexes.map(hexKey)} in the corridor`);
            assert.notEqual(searchFrom(s, target), "none", `${size} from ${hexKey(seatHex)}: the search finds the corridor`);
          }
        }
      }
    });

    test("the walking ruler from the rider, as every player reads it, walks into the corridor from every seat", () => {
      const base = corridor();
      for (const seatHex of occupiedHexes(g, base.tokens.horse!)) {
        const s = { ...base, tokens: { ...base.tokens, brom: onHex(g, "brom", "medium", seatHex, { name: "Brom", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }) } };
        const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "brom" }, hexCenter(g, at(9, 6))], viewer: { role: "player" }, everything: false })!;
        const leg = m.legs[0]!;
        assert.equal(leg.none, false, `seat ${hexKey(seatHex)}: a way in`);
        assert.equal(hexKey(occupiedHexes(g, { size: "medium", ...leg.to })[0]!), hexKey(at(9, 6)), `seat ${hexKey(seatHex)}: the leg ends on the stop's hex`);
      }
    });
  });
}

/**
 * A rider's drag where the mount's box at the finger's offset lies across a
 * ledge (guide pass 6, RIDER-DRAG-LEDGE): walls pick the stand that keeps
 * the rider's middle on the mount, never a ledge, so on open ground the
 * mount goes as that box goes. The DM's drop lands it across the rise's
 * edge, and a player's walk is held at the ledge and says so, as a drag of
 * the mount itself does. The seat rule read the ledge as a wall and took
 * the next stand clear of it: a square short on the DM's screen, and on a
 * player's with no word of the ledge. Where ledges make a real narrow
 * space, as along a ridge, the mount still squeezes under the rider.
 */
describe("a rider's drag where the mount's box lies across a ledge (RIDER-DRAG-LEDGE)", () => {
  /** The watchtower's field in the guide's mounted turn: a rise 10 ft up from x 14, the warhorse at 7, 13, Mara riding it, Controlled, on `seat`. */
  function field(seat: readonly [number, number]): RoomState {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    heights(s, { x: 14, y: 4, w: 11, h: 11 }, 10);
    s.tokens.horse = token("horse", { size: "large", x: 7, y: 13, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    s.tokens.mara = token("mara", { x: seat[0], y: seat[1], name: "Mara", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    return s;
  }

  /** Where a plan moves each token, its height and squeeze, and the note after it. */
  const lands = (plan: DropPlan | null) => [plan?.moves.map((m) => [m.tokenId, m.x, m.y, m.elevation ?? null, m.squeeze ?? null]), plan?.stop ? stopText(plan.stop) : null];

  test("squares: from every seat, the DM's drop and a player's walk land the warhorse as a drag of the warhorse itself does", () => {
    for (const seat of SQUARE_SEATS.map(([x, y]) => [x + 4, y + 4] as const)) {
      const s = field(seat);
      for (const role of ["dm", "player"] as const) {
        // The box across the rise's edge at x 14, so Mara's middle is on the low ground or on the rise by her seat.
        for (const box of [{ x: 13, y: 13 }, { x: 13.2, y: 12.9 }, { x: 12.8, y: 13.3 }]) {
          const at = `seat ${seat}, ${role}, box ${box.x}, ${box.y}`;
          const aimed = dropOf(s, box, s.tokens.mara, role).plan;
          assert.deepEqual(lands(aimed), lands(dropOf(s, box, undefined, role).plan), at);
          const expected = role === "dm" ? [[["horse", 13, 13, 10, null]], null] : [[["horse", 12, 13, null, null]], "Ledge in the way. No stairs you have seen lead there."];
          assert.deepEqual(lands(aimed), expected, `${at}: ${role === "dm" ? "across the rise's edge, 10 ft up" : "held at the ledge, which the note names"}`);
        }
      }
    }
  });

  test("squares: the walking ruler from Mara reads the landing the drag makes", () => {
    for (const role of ["dm", "player"] as const) {
      const s = field([7, 14]);
      const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "mara" }, { x: 13.5, y: 14.5 }], viewer: { role }, everything: role === "dm" })!;
      assert.deepEqual([m.legs[0]!.to.x, m.legs[0]!.to.y], role === "dm" ? [13, 14] : [12, 14], `${role}: Mara on her seat where the warhorse lands`);
    }
  });

  test("squares: along a ridge one square wide, 10 ft up, its ledges still make a narrow space, so from every seat the warhorse squeezes onto the square under Mara's middle", () => {
    for (const seat of SQUARE_SEATS) {
      const s = room({ scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off" }) } });
      s.buildChunks = {};
      // A plateau west of x 8 and the ridge along row 10 from it, both 10 ft up.
      heights(s, { x: 0, y: 0, w: 8, h: 20 }, 10);
      heights(s, { x: 8, y: 10, w: 8, h: 1 }, 10);
      const horse = (s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, elevation: 10, name: "Warhorse", kind: "npc", ownerIds: ["p1"] }));
      const mara = (s.tokens.mara = token("mara", { x: seat[0], y: seat[1], elevation: 10, name: "Mara", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }));
      for (const role of ["dm", "player"] as const) {
        for (const fx of offsets) {
          for (const fy of offsets) {
            const middle = { x: 12 + fx, y: 10 + fy };
            const view = seenRoom(s, role);
            const aim = pressedAim(view, horse, mara, { x: middle.x - 0.5 + horse.x - seat[0], y: middle.y - 0.5 + horse.y - seat[1] });
            const target = routeTarget(view, horse, aim);
            assert.equal(target.squeeze, true, `seat ${seat}, ${role}, middle ${middle.x}, ${middle.y}: squeezed`);
            assert.deepEqual(footprintRect(SQUARES, { ...horse, x: target.x, y: target.y, squeeze: true }), { x: 12, y: 10, w: 1, h: 1 }, `seat ${seat}, ${role}, middle ${middle.x}, ${middle.y}: on Mara's square`);
          }
        }
      }
    }
  });

  test("hex rows: from every hex of the warhorse, the DM's drop and a player's walk land it as a drag of the warhorse itself does", () => {
    let base: RoomState = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 20, h: 14 }, blockMovement: true }) } });
    const rise = sceneHexes(ROWS, { w: 20, h: 14 }).filter((h) => h.col >= 10).map(hexKey);
    for (let i = 0; i < rise.length; i += 50) base = apply(base, { t: "build.height", sceneId: "s1", cells: rise.slice(i, i + 50), height: 10 } as Op);
    const horse = onHex(ROWS, "horse", "large", { col: 3, row: 6 }, { name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    // Its stand from 10, 6 takes 10, 6 and 10, 7 on the rise and 9, 7 below it.
    const box = placedOnHex(ROWS, horse, { col: 10, row: 6 });
    for (const seatHex of occupiedHexes(ROWS, horse)) {
      const s: RoomState = { ...base, tokens: { horse, mara: onHex(ROWS, "mara", "medium", seatHex, { name: "Mara", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }) } };
      for (const role of ["dm", "player"] as const) {
        const aimed = dropOf(s, box, s.tokens.mara, role).plan;
        assert.deepEqual(lands(aimed), lands(dropOf(s, box, undefined, role).plan), `seat ${hexKey(seatHex)}, ${role}`);
        if (role === "dm") assert.deepEqual(occupiedHexes(ROWS, { ...horse, ...aimed!.moves[0]! }).map(hexKey), ["10,6", "10,7", "9,7"], `seat ${hexKey(seatHex)}: across the rise's edge`);
      }
    }
  });

  test("hex rows: along a ridge one hex wide, 10 ft up, from every hex of the warhorse it squeezes onto the hex under Mara's middle", () => {
    let base: RoomState = room({ scenes: { s1: scene("s1", { gridShape: "hexRows", bounds: { w: 22, h: 16 }, blockMovement: true }) } });
    // A plateau west of column 6 and the ridge along row 6 from it to column 12, both 10 ft up.
    const raised = sceneHexes(ROWS, { w: 22, h: 16 }).filter((h) => h.col <= 5 || (h.row === 6 && h.col <= 12)).map(hexKey);
    for (let i = 0; i < raised.length; i += 50) base = apply(base, { t: "build.height", sceneId: "s1", cells: raised.slice(i, i + 50), height: 10 } as Op);
    const horse = onHex(ROWS, "horse", "large", { col: 2, row: 5 }, { elevation: 10, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
    for (const seatHex of occupiedHexes(ROWS, horse)) {
      const mara = onHex(ROWS, "mara", "medium", seatHex, { elevation: 10, name: "Mara", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
      const s: RoomState = { ...base, tokens: { horse, mara } };
      for (const role of ["dm", "player"] as const) {
        for (const [dx, dy] of [[0, 0], [0.2, 0.15], [-0.25, 0.1], [0.1, -0.3]] as const) {
          const c = hexCenter(ROWS, { col: 9, row: 6 });
          const view = seenRoom(s, role);
          const aim = pressedAim(view, horse, mara, { x: c.x + dx - 0.5 + horse.x - mara.x, y: c.y + dy - 0.5 + horse.y - mara.y });
          const target = routeTarget(view, horse, aim);
          assert.equal(target.squeeze, true, `seat ${hexKey(seatHex)}, ${role}: squeezed`);
          assert.deepEqual(occupiedHexes(ROWS, { ...horse, x: target.x, y: target.y, squeeze: true }).map(hexKey), ["9,6"], `seat ${hexKey(seatHex)}, ${role}, ${dx}, ${dy}: on Mara's hex`);
        }
      }
    }
  });
});

/** Frames by hand, as dragStops.test.ts drives them. */
class Hand implements Frames {
  queue: (() => void)[] = [];
  now(): number {
    return 0;
  }
  request(run: () => void): number {
    this.queue.push(run);
    return this.queue.length;
  }
  cancel(): void {}
  frame(): void {
    for (const run of this.queue.splice(0)) run();
  }
}

function board(view: RoomState, role: DragDeps["role"] = "player") {
  const frames = new Hand();
  const work = new RouteWork(frames, () => new WorkBudget({ limit: 100000 }));
  const deps: DragDeps = {
    store: { getState: () => ({ view, floorView: view }) } as unknown as DragDeps["store"],
    actions: { dispatch: () => 1, newId: () => "id" } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope: new RoomScope(),
    role,
    work,
  };
  return { frames, stops: dragStops(deps), hold: () => deps.scope.get(holdSlot).getState().hold };
}

describe("squares: a Huge mount into a corridor two squares wide, its rider leading a prisoner in single file (review FU45BR-OPUS-10)", () => {
  /** The corridor along rows 6 and 7 from x 6 to 14, a Huge horse west of it, and riders by id at their squares, `lead` leading a prisoner beside it. */
  function ridden(riders: readonly [string, number, number, Partial<Token>?][], lead: string, prisoner: { x: number; y: number }): RoomState {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 22, h: 14 }, blockMovement: true, autoWalls: "off" }) } });
    s.buildChunks = {};
    const runs: [[number, number], [number, number]][] = [[[6, 0], [6, 6]], [[6, 8], [6, 14]], [[14, 0], [14, 6]], [[14, 8], [14, 14]], [[6, 6], [14, 6]], [[6, 8], [14, 8]]];
    runs.forEach(([a, b], i) => wall(s, `fu48mo${String(i).padStart(6, "0")}`, a, b));
    s.tokens.horse = token("horse", { size: "huge", x: 1, y: 5, name: "Elephant", kind: "npc", ownerIds: ["p1"] });
    for (const [id, x, y, over] of riders) s.tokens[id] = token(id, { x, y, name: id, kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride" }, ...over });
    s.tokens.pris = token("pris", { ...prisoner, name: "Prisoner", kind: "npc", attached: { to: lead, kind: "drag" } });
    return s;
  }

  const held = (plan: DropPlan) => [plan.moves.find((m) => m.tokenId === "horse")?.squeeze === true, plan.stop && stopText(plan.stop)];

  test("the prisoner follows where his rider's seat keeps him in reach, a rider no player sees changing nothing, and the server takes it", () => {
    for (const shade of [false, true]) {
      const riders: [string, number, number, Partial<Token>?][] = [["brom", 1, 6]];
      if (shade) riders.push(["shade", 1, 7, { kind: "npc", ownerIds: [], visibility: "dm" }]);
      const s = ridden(riders, "brom", { x: 0, y: 6 });
      const { plan } = dropOf(s, { x: 9.5, y: 5.5 });
      assert.ok(plan, "the drop landed");
      assert.deepEqual(held(plan), [true, null], `shade ${shade}: in, squeezed, nothing held`);
      assert.ok(takes(s, plan), `shade ${shade}: the server takes it`);
      const r = applyOp(s, moveOpsOf(plan.moves)[0]!, P1, env(1));
      assert.ok(r.ok);
      const [brom, pris] = [r.state.tokens.brom!, r.state.tokens.pris!];
      assert.deepEqual([brom.x, brom.y, brom.attached?.to, pris.x, pris.y, pris.attached?.to], [10, 6, "horse", 9, 7, "brom"], `shade ${shade}: on the near seat, his prisoner right behind`);
    }
  });

  test("the seat a second rider leaves him decides: on the far seat the drop holds at the mouth and names the prisoner, and the server refuses the whole way", () => {
    const far = ridden([["brom", 3, 6], ["ana", 1, 6]], "brom", { x: 4, y: 6 });
    const { plan } = dropOf(far, { x: 9.5, y: 5.5 });
    assert.ok(plan, "the drop landed");
    assert.deepEqual(held(plan), [false, "Prisoner can't follow through there."]);
    const { towed: _towed, ...input } = groupWalkWorld(far, ownWalk(far.tokens.horse!), { role: "player" }).input;
    const found = findRouteOn(input, { x: 9.5, y: 5.5 });
    assert.ok(found && found !== "none", "a way in for the mount alone");
    const whole: Op = { t: "token.move", tokenId: "horse", x: 9.5, y: 5.5, squeeze: true, route: found.pieces.map(([x, y, e, w]): [number, number, number, 0 | 1] => [x, y, e, w]) };
    assert.deepEqual(canApply(whole, P1, far, { canUseAsset: () => true }), { ok: false, code: "forbidden", message: "Prisoner can't follow through there." });
    // With the riders' places swapped he takes the near seat, and the same walk keeps the prisoner in reach.
    const near = ridden([["brom", 1, 6], ["ana", 3, 6]], "brom", { x: 0, y: 6 });
    const into = dropOf(near, { x: 9.5, y: 5.5 }).plan!;
    assert.deepEqual(held(into), [true, null]);
    assert.ok(takes(near, into), "the server takes it");
    const r = applyOp(near, moveOpsOf(into.moves)[0]!, P1, env(1));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.brom!.attached?.to, r.state.tokens.ana!.attached?.to, r.state.tokens.pris!.attached?.to], ["horse", "horse", "brom"]);
  });
});
