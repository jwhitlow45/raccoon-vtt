import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, member, room } from "#shared/testutil.ts";
import { memberInk } from "../lib/accent.ts";

/*
 * A name in the Log wears its member's color made readable as text
 * (docs/design/design-v1-light-theme.md 6.3): a navy name read 1.2:1 on the
 * dark panel before the rule applied to names too.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../state/view.ts");
const { default: LogPanel } = await import("./LogPanel.tsx");

function chatFrom(color: string): string {
  const state = room();
  state.members.p1 = { ...member("p1"), name: "Pat", color };
  const log: LogEntry[] = [{ id: "1:0", at: "2026-10-17T20:00:00.000Z", kind: "chat", from: "p1", text: "hello there" }];
  state.log = log;
  const view = projectState(state, DM, { sceneId: "s1" });
  const store = createStore(() => ({ roomId: "room", view, you: DM, sceneId: "s1" }));
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(LogPanel, { selectedTokenId: null, shown: true, close() {} }) }));
}

test("a navy name is moved until it reads, and the raw navy is not drawn", () => {
  const markup = chatFrom("#1a237e");
  const ink = memberInk("#1a237e", "dark");
  assert.notEqual(ink, "#1a237e");
  assert.match(markup, new RegExp(`<strong style="color:${ink}">Pat</strong>`, "i"));
  assert.doesNotMatch(markup, /color:#1a237e/i);
});

test("a name already readable keeps its color", () => {
  assert.match(chatFrom("#e5e5e5"), /<strong style="color:#e5e5e5">Pat<\/strong>/i);
});
