import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lift } from "#shared/discoveryTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { actor, apply, env, P1, room, scene, token } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { moveOpsOf, stopText, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";

/*
 * A player's touch drag of a rider plans as a mouse drag to the same square
 * does (live play 39, LP39B-MOVE-1). Pat, on a phone, rides the warhorse,
 * Controlled, which stands squeezed in a corridor's mouth, half a square off
 * Bree's grid, and Bree drags a Grappled goblin. Dragged to the square below
 * and right of the mouth, the warhorse's box at Bree's offset lay between
 * four of its full stands, all equally near. The touch's point landed a
 * hair right of the square's middle and took the stand the goblin cannot
 * follow from ("Goblin can't follow through there."), and the mouse's,
 * a whole pixel left of it, took the one it can. The aim now reads the
 * square Bree is dropped on.
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

/**
 * Live play 39's keep, painted as the DM painted it, its walls raised by the
 * build: room A, a corridor one square wide east along row 4 that turns
 * south down column 13, and room B from row 10. Its tokens stand where
 * Pat's drags left them at the corridor's mouth: the warhorse squeezed on
 * square 13, 9, Bree on it, and the goblin she drags on the square above.
 */
function keep(fog: boolean): RoomState {
  let s = room({ scenes: { s1: scene("s1", { bounds: { w: 24, h: 14 }, blockMovement: true, fogEnabled: fog }) } });
  for (const [x, y, w, h] of [[2, 2, 6, 6], [8, 4, 6, 1], [13, 5, 1, 5], [10, 10, 8, 4]] as const) s = apply(s, { t: "build.rect", sceneId: "s1", terrain: "stone", x, y, w, h });
  if (fog) lift(s, "dm", { x: 0, y: 0, w: 24, h: 14 });
  s.tokens = {
    horse: token("horse", { size: "large", x: 12.5, y: 8.5, squeeze: true, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } }),
    bree: token("bree", { x: 13, y: 9, name: "Bree", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }),
    gob: token("gob", { x: 13, y: 8, name: "Goblin", kind: "monster", disposition: "hostile", actor: { inline: actor({ effects: [{ id: "grab", key: "grappled" }] }) }, attached: { to: "bree", kind: "drag" } }),
  };
  return s;
}

/** Pat's drag of the warhorse, pressed on Bree, its node let go at `box`, as the board plans it on Pat's copy. */
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

/**
 * Where the warhorse's node was let go with Bree dropped on 14, 10, as Pat's phone read it: by touch a hair right of the
 * square's middle, and by mouse a whole pixel up and left of it.
 */
const TOUCH = { x: 13.500000000000002, y: 9.499999999999996 };
const MOUSE = { x: 13.482456140350877, y: 9.482456140350873 };

describe("a touch drag of a rider plans as a mouse drag to the same square does (LP39B-MOVE-1)", () => {
  for (const fog of [false, true]) {
    test(`fog ${fog ? "on, every square revealed" : "off"}: from the corridor's mouth to 14, 10 and then to 15, 12, Bree lands where the mouse put her, and the goblin follows`, () => {
      let stored = keep(fog);
      let copy = projectState(stored, P1, { sceneId: "s1" }) as unknown as RoomState;
      const byMouse = planOn(copy, MOUSE);
      assert.deepEqual(sent(planOn(copy, TOUCH)), sent(byMouse), "the touch plans as the mouse");
      // Anywhere in the square Bree is dropped on, as a finger lands.
      for (const dx of [-0.4, -0.1, 0.1, 0.4]) for (const dy of [-0.4, -0.1, 0.1, 0.4]) assert.deepEqual(sent(planOn(copy, { x: 13.5 + dx, y: 9.5 + dy })), sent(byMouse), `Bree dropped ${dx}, ${dy} off the square's middle`);
      assert.deepEqual(
        byMouse.moves.map((m) => [m.tokenId, m.x, m.y, m.squeeze]),
        [["horse", 13, 10, undefined]],
        "out of the mouth onto the full stand whose top left square is 13, 10",
      );
      assert.equal(byMouse.stop, null, "nothing holds it");
      for (const op of moveOpsOf(byMouse.moves)) {
        assert.ok(canApply(op, P1, stored, { canUseAsset: () => true }).ok, "the server takes it");
        const r = applyOp(stored, op, P1, env(1));
        assert.ok(r.ok);
        stored = r.state;
      }
      const at = (id: string) => [stored.tokens[id]!.x, stored.tokens[id]!.y, stored.tokens[id]!.attached?.to];
      assert.deepEqual([at("bree"), at("gob")], [[13, 10, "horse"], [13, 9, "bree"]], "Bree rides on, and the goblin follows her into the mouth");

      // From there, Bree dropped on 15, 12: a whole number of squares from where she sits, the warhorse full size on its grid.
      copy = projectState(stored, P1, { sceneId: "s1" }) as unknown as RoomState;
      const next = planOn(copy, { x: 14.964912280701757, y: 11.964912280701753 });
      assert.deepEqual(sent(planOn(copy, { x: 15.000000000000002, y: 11.999999999999996 })), sent(next), "the touch plans as the mouse");
      assert.deepEqual(next.moves.map((m) => [m.tokenId, m.x, m.y]), [["horse", 15, 12]]);
      assert.equal(next.stop, null);
      for (const op of moveOpsOf(next.moves)) assert.ok(canApply(op, P1, stored, { canUseAsset: () => true }).ok, "the server takes it");
    });
  }
});

/*
 * A group drag pressed on a token sitting on its lead moves every token by
 * the pointer's own offset, each snapped by its own box (review
 * LP39FIX-SOL-01). The rider's snapped seat is a lone drag's aim, and as a
 * group's offset it moved them all a square where they had not gone.
 */
describe("a group drag pressed on a token sitting on its lead moves by the pointer's own offset (LP39FIX-SOL-01)", () => {
  /** The DM's group drag of `ids`, led by `leadId` and pressed on `pressedId`, the lead's node let go at `box`. */
  function groupDrop(s: RoomState, leadId: string, pressedId: string, ids: readonly string[], box: { x: number; y: number }): DropPlan {
    const frames = new Hand();
    const stops = dragStops({
      store: { getState: () => ({ view: s, floorView: s }) } as unknown as DragDeps["store"],
      actions: { dispatch: () => 1, newId: () => "id" } as unknown as DragDeps["actions"],
      ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
      scope: new RoomScope(),
      role: "dm",
      work: new RouteWork(frames, () => new WorkBudget({ limit: 100_000 })),
    });
    const lead = s.tokens[leadId]!;
    stops.start(lead.id, s.tokens[pressedId]);
    let plan: DropPlan | null = null;
    stops.drop({ x: () => box.x, y: () => box.y, position: () => {} }, lead, ids.map((id) => s.tokens[id]!), (p) => (plan = p));
    for (let i = 0; i < 50 && !plan; i++) frames.frame();
    assert.ok(plan, "the drop landed");
    return plan;
  }
  const lands = (plan: DropPlan) => plan.moves.map((m) => [m.tokenId, m.x, m.y]);

  test("a Tiny owl perched on its selected holder, pressed and dragged three tenths of a square, moves no one", () => {
    const s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 20 } }) } });
    s.tokens = {
      holder: token("holder", { x: 3, y: 3, name: "Ana", kind: "pc", ownerIds: ["p1"] }),
      owl: token("owl", { size: "tiny", x: 3.5, y: 3.5, name: "Pip", kind: "npc", attached: { to: "holder", kind: "perch" } }),
      other: token("other", { x: 8, y: 8, name: "Thorn", kind: "pc", ownerIds: ["p1"] }),
    };
    assert.deepEqual(lands(groupDrop(s, "holder", "owl", ["holder", "other"], { x: 3.3, y: 3.3 })), [], "each box snaps back to its own square");
    assert.deepEqual(lands(groupDrop(s, "holder", "owl", ["holder", "other"], { x: 3.7, y: 3.3 })), [["holder", 4, 3], ["other", 9, 8]], "and a square east once the pointer is past half");
  });

  test("the warhorse squeezed in the corridor's mouth, pressed on Bree and dragged nine tenths of a square, lands where its own box snaps", () => {
    const s = keep(false);
    s.tokens.pip = token("pip", { x: 15, y: 11, name: "Pip", kind: "npc", ownerIds: ["p1"] });
    assert.deepEqual(lands(groupDrop(s, "horse", "bree", ["horse", "pip"], { x: 13.4, y: 9.4 })), [["horse", 13, 9], ["pip", 16, 12]], "not a square farther, by Bree's snapped square");
  });
});
