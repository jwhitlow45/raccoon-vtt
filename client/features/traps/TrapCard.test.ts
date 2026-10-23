import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry, TrapDue } from "#shared/model.ts";
import { room, token, trap } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { TrapCard } = await import("./TrapCard.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

/*
 * The trap card's lines (docs/design-v1-look-pass-2.md D24): what it could
 * not do reads as an error by the line's own outcome, and a springing out of
 * the players' sight as a warning, since the trap is still armed for them.
 */

const due = (id: string, over: Partial<TrapDue> = {}): TrapDue => ({ id, at: "2026-10-22T10:00:00.000Z", how: "enter", by: ["thorn"], hits: ["thorn"], ...over });

function card(d: TrapDue): string {
  const base = trap("pit", { name: "Hidden Pit", rig: { ...trap("x").rig!, due: [d], actions: [{ show: { tokenId: "imp" } }, { light: "gone", on: false }] } });
  const line: LogEntry = { id: d.id, at: "", kind: "event", data: { type: "trap", trapId: "pit", sceneId: "s1", name: "Hidden Pit", how: "enter", by: ["thorn"], hits: 1, did: [{ action: 0, ok: true }, { action: 1, ok: false }] } };
  const state = { ...room({ tokens: { thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"] }), imp: token("imp", { name: "Imp", visibility: "dm" }) }, traps: { pit: base } }), trapLog: [line] };
  const store = createStore(() => ({ view: state, you: { role: "dm" } }));
  const element = createElement(TrapCard, { trap: base, due: d, open: true, onToggle() {}, toggleRef() {} });
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: element }) }));
}

/** The element whose text is exactly `text`, with its tag and style. */
function holder(markup: string, text: string): string {
  const at = markup.indexOf(`>${text}<`);
  assert.ok(at > 0, `"${text}" is not on the card`);
  return markup.slice(markup.lastIndexOf("<", at), at + 1);
}

describe("the trap card's lines", () => {
  test("what it did reads plainly, and what it could not do as an error line", () => {
    const markup = card(due("12:0"));
    assert.doesNotMatch(holder(markup, "Showed Imp."), new RegExp(theme.color.dangerText));
    const failed = holder(markup, "Could not put out a light: it was deleted.");
    assert.match(failed, /^<p/, "an error line, as the card's other error is");
    assert.match(failed, new RegExp(theme.color.dangerText));
  });

  test("a springing out of the players' sight is a warning, not muted help", () => {
    const markup = card(due("15:1", { by: ["imp"], hits: ["imp"], hidden: true }));
    assert.match(holder(markup, "Imp set it off, out of the players&#x27; sight. The trap is still armed for them."), new RegExp(theme.color.warning));
  });
});
