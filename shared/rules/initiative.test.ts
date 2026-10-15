import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "../model.ts";
import { actor, character, effect, entry, room, token } from "../testutil.ts";
import { advantageHint, groupKeyFor, nextTurn, placeEntry, scoredValue, sortEntries } from "./initiative.ts";

function fixture() {
  const state = room();
  state.characters.c1 = character("c1", { name: "Ayla", actor: actor({ initBonus: 3 }) });
  state.tokens.pc = token("pc", { kind: "pc", name: "Ayla", actor: { ref: "c1" } });
  state.tokens.g1 = token("g1", { name: "Goblin", actor: { inline: actor({ initBonus: 2, srdId: "goblin", initScore: 12 }) } });
  state.tokens.g2 = token("g2", { name: "Goblin", actor: { inline: actor({ initBonus: 2, srdId: "goblin" }) } });
  state.tokens.orc = token("orc", { name: "Orc", actor: { inline: actor({ initBonus: 1 }) } });
  return state;
}

describe("ordering", () => {
  test("value descending, null last, then tieOrder", () => {
    const sorted = sortEntries([
      entry("a", { value: 10, tieOrder: 1 }),
      entry("b", { value: null, tieOrder: 0 }),
      entry("c", { value: 15, tieOrder: 5 }),
      entry("d", { value: 10, tieOrder: 0 }),
    ]);
    assert.deepEqual(sorted.map((e) => e.id), ["c", "d", "a", "b"]);
  });

  test("a new tie goes PCs first, then higher bonus, then name, and renumbers", () => {
    const state = fixture();
    let entries = placeEntry(state, [], entry("orc", { tokenId: "orc", value: 12 }));
    entries = placeEntry(state, entries, entry("g1", { tokenId: "g1", value: 12 }));
    entries = placeEntry(state, entries, entry("pc", { tokenId: "pc", value: 12 }));
    entries = placeEntry(state, entries, entry("g2", { tokenId: "g2", value: 12 }));
    assert.deepEqual(entries.map((e) => e.id), ["pc", "g1", "g2", "orc"]);
    assert.deepEqual(entries.map((e) => e.tieOrder), [0, 1, 2, 3]);
  });

  test("re-placing a dragged group keeps the DM's order for the others", () => {
    const state = fixture();
    const dragged = [entry("orc", { tokenId: "orc", value: 12, tieOrder: 0 }), entry("g1", { tokenId: "g1", value: 12, tieOrder: 1 })];
    const entries = placeEntry(state, dragged, entry("g2", { tokenId: "g2", value: 12 }));
    assert.deepEqual(entries.map((e) => e.id), ["orc", "g1", "g2"]);
    const moved = placeEntry(state, entries, { ...entries[0]!, value: 20 });
    assert.deepEqual(moved.map((e) => e.id), ["orc", "g1", "g2"]);
    const down = placeEntry(state, entries, { ...entries[0]!, value: 5 });
    assert.deepEqual(down.map((e) => e.id), ["g1", "g2", "orc"]);
  });
});

describe("next", () => {
  test("starts on the first row, wraps with a round, and skips the defeated", () => {
    const state = fixture();
    state.tokens.g2!.actor = { inline: actor({ life: "dead", hp: { cur: 0, max: 7, temp: 0 } }) };
    const encounter = {
      rev: 0,
      round: 1,
      activeEntryId: null,
      entries: [entry("pc", { tokenId: "pc", value: 20, tieOrder: 0 }), entry("g2", { tokenId: "g2", value: 15, tieOrder: 1 }), entry("orc", { tokenId: "orc", value: 10, tieOrder: 2 })],
    };
    const first = nextTurn(state, encounter, DEFAULT_SETTINGS)!;
    assert.deepEqual(first, { landing: "pc", skipped: [], wrapped: false });
    const second = nextTurn(state, { ...encounter, activeEntryId: "pc" }, DEFAULT_SETTINGS)!;
    assert.deepEqual(second, { landing: "orc", skipped: ["g2"], wrapped: false });
    const third = nextTurn(state, { ...encounter, activeEntryId: "orc" }, DEFAULT_SETTINGS)!;
    assert.deepEqual(third, { landing: "pc", skipped: [], wrapped: true });
    const noSkip = nextTurn(state, { ...encounter, activeEntryId: "pc" }, { ...DEFAULT_SETTINGS, skipDefeated: false })!;
    assert.equal(noSkip.landing, "g2");
  });

  test("never loops when every row is defeated", () => {
    const state = fixture();
    state.tokens.orc!.actor = { inline: actor({ life: "dead" }) };
    const encounter = { rev: 0, round: 1, activeEntryId: "orc", entries: [entry("orc", { tokenId: "orc", value: 10 })] };
    assert.deepEqual(nextTurn(state, encounter, DEFAULT_SETTINGS), { landing: "orc", skipped: [], wrapped: true });
    assert.equal(nextTurn(state, { ...encounter, entries: [] }, DEFAULT_SETTINGS), null);
  });
});

describe("reminders and scores", () => {
  test("advantage from Invisible, disadvantage from Surprised or Incapacitated, both cancel", () => {
    assert.equal(advantageHint([effect("a", { key: "invisible" })]), "adv");
    assert.equal(advantageHint([effect("a", { key: "surprised" })]), "dis");
    assert.equal(advantageHint([effect("a", { key: "paralyzed" })]), "dis");
    assert.equal(advantageHint([effect("a", { key: "invisible" }), effect("b", { key: "stunned" })]), undefined);
    assert.equal(advantageHint([]), undefined);
  });

  test("the initiative score is used only when the room says so and the actor has one", () => {
    const state = fixture();
    const g1 = state.tokens.g1!.actor;
    const a = "inline" in g1 ? g1.inline : undefined;
    assert.equal(scoredValue(a, DEFAULT_SETTINGS), null);
    assert.equal(scoredValue(a, { ...DEFAULT_SETTINGS, monsterInitScore: true }), 12);
    assert.equal(scoredValue(actor(), { ...DEFAULT_SETTINGS, monsterInitScore: true }), null);
  });

  test("group keys come from the SRD id or the name, never for PCs", () => {
    const state = fixture();
    assert.equal(groupKeyFor(state, { tokenId: "g1" }), "goblin");
    assert.equal(groupKeyFor(state, { tokenId: "orc" }), "Orc");
    assert.equal(groupKeyFor(state, { tokenId: "pc" }), undefined);
    assert.equal(groupKeyFor(state, { characterId: "c1" }), undefined);
  });
});
