import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { actor, character, room } from "#shared/testutil.ts";
import { theme } from "../../lib/theme.ts";
import { tokenPattern } from "../../components/testing/tokenPattern.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { FromControl } = await import("./FromControl.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { Parts } = await import("../measure/controls.tsx");

function draw(control: Parameters<typeof FromControl>[0]["control"]): string {
  const view = room({ characters: { ash: character("ash", { name: "Ash", ownerIds: ["p1"], actor: actor() }) }, tokens: {} });
  const store = createStore(() => ({ view, you: { role: "player" } }));
  // The measuring copy draws the compact square's face with no popover, which is the part this checks.
  const el = createElement(Parts, { place: { at: "measure", form: "compact", id: "from" }, children: createElement(FromControl, { control, onPick() {} }) });
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, assets: { url: () => "" } as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: el }) }));
}

// The tokens forbid fading a disabled control, so the marked portrait keeps full opacity (D-261101-302).
test("a disabled From square greys its portrait at full opacity, inside the dim outline", () => {
  const markup = draw({ form: "disabled", name: "Ash", characterId: "ash" });
  const face = /data-rvtt-from="disabled"[^>]*><span style="([^"]*)"/.exec(markup)?.[1] ?? "";
  assert.match(face, /filter:grayscale\(1\)/);
  assert.doesNotMatch(face, /opacity:0\.\d/, "no fade");
  assert.match(markup, new RegExp(`outline:2px solid ${tokenPattern(theme.color.textDisabled)}`, "i"), "the portrait's ring is the dim outline");
  // Every word in an off control is textDisabled, the initials of a portrait with no picture too (LOOK1-OPUS-08).
  assert.match(markup, new RegExp(`color:${tokenPattern(theme.color.textDisabled)}[^"]*">As</span>`, "i"), "the initials draw the disabled color");
});
