import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { P1, room } from "#shared/testutil.ts";

/*
 * The dice tray keeps the board's dark look in either scheme
 * (docs/design/design-v1-light-theme.md 6.4, D-261102-363): its root puts
 * the dark palette and the dark accent in scope, so the scrim, the rings
 * and the "+N" disc under it are dark on a light pane too.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../../state/scope.ts");
const { Tray } = await import("./Tray.tsx");
const { BOARD_SCOPE } = await import("../../../lib/theme.ts");
const { tokenPattern } = await import("../../../components/testing/tokenPattern.ts");

test("the tray's root holds the whole dark palette and the dark accent", () => {
  const store = createStore(() => ({ view: room(), roomId: "r1", connection: "open", you: P1, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  const html = renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => null } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(Tray, {}) }),
    }),
  );
  const root = /<div aria-hidden="true" data-dice-tray="" style="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.notEqual(root, "");
  for (const [name, value] of Object.entries(BOARD_SCOPE)) {
    const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    assert.match(root, new RegExp(`(^|;)${tokenPattern(property)}:${tokenPattern(value)}(;|$)`), property);
  }
});
