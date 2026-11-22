import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, ATTIC, GROUND, UPPER, run, thornToken, tower, trapdoor, withOpening, withStairs, withTrapdoor } from "../floorLinksTestutil.ts";
import type { FloorLink, RoomState, Scene, Token } from "../model.ts";
import type { Op } from "../protocol.ts";
import { DM, actor, effect } from "../testutil.ts";
import { floorProblem } from "./floors.ts";
import {
  FLIGHT_LANDING_FT,
  KIND_WORDS,
  LINK_LABELS,
  LINK_WORDS,
  climbCost,
  climbLabel,
  fallDice,
  fallDrop,
  isHole,
  isStairsRefusal,
  landingOf,
  landingShift,
  linkProblem,
  linkSideOf,
  restoreStairsWords,
  throughOpening,
  type LinkDraft,
} from "./floorLinks.ts";

/*
 * The rules of openings (docs/design/design-v1-floors.md phase 4, 3, 4.2,
 * 5, 8.1, 8.2): how far a fall drops and its dice, which flier may go
 * through, where a climb, a flight and a fall land, the words of each kind,
 * the put rules by kind, and the pair rules floorProblem holds after every
 * op. Stairs' and ladders' words are pinned as they read before openings.
 */

const edge = (sceneId: string, key: string): Op => ({ t: "build.edge", sceneId, edges: [{ key, feature: { kind: "wall" } }] });
const draft = (over: Partial<LinkDraft> = {}): LinkDraft => ({ id: "n1", pairId: "n2", sceneId: UPPER, to: GROUND, rect: { x: 2, y: 2, w: 2, h: 2 }, kind: "opening", ...over });
const ends = (state: RoomState, patch: Partial<FloorLink>, ids?: string[]): RoomState => ({
  ...state,
  floorLinks: Object.fromEntries(Object.entries(state.floorLinks ?? {}).map(([id, l]) => [id, !ids || ids.includes(id) ? { ...l, ...patch } : l])),
});
const BROKEN = "Tower's stairs and ladders don't fit its floors any more.";

describe("the drop and its dice (4.2, SRD 5.2.1)", () => {
  test("the floor's height plus the upper ground less the lower, never below 0", () => {
    assert.equal(fallDrop(10, 0, 0), 10);
    assert.equal(fallDrop(10, 5, 0), 15);
    assert.equal(fallDrop(10, 0, 5), 5);
    assert.equal(fallDrop(10, -5, 20), 0);
  });

  test("a d6 for each full 10 ft: 5, 10, 25 and 300 ft give none, one, two and twenty", () => {
    assert.deepEqual([5, 10, 25, 300].map(fallDice), [0, 1, 2, 20]);
    assert.deepEqual([0, 9, 19, 199, 200, 210].map(fallDice), [0, 0, 1, 19, 20, 20]);
  });
});

describe("who flies through (5)", () => {
  const holed = (thorn: Partial<Token>) => withOpening(tower({ tokens: { thorn: thornToken(thorn) } }));

  test("a creature in the air inside the squares is on, one on the ground or off them gets nothing, and one too big is too big", () => {
    const under = (over: Partial<Token>) => {
      const s = holed(over);
      return throughOpening(s, ANA, s.tokens.thorn!, s.floorLinks!.o2!);
    };
    assert.equal(under({ x: 6, y: 6, elevation: 5 }), "on");
    assert.equal(under({ x: 6, y: 6 }), null, "on the ground: no Fly up");
    assert.equal(under({ x: 12, y: 12, elevation: 5 }), null, "off the squares");
    assert.equal(under({ x: 7, y: 7, elevation: 5, size: "large" }), null, "partly on squares it would fit");
    assert.equal(under({ x: 6, y: 6, elevation: 5, size: "huge" }), "tooBig");
    const over = holed({ sceneId: UPPER, x: 6, y: 6, elevation: 5 });
    assert.equal(throughOpening(over, ANA, over.tokens.thorn!, over.floorLinks!.o1!), "on");
    assert.equal(throughOpening(over, ANA, over.tokens.thorn!, over.floorLinks!.o2!), null, "an end on another floor");
  });

  test("stairs are no opening, whatever height", () => {
    const s = withStairs(tower({ tokens: { thorn: thornToken({ elevation: 5 }) } }));
    assert.equal(throughOpening(s, ANA, s.tokens.thorn!, s.floorLinks!.l1!), null);
  });

  test("only an opening's upper end is the hole", () => {
    const s = withOpening(withStairs());
    assert.deepEqual([isHole(s, s.floorLinks!.o1!), isHole(s, s.floorLinks!.o2!), isHole(s, s.floorLinks!.l2!)], [true, false, false]);
  });
});

describe("where a creature lands (4.2, 5, 8.2)", () => {
  test("the far end's offset, by sign", () => {
    assert.deepEqual(landingShift({ rect: { x: 3, y: 3, w: 2, h: 1 } }, { rect: { x: 5, y: 1, w: 2, h: 1 } }), { dx: 2, dy: -2 });
    assert.deepEqual(landingShift({ rect: { x: 3, y: 3, w: 2, h: 1 } }, { rect: { x: 3, y: 3, w: 2, h: 1 } }), { dx: 0, dy: 0 });
  });

  test("a flier through an opening lands 5 ft over the far ground, and a faller, or any creature through stairs, on it", () => {
    assert.equal(FLIGHT_LANDING_FT, 5);
    const s = withOpening(tower());
    const far = { ...s.floorLinks!.o2!, ground: 3 };
    const at = (over: Partial<Token>, link: Pick<FloorLink, "rect" | "kind">) => landingOf(s, thornToken({ x: 6, y: 6, ...over }), link, far);
    assert.deepEqual(at({ elevation: 10 }, s.floorLinks!.o1!), { x: 6, y: 6, elevation: 8 });
    assert.deepEqual(at({ elevation: 0 }, s.floorLinks!.o1!), { x: 6, y: 6, elevation: 3 });
    assert.deepEqual(at({ elevation: 10 }, { ...s.floorLinks!.o1!, kind: "stairs" }), { x: 6, y: 6, elevation: 3 });
    // Stairs whose far end lies 2 squares east and 1 north land shifted so.
    assert.deepEqual(landingOf(s, thornToken({ x: 3, y: 3 }), { rect: { x: 3, y: 3, w: 2, h: 1 }, kind: "stairs" }, { rect: { x: 5, y: 2, w: 2, h: 1 }, ground: 0 }), { x: 5, y: 2, elevation: 0 });
  });

  test("a flight costs the floor's height alone, prone or not, without a climb speed", () => {
    const s = withOpening(tower());
    const prone = tower({ characters: { thorn: { ...tower().characters.thorn!, actor: actor({ speeds: { walk: 30 }, effects: [effect("e1", { key: "prone" })] }) } } });
    const link = s.floorLinks!.o1!;
    assert.deepEqual(climbCost(s, thornToken(), link), { moved: 10, cost: 10 });
    assert.deepEqual(climbCost({ ...prone, floorLinks: s.floorLinks }, thornToken(), link), { moved: 10, cost: 10 });
    // Stairs keep their crawl, so the opening's rule is its own.
    assert.deepEqual(climbCost({ ...prone, floorLinks: s.floorLinks }, thornToken(), { ...link, kind: "stairs" }), { moved: 10, cost: 20 });
  });
});

describe("the words by kind (3, D-261119-093)", () => {
  test("stairs and ladders read as they did before openings", () => {
    const want: Record<"stairs" | "ladder", string[]> = {
      stairs: [
        "Thorn is carried. Its holder takes the stairs.",
        "Too big for these stairs. Squeeze to fit.",
        "Too big for these stairs.",
        "the stairs changed",
        "Those squares already have stairs to Attic on Cellar.",
        "That would change the ground under the stairs to Attic. Remove them first.",
        "That would block the stairs to Attic. Remove them first.",
        "Stairs join A and B. Remove them before putting a floor between.",
        "A pit can't open under stairs. Remove them first.",
      ],
      ladder: [
        "Thorn is carried. Its holder takes the ladder.",
        "Too big for this ladder. Squeeze to fit.",
        "Too big for this ladder.",
        "the ladder changed",
        "Those squares already have a ladder to Attic on Cellar.",
        "That would change the ground under the ladder to Attic. Remove it first.",
        "That would block the ladder to Attic. Remove it first.",
        "A ladder joins A and B. Remove it before putting a floor between.",
        "A pit can't open under a ladder. Remove it first.",
      ],
    };
    for (const kind of ["stairs", "ladder"] as const) {
      const got = [
        LINK_WORDS.carried("Thorn", kind),
        LINK_WORDS.tooBigSqueeze(kind),
        LINK_WORDS.tooBig(kind),
        LINK_WORDS.changed(kind),
        LINK_WORDS.overEnd(kind, "Attic", "Cellar"),
        LINK_WORDS.changeGround(kind, "Attic"),
        LINK_WORDS.block(kind, "Attic"),
        LINK_WORDS.between(kind, "A", "B"),
        LINK_WORDS.pitUnder(kind),
      ];
      assert.deepEqual(got, want[kind], kind);
    }
    assert.equal(LINK_WORDS.noStairs, "There are no stairs here.");
    assert.equal(LINK_WORDS.notNext, "Stairs join a floor and the floor just above or below it.");
    assert.equal(LINK_WORDS.notNextFor("stairs"), LINK_WORDS.notNext);
    assert.equal(climbLabel("Thorn", "up", "stairs"), "moving Thorn up the stairs");
    assert.equal(climbLabel("Thorn", "down", "ladder"), "moving Thorn down the ladder");
    assert.deepEqual(
      [LINK_LABELS.placed("stairs", "Upper floor"), LINK_LABELS.placed("ladder", "Upper floor"), LINK_LABELS.removed("ladder", "Attic"), LINK_LABELS.lock("stairs", true), LINK_LABELS.lock("ladder", false), LINK_LABELS.kind("stairs"), LINK_LABELS.kind("ladder"), LINK_LABELS.same("stairs"), LINK_LABELS.same("ladder")],
      ["placing stairs to Upper floor", "placing a ladder to Upper floor", "removing a ladder to Attic", "locking the stairs", "unlocking the ladder", "changing stairs to a ladder", "changing a ladder to stairs", "changing stairs", "changing a ladder"],
    );
  });

  test("an opening's words", () => {
    assert.deepEqual(KIND_WORDS.opening, { bare: "an opening", the: "the opening", this: "this opening", them: "it", joins: "An opening joins" });
    assert.deepEqual(
      [
        LINK_WORDS.carried("Thorn", "opening"),
        LINK_WORDS.tooBigSqueeze("opening"),
        LINK_WORDS.tooBig("opening"),
        LINK_WORDS.changed("opening"),
        LINK_WORDS.overEnd("opening", "Ground floor", "Upper floor"),
        LINK_WORDS.notNextFor("opening"),
        LINK_WORDS.changeGround("opening", "Ground floor"),
        LINK_WORDS.block("opening", "Ground floor"),
        LINK_WORDS.between("opening", "A", "B"),
        LINK_WORDS.pitUnder("opening"),
        LINK_WORDS.onlyInAir,
        LINK_WORDS.openingLocked,
        LINK_WORDS.openingHidden,
        LINK_WORDS.openingSide,
        LINK_WORDS.stairsSide,
      ],
      [
        "Thorn is carried. Its holder goes through the opening.",
        "Too big for this opening. Squeeze to fit.",
        "Too big for this opening.",
        "the opening changed",
        "Those squares already have an opening to Ground floor on Upper floor.",
        "An opening joins a floor and the floor just above or below it.",
        "That would change the ground under the opening to Ground floor. Remove it first.",
        "That would block the opening to Ground floor. Remove it first.",
        "An opening joins A and B. Remove it before putting a floor between.",
        "A pit can't open under an opening. Remove it first.",
        "Only a creature in the air goes through an opening.",
        "Openings can't be locked.",
        "Openings can't be hidden. A pit trap can open to the floor below.",
        "Openings are at most 8 squares a side.",
        "Stairs and ladders are at most 4 squares a side.",
      ],
    );
    assert.deepEqual(
      [LINK_WORDS.kindChange("stairs", "opening"), LINK_WORDS.kindChange("ladder", "opening"), LINK_WORDS.kindChange("opening", "stairs"), LINK_WORDS.kindChange("opening", "ladder")],
      ["Remove them and place an opening.", "Remove it and place an opening.", "Remove it and place stairs.", "Remove it and place a ladder."],
    );
    assert.equal(LINK_WORDS.oneSize("stairs"), "Both ends of the stairs are one size.");
    assert.equal(LINK_WORDS.sameSquares("opening"), "An opening lies on the same squares of both floors.");
    assert.equal(LINK_WORDS.sameSquares("ladder"), "On hexes both ends of the ladder lie on the same hexes.");
    assert.equal(climbLabel("Thorn", "down", "opening"), "flying Thorn down through the opening");
    assert.deepEqual(
      [LINK_LABELS.placed("opening", "Ground floor"), LINK_LABELS.removed("opening", "Ground floor"), LINK_LABELS.same("opening"), LINK_LABELS.hide("stairs", true), LINK_LABELS.hide("ladder", false), LINK_LABELS.moved("stairs", "Upper floor"), LINK_LABELS.resized("opening", "Ground floor")],
      ["placing an opening to Ground floor", "removing an opening to Ground floor", "changing an opening", "hiding the stairs", "showing the ladder", "moving stairs to Upper floor", "resizing an opening to Ground floor"],
    );
  });

  test("an opening's later-edit refusals are stairs refusals, in a restore's words too", () => {
    const block = LINK_WORDS.block("opening", "Ground floor");
    assert.ok(isStairsRefusal(block));
    assert.equal(restoreStairsWords(block), "That would block the opening to Ground floor. The DM who placed it can remove it.");
    assert.equal(restoreStairsWords(LINK_WORDS.between("opening", "A", "B")), "An opening joins A and B. The DM who placed it can remove it.");
  });

  test("no em dash or semicolon in any of them", () => {
    const all = [
      LINK_WORDS.onlyInAir,
      LINK_WORDS.openingLocked,
      LINK_WORDS.openingHidden,
      LINK_WORDS.openingSide,
      ...(["stairs", "ladder", "opening"] as const).flatMap((k) => [LINK_WORDS.notNextFor(k), LINK_WORDS.oneSize(k), LINK_WORDS.sameSquares(k), LINK_WORDS.kindChange(k, "opening"), LINK_WORDS.carried("Thorn", k), LINK_WORDS.between(k, "A", "B"), climbLabel("Thorn", "up", k)]),
    ];
    for (const s of all) assert.doesNotMatch(s, /[\u2014;]/, s);
  });
});

describe("the put rules by kind (3, 8.2)", () => {
  test("an opening up to 8 by 8 is placed, one past it and stairs past 4 are refused in their words", () => {
    const s = tower();
    assert.equal(linkSideOf("opening"), 8);
    assert.equal(linkSideOf("ladder"), 4);
    assert.equal(linkProblem(s, draft({ rect: { x: 2, y: 2, w: 8, h: 8 } })), null);
    assert.equal(linkProblem(s, draft({ rect: { x: 2, y: 2, w: 9, h: 9 } })), LINK_WORDS.openingSide);
    assert.equal(linkProblem(s, draft({ rect: { x: 2, y: 2, w: 1, h: 9 } })), LINK_WORDS.openingSide);
    assert.equal(linkProblem(s, draft({ kind: "stairs", sceneId: GROUND, to: UPPER, rect: { x: 2, y: 2, w: 5, h: 5 } })), LINK_WORDS.stairsSide);
    assert.equal(linkProblem(s, draft({ kind: "ladder", sceneId: GROUND, to: UPPER, rect: { x: 2, y: 2, w: 4, h: 4 } })), null);
  });

  test("an opening two floors apart reads an opening's words, and stairs keep theirs", () => {
    const s = tower();
    assert.equal(linkProblem(s, draft({ sceneId: ATTIC, to: GROUND })), "An opening joins a floor and the floor just above or below it.");
    assert.equal(linkProblem(s, draft({ kind: "ladder", sceneId: ATTIC, to: GROUND })), LINK_WORDS.notNext);
  });

  test("the far end's own squares are judged on the far floor", () => {
    const walled = run(tower(), edge(UPPER, "9,3,w"));
    const stairs = draft({ kind: "stairs", sceneId: GROUND, to: UPPER, rect: { x: 3, y: 3, w: 2, h: 1 } });
    assert.equal(linkProblem(walled, stairs), null);
    assert.equal(linkProblem(walled, { ...stairs, pairRect: { x: 8, y: 3, w: 2, h: 1 } }), LINK_WORDS.wall("Upper floor"));
    const ladder = withStairs(tower(), { id: "l3", pairId: "l4", rect: { x: 12, y: 3, w: 1, h: 1 }, kind: "ladder" });
    assert.equal(linkProblem(ladder, { ...stairs, pairRect: { x: 11, y: 3, w: 2, h: 1 } }), LINK_WORDS.overEnd("ladder", "Ground floor", "Upper floor"));
    assert.equal(linkProblem(tower(), { ...stairs, pairRect: { x: 19, y: 3, w: 2, h: 1 } }), LINK_WORDS.pastEdge("Upper floor"));
  });
});

describe("the pair rules floorProblem holds (3, 8.1, 8.2)", () => {
  test("an opening locked or hidden is broken, as are hidden ends not alike", () => {
    const s = withOpening(tower());
    assert.equal(floorProblem(s, UPPER), null);
    assert.equal(floorProblem(ends(s, { locked: true }), UPPER), BROKEN);
    assert.equal(floorProblem(ends(s, { hidden: true }), UPPER), BROKEN);
    const stairs = withStairs();
    assert.equal(floorProblem(ends(stairs, { hidden: true }), GROUND), null, "hidden stairs, both ends alike");
    assert.equal(floorProblem(ends(stairs, { hidden: true }, ["l1"]), GROUND), BROKEN);
  });

  test("stairs on squares may lie on other squares of the far floor at one size, never at two", () => {
    const stairs = withStairs();
    const moved = { ...stairs, floorLinks: { ...stairs.floorLinks!, l2: { ...stairs.floorLinks!.l2!, rect: { x: 8, y: 5, w: 2, h: 1 } } } };
    assert.equal(floorProblem(moved, GROUND), null);
    const resized = { ...stairs, floorLinks: { ...stairs.floorLinks!, l2: { ...stairs.floorLinks!.l2!, rect: { x: 8, y: 5, w: 1, h: 1 } } } };
    assert.equal(floorProblem(resized, GROUND), BROKEN);
    // An opening keeps one rect.
    const opening = withOpening(tower());
    const apart = { ...opening, floorLinks: { ...opening.floorLinks!, o2: { ...opening.floorLinks!.o2!, rect: { x: 10, y: 10, w: 2, h: 2 } } } };
    assert.equal(floorProblem(apart, UPPER), BROKEN);
  });

  test("on hexes both ends keep the same hexes", () => {
    const base = tower();
    const scenes = Object.fromEntries(Object.entries(base.scenes).map(([id, sc]) => [id, sc.floor ? ({ ...sc, gridShape: "hexRows" } as Scene) : sc]));
    const hex = run({ ...base, scenes }, { t: "floorLink.put", link: { id: "l1", pairId: "l2", sceneId: GROUND, to: UPPER, rect: { x: 3, y: 3, w: 1, h: 1 }, kind: "stairs" } });
    assert.equal(hex.floorLinks!.l1!.grid, "hexRows");
    assert.equal(floorProblem(hex, GROUND), null);
    const apart = { ...hex, floorLinks: { ...hex.floorLinks!, l2: { ...hex.floorLinks!.l2!, rect: { x: 5, y: 5, w: 1, h: 1 } } } };
    assert.equal(floorProblem(apart, GROUND), BROKEN);
  });

  test("an end past its kind's side is broken, an opening of 8 is not", () => {
    const big = withOpening(tower(), { rect: { x: 2, y: 2, w: 8, h: 8 } });
    assert.equal(floorProblem(big, UPPER), null);
    const stairs = withStairs();
    assert.equal(floorProblem(ends(stairs, { rect: { x: 3, y: 3, w: 5, h: 1 } }), GROUND), BROKEN);
  });

  test("a trapdoor over an end blocks it, as a pit does", () => {
    const s = withTrapdoor(withStairs(), trapdoor("td1", { zone: { cells: [{ x: 4, y: 3, w: 1, h: 1 }] } }));
    assert.equal(floorProblem(s, UPPER), LINK_WORDS.block("stairs", "Ground floor"));
    const opening = withTrapdoor(withOpening(tower()), trapdoor("td1", { sceneId: GROUND, zone: { cells: [{ x: 7, y: 7, w: 1, h: 1 }] } }));
    assert.equal(floorProblem(opening, GROUND), LINK_WORDS.block("opening", "Upper floor"));
    assert.equal(floorProblem(withTrapdoor(withOpening(tower())), UPPER), null, "the trapdoor at 10, 10 away from it");
  });

  test("the DM's put of an opening over a wall below is refused in the builder's words", () => {
    const walled = run(tower(), edge(GROUND, "7,6,w"));
    assert.throws(() => run(walled, { t: "floorLink.put", link: { id: "o1", pairId: "o2", sceneId: UPPER, to: GROUND, rect: { x: 6, y: 6, w: 2, h: 2 }, kind: "opening" } }, DM), /A wall crosses those squares on Ground floor\./);
  });
});
