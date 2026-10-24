import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, P2, character, entry, room, token } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ReactionSection, reactionFor } = await import("./ReactionSection.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * Combat's Reaction section (docs/design-v1-token-sections.md 3.2): the
 * row's Reaction used switch alone, while the creature has a Reaction in
 * the fight, for the DM or the row's owner as the server allows, and a
 * shared companion's own for the DM and its owners.
 */

/**
 * Thorn, Pat's (p1), with his token and Skitter, a companion sharing his
 * turn. Bree's token is lent to p2, her row keyed by the character. A
 * goblin with a row, and a lent token whose row is the token's own.
 */
function fight(): RoomState {
  const state = room({
    characters: {
      thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }),
      bree: character("bree", { name: "Bree", ownerIds: [] }),
      cara: character("cara", { name: "Cara", ownerIds: [] }),
    },
  });
  state.tokens.thornT = token("thornT", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } });
  // A companion carries its character's owners (shared/reducer/companions.ts).
  state.tokens.skitter = token("skitter", { name: "Skitter", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared", reactionUsed: true } });
  state.tokens.loner = token("loner", { name: "Loner", ownerIds: ["p1"], companion: { of: "thorn", turn: "none" } });
  state.tokens.breeT = token("breeT", { kind: "pc", name: "Bree", ownerIds: ["p2"], actor: { ref: "bree" } });
  state.tokens.caraT = token("caraT", { kind: "pc", name: "Cara", ownerIds: ["p2"], actor: { ref: "cara" } });
  state.tokens.goblin = token("goblin", { name: "Goblin" });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "et",
    entries: [entry("et", { tokenId: "thornT", value: 18 }), entry("eb", { characterId: "bree", value: 15 }), entry("ec", { tokenId: "caraT", value: 12, reactionUsed: true }), entry("eg", { tokenId: "goblin", value: 10 })],
  };
  return state;
}

const you = (v: Viewer) => ({ role: v.role, memberId: v.memberId });

describe("whose Reaction a viewer marks (reactionFor)", () => {
  const state = fight();

  test("the DM marks every row's and a shared companion's own", () => {
    assert.deepEqual(reactionFor(state, you(DM), { tokenId: "goblin" }), { kind: "row", entryId: "eg", tokenId: "goblin" });
    assert.deepEqual(reactionFor(state, you(DM), { tokenId: "skitter" }), { kind: "companion", tokenId: "skitter", entryId: "et" });
    assert.deepEqual(reactionFor(state, you(DM), { characterId: "thorn" }), { kind: "row", entryId: "et", tokenId: "thornT" }, "a character's page finds its token's row");
  });

  test("a player marks the rows they own, by the token or its character, and their companion's own", () => {
    assert.deepEqual(reactionFor(state, you(P1), { tokenId: "thornT" }), { kind: "row", entryId: "et", tokenId: "thornT" });
    assert.deepEqual(reactionFor(state, you(P1), { characterId: "thorn" }), { kind: "row", entryId: "et", tokenId: "thornT" });
    assert.deepEqual(reactionFor(state, you(P1), { tokenId: "skitter" }), { kind: "companion", tokenId: "skitter", entryId: "et" });
  });

  test("a player lent a token marks its row only where the row is the token's, as the server allows", () => {
    assert.equal(reactionFor(state, you(P2), { tokenId: "breeT" }), null, "Bree's row is keyed by the character");
    assert.deepEqual(reactionFor(state, you(P2), { tokenId: "caraT" }), { kind: "row", entryId: "ec", tokenId: "caraT" });
  });

  test("none for another player's creature, a companion with no turn, a creature with no row, or no fight", () => {
    assert.equal(reactionFor(state, you(P2), { tokenId: "thornT" }), null);
    assert.equal(reactionFor(state, you(P2), { tokenId: "skitter" }), null);
    assert.equal(reactionFor(state, you(P1), { tokenId: "goblin" }), null);
    assert.equal(reactionFor(state, you(DM), { tokenId: "loner" }), null);
    assert.equal(reactionFor({ ...state, encounter: null }, you(DM), { tokenId: "goblin" }), null);
    assert.equal(reactionFor(state, null, { tokenId: "goblin" }), null);
  });
});

function render(state: RoomState, viewer: Viewer, self: { tokenId: string } | { characterId: string }): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(ReactionSection, { self, name: "It" }) }),
    }),
  );
}

describe("the Reaction section as it draws", () => {
  const state = fight();
  const switchOf = (markup: string) => /<button[^>]*role="switch"[^>]*>/.exec(markup)?.[0] ?? "";

  test("the DM's: the row's switch in the row's words", () => {
    const markup = render(state, DM, { tokenId: "goblin" });
    assert.match(markup, />Reaction<\/h/);
    assert.match(markup, />Reaction used</);
    assert.match(markup, />Clears at the start of its turn</);
    assert.match(markup, /role="group" aria-label="It&#x27;s reaction"/);
    assert.match(switchOf(markup), /aria-checked="false"/);
  });

  test("a player's own row: in their words, and spent where the row says so", () => {
    assert.match(render(state, P1, { tokenId: "thornT" }), />Clears at the start of your turn</);
    const lent = render(state, P2, { tokenId: "caraT" });
    assert.match(lent, />Clears at the start of your turn</);
    assert.match(switchOf(lent), /aria-checked="true"/);
  });

  test("a shared companion's own, for the DM and its owner", () => {
    for (const viewer of [DM, P1]) {
      const markup = render(state, viewer, { tokenId: "skitter" });
      assert.match(markup, />Its own, which clears when its character&#x27;s turn starts</);
      assert.match(switchOf(markup), /aria-checked="true"/);
    }
  });

  test("nothing where the viewer marks none, or outside the fight", () => {
    assert.equal(render(state, P2, { tokenId: "breeT" }), "");
    assert.equal(render(state, P1, { tokenId: "goblin" }), "");
    assert.equal(render({ ...state, encounter: null }, DM, { tokenId: "goblin" }), "");
  });
});
