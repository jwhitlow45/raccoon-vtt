import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { room } from "#shared/testutil.ts";
import { accentFor } from "../lib/accent.ts";
import { BOARD_SCOPE, MEMBER_COLORS, theme } from "../lib/theme.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../state/scope.ts");
const { PauseScreen, roomAccentVars } = await import("./RoomChrome.tsx");

/*
 * A room sets two accents on the page (docs/design/design-v1-light-theme.md
 * 6.3): the member's for the page's scheme, which buttons and rings read,
 * and the same color resolved for dark, which what keeps the dark look and
 * the rings on the board read (lib/theme.ts BOARD_SCOPE, ON_BOARD_STYLE).
 */
describe("the room's accent variables", () => {
  test("carry the scheme's accent family and the board's, for every member color", () => {
    for (const color of MEMBER_COLORS) {
      const page = accentFor(color, "light");
      const board = accentFor(color, "dark");
      const vars = roomAccentVars(page, board);
      assert.deepEqual(vars, {
        "--rvtt-accent": page.accent,
        "--rvtt-on-accent": page.onAccent,
        "--rvtt-accent-tint": page.tint,
        "--rvtt-selection": page.selection,
        "--rvtt-board-accent": board.accent,
        "--rvtt-board-on-accent": board.onAccent,
        "--rvtt-board-accent-tint": board.tint,
        "--rvtt-board-selection": board.selection,
      });
    }
  });

  test("on a light page the crest yellow buttons are the olive gold, and the board keeps the yellow", () => {
    const vars = roomAccentVars(accentFor("#f7df00", "light"), accentFor("#f7df00", "dark"));
    assert.equal(vars["--rvtt-accent"], "#675c00");
    assert.equal(vars["--rvtt-board-accent"], "#f7df00");
  });
});

/*
 * The pause screen is dark in both schemes (D-261102-364): it sits on the
 * black stage, where the light theme's muted text reads 2.8:1, and its
 * X-card's buttons and rings take the accent resolved for dark.
 */
describe("the pause screen", () => {
  test("takes the whole dark palette and the dark accent on its root", () => {
    const store = createStore(() => ({ view: room(), you: { role: "player", memberId: "p1" }, toasts: [], connection: "open" }));
    const ui = { dismissToast() {} };
    const markup = renderToStaticMarkup(
      createElement(RoomProvider, { store: store as never, actions: {} as never, ui: ui as never, assets: { url: () => "" } as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(PauseScreen) }) }),
    );
    const style = /^<div data-rvtt-pause-screen="" style="([^"]*)"/.exec(markup)?.[1];
    assert.ok(style, markup.slice(0, 300));
    for (const [name, value] of Object.entries(BOARD_SCOPE)) {
      const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      assert.ok(style.includes(`${property}:${value}`), `${property}:${value}`);
    }
    assert.ok(style.includes(`background:${theme.color.stage}`));
    assert.ok(style.includes(`color:${theme.color.textMuted}`));
    assert.match(markup, /The DM has paused the game\./);
  });
});

describe("a reload's reopen (docs/design/design-v1-features.md 8)", () => {
  test("a tool or panel of a part hidden on this device is skipped, the rest opens, and an unknown role skips nothing", async () => {
    const { reopenShown } = await import("./RoomChrome.tsx");
    const { NO_CHOICES, withChoice } = await import("../features/modules/store.ts");
    const hidden = withChoice(withChoice(NO_CHOICES, "dm", "ruler", false), "dm", "journal", false);
    assert.deepEqual(reopenShown({ tool: "ruler", panel: "journal" }, "dm", NO_CHOICES), { tool: "ruler", panel: "journal" });
    assert.deepEqual(reopenShown({ tool: "ruler", panel: "journal" }, "dm", hidden), {});
    assert.deepEqual(reopenShown({ tool: "fog", panel: "dice" }, "dm", hidden), { tool: "fog", panel: "dice" });
    assert.deepEqual(reopenShown({ tool: "ruler" }, "player", hidden), { tool: "ruler" }, "the DM's choices hold for the DM alone");
    assert.deepEqual(reopenShown({ tool: "ruler" }, null, hidden), { tool: "ruler" });
    assert.deepEqual(reopenShown(null, "dm", hidden), {});
  });
});
