import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { edge, fogRoom, heights, lift, wall } from "#shared/discoveryTestutil.ts";
import { tileKey } from "#shared/keys.ts";
import { FOG_SUBCELLS, type RoomState, type SightTile } from "#shared/model.ts";
import { TILE_SUB } from "#shared/rules/fog.ts";
import { SOMETHING_BLOCKS, stopWords, WALL_IN_THE_WAY } from "#shared/permissions.ts";
import { deviceGround } from "#shared/rules/held.ts";
import { ownWalk } from "#shared/rules/movement.ts";
import { token } from "#shared/testutil.ts";
import { dropView, heldText, holdLabel, planGroup, planOne, stopText } from "./drop.ts";
import { teleportMove } from "./teleport.ts";
import { thorn } from "./testing.ts";

/*
 * The words a player's device gives its own stops (docs/design-v1-map-discovery.md
 * 6, the words, decision 11, D-261027-04): the kind only where the part of
 * the blocker the walk met is live to it, in sight with fog and vision on,
 * revealed with fog on and vision off, everywhere with fog off: a wall or
 * door beside a live cell or through one, a ledge between two. Else
 * "Something blocks the way.", remembered ground included, and "Teleport
 * here" past it names no kind.
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

/** Sight as players get it, two bits a sub-cell: dim light on every cell of tile (0, 0) that `seen` takes. */
function sightOn(seen: (x: number, y: number) => boolean): Record<string, SightTile> {
  const packed = new Uint8Array((TILE_SUB * TILE_SUB) / 4);
  for (let sy = 0; sy < TILE_SUB; sy++) {
    for (let sx = 0; sx < TILE_SUB; sx++) {
      if (!seen(Math.floor(sx / FOG_SUBCELLS), Math.floor(sy / FOG_SUBCELLS))) continue;
      const i = sy * TILE_SUB + sx;
      packed[i >> 2] = packed[i >> 2]! | (1 << ((i & 3) << 1));
    }
  }
  return { [tileKey("s1", 0, 0)]: { b: Buffer.from(packed).toString("base64") } };
}

/** Rows `y0` and below in sight. */
const sightFrom = (y0: number) => sightOn((_x, y) => y >= y0);

/** Thorn walking north from (5, 7) to (5, 3) on an Explore scene, all ground held, rows 5 and below in his sight, row 4 past the stop out of it. */
function seenTo5(build: (state: RoomState) => void): RoomState {
  const state = fogRoom({ vision: true, scene: { blockMovement: true } });
  build(state);
  lift(state, "dm", { x: 0, y: 0, w: 32, h: 16 });
  state.tokens = { thorn: thorn({ x: 5, y: 7, sceneId: "s1" }) };
  return { ...state, sight: sightFrom(5) } as RoomState;
}

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

describe("a stop names the very blocker it met where that blocker is live (D-261027-04)", () => {
  test("a closed door on the side of a cell in sight names the door, the cell behind it out of sight", () => {
    const plan = drop(seenTo5((s) => edge(s, "5,5,n", { kind: "door", state: "closed", secret: false, discovered: false })));
    assert.deepEqual([plan.stop?.at, plan.stop?.blocker], [{ x: 5, y: 5 }, "wall"]);
    assert.deepEqual(plan.stop?.door, { edge: "5,5,n" });
    assert.equal(stopText(plan.stop!), "A door is in the way. Tap it to open.");
  });

  test("a wall on that side names the wall", () => {
    assert.equal(drop(seenTo5((s) => edge(s, "5,5,n", { kind: "wall" }))).stop?.blocker, "wall");
  });

  test("a free wall that stops the walk inside the cell out of sight names none, though a wall in sight stands beside the way", () => {
    const plan = drop(
      seenTo5((s) => {
        wall(s, "aaaaaaaaaaaa", [4, 4.5], [7, 4.5]);
        edge(s, "7,5,w", { kind: "wall" });
      }),
    );
    assert.deepEqual([plan.stop?.at, plan.stop?.blocker, plan.stop?.door], [{ x: 5, y: 5 }, "unknown", null]);
  });

  test("a ledge names its kind only with the cells on both sides in sight", () => {
    const raised = (s: RoomState) => heights(s, { x: 0, y: 0, w: 32, h: 5 }, 10);
    assert.equal(drop(seenTo5(raised)).stop?.blocker, "unknown", "the raised row is out of sight");
    const both = seenTo5(raised);
    assert.equal(drop({ ...both, sight: sightFrom(4) } as RoomState).stop?.blocker, "ledge");
  });
});

describe("the part of a blocker a walk met is judged cell by cell (D-261027-04)", () => {
  test("met across two cells, one out of sight, it names none, and with both in sight it names the wall", () => {
    // A free wall along y = 4.5 inside row 4, and Thorn's middle on x = 5: his core meets it across columns 4 and 5.
    const state = fogRoom({ vision: true, scene: { blockMovement: true } });
    wall(state, "aaaaaaaaaaaa", [3, 4.5], [7, 4.5]);
    lift(state, "dm", { x: 0, y: 0, w: 32, h: 16 });
    const walker = ownWalk(thorn({ x: 4.5, y: 7, sceneId: "s1" }));
    const words = (seen: (x: number, y: number) => boolean) => {
      const view = { ...state, sight: sightOn(seen) } as RoomState;
      return stopWords(view, deviceGround(view, "s1"), walker, { x: 4.5, y: 3, elevation: 0 }, "wall");
    };
    assert.equal(words((x, y) => y >= 5 || x === 4), SOMETHING_BLOCKS);
    assert.equal(words((x, y) => y >= 5 || x === 4 || x === 5), WALL_IN_THE_WAY);
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
