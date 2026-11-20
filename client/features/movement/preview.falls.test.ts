import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, OPENING_RECT, UPPER, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { FloorLink, RoomState, Token } from "#shared/model.ts";
import { token } from "#shared/testutil.ts";
import { dragLabel } from "../measure/movement.ts";
import { dropView, fallLabel, fallsAt } from "./drop.ts";
import { groupReading, walkPreview } from "./preview.ts";

/*
 * A drag's label where the drop would fall through an opening
 * (docs/design/design-v1-floors.md phase 4, 12, D-261119-009): the tower's
 * opening from Upper floor (o1, the hole, 2 by 2 at 6, 6) down to Ground
 * floor, Upper floor open to players, and Thorn on Upper floor at 3, 3.
 */

function room(...made: Token[]): RoomState {
  const s = withOpening(tower({ tokens: { thorn: thornToken({ sceneId: UPPER }) } }));
  return { ...s, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } }, tokens: { ...s.tokens, ...Object.fromEntries(made.map((t) => [t.id, t])) } };
}

/** A player's copy that lacks Ground floor: the hole leads down, to a floor it does not name. */
function withoutFarFloor(s: RoomState): RoomState {
  const { [GROUND]: _ground, ...scenes } = s.scenes;
  const { pair: _pair, to: _to, ground: _g, made: _made, ...hole } = s.floorLinks!.o1!;
  return { ...s, scenes, floorLinks: { o1: { ...hole, dir: "down" } as unknown as FloorLink } };
}

const preview = (s: RoomState, role: "dm" | "player", t: Token, to = { x: OPENING_RECT.x, y: OPENING_RECT.y }) =>
  walkPreview({ labels: new Map(), view: dropView(s, role), token: t, target: to, answer: { kind: "open" }, held: null, world: null, role });

describe("the drag's fall label (phase 4, 12)", () => {
  test("Thorn dragged onto the hole reads Falls to Ground floor in the band's label, the DM's drag and Ana's alike", () => {
    const s = room();
    for (const role of ["dm", "player"] as const) {
      const read = preview(s, role, s.tokens.thorn!).read;
      assert.equal(read.falls, "Falls to Ground floor", role);
      assert.match(dragLabel(read), /\nFalls to Ground floor$/, role);
    }
  });

  test("a copy without the floor below reads Falls through the opening", () => {
    const s = withoutFarFloor(room());
    assert.equal(preview(s, "player", s.tokens.thorn!).read.falls, "Falls through the opening");
    assert.equal(fallLabel({ floor: null }), "Falls through the opening");
  });

  test("nothing past the hole, half over it, or in the air over it", () => {
    const s = room();
    assert.equal(preview(s, "player", s.tokens.thorn!, { x: 9, y: 6 }).read.falls, undefined, "past it");
    const ogre = token("ogre", { sceneId: UPPER, size: "large", x: 3, y: 10 });
    const withOgre = room(ogre);
    assert.equal(preview(withOgre, "dm", ogre, { x: 5, y: 6 }).read.falls, undefined, "a Large ogre half over it");
    assert.equal(preview(withOgre, "dm", ogre, { x: 6, y: 6 }).read.falls, "Falls to Ground floor", "and wholly over it");
    const bat = token("bat", { sceneId: UPPER, x: 3, y: 10, elevation: 10 });
    assert.equal(preview(room(bat), "dm", bat).read.falls, undefined, "a flier keeps its height");
    const below = token("goblin", { sceneId: GROUND, x: 3, y: 10 });
    assert.equal(preview(room(below), "dm", below).read.falls, undefined, "onto the opening's lower end, under the hole");
  });

  test("a rider kept on its mount over the hole stays up, on a mount every player sees for Bree's drag and on any for the DM's", () => {
    // A Large horse straddling the rim, and Thorn riding it beside the hole.
    const horse = token("horse", { sceneId: UPPER, size: "large", x: 5, y: 6 });
    const thorn = thornToken({ sceneId: UPPER, x: 5, y: 6, attached: { kind: "ride", to: "horse" } });
    const seen = room(horse, thorn);
    assert.equal(preview(seen, "player", thorn).read.falls, undefined, "a seen mount holds her up");
    assert.equal(preview(seen, "dm", thorn).read.falls, undefined);
    const hidden = room({ ...horse, visibility: "dm" }, thorn);
    assert.equal(preview(hidden, "player", thorn).read.falls, "Falls to Ground floor", "a mount some player cannot see holds up nothing for a player's drag");
    assert.equal(preview(hidden, "dm", thorn).read.falls, undefined, "the DM's drag counts every holder");
    // Past the horse's back, still wholly over the hole, nothing holds her up, whoever drags her.
    assert.deepEqual(fallsAt(dropView(seen, "dm"), thorn, { x: 7, y: 7 }, 0), { floor: "Ground floor" });
  });

  test("a group drag's reading says it too", () => {
    const s = room();
    assert.equal(groupReading(dropView(s, "dm"), s.tokens.thorn!, { x: 6, y: 6 }, "dm").falls, "Falls to Ground floor");
    assert.equal(groupReading(dropView(s, "dm"), s.tokens.thorn!, { x: 2, y: 6 }, "dm").falls, undefined);
  });
});
