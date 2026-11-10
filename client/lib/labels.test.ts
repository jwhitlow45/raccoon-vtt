import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import { character, member, room, scene, token } from "#shared/testutil.ts";
import { labelOf, labelsFor, labelSpoken, labelSuffix, labelText, namesFull, NAMES_FULL_HELP, numberHelp, PREVIEW_HELP, type Label } from "./labels.ts";
import { initialsOf } from "./tokenView.ts";

/** A DM's copy of one scene whose Goblins have given `given` numbers in group 1 and Orcs `orcs` in group 2. */
function dmView(tokens: Token[], given = 2, orcs = 0): RoomState {
  const names: Record<string, [number, number]> = { Goblin: [1, given] };
  if (orcs > 0) names.Orc = [2, orcs];
  return room({ scenes: { s1: scene("s1", { numbers: { names } }) }, tokens: Object.fromEntries(tokens.map((t) => [t.id, t])) });
}

const goblin = (id: string, extra: Partial<Token> = {}) => token(id, { name: "Goblin", ...extra });

describe("the words a label makes", () => {
  test("a number, a preview and a disguise each follow the name", () => {
    assert.equal(labelText({ name: "Goblin" }), "Goblin");
    assert.equal(labelText({ name: "Goblin", number: 2 }), "Goblin 2");
    assert.equal(labelText({ name: "Goblin", preview: 3 }), "Goblin (3)");
    assert.equal(labelText({ name: "Orc", as: "Goblin", number: 2 }), "Orc (as Goblin 2)");
    assert.equal(labelText({ name: "Orc", as: "Goblin", preview: 3 }), "Orc (as Goblin (3))");
    assert.equal(labelSuffix({ as: "Goblin", preview: 3 }), " (as Goblin (3))");
  });

  test("a screen reader hears what a preview and a disguise mean, never brackets", () => {
    assert.equal(labelSpoken({ name: "Goblin", preview: 3 }), "Goblin, would be 3, not yet seen by the party");
    assert.equal(labelSpoken({ name: "Orc", as: "Goblin", number: 2 }), "Orc, shown to players as Goblin 2");
    assert.equal(labelSpoken({ name: "Goblin", number: 2 }), "Goblin 2");
  });

  test("a token missing from the map is named by its own fields", () => {
    assert.deepEqual(labelOf(new Map(), { id: "x", name: "Goblin", number: 4 }), { name: "Goblin", number: 4 });
    assert.deepEqual(labelOf(undefined, { name: "Goblin" }), { name: "Goblin" });
  });
});

describe("a DM's label map", () => {
  test("met creatures keep their numbers, the unmet take the next in brackets by id, and a shown companion takes none", () => {
    const state = dmView([
      goblin("a", { met: 1, number: 1 }),
      goblin("b", { met: 1, number: 2 }),
      goblin("e"),
      goblin("c"),
      goblin("d", { companion: { of: "thorn", turn: "own" }, ownerIds: ["p1"] }),
    ]);
    state.members.p1 = member("p1");
    state.characters.thorn = character("thorn", { ownerIds: ["p1"] });
    const labels = labelsFor(state, "dm");
    const shown = (id: string) => labelText(labels.get(id)!);
    assert.deepEqual(["a", "b", "c", "e", "d"].map(shown), ["Goblin 1", "Goblin 2", "Goblin (3)", "Goblin (4)", "Goblin"]);
    assert.deepEqual(initialsOf(labels.get("c")!), { text: "G3", preview: true });
    assert.deepEqual(initialsOf(labels.get("a")!), { text: "G1", preview: false });
  });

  test("a disguise reads its real name with what the table reads, beside a real one of the name", () => {
    const state = dmView([token("orc", { name: "Orc", nameHidden: true, publicName: "Goblin", met: 1, number: 2 }), goblin("g", { met: 1, number: 1 }), token("o2", { name: "Orc", met: 2, number: 2 })], 2, 2);
    const labels = labelsFor(state, "dm");
    assert.equal(labelText(labels.get("orc")!), "Orc (as Goblin 2)");
    assert.equal(labelText(labels.get("o2")!), "Orc 2");
    assert.equal(initialsOf(labels.get("orc")!).text, "G2");
    assert.equal(initialsOf(labels.get("o2")!).text, "O2");
  });

  test("an unseen disguise previews under its shown name", () => {
    const state = dmView([goblin("g", { met: 1, number: 1 }), token("orc", { name: "Orc", nameHidden: true, publicName: "Goblin" })], 1);
    assert.equal(labelText(labelsFor(state, "dm").get("orc")!), "Orc (as Goblin (2))");
  });

  test("an entry that did not change keeps its object, so a row reading it does not draw again", () => {
    const state = dmView([goblin("a", { met: 1, number: 1 }), goblin("b"), token("t", { name: "Troll" })], 1);
    const first = labelsFor(state, "dm");
    const next = labelsFor({ ...state, tokens: { ...state.tokens, t: { ...state.tokens.t!, name: "Ogre" } } }, "dm", first);
    assert.equal(next.get("a"), first.get("a"));
    assert.equal(next.get("b"), first.get("b"));
    assert.notEqual(next.get("t"), first.get("t"));
    assert.equal(labelsFor({ ...state, tokens: { ...state.tokens, a: { ...state.tokens.a!, x: 9 } } }, "dm", first), first, "a move changes no label, so the map stays");
  });
});

describe("a player's label map", () => {
  test("never shows brackets, whatever namesakes the copy holds", () => {
    // A player's copy: no register, no marks, and numbers only as the table gave them.
    const state = room({ tokens: { a: goblin("a"), b: goblin("b"), c: goblin("c", { number: 1 }) } });
    const labels = labelsFor(state, "player");
    assert.deepEqual(["a", "b", "c"].map((id) => labelText(labels.get(id)!)), ["Goblin", "Goblin", "Goblin 1"]);
    for (const label of labels.values()) assert.equal(label.preview, undefined);
  });

  test("an owner of a disguised creature reads its real name with the table's number", () => {
    const state = room({ tokens: { orc: token("orc", { name: "Orc", nameHidden: true, publicName: "Goblin", number: 2, ownerIds: ["p1"] }) } });
    assert.equal(labelText(labelsFor(state, "player").get("orc")!), "Orc (as Goblin 2)");
  });
});

describe("the token panel's help under a name", () => {
  const preview: Label = { name: "Goblin", preview: 3 };
  test("a preview, a disguise and a full scene each say what they mean, to the DM alone", () => {
    assert.equal(numberHelp(preview, true, false), PREVIEW_HELP);
    assert.equal(numberHelp({ name: "Orc", as: "Goblin", number: 2 }, true, false), "Players read Goblin 2.");
    assert.equal(numberHelp({ name: "Kobold" }, true, true), NAMES_FULL_HELP);
    assert.equal(numberHelp({ name: "Kobold" }, true, false), null);
    assert.equal(numberHelp(preview, false, true), null);
  });

  test("a scene full of names leaves a new name unnumbered, and a met one still numbered", () => {
    const names: Record<string, [number, number]> = {};
    for (let i = 0; i < 100; i++) names[`Name ${i}`] = [i + 1, 1];
    const state = room({ scenes: { s1: scene("s1", { numbers: { names } }) }, tokens: { k: token("k", { name: "Kobold" }), n: token("n", { name: "Name 3", met: 4, number: 1 }), m: token("m", { name: "Name 5" }) } });
    assert.equal(namesFull(state, state.tokens.k!), true);
    assert.equal(namesFull(state, state.tokens.n!), false);
    assert.equal(namesFull(state, state.tokens.m!), false, "a name the scene already numbers still takes numbers");
  });
});
