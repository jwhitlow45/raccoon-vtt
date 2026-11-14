import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lift } from "#shared/discoveryTestutil.ts";
import type { FreeWall, RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { WorkBudget } from "#shared/rules/walk.ts";
import { actor, apply, P1, room, scene, token } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { moveOpsOf, stopText, type DropPlan } from "./drop.ts";
import { RouteWork, type Frames } from "./routeWork.ts";
import { dragStops, type DragDeps } from "./stageHooks.ts";

/*
 * A player's drag on a copy of a square scene cut from held ground plans as
 * the stored build plans it, where the copy holds every wall (e2e
 * fu44b-1, D-261113-040). With fog off every square is held,
 * so the copy's walls are the stored ones cut at the split lines x or y = 4m
 * and rounded 1/10000 cell outward. Read within their band, the pieces of
 * the corridor's west wall and its top wall, overlapping at the corner
 * (6, 6), let the goblin's point core slide along y = 6 through that
 * corner, which the stored walls stop. So Pat's drop sent a walk in single
 * file the server refused with "A wall is in the way.", and the warhorse
 * stayed put. With fog on and every square revealed the copy is the same.
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
 * fu44b-1's room: rock from x 6 to 14 but for a corridor along row 6, sent
 * as the DM sends it, the warhorse Pat rides at 2, 5 with a stub inside its
 * box, and the goblin it drags above its left side, whom the stub keeps
 * from falling in behind it.
 */
function corridor(fog: boolean, stub: boolean): RoomState {
  const s = room({ scenes: { s1: scene("s1", { bounds: { w: 20, h: 12 }, blockMovement: true, fogEnabled: fog }) } });
  const runs = [[6, 0, 6, 6], [6, 7, 6, 12], [14, 0, 14, 6], [14, 7, 14, 12], [6, 6, 14, 6], [6, 7, 14, 7], ...(stub ? [[2.25, 5.625, 2.625, 5.25]] : [])];
  const put: FreeWall[] = runs.map(([ax, ay, bx, by], i) => ({ id: `wallcut${String(i).padStart(5, "0")}`, a: [ax!, ay!], b: [bx!, by!], f: { kind: "wall" } }));
  const built = apply(s, { t: "build.walls", sceneId: "s1", put });
  if (fog) lift(built, "dm", { x: 0, y: 0, w: 20, h: 12 });
  built.tokens = {
    horse: token("horse", { size: "large", x: 2, y: 5, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"], actor: { inline: actor({ speeds: { walk: 60 } }) } }),
    brom: token("brom", { x: 2, y: 5, name: "Brom", kind: "pc", ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }),
    gob: token("gob", { x: 1, y: 4, name: "Goblin", kind: "monster", disposition: "hostile", attached: { to: "horse", kind: "drag" } }),
  };
  return built;
}

/** Pat's drag of the warhorse on a copy, pressed on Brom or on the warhorse, its box dropped at `box`, as the board plans it. */
function planOn(copy: RoomState, box: { x: number; y: number }, pressed: Token | undefined): DropPlan {
  const frames = new Hand();
  const scope = new RoomScope();
  const stops = dragStops({
    store: { getState: () => ({ view: copy, floorView: copy }) } as unknown as DragDeps["store"],
    actions: { dispatch: () => 1, newId: () => "id" } as unknown as DragDeps["actions"],
    ui: { notify: () => {}, showActions: () => {} } as unknown as DragDeps["ui"],
    scope,
    role: "player",
    work: new RouteWork(frames, () => new WorkBudget({ limit: 100_000 })),
  });
  const horse = copy.tokens.horse!;
  const node = { x: () => box.x, y: () => box.y, position: () => {} };
  stops.start(horse.id, pressed);
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

describe("a player's drag on a square scene cut from held ground plans as the stored build does (D-261113-040)", () => {
  // Brom's middle dropped at 10.2, 6.2, as fu44b-1 swipes, and two drops of the warhorse's own box into the corridor.
  const boxes = [
    { x: 9.7, y: 5.7 },
    { x: 9.5, y: 5.5 },
    { x: 11.6, y: 5.9 },
  ];

  for (const fog of [false, true]) {
    test(`fog ${fog ? "on, every square revealed" : "off"}: the goblin the stub holds back stops the warhorse at 4, 5 on Pat's copy too, and the server takes it`, () => {
      const stored = corridor(fog, true);
      const copy = projectState(stored, P1, { sceneId: "s1" }) as unknown as RoomState;
      const pieces = Object.values(copy.buildChunks).flatMap((c) => c?.walls ?? []);
      assert.ok(pieces.some((w) => w.b[1] === 6.0001), "the copy holds the corridor's west wall as rounded pieces");
      for (const box of boxes) {
        for (const pressed of ["brom", undefined] as const) {
          const at = `box ${box.x}, ${box.y}, pressed ${pressed ?? "horse"}`;
          const theirs = planOn(copy, box, pressed && copy.tokens[pressed]);
          assert.deepEqual(sent(theirs), sent(planOn(stored, box, pressed && stored.tokens[pressed])), `${at}: as on the stored build`);
          const horse = theirs.moves.find((m) => m.tokenId === "horse");
          assert.deepEqual([horse?.x, horse?.y, horse?.squeeze, sent(theirs).note], [4, 5, undefined, "Goblin can't follow through there."], at);
          for (const op of moveOpsOf(theirs.moves)) assert.equal(canApply(op, P1, stored, { canUseAsset: () => true }).ok, true, `${at}: the server takes it`);
        }
      }
    });
  }

  test("without the stub the goblin follows in single file on both copies, squeezed into the corridor", () => {
    const stored = corridor(false, false);
    const copy = projectState(stored, P1, { sceneId: "s1" }) as unknown as RoomState;
    const theirs = planOn(copy, boxes[0]!, copy.tokens.brom);
    assert.deepEqual(sent(theirs), sent(planOn(stored, boxes[0]!, stored.tokens.brom)));
    assert.deepEqual([theirs.moves[0]?.x, theirs.moves[0]?.y, theirs.moves[0]?.squeeze, theirs.stop], [9.5, 5.5, true, null]);
    for (const op of moveOpsOf(theirs.moves)) assert.equal(canApply(op, P1, stored, { canUseAsset: () => true }).ok, true);
  });
});
