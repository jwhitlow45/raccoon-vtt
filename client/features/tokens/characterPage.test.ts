import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCharacterPageStore, openCharacterPage, openForm, pageBackTo, patchForm, shownPage, staleList } from "./characterPage.ts";

const BREE = { id: "bree" };
const CYRA = { id: "cyra" };
const ZED = { id: "zed" };

describe("which character's page shows (docs/design-v1-look-pass.md 3.1)", () => {
  test("a player with one character lands on its page until they pick, and the DM on the list", () => {
    assert.equal(shownPage(undefined, [BREE], false), "bree");
    assert.equal(shownPage(undefined, [BREE, CYRA], false), null, "with two, the list");
    assert.equal(shownPage(undefined, [], false), null);
    assert.equal(shownPage(undefined, [BREE], true), null, "the DM starts on the list");
  });

  test("Back's list stays the list, even for a player with one character", () => {
    assert.equal(shownPage(null, [BREE], false), null);
  });

  test("a page picked shows while its character is one of the viewer's", () => {
    assert.equal(shownPage("cyra", [BREE, CYRA], false), "cyra");
    assert.equal(shownPage("cyra", [BREE], false), null, "deleted, or no longer theirs: the list");
    assert.equal(shownPage("cyra", [BREE, CYRA], true), "cyra");
  });
});

describe("the form in the panel's place (LP10, FU16)", () => {
  test("each opening is an instance of its own, which remembers the outside opens it began with", () => {
    const store = createCharacterPageStore();
    openCharacterPage(store, "bree");
    openForm(store, { kind: "companion", characterId: "bree" });
    const first = store.getState().form!;
    assert.deepEqual([first.kind, first.opened], ["companion", 1]);
    openForm(store, { kind: "companion", characterId: "bree" });
    assert.notEqual(store.getState().form!.id, first.id, "the same form opened again is another instance");
  });

  test("an answer changes only the instance that sent it", () => {
    const store = createCharacterPageStore();
    openForm(store, { kind: "companion", characterId: "bree" });
    const sent = store.getState().form!.id;
    patchForm(store, sent, (f) => (f.kind === "companion" ? { ...f, sending: true } : f));
    const form = store.getState().form;
    assert.equal(form?.kind === "companion" && form.sending, true);
    // Cancel, and the form opened again with a new draft.
    patchForm(store, sent, () => null);
    openForm(store, { kind: "companion", characterId: "bree" });
    const again = store.getState().form!;
    patchForm(store, sent, () => null);
    assert.equal(store.getState().form, again, "the late answer left the new instance alone");
  });

  test("a stat blocks page an outside open passed gives way, the one opened after it stays", () => {
    const store = createCharacterPageStore();
    openForm(store, { kind: "blocks", characterId: "bree" });
    assert.equal(staleList(store.getState()), false);
    openCharacterPage(store, "bree");
    assert.equal(staleList(store.getState()), true, "an open made while the panel was away still counts");
    openForm(store, { kind: "blocks", characterId: "bree" });
    assert.equal(staleList(store.getState()), false);
    openForm(store, { kind: "new" });
    openCharacterPage(store, "bree");
    assert.equal(staleList(store.getState()), false, "a form leaves through its own question");
  });
});

describe("where Back's focus goes from a page", () => {
  test("its own row, then the rows after it, then those before it, nearest first, then New character, else the empty list's line", () => {
    assert.deepEqual(pageBackTo("cyra", [BREE, CYRA, ZED]), ["character:cyra", "character:zed", "character:bree", "new-character", "characters-empty"]);
    assert.deepEqual(pageBackTo("zed", [BREE, CYRA, ZED]), ["character:zed", "character:cyra", "character:bree", "new-character", "characters-empty"]);
    assert.deepEqual(pageBackTo("bree", [BREE]), ["character:bree", "new-character", "characters-empty"]);
  });

  test("a character not in the list names its own row alone", () => {
    assert.deepEqual(pageBackTo("gone", [BREE]), ["character:gone", "new-character", "characters-empty"]);
  });
});
