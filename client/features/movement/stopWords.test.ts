import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, lift } from "#shared/discoveryTestutil.ts";
import { tileKey } from "#shared/keys.ts";
import type { RoomState, SightTile } from "#shared/model.ts";
import { SOMETHING_BLOCKS } from "#shared/permissions.ts";
import { token } from "#shared/testutil.ts";
import { dropView, heldText, holdLabel, planGroup, planOne, stopText } from "./drop.ts";
import { teleportMove } from "./teleport.ts";
import { thorn } from "./testing.ts";

/*
 * The words a player's device gives its own stops (docs/design-v1-map-discovery.md
 * 6, the words, decision 11): the kind only where every cell the stopping
 * step touches is live to it, in sight with fog and vision on, revealed
 * with fog on and vision off, everywhere with fog off. Else "Something
 * blocks the way.", remembered ground included, and "Teleport here" past
 * it names no kind.
 */

/** A device's copy by hand: a wall on the north side of cell (5, 5), all ground held, and its sight over tile (0, 0) where `inSight`. */
function copy(opts: { vision: boolean; fog?: boolean; inSight: boolean }): RoomState {
  const state = fogRoom({ vision: opts.vision, scene: { blockMovement: true, fogEnabled: opts.fog ?? true } });
  edge(state, "5,5,n", { kind: "wall" });
  lift(state, "dm", { x: 0, y: 0, w: 32, h: 16 });
  state.tokens = { thorn: thorn({ x: 5, y: 7, sceneId: "s1" }), bree: token("bree", { kind: "pc", ownerIds: ["p1"], x: 20, y: 7, sceneId: "s1" }) };
  const sight: Record<string, SightTile> = opts.inSight ? { [tileKey("s1", 0, 0)]: { f: 1 } } : {};
  return { ...state, sight } as RoomState;
}

const drop = (view: RoomState) => planOne(dropView(view, "player"), view.tokens.thorn!, { x: 5.4, y: 3.4 }, "walk");

describe("a device names what stopped its walk only on its live ground", () => {
  test("in sight with party vision on: the wall", () => {
    const plan = drop(copy({ vision: true, inSight: true }));
    assert.deepEqual([plan.stop?.at, plan.stop?.blocker], [{ x: 5, y: 5 }, "wall"]);
    assert.equal(stopText(plan.stop!), "Stopped at a wall. Drop at the corner first, then go on.");
  });

  test("remembered, out of sight: no kind, and its teleport names none", () => {
    const view = copy({ vision: true, inSight: false });
    const plan = drop(view);
    assert.deepEqual([plan.stop?.at, plan.stop?.blocker, plan.stop?.door], [{ x: 5, y: 5 }, "unknown", null]);
    assert.equal(stopText(plan.stop!), SOMETHING_BLOCKS);
    assert.equal(teleportMove(dropView(view, "player"), view.tokens.thorn!, plan.stop!).teleport, "unknown");
  });

  test("fog on and vision off, all of it revealed, is live", () => {
    assert.equal(drop(copy({ vision: false, inSight: false })).stop?.blocker, "wall");
  });

  test("fog off is today's words", () => {
    assert.equal(drop(copy({ vision: true, fog: false, inSight: false })).stop?.blocker, "wall");
  });

  test("a group's held leg off live ground names none", () => {
    const view = copy({ vision: true, inSight: false });
    const plan = planGroup(dropView(view, "player"), [view.tokens.thorn!, view.tokens.bree!], 0, -4, "walk");
    assert.deepEqual(plan.held.map((h) => [h.token.id, h.blocker]), [["thorn", "unknown"]]);
    const live = copy({ vision: true, inSight: true });
    assert.deepEqual(planGroup(dropView(live, "player"), [live.tokens.thorn!], 0, -4, "walk").held.map((h) => h.blocker), ["wall"]);
  });
});

describe("the words of a stop that names no kind", () => {
  test("the note, the drag's mark and the group's toast", () => {
    assert.equal(stopText({ blocker: "unknown", door: null }), "Something blocks the way.");
    assert.equal(stopText({ blocker: "unknown", door: null, searched: true, capped: true }), "Too far to work out a way around. Something blocks the way.");
    assert.equal(holdLabel("unknown"), "Something in the way");
    assert.equal(heldText([{ name: "Thorn", blocker: "unknown" }]), "Thorn stayed where it was: something blocks the way.");
    assert.equal(heldText([{ name: "Thorn", blocker: "unknown" }, { name: "Bree", blocker: "wall" }]), "2 tokens stayed where they were: something blocks the way.");
  });
});
