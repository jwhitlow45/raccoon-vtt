import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, P1, character, member, room, token } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createViewAs, viewAsPlayers, ViewAsButton, ViewAsEye } = await import("./viewAs.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * View as a player from a token (D-261027-09): which tokens offer it and to
 * whom, its one button or its list, that a player never sees it, and the
 * one preview every entry shares.
 */

/** Ana (p1) and Ben (p2), named so the order by name shows. */
const table = (over: Partial<RoomState> = {}): RoomState => {
  const base = room(over);
  return { ...base, members: { ...base.members, p1: { ...member("p1"), name: "Ana" }, p2: { ...member("p2"), name: "Ben" } } };
};

const names = (state: RoomState, t: Token) => viewAsPlayers(state, t).map((m) => m.name);

describe("who a token offers View as", () => {
  test("a player who owns the token directly", () => {
    assert.deepEqual(names(table(), token("t", { kind: "pc", ownerIds: ["p1"] })), ["Ana"]);
  });

  test("a player who owns it only through its character", () => {
    const thorn = character("thorn", { ownerIds: ["p2"] });
    assert.deepEqual(names(table({ characters: { thorn } }), token("t", { kind: "pc", ownerIds: [], actor: { ref: "thorn" } })), ["Ben"]);
  });

  test("a companion's players, through its character, even before its own owners are in step", () => {
    const thorn = character("thorn", { ownerIds: ["p2", "p1"] });
    const wolf = token("w", { kind: "monster", ownerIds: [], companion: { of: "thorn", turn: "shared" } });
    assert.deepEqual(names(table({ characters: { thorn } }), wolf), ["Ana", "Ben"]);
  });

  test("none for a monster or NPC no player owns, and never the DM, even listed as an owner", () => {
    assert.deepEqual(names(table(), token("g")), []);
    assert.deepEqual(names(table(), token("n", { kind: "npc", ownerIds: ["dm1"] })), []);
  });

  test("several owners, each once, by name", () => {
    const thorn = character("thorn", { ownerIds: ["p1"] });
    assert.deepEqual(names(table({ characters: { thorn } }), token("t", { ownerIds: ["p2", "p1"], actor: { ref: "thorn" } })), ["Ana", "Ben"]);
  });

  test("an owner who left the room is not offered", () => {
    assert.deepEqual(names(table(), token("t", { ownerIds: ["gone", "p2"] })), ["Ben"]);
  });
});

function render(state: RoomState, viewer: Viewer, element: ReturnType<typeof createElement>): string {
  const view = projectState(state, viewer, { sceneId: "s1" });
  const store = createStore(() => ({ view, you: { memberId: viewer.memberId, role: viewer.role }, roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }),
    }),
  );
}

/** The window the layout reads, a computer's unless a phone's width is given. */
const sized = (width = 1280) => Object.assign(globalThis, { window: { innerWidth: width, innerHeight: 800 } });

const button = (state: RoomState, viewer: Viewer, t: Token) => render({ ...state, tokens: { [t.id]: t } }, viewer, createElement(ViewAsButton, { token: t }));

describe("a token's View as button", () => {
  beforeEach(() => sized());
  test("one player owner: the eye and View as that player, for the DM", () => {
    const markup = button(table(), DM, token("t", { kind: "pc", ownerIds: ["p2"] }));
    assert.match(markup, /<button[^>]*>.*View as Ben(<\/span>)?<\/button>/);
    assert.match(markup, /<svg/, "it wears an icon");
    assert.doesNotMatch(markup, /aria-haspopup/, "one tap, no list");
  });

  test("an 80-letter name with no space breaks anywhere inside its button, which keeps the whole name", () => {
    const long = "W".repeat(80);
    const state = table();
    state.members.p2 = { ...state.members.p2!, name: long };
    const markup = button(state, DM, token("t", { kind: "pc", ownerIds: ["p2"] }));
    const style = /<button[^>]*style="([^"]*)"/.exec(markup)?.[1] ?? "";
    assert.match(style, /max-width:100%/, "held to its row's width");
    assert.match(style, /overflow-wrap:anywhere/, "broken anywhere");
    assert.match(markup, new RegExp(`>View as ${long}<`), "the whole name, which the button is named by");
  });

  test("several player owners: View as a player opens a list of them, a menu on a computer and a sheet's on a phone", () => {
    for (const width of [1280, 390]) {
      sized(width);
      const markup = button(table(), DM, token("t", { kind: "pc", ownerIds: ["p1", "p2"] }));
      assert.match(markup, /<button[^>]*aria-haspopup="menu"[^>]*>.*View as a player<\/button>/, `at ${width} px`);
      assert.doesNotMatch(markup, /View as Ana|View as Ben/, `at ${width} px`);
    }
  });

  test("nothing on a token no player owns", () => {
    assert.equal(button(table(), DM, token("g")), "");
  });

  test("a player never sees it, not even on their own token", () => {
    assert.equal(button(table(), P1, token("t", { kind: "pc", ownerIds: ["p1"] })), "");
    assert.equal(button(table(), P1, token("t", { kind: "pc", ownerIds: ["p1", "p2"] })), "");
    assert.equal(render(table(), P1, createElement(ViewAsEye, { player: { id: "p2", name: "Ben" } })), "");
  });

  test("the Owners group's eye is named for its player", () => {
    assert.match(render(table(), DM, createElement(ViewAsEye, { player: { id: "p2", name: "Ben" } })), /aria-label="View as Ben"/);
  });
});

describe("the one preview every entry opens", () => {
  const el = (name: string) => ({ name }) as unknown as HTMLElement;

  test("opens with the control focus returns to, and Exit clears it", () => {
    const viewAs = createViewAs();
    const bar = el("bar");
    viewAs.open({ memberId: "p1", name: "Ana", returnFocus: bar });
    assert.equal(viewAs.store.getState().target?.memberId, "p1");
    assert.equal(viewAs.store.getState().target?.returnFocus, bar);
    viewAs.exit();
    assert.equal(viewAs.store.getState().target, null);
  });

  test("a second entry while one is open opens nothing, and the first keeps its player and its return", () => {
    const viewAs = createViewAs();
    const bar = el("bar");
    viewAs.open({ memberId: "p1", name: "Ana", returnFocus: bar });
    viewAs.open({ memberId: "p2", name: "Ben", returnFocus: el("panel") });
    assert.equal(viewAs.store.getState().target?.memberId, "p1");
    assert.equal(viewAs.store.getState().target?.returnFocus, bar);
    viewAs.exit();
    viewAs.open({ memberId: "p2", name: "Ben", returnFocus: el("panel") });
    assert.equal(viewAs.store.getState().target?.memberId, "p2", "after Exit the next entry opens");
  });
});
