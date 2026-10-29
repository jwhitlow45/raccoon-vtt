import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wall } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { footprintRect, occupiedHexes } from "#shared/rules/footprint.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexAt, hexCenter, hexKey, type Hex, type HexGrid } from "#shared/rules/hex.ts";
import { findRouteOn } from "#shared/rules/hexWalk.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { ownWalk } from "#shared/rules/movement.ts";
import { groupWalkWorld } from "#shared/rules/walkWorld.ts";
import { room, scene, token } from "#shared/testutil.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { RoomScope } from "../../state/scope.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { planOne, pressedAim, routeTarget, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";
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

function board(view: RoomState) {
  const frames = new Hand();
  const work = new RouteWork(frames, () => new WorkBudget({ limit: 100000 }));
  const deps: DragDeps = {
    store: { getState: () => ({ view }) } as unknown as DragDeps["store"],
    actions: { dispatch: () => 1, newId: () => "id" } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope: new RoomScope(),
    role: "player",
    work,
  };
  return { frames, stops: dragStops(deps) };
}
