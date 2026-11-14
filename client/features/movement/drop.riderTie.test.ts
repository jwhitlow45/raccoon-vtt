import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights } from "#shared/discoveryTestutil.ts";
import type { RoomState } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { hexSqueezedSize, occupiedHexes } from "#shared/rules/footprint.ts";
import { hexCenter, hexKey, type Hex } from "#shared/rules/hex.ts";
import { COLUMNS, hexWallRoom, onHex, ROWS, wallsRound } from "#shared/rules/hexWalls.testkit.ts";
import { hexStandPlace } from "#shared/rules/movement.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { actor, apply, env, P1, room, scene, token } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { measureWalk } from "../measure/walkRuler.ts";
import { moveOpsOf, stopText, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";

/*
 * A rider dragged out of a squeezed mount lands under the finger (live play
 * 40, LP40-RIDER-1, D-261113-220). A mount squeezed in a corridor stands
 * half a square off its rider's grid, or on one hex, so its box at the
 * rider's offset lies between several of its full stands, all equally near,
 * and a rider off a mount that was squeezed takes the stand's top-left seat
 * (D-261029-80), on hexes the hex the mount counts its steps from. The tie
 * went top then left, so Bree landed a square up and left of the finger on
 * open floor too. Now it goes to the stand that lands her on the square or
 * hex she is dropped on, or nearest it, where the goblin she drags still
 * stands clear of the rock, else top then left as before.
 */

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

/** Pat's drag of the warhorse pressed on Bree, its node let go at `box`, as the board plans it on Pat's copy. */
function planOn(copy: RoomState, box: { x: number; y: number }): DropPlan {
  const frames = new Hand();
  const stops = dragStops({
    store: { getState: () => ({ view: copy, floorView: copy }) } as unknown as DragDeps["store"],
    actions: { dispatch: () => 1, newId: () => "id" } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope: new RoomScope(),
    role: "player",
    work: new RouteWork(frames, () => new WorkBudget({ limit: 100_000 })),
  });
  const horse = copy.tokens.horse!;
  const node = { x: () => box.x, y: () => box.y, position: () => {} };
  stops.start(horse.id, copy.tokens.bree);
  for (let i = 0; i < 20; i++) {
    stops.frame(node, horse);
    frames.frame();
  }
  let plan: DropPlan | null = null;
  stops.drop(node, horse, [horse], (p) => (plan = p));
  for (let i = 0; i < 50 && !plan; i++) frames.frame();
  assert.ok(plan, "the drop landed");
  return plan;
}

/** What a plan sends and says. */
const sent = (plan: DropPlan) => ({ moves: plan.moves, note: plan.stop && stopText(plan.stop) });

/** The room once the server takes each op of the plan, as it must. */
function served(stored: RoomState, plan: DropPlan): RoomState {
  let s = stored;
  assert.ok(plan.moves.length > 0, `it moves: ${JSON.stringify(sent(plan))}`);
  for (const op of moveOpsOf(plan.moves)) {
    const allowed = canApply(op, P1, s, { canUseAsset: () => true });
    assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
    const r = applyOp(s, op, P1, env(1));
    assert.ok(r.ok);
    s = r.state;
  }
  return s;
}

/**
 * Bree, her box's middle dropped at `middle` by the finger's offset from
 * hers, planned anywhere in that square or hex as a finger lifts and alike
 * by each lift point, then taken by the server.
 */
function dropBree(stored: RoomState, middle: { x: number; y: number }, lifts: readonly (readonly [number, number])[]): { plan: DropPlan; after: RoomState } {
  const copy = projectState(stored, P1, { sceneId: "s1" }) as unknown as RoomState;
  const horse = stored.tokens.horse!;
  const bree = stored.tokens.bree!;
  const boxAt = (dx: number, dy: number) => ({ x: middle.x + dx - 0.5 + horse.x - bree.x, y: middle.y + dy - 0.5 + horse.y - bree.y });
  const plan = planOn(copy, boxAt(0, 0));
  for (const [dx, dy] of lifts) assert.deepEqual(sent(planOn(copy, boxAt(dx, dy))), sent(plan), `lifted ${dx}, ${dy} from the middle`);
  return { plan, after: served(stored, plan) };
}

const SQUARE_LIFTS = [-0.4, -0.1, 0.1, 0.4].flatMap((dx) => [-0.4, -0.1, 0.1, 0.4].map((dy) => [dx, dy] as const));

describe("squares: a rider dragged out of a squeezed mount lands under the finger (LP40-RIDER-1)", () => {
  /**
   * Live play 39's keep, walled by the build: room A, a corridor one square
   * wide east along row 4 and south down column 13, and room B from row 10.
   * The warhorse stands squeezed on `at`, Bree on it, and the goblin she
   * drags, Grappled, on `goblin`.
   */
  function keep(at: { x: number; y: number }, goblin: { x: number; y: number }): RoomState {
    let s = room({ scenes: { s1: scene("s1", { bounds: { w: 24, h: 14 }, blockMovement: true }) } });
    for (const [x, y, w, h] of [[2, 2, 6, 6], [8, 4, 6, 1], [13, 5, 1, 5], [10, 10, 8, 4]] as const) s = apply(s, { t: "build.rect", sceneId: "s1", terrain: "stone", x, y, w, h });
    s.tokens = {
      horse: token("horse", { size: "large", x: at.x - 0.5, y: at.y - 0.5, squeeze: true, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { ...at, name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }),
      gob: token("gob", { ...goblin, name: "Goblin", kind: "monster", disposition: "hostile", actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: "bree", kind: "drag" } }),
    };
    return s;
  }
  const at = (s: RoomState, id: string) => [s.tokens[id]!.x, s.tokens[id]!.y];

  test("open floor: from the corridor's row onto 5, 5, the warhorse stands on 5, 5 with Bree on it, not on 4, 4", () => {
    const { plan, after } = dropBree(keep({ x: 9, y: 4 }, { x: 10, y: 4 }), { x: 5.5, y: 5.5 }, SQUARE_LIFTS);
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y, m.squeeze]), [["horse", 5, 5, undefined]]);
    assert.deepEqual([at(after, "bree"), at(after, "gob"), after.tokens.gob!.attached?.to], [[5, 5], [6, 5], "bree"], "Bree under the finger, the goblin in tow beside her");
  });

  test("the mouth: onto 14, 10 Bree still lands on 13, 10, since on the stand that seats her on 14, 10 the goblin would stand in the rock (lp39fix-1)", () => {
    const s = keep({ x: 13, y: 9 }, { x: 13, y: 8 });
    const { plan, after } = dropBree(s, { x: 14.5, y: 10.5 }, SQUARE_LIFTS);
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y, m.squeeze]), [["horse", 13, 10, undefined]]);
    assert.deepEqual([at(after, "bree"), at(after, "gob")], [[13, 10], [13, 9]], "the goblin into the mouth behind her");
  });

  test("the mouth: onto 14, 11 and onto 13, 10 she lands on the square she is dropped on, where the top-left stand put her a square up and left, or left the goblin in the rock", () => {
    const s = keep({ x: 13, y: 9 }, { x: 13, y: 8 });
    for (const [x, y] of [[14, 11], [13, 10]] as const) {
      const { after } = dropBree(s, { x: x + 0.5, y: y + 0.5 }, SQUARE_LIFTS);
      assert.deepEqual([at(after, "horse"), at(after, "bree"), at(after, "gob")], [[x, y], [x, y], [x, y - 1]], `dropped on ${x}, ${y}`);
    }
  });

  test("the row: onto 7, 4, where no stand that fits seats her, she lands on 6, 4 beside the finger, not on 6, 3", () => {
    const { plan, after } = dropBree(keep({ x: 10, y: 4 }, { x: 9, y: 4 }), { x: 7.5, y: 4.5 }, SQUARE_LIFTS);
    assert.deepEqual(plan.moves.map((m) => [m.tokenId, m.x, m.y]), [["horse", 6, 4]]);
    assert.deepEqual([at(after, "bree"), at(after, "gob")], [[6, 4], [5, 4]]);
  });

  test("a flying warhorse, Bree and the goblin she drags 5 ft up, a rise 2 ft high on 6, 5: onto 5, 5 she lands there, the goblin over the rise at 5 ft (review LP40FIX-SOL-01)", () => {
    const s = keep({ x: 9, y: 4 }, { x: 10, y: 4 });
    heights(s, { x: 6, y: 5, w: 1, h: 1 }, 2);
    s.tokens.horse = { ...s.tokens.horse!, elevation: 5, actor: { inline: actor({ speeds: { walk: 60, fly: 60 } }) } };
    for (const id of ["bree", "gob"]) s.tokens[id] = { ...s.tokens[id]!, elevation: 5 };
    const { after } = dropBree(s, { x: 5.5, y: 5.5 }, SQUARE_LIFTS);
    assert.deepEqual([at(after, "horse"), at(after, "bree"), at(after, "gob")], [[5, 5], [5, 5], [6, 5]]);
    assert.deepEqual([after.tokens.bree!.elevation, after.tokens.gob!.elevation], [5, 5], "still 5 ft up");
  });

  test("the walking ruler from Bree reads the landing the drag makes", () => {
    for (const [from, goblin, to, lands] of [
      [{ x: 9, y: 4 }, { x: 10, y: 4 }, { x: 5.5, y: 5.5 }, { x: 5, y: 5 }],
      [{ x: 10, y: 4 }, { x: 9, y: 4 }, { x: 7.5, y: 4.5 }, { x: 6, y: 4 }],
    ] as const) {
      const s = keep(from, goblin);
      const m = measureWalk({ view: s, sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "bree" }, to], viewer: { role: "player" }, everything: false })!;
      const leg = m.legs[0]!;
      assert.equal(leg.none, false);
      assert.deepEqual([leg.to.x, leg.to.y], [lands.x, lands.y], `from ${from.x}, ${from.y}: the leg ends where she lands`);
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
    return along >= 7 && along <= 12 && across !== 6;
  };
  const wide = g.orient === "rows" ? { w: 22, h: 16 } : { w: 16, h: 22 };
  /** Room A, a corridor one hex wide from 7 to 12 along line 6, and room B, the warhorse squeezed on the corridor's hex `along` with Bree on it, dragging the goblin on the hex `goblin` along. */
  const keep = (along: number, goblin: number): RoomState => {
    const s = hexWallRoom(g.orient === "rows" ? "hexRows" : "hexColumns", wide.w, wide.h, wallsRound(g, wide, solid));
    const on = at(along, 6);
    const horse = onHex(g, "horse", "large", on, { name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } });
    s.tokens.horse = { ...horse, ...hexStandPlace(g, horse, { size: hexSqueezedSize("large")!, ref: on, squeezed: true }), squeeze: true };
    s.tokens.bree = onHex(g, "bree", "medium", on, { name: "Bree", kind: "pc", disposition: "ally", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } });
    s.tokens.gob = onHex(g, "gob", "medium", at(goblin, 6), { name: "Goblin", kind: "monster", disposition: "hostile", actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: "bree", kind: "drag" } });
    return s;
  };
  const hexOf = (s: RoomState, id: string) => occupiedHexes(g, s.tokens[id]!).map(hexKey);
  const LIFTS = [[0.25, 0], [-0.25, 0.05], [0.1, 0.25], [-0.1, -0.25]] as const;

  describe(`${name}: a rider dragged out of a squeezed mount lands under the finger (LP40-RIDER-1)`, () => {
    test("open floor: from the corridor's middle onto a hex of room A, the warhorse stands with Bree on that hex, not on the hex above", () => {
      const goal = at(5, 5);
      const { after } = dropBree(keep(9, 10), hexCenter(g, goal), LIFTS);
      assert.deepEqual(hexOf(after, "bree"), [hexKey(goal)]);
      assert.equal(after.tokens.horse!.squeeze, undefined, "full size");
      assert.equal(after.tokens.gob!.attached?.to, "bree", "the goblin in tow");
    });

    test("the mouth: from the corridor's end onto a hex of room B beside it, Bree lands on it", () => {
      const goal = at(14, 5);
      const { after } = dropBree(keep(12, 11), hexCenter(g, goal), LIFTS);
      assert.deepEqual(hexOf(after, "bree"), [hexKey(goal)]);
      assert.equal(after.tokens.gob!.attached?.to, "bree");
    });

    test("the row: from the corridor onto room A's hex at its end, Bree lands on it, as before", () => {
      const goal = at(6, 6);
      const { after } = dropBree(keep(9, 10), hexCenter(g, goal), LIFTS);
      assert.deepEqual(hexOf(after, "bree"), [hexKey(goal)]);
    });

    test("at the scene's edge, where the stand that seats her on the hex would put the goblin off the scene, she lands as before on the hex beside it, and the goblin follows", () => {
      const { after } = dropBree(keep(7, 8), hexCenter(g, at(20, 9)), LIFTS);
      assert.deepEqual(hexOf(after, "bree"), [hexKey(at(20, 8))]);
      assert.equal(after.tokens.gob!.attached?.to, "bree");
    });

    test("the walking ruler from Bree reads the landing the drag makes", () => {
      const goal = at(5, 5);
      const m = measureWalk({ view: keep(9, 10), sceneId: "s1", stops: [{ x: 0, y: 0, tokenId: "bree" }, hexCenter(g, goal)], viewer: { role: "player" }, everything: false })!;
      const leg = m.legs[0]!;
      assert.equal(leg.none, false);
      assert.equal(hexKey(occupiedHexes(g, { size: "medium", ...leg.to })[0]!), hexKey(goal));
    });
  });
}
