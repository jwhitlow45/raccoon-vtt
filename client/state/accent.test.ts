import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { member, room } from "#shared/testutil.ts";
import { accentFor, type Accent } from "../lib/accent.ts";
import { MEMBER_COLORS } from "../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("./view.ts");
const { useAccent, useSchemeAccent } = await import("./accent.ts");

/** What the hooks give a member of `color`, rendered in a room. */
function accents(color: string): { board: Accent; page: Accent } {
  const view = room({ members: { p1: { ...member("p1"), color } } });
  const store = createStore(() => ({ view, you: { role: "player", memberId: "p1" } }));
  let got: { board: Accent; page: Accent } | null = null;
  function Probe() {
    got = { board: useAccent(), page: useSchemeAccent() };
    return null;
  }
  renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, assets: { url: () => "" } as never, children: createElement(Probe) }));
  assert.ok(got);
  return got;
}

/*
 * The board keeps the dark look in both schemes, so what draws on it takes
 * the member's accent resolved for dark (docs/design/design-v1-light-theme.md
 * 6.3 and 6.4). The page's accent follows the scheme, dark in a render
 * outside the browser.
 */
test("the board's accent is the member's resolved for dark, and the page's follows the scheme", () => {
  for (const color of MEMBER_COLORS) {
    const { board, page } = accents(color);
    assert.deepEqual(board, accentFor(color, "dark"), color);
    assert.deepEqual(page, accentFor(color, "dark"), color);
  }
  // The yellow's light accent is the dark olive gold, never the board's yellow.
  assert.notDeepEqual(accentFor("#f7df00", "light"), accents("#f7df00").board);
});
