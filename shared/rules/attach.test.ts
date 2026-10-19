import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../limits.ts";
import type { AttachKind, CreatureSize, DiagonalRule, Token } from "../model.ts";
import { effect, token } from "../testutil.ts";
import {
  attachDistanceFt,
  carriedGroup,
  checkSet,
  dragExtra,
  getOffFits,
  getOffSpot,
  insideHolder,
  kindRefusal,
  linkHolds,
  linkLimitRefusal,
  moveGroups,
  publicMembers,
  seatSpot,
  withinReach,
} from "./attach.ts";

const NAMES = { carried: "Bree", holder: "Warhorse" };
const SIZES: CreatureSize[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"];
const RANK: Record<string, number> = { tiny: 0, small: 1, medium: 2, large: 3, huge: 4, gargantuan: 5 };
const CELLS: Record<string, number> = { tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };
const rules = (diagonal: DiagonalRule = "five") => ({ feetPerCell: 5, diagonal });

function creature(id: string, size: CreatureSize, overrides: Partial<Token> = {}): Token {
  return token(id, { size, x: 0, y: 0, ...overrides });
}

function linked(id: string, to: string, kind: AttachKind = "carry", overrides: Partial<Token> = {}): Token {
  return token(id, { attached: { to, kind }, ...overrides });
}

function tokensOf(...list: Token[]): Record<string, Token> {
  return Object.fromEntries(list.map((t) => [t.id, t]));
}

describe("which kinds fit which pairs (docs/design-v1-attach.md 5.1)", () => {
  test("a ride needs a creature that is not Tiny on a creature at least one size larger, for every pair of sizes", () => {
    for (const rider of SIZES) {
      for (const mount of SIZES) {
        const r = kindRefusal("ride", creature("r", rider), creature("m", mount), NAMES);
        const fits = rider !== "tiny" && RANK[mount]! - RANK[rider]! >= 1 && CELLS[rider]! <= CELLS[mount]!;
        assert.equal(r === null, fits, `${rider} on ${mount}: ${r}`);
      }
    }
  });

  test("a perch is a Tiny creature on any creature it fits on", () => {
    for (const holder of SIZES) {
      assert.equal(kindRefusal("perch", creature("f", "tiny"), creature("h", holder), NAMES), null, holder);
      assert.equal(kindRefusal("perch", creature("f", "small"), creature("h", holder), NAMES), "only a Tiny creature perches");
    }
    assert.equal(kindRefusal("ride", creature("f", "tiny"), creature("h", "large"), NAMES), "a Tiny creature perches instead of riding");
  });

  test("custom sizes read by their size category, and containment is a separate test", () => {
    // A 1 by 2 creature is Large, as a 2 by 2 one is: neither rides the other.
    const long = creature("l", "custom", { w: 1, h: 2 });
    const large = creature("g", "large");
    assert.match(kindRefusal("ride", long, large, NAMES) ?? "", /not big enough/);
    assert.match(kindRefusal("ride", large, long, NAMES) ?? "", /not big enough/);
    // A Small halfling on a Medium mastiff: one size, and the two single cells fit.
    assert.equal(kindRefusal("ride", creature("h", "small"), creature("m", "medium"), NAMES), null);
    // A Medium creature on a 1 by 3 custom creature, which is Huge: a size larger and it fits.
    assert.equal(kindRefusal("ride", creature("h", "medium"), creature("c", "custom", { w: 1, h: 3 }), NAMES), null);
    // A Large 2 by 2 creature on a 1 by 4 Gargantuan one is larger by size, but cannot fit.
    assert.match(kindRefusal("ride", large, creature("c", "custom", { w: 1, h: 4 }), NAMES) ?? "", /not big enough/);
  });

  test("a carry takes an object on anything and a creature on an object it fits on, and a creature by a larger creature", () => {
    const torch = creature("t", "tiny", { kind: "object" });
    const cart = creature("c", "large", { kind: "object" });
    assert.equal(kindRefusal("carry", torch, creature("b", "medium"), NAMES), null);
    assert.equal(kindRefusal("carry", creature("b", "medium"), cart, NAMES), null);
    assert.equal(kindRefusal("carry", creature("b", "medium", { kind: "npc" }), creature("c", "medium", { kind: "object" }), NAMES), null);
    assert.match(kindRefusal("carry", creature("k", "small"), creature("b", "small"), NAMES) ?? "", /not big enough/);
    assert.equal(kindRefusal("carry", creature("k", "small"), creature("b", "medium"), NAMES), null);
    // A cart only has to hold its passenger: a Large one fits a Large cart, and a Huge one does not.
    assert.equal(kindRefusal("carry", creature("o", "large"), cart, NAMES), null);
    assert.match(kindRefusal("carry", creature("o", "huge"), cart, NAMES) ?? "", /not big enough/);
  });

  test("only a creature rides, is ridden, drags or is dragged", () => {
    const crate = creature("c", "large", { kind: "object" });
    assert.equal(kindRefusal("ride", creature("t", "small", { kind: "object" }), creature("m", "large"), NAMES), "only a creature rides or perches");
    assert.match(kindRefusal("ride", creature("b", "medium"), crate, NAMES) ?? "", /Carry it instead/);
    assert.equal(kindRefusal("drag", crate, creature("b", "medium"), NAMES), "only a creature is dragged");
    assert.equal(kindRefusal("drag", creature("b", "medium"), crate, NAMES), "only a creature drags");
    assert.equal(kindRefusal("drag", creature("g", "gargantuan"), creature("b", "tiny"), NAMES), null);
  });

  test("a link holds while it fits where the two stand, and a drag while within reach", () => {
    const mount = creature("m", "large", { x: 4, y: 4 });
    assert.equal(linkHolds(rules(), "ride", creature("r", "medium", { x: 5, y: 5 }), mount), true);
    assert.equal(linkHolds(rules(), "ride", creature("r", "medium", { x: 6, y: 5 }), mount), false);
    assert.equal(linkHolds(rules(), "ride", creature("r", "medium", { x: 5, y: 5, sceneId: "s2" }), mount), false);
    // Reduce shrinks the mount to the rider's size: it still covers the cell, but no longer carries it.
    assert.equal(linkHolds(rules(), "ride", creature("r", "medium", { x: 4, y: 4 }), creature("m", "medium", { x: 4, y: 4 })), false);
    // A squeezed mount keeps its rider: links read the full footprint.
    assert.equal(linkHolds(rules(), "ride", creature("r", "medium", { x: 5, y: 5 }), { ...mount, squeeze: true }), true);
    assert.equal(linkHolds(rules(), "drag", creature("g", "medium", { x: 6, y: 4 }), mount), true);
    assert.equal(linkHolds(rules(), "drag", creature("g", "medium", { x: 7, y: 4 }), mount), false);
  });

  test("containment reads both full footprints on their own snap grids", () => {
    const horse = creature("h", "large", { x: 2, y: 2 });
    assert.equal(insideHolder(creature("t", "tiny", { x: 3.5, y: 3.5 }), horse), true);
    assert.equal(insideHolder(creature("t", "tiny", { x: 4, y: 3.5 }), horse), false);
    assert.equal(insideHolder(creature("b", "medium", { x: 2.4, y: 3 }), horse), true);
  });
});

describe("reach (5.1, drag and a player's attach)", () => {
  test("is 5 ft by the room's rule, or one cell where a cell is wider", () => {
    const a = creature("a", "medium", { x: 0, y: 0 });
    for (const diagonal of ["five", "fiveTen", "euclid"] as const) {
      assert.equal(withinReach(rules(diagonal), a, creature("b", "medium", { x: 1, y: 0 })), true, diagonal);
      assert.equal(withinReach(rules(diagonal), a, creature("b", "medium", { x: 2, y: 0 })), false, diagonal);
    }
    // A diagonal neighbor is 5 ft away by the 5 ft and 5-10-5 rules, and 7 ft by true distance.
    assert.equal(withinReach(rules("five"), a, creature("b", "medium", { x: 1, y: 1 })), true);
    assert.equal(withinReach(rules("fiveTen"), a, creature("b", "medium", { x: 1, y: 1 })), true);
    assert.equal(withinReach(rules("euclid"), a, creature("b", "medium", { x: 1, y: 1 })), false);
    assert.equal(withinReach({ feetPerCell: 10, diagonal: "five" }, a, creature("b", "medium", { x: 1, y: 0 })), true);
  });

  test("counts elevation: a creature 10 ft above is out of reach", () => {
    const a = creature("a", "medium");
    assert.equal(withinReach(rules(), a, creature("b", "medium", { x: 1, elevation: 5 })), true);
    assert.equal(withinReach(rules(), a, creature("b", "medium", { x: 1, elevation: 10 })), false);
    assert.equal(attachDistanceFt(rules(), a, creature("b", "medium", { x: 1, elevation: 10 })), 10);
  });
});

describe("the seat (4.1)", () => {
  test("is the spot on the carried token's own grid inside the holder nearest where it stood, ties to the smaller y then x", () => {
    const horse = creature("h", "large", { x: 4, y: 4 });
    assert.deepEqual(seatSpot(creature("b", "medium", { x: 7, y: 5 }), horse), { x: 5, y: 5 });
    assert.deepEqual(seatSpot(creature("b", "medium", { x: 3, y: 3 }), horse), { x: 4, y: 4 });
    // Read from its snapped footprint: 4.4 stands in row 4.
    assert.deepEqual(seatSpot(creature("b", "medium", { x: 6, y: 4.4 }), horse), { x: 5, y: 4 });
    // A Tiny familiar keeps to half cells.
    assert.deepEqual(seatSpot(creature("f", "tiny", { x: 6.5, y: 4.5 }), horse), { x: 5.5, y: 4.5 });
    assert.equal(seatSpot(creature("g", "huge"), horse), null);
  });
});

describe("getting off (4.3)", () => {
  const bounds = { w: 10, h: 10 };
  const horse = creature("h", "large", { x: 4, y: 4 });
  const rider = creature("b", "medium", { x: 4, y: 4 });

  test("lands inside the scene, within 5 ft of the holder and clear of it", () => {
    assert.equal(getOffFits(rules(), bounds, rider, horse, { x: 6, y: 4 }), true);
    assert.equal(getOffFits(rules(), bounds, rider, horse, { x: 5, y: 4 }), false);
    assert.equal(getOffFits(rules(), bounds, rider, horse, { x: 7, y: 4 }), false);
    assert.equal(getOffFits(rules(), bounds, rider, creature("h", "large", { x: 8, y: 8 }), { x: 10, y: 8 }), false);
  });

  test("the first spot goes east of the middle, then clockwise, and skips what the device refuses", () => {
    // The middle of the horse is the corner (5, 5) for a Medium creature, so the ring starts at (6, 5) and turns south.
    const first = getOffSpot(rules(), bounds, rider, horse);
    assert.deepEqual(first, { x: 6, y: 5 });
    const second = getOffSpot(rules(), bounds, rider, horse, (p) => !(p.x === 6 && p.y === 5));
    assert.deepEqual(second, { x: 6, y: 6 });
    assert.equal(getOffSpot(rules(), bounds, rider, horse, () => false), null);
  });

  test("on a fine grid, reach is 5 ft: five cells", () => {
    const fine = { feetPerCell: 1, diagonal: "five" as const };
    const spot = getOffSpot(fine, { w: 40, h: 40 }, creature("b", "medium", { x: 10, y: 10 }), creature("h", "large", { x: 10, y: 10 }), (p) => p.x > 15);
    assert.ok(spot && spot.x > 15 && spot.x <= 17, JSON.stringify(spot));
  });
});

describe("groups (8.2)", () => {
  // horse carries bree, who carries torch and drags gob, who carries a dagger.
  const tokens = tokensOf(
    creature("horse", "large"),
    linked("bree", "horse", "ride"),
    linked("torch", "bree", "carry", { kind: "object", size: "tiny" }),
    linked("gob", "bree", "drag"),
    linked("dagger", "gob", "carry", { kind: "object", size: "tiny" }),
    token("cat"),
  );

  test("a group is the token, then what it carries, depth first in token id order", () => {
    assert.deepEqual(carriedGroup(tokens, "horse"), ["horse", "bree", "gob", "dagger", "torch"]);
    assert.deepEqual(carriedGroup(tokens, "bree", new Set(["gob"])), ["bree", "torch"]);
    assert.deepEqual(carriedGroup(tokens, "cat"), ["cat"]);
  });

  test("a link to a holder on another scene carries nothing", () => {
    const split = { ...tokens, bree: { ...tokens.bree!, sceneId: "s2" } };
    assert.deepEqual(carriedGroup(split, "horse"), ["horse"]);
  });

  test("the split is by nearest named ancestor, the same for any order of the named tokens", () => {
    const one = moveGroups(tokens, ["horse", "gob"]);
    const other = moveGroups(tokens, ["gob", "horse"]);
    assert.deepEqual(one.get("horse"), ["horse", "bree", "torch"]);
    assert.deepEqual(one.get("gob"), ["gob", "dagger"]);
    assert.deepEqual(other.get("horse"), one.get("horse"));
    assert.deepEqual(other.get("gob"), one.get("gob"));
  });

  test("a loop is walked once, and split the same whichever token of it is named", () => {
    const loop = tokensOf(linked("a", "c"), linked("b", "a"), linked("c", "b"));
    assert.deepEqual(carriedGroup(loop, "a"), ["a", "b", "c"]);
    for (const order of [["a", "c"], ["c", "a"]]) {
      const groups = moveGroups(loop, order);
      assert.deepEqual(groups.get("a"), ["a", "b"]);
      assert.deepEqual(groups.get("c"), ["c"]);
    }
  });

  test("public members walk only links whose two ends every player sees, and the check set adds the named tokens", () => {
    const hidden = new Set(["bree"]);
    const seen = (t: { id: string }) => !hidden.has(t.id);
    assert.deepEqual(publicMembers(tokens, "horse", seen), ["horse"]);
    assert.deepEqual(checkSet(tokens, "horse", new Set(["horse"]), seen), ["horse"]);
    // A hidden rider the op names is in its own check set, with the links below it every player sees.
    assert.deepEqual(checkSet(tokens, "bree", new Set(["bree"]), seen), ["bree", "gob", "dagger", "torch"]);
    assert.deepEqual(publicMembers(tokens, "bree", seen), ["bree"]);
    hidden.clear();
    hidden.add("gob");
    assert.deepEqual(publicMembers(tokens, "horse", seen), ["horse", "bree", "torch"]);
  });
});

describe("the limits and loops (5.1)", () => {
  const all = () => true;

  test("a loop is refused, a chain is at most 3 deep, a token carries at most 8 and a group moves at most 20", () => {
    const chain = tokensOf(creature("horse", "large"), linked("bree", "horse", "ride"), creature("torch", "tiny", { kind: "object" }), creature("ring", "tiny", { kind: "object" }));
    assert.equal(linkLimitRefusal(chain, "horse", "bree", all, NAMES), "Bree would carry itself");
    assert.equal(linkLimitRefusal(chain, "torch", "bree", all, NAMES), null);
    const deeper = { ...chain, torch: linked("torch", "bree", "carry", { kind: "object", size: "tiny" }) };
    assert.equal(linkLimitRefusal(deeper, "ring", "torch", all, NAMES), `a chain of carried tokens is at most ${LIMITS.attachDepth} deep`);
    // Replacing the token's own link is no new depth.
    assert.equal(linkLimitRefusal(deeper, "torch", "bree", all, NAMES), null);

    const many: Token[] = [creature("cart", "gargantuan", { kind: "object" })];
    for (let i = 0; i < LIMITS.carriedPerToken; i++) many.push(linked(`p${i}`, "cart", "carry", { size: "tiny" }));
    many.push(creature("extra", "tiny"));
    assert.equal(linkLimitRefusal(tokensOf(...many), "extra", "cart", all, NAMES), `a token carries at most ${LIMITS.carriedPerToken} others`);

    const wide: Token[] = [creature("ship", "gargantuan", { kind: "object" })];
    for (let i = 0; i < 6; i++) {
      wide.push(linked(`deck${i}`, "ship", "carry", { size: "large", kind: "object" }));
      wide.push(linked(`crew${i}a`, `deck${i}`, "carry", { size: "tiny" }));
      wide.push(linked(`crew${i}b`, `deck${i}`, "carry", { size: "tiny" }));
    }
    wide.push(linked("deck6", "ship", "carry", { size: "large", kind: "object" }));
    // 1 + 6 * 3 + 1 = 20 already.
    wide.push(creature("stow", "tiny"));
    assert.equal(linkLimitRefusal(tokensOf(...wide), "stow", "deck6", all, NAMES), `a group moves at most ${LIMITS.groupTokens} tokens`);
    assert.equal(linkLimitRefusal(tokensOf(...wide), "stow", "deck6", (t) => !t.id.endsWith("b"), NAMES), null);
  });

  test("a player's check counts only what every player sees and the named tokens", () => {
    // The hidden imp carries the hidden dagger: the player's attach of the coin to the visible goblin sees no depth past it.
    const tokens = tokensOf(creature("gob", "medium"), linked("imp", "gob", "carry", { size: "tiny" }), linked("dagger", "imp", "carry", { size: "tiny", kind: "object" }), creature("coin", "tiny", { kind: "object" }));
    const playerGraph = (t: { id: string }) => t.id === "gob" || t.id === "coin";
    assert.equal(linkLimitRefusal(tokens, "coin", "dagger", all, NAMES), `a chain of carried tokens is at most ${LIMITS.attachDepth} deep`);
    assert.equal(linkLimitRefusal(tokens, "coin", "gob", playerGraph, NAMES), null);
    // A loop through a link the player's graph leaves out stands.
    const loop = tokensOf(creature("a", "medium"), linked("b", "a", "carry"));
    assert.equal(linkLimitRefusal(loop, "a", "b", all, NAMES), "Bree would carry itself");
    assert.equal(linkLimitRefusal(loop, "a", "b", (t) => t.id === "a", NAMES), null);
  });
});

describe("the cost of dragging (7.3)", () => {
  const seenAll = () => true;
  const grappled = (t: Token): Token => ({ ...t, actor: { inline: { ...("inline" in t.actor ? t.actor.inline : ({} as never)), effects: [effect("g", { key: "grappled" })] } } });

  test("is 1 for a creature dragged, or carried by a carry, that is neither Tiny nor two sizes smaller", () => {
    const base = (carried: Token) => tokensOf(creature("thorn", "medium"), carried);
    assert.equal(dragExtra(base(linked("gob", "thorn", "drag", { size: "small" })), "thorn", seenAll), 1);
    assert.equal(dragExtra(base(linked("gob", "thorn", "carry", { size: "small" })), "thorn", seenAll), 1);
    assert.equal(dragExtra(base(linked("rat", "thorn", "drag", { size: "tiny" })), "thorn", seenAll), 0);
    assert.equal(dragExtra(tokensOf(creature("ogre", "large"), linked("gob", "ogre", "drag", { size: "small" })), "ogre", seenAll), 0);
    assert.equal(dragExtra(base(linked("torch", "thorn", "carry", { size: "small", kind: "object" })), "thorn", seenAll), 0);
    assert.equal(dragExtra(base(linked("owl", "thorn", "perch", { size: "small" })), "thorn", seenAll), 0);
    assert.equal(dragExtra(tokensOf(creature("cart", "large", { kind: "object" }), linked("gob", "cart", "drag")), "cart", seenAll), 0);
  });

  test("is 1 however many it drags, and 0 for a creature or link not every player sees", () => {
    const two = tokensOf(creature("thorn", "medium"), linked("a", "thorn", "drag"), linked("b", "thorn", "drag"));
    assert.equal(dragExtra(two, "thorn", seenAll), 1);
    assert.equal(dragExtra(two, "thorn", (t) => t.id === "thorn"), 0);
    assert.equal(dragExtra(two, "thorn", (t) => t.id !== "thorn"), 0);
  });

  test("never reads a condition: the same with or without Grappled", () => {
    const plain = tokensOf(creature("thorn", "medium"), linked("gob", "thorn", "drag"));
    const held = tokensOf(creature("thorn", "medium"), grappled(linked("gob", "thorn", "drag")));
    assert.equal(dragExtra(plain, "thorn", seenAll), dragExtra(held, "thorn", seenAll));
  });
});
