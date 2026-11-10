import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Scene, Token } from "./model.ts";
import {
  boardLabel,
  labelParts,
  memberOf,
  nameEntry,
  NUMBER_NAMES_MOST,
  NUMBERS_MOST,
  numberable,
  ownLabel,
  previewNumbers,
  publicLabel,
  registerBytesMost,
  shownName,
  tableNumber,
} from "./numbering.ts";
import { character, room, scene, token } from "./testutil.ts";

/** A room whose scene s1 has given Goblin (group 1) two numbers and Orc (group 2) one. */
function numbered(tokens: Token[], numbers: Scene["numbers"] = { names: { Goblin: [1, 2], Orc: [2, 1] } }, extra: Partial<RoomState> = {}): RoomState {
  return room({ scenes: { s1: scene("s1", { numbers }), s2: scene("s2", { order: 1 }) }, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), ...extra });
}

describe("the shown name", () => {
  test("is the name, the public name while hidden, or Unknown creature", () => {
    assert.equal(shownName(token("a", { name: "Orc" })), "Orc");
    assert.equal(shownName(token("a", { name: "Orc", nameHidden: true, publicName: "Goblin" })), "Goblin");
    assert.equal(shownName(token("a", { name: "Orc", nameHidden: true })), "Unknown creature");
    assert.equal(shownName(token("a", { name: "Orc", publicName: "Goblin" })), "Orc");
  });
});

describe("what can carry a number", () => {
  test("monsters and NPCs, not characters or objects", () => {
    const state = room();
    assert.equal(numberable(state, token("a", { kind: "monster" })), true);
    assert.equal(numberable(state, token("a", { kind: "npc" })), true);
    assert.equal(numberable(state, token("a", { kind: "pc" })), false);
    assert.equal(numberable(state, token("a", { kind: "object" })), false);
  });

  test("a party member's companion is not numbered, one of a character no player plays is", () => {
    const state = room({ characters: { hero: character("hero", { ownerIds: ["p1"] }), npc: character("npc", { ownerIds: [] }) } });
    assert.equal(numberable(state, token("owl", { kind: "npc", name: "Owl", companion: { of: "hero", turn: "own" }, ownerIds: ["p1"] })), false);
    assert.equal(numberable(state, token("owl", { kind: "npc", name: "Owl", companion: { of: "npc", turn: "own" } })), true);
  });
});

describe("membership", () => {
  test("needs a mark matching the shown name's group on the creature's scene", () => {
    const state = numbered([]);
    assert.equal(memberOf(state, token("a", { met: 1, number: 2 })), true);
    assert.equal(memberOf(state, token("a", { number: 2 })), false, "a number alone");
    assert.equal(memberOf(state, token("a", { met: 2, number: 2 })), false, "another name's group");
    assert.equal(memberOf(state, token("a", { met: 1, number: 2, sceneId: "s2" })), false, "another scene");
    assert.equal(memberOf(state, token("a", { name: "Kobold", met: 1 })), false, "a name the scene never met");
    assert.equal(memberOf(room(), token("a", { met: 1, number: 2 })), false, "a scene with no numbers");
  });

  test("goes by the shown name, so a private rename under a hidden name changes nothing", () => {
    const state = numbered([]);
    const hidden = token("a", { name: "Orc", nameHidden: true, publicName: "Goblin", met: 1, number: 2 });
    assert.equal(memberOf(state, hidden), true);
    assert.equal(memberOf(state, { ...hidden, name: "Hobgoblin" }), true);
    assert.equal(memberOf(state, { ...hidden, nameHidden: false }), false);
  });

  test("reads the register on the scene's main floor", () => {
    const state = room({
      scenes: { s1: scene("s1", { numbers: { names: { Goblin: [1, 2] } }, floor: { of: "s1", level: 0, name: "Ground" } }), up: scene("up", { floor: { of: "s1", level: 1, name: "Upper" } }) },
    });
    assert.equal(memberOf(state, token("a", { sceneId: "up", met: 1, number: 2 })), true);
  });

  test("an entry named for an object's own members is read as an own entry only", () => {
    const state = numbered([]);
    assert.equal(memberOf(state, token("a", { name: "constructor", met: 1 })), false);
    assert.equal(memberOf(state, token("a", { name: "__proto__", met: 1 })), false);
    assert.equal(nameEntry(state, "s1", "constructor"), undefined);
    assert.equal(nameEntry(state, "s1", "__proto__"), undefined);
    const names: Record<string, [number, number]> = { ["__proto__"]: [3, 2] };
    assert.equal(memberOf(numbered([], { names }), token("a", { name: "__proto__", met: 3 })), true);
  });
});

describe("the table's number", () => {
  test("is a numberable member's number and nothing else", () => {
    const state = numbered([]);
    assert.equal(tableNumber(state, token("a", { met: 1, number: 2 })), 2);
    assert.equal(tableNumber(state, token("a", { met: 1 })), undefined);
    assert.equal(tableNumber(state, token("a", { number: 7 })), undefined, "a number from before");
    assert.equal(tableNumber(state, token("a", { kind: "object", met: 1, number: 2 })), undefined, "an object");
  });
});

describe("labels", () => {
  const orc = token("o", { name: "Orc", nameHidden: true, publicName: "Goblin", met: 1, number: 2 });
  const realOrc = token("r", { name: "Orc", met: 2, number: 2 });

  test("the DM reads a disguise numbered under its shown name beside a real one", () => {
    const state = numbered([orc, realOrc], { names: { Goblin: [1, 2], Orc: [2, 2] } });
    assert.equal(ownLabel(state, orc), "Orc (as Goblin 2)");
    assert.equal(ownLabel(state, realOrc), "Orc 2");
    assert.deepEqual(labelParts(state, orc, "own"), { name: "Orc", number: 2, as: "Goblin" });
  });

  test("everyone else reads the shown name and the table's number", () => {
    const state = numbered([orc]);
    assert.equal(publicLabel(state, orc), "Goblin 2");
    assert.equal(publicLabel(state, token("u", { name: "Cultist", nameHidden: true, met: 3, number: 2 })), "Unknown creature", "no group of its shown name");
    assert.equal(publicLabel(numbered([], { names: { "Unknown creature": [3, 2] } }), token("u", { name: "Cultist", nameHidden: true, met: 3, number: 2 })), "Unknown creature 2");
  });

  test("on the server a number counts only for a member, on a copy it is read as sent", () => {
    const stale = token("g", { number: 7 });
    assert.equal(publicLabel(numbered([stale]), stale), "Goblin");
    assert.equal(publicLabel(null, { ...stale, number: 3 }), "Goblin 3");
  });

  test("an unnumbered disguise reads as its name alone", () => {
    const state = numbered([]);
    assert.equal(ownLabel(state, token("o", { name: "Orc", nameHidden: true, publicName: "Goblin" })), "Orc");
  });

  test("a preview shows on a DM's board alone", () => {
    const previews = new Map([["g", 3]]);
    const g = token("g", { name: "Goblin" });
    assert.equal(boardLabel(previews, g, "dm"), "Goblin (3)");
    assert.equal(boardLabel(previews, g, "player"), "Goblin");
    assert.equal(boardLabel(previews, token("g", { name: "Orc", nameHidden: true, publicName: "Goblin" }), "dm"), "Orc (as Goblin (3))");
    assert.equal(boardLabel(previews, { ...g, number: 2 }, "dm"), "Goblin 2", "a number wins over a preview");
  });
});

describe("previews", () => {
  test("number the unmet after the last given, in id order, skipping a shown companion", () => {
    const state = numbered(
      [
        token("a1", { met: 1, number: 1 }),
        token("a2", { met: 1, number: 2 }),
        token("c3"),
        token("b4"),
        token("owl", { companion: { of: "hero", turn: "own" }, ownerIds: ["p1"] }),
      ],
      undefined,
      { characters: { hero: character("hero") } },
    );
    assert.deepEqual([...previewNumbers(state, "s1")].sort(), [
      ["b4", 3],
      ["c3", 4],
    ]);
  });

  test("a name not met previews only two or more", () => {
    assert.deepEqual([...previewNumbers(numbered([token("k1", { name: "Kobold" })]), "s1")], []);
    assert.deepEqual([...previewNumbers(numbered([token("k1", { name: "Kobold" }), token("k2", { name: "Kobold" })]), "s1")].sort(), [
      ["k1", 1],
      ["k2", 2],
    ]);
  });

  test("a disguise ranks under its shown name", () => {
    const state = numbered([token("o", { name: "Orc", nameHidden: true, publicName: "Goblin" })]);
    assert.deepEqual([...previewNumbers(state, "s1")], [["o", 3]]);
  });

  test("only the scene asked, all its floors", () => {
    const state = room({
      scenes: { s1: scene("s1", { floor: { of: "s1", level: 0, name: "Ground" } }), up: scene("up", { floor: { of: "s1", level: 1, name: "Upper" } }), s2: scene("s2") },
      tokens: { a: token("a"), b: token("b", { sceneId: "up" }), c: token("c", { sceneId: "s2" }) },
    });
    assert.deepEqual([...previewNumbers(state, "s1")].sort(), [
      ["a", 1],
      ["b", 2],
    ]);
  });

  test("stop at the caps", () => {
    const full: Record<string, [number, number]> = {};
    for (let i = 0; i < NUMBER_NAMES_MOST; i++) full[`Name ${i}`] = [i + 1, 1];
    assert.deepEqual([...previewNumbers(numbered([token("k1", { name: "Kobold" }), token("k2", { name: "Kobold" })], { names: full }), "s1")], [], "a new name at the names cap");
    const nearly = numbered([token("g1"), token("g2")], { names: { Goblin: [1, NUMBERS_MOST - 1] } });
    assert.deepEqual([...previewNumbers(nearly, "s1")], [["g1", NUMBERS_MOST]], "the numbers cap");
  });
});

describe("the register's byte bound", () => {
  test("covers a full register of the widest names, ids and counts", () => {
    const names: Record<string, [number, number]> = {};
    for (let i = 0; i < NUMBER_NAMES_MOST; i++) names[String.fromCharCode(0xd800 + i).repeat(80)] = [Number.MAX_SAFE_INTEGER, NUMBERS_MOST];
    const bare = scene("s1");
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    assert.equal(bytes({ ...bare, numbers: { names } }) - bytes(bare), registerBytesMost());
  });
});
