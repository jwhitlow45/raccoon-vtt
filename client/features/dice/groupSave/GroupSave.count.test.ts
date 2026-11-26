import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { actor, DM, room, token } from "#shared/testutil.ts";

/*
 * A group save's count is creatures wherever the page says it: the title the
 * page gives the panel and the question Replace asks. One character's two
 * tokens count once. This file hooks GroupSave.tsx to read the title it gives
 * the panel, which needs the page's modules loaded after the hook, so it
 * stays apart from GroupSave.test.ts and its static imports.
 *
 * The page's `view?.tokens` argument to pageTitle matters only where the
 * rows are empty beside tokens the room holds, which a live setup never has
 * (the rows come from those tokens), so no test can tell it from a missing
 * one.
 */

const headers: string[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for("group-save-count-header")] = (header: { title?: string } | null) => headers.push(header?.title ?? "");
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/groupSave/GroupSave.tsx")) return result;
  return { ...result, source: String(result.source).replace(/usePanelHeader\(\{\s*title,/, 'globalThis[Symbol.for("group-save-count-header")]({ title }); usePanelHeader({ title,') };
} });

// The panel module first, as GroupSave.test.ts does: loaded from the page alone, panels.ts and Sheet.tsx meet in a cycle.
await import("../useDicePanel.ts");
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { newPage } = await import("./chain.ts");
const { GroupSave } = await import("./GroupSave.tsx");
const { ReplaceConfirm } = await import("./ReplaceConfirm.tsx");
const { groupSaveSlot } = await import("./store.ts");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../../state/scope.ts");

/** One character's two tokens and two goblins, and a setup page that selects all four. */
const tokens = {
  a1: token("a1", { kind: "pc", name: "Thorn", actor: { ref: "a" } }),
  a2: token("a2", { kind: "pc", name: "Thorn", actor: { ref: "a" } }),
  g1: token("g1", { name: "Goblin", actor: { inline: actor({}) } }),
  g2: token("g2", { name: "Goblin", actor: { inline: actor({}) } }),
};
const page = newPage({
  id: "p",
  sceneId: "s1",
  source: { kind: "selection", tokenIds: ["a1", "a2", "g1", "g2"] },
  test: { kind: "save", ability: "dex" },
  dc: 13,
  secret: true,
  spell: false,
  switches: { dcShown: true, resultShown: true },
  outcome: { damage: "", conditions: [], saveEnds: { ability: "con", dc: null } },
});

/** Renders `child` on a room that holds the four tokens, with the group save store holding the page. */
function drawWith(child: () => import("react").ReactElement): string {
  const scope = new RoomScope();
  const saves = scope.get(groupSaveSlot);
  saves.setState({ page, reopen: null });
  saves.getInitialState = saves.getState;
  const store = createStore(() => ({ view: room({ tokens }), roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false }, history: { summary: null, ready: false, pending: 0, slow: false, result: null } }));
  return renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never,
    children: createElement(RoomScopeProvider, { scope, children: child() }),
  }));
}

describe("a setup's count is creatures wherever the page says it (LP52B-COUNT)", () => {
  test("Replace asks about the creatures the open save names, not its tokens", () => {
    const markup = drawWith(() => createElement(ReplaceConfirm, { onDiscard() {}, onKeep() {} }));
    assert.match(markup, /Discard the Dexterity save for 3\?/);
  });

  test("the page's own title counts creatures", () => {
    headers.length = 0;
    drawWith(() => createElement(GroupSave, { parent: "Dice", onBack() {} }));
    assert.deepEqual([...new Set(headers)], ["Dexterity save for 3"]);
  });
});
