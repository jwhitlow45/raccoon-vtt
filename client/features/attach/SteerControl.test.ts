import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Token } from "#shared/model.ts";
import { DM, room, token } from "#shared/testutil.ts";

/*
 * Ride's question in the rider's panel (docs/design-v1-look-pass-2.md 2.7
 * and 3.1): two short words side by side, where two sentences stacked as
 * pills of different widths, and a Help line under them that says what the
 * chosen one does and is the radiogroup's description, so the short words
 * keep their meaning for a screen reader too.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { SteerControl } = await import("./SteerControl.tsx");

function render(steer: boolean): string {
  const state: RoomState = room();
  const list: Token[] = [
    token("thorn", { name: "Thorn", kind: "pc", x: 5, y: 5, attached: { to: "horse", kind: "ride", ...(steer ? { steer: true as const } : {}) } }),
    token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 5, y: 5 }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  const store = createStore(() => ({ view: state, you: { role: "dm", memberId: DM.memberId } }));
  const control = createElement(SteerControl, { token: state.tokens.thorn! });
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: control }));
}

describe("Ride's question in the rider's panel", () => {
  test("two words, described by the Help line that says what the chosen one does", () => {
    for (const [steer, words] of [
      [true, "Warhorse moves on Thorn&#x27;s turn."],
      [false, "Warhorse keeps its own turn."],
    ] as const) {
      const markup = render(steer);
      assert.match(markup, />Controlled</);
      assert.match(markup, />Independent</);
      assert.doesNotMatch(markup, /Controlled:|Independent:/, "no sentence in the options");
      const id = /role="radiogroup"[^>]* aria-describedby="([^"]+)"/.exec(markup)?.[1];
      assert.ok(id, "the radiogroup names its description");
      assert.match(markup, new RegExp(`<p id="${id}"[^>]*>${words}</p>`));
      assert.match(markup, /rvtt-even-choices/, "the options share the row");
    }
  });
});
