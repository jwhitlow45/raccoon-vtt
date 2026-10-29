import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { GridShape, Token } from "#shared/model.ts";
import { DM, P1, room, scene, token } from "#shared/testutil.ts";
import { tokenAccess } from "../tokens/access.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { SizeField } = await import("../../panels/TokenPanel.tsx");
const { SizeRow } = await import("../../canvas/TokenActionBar.tsx");

function render(kind: "panel" | "bar", gridShape: GridShape | undefined, size: Token["size"] = "large", locked = false): string {
  const t = token("t1", { sceneId: "s1", size, locked, ownerIds: [P1.memberId] });
  const view = room({ scenes: { s1: scene("s1", { gridShape }), s2: scene("s2") }, tokens: { t1: t } });
  const you = locked ? P1 : DM;
  const store = createStore(() => ({ view, you, sceneId: "s2" }));
  const access = tokenAccess({ view, role: you.role, memberId: you.memberId, token: t });
  const node = kind === "panel"
    ? createElement(SizeField, { token: t, actor: {}, access, feetPerCell: 5 })
    : createElement(SizeRow, { token: t, owner: true, canResize: !locked });
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: node }) }));
}

describe("FU39-B: token size controls name the hex footprint", () => {
  test("the token panel's choices count the token scene's hexes in either orientation", () => {
    for (const shape of ["hexRows", "hexColumns"] as const) {
      const html = render("panel", shape);
      const options = [...html.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map((m) => m[1]);
      assert.deepEqual(options, ["Tiny (1 hex)", "Small (1 hex)", "Medium (1 hex)", "Large (3 hexes)", "Huge (7 hexes)", "Gargantuan (12 hexes)", "Custom"]);
    }
    assert.match(render("panel", undefined), />Large<\/option>/);
  });

  test("the bar's live size counts hexes while keeping room for the largest size", () => {
    for (const shape of ["hexRows", "hexColumns"] as const) {
      for (const [size, words] of [["tiny", "Tiny (1 hex)"], ["large", "Large (3 hexes)"], ["huge", "Huge (7 hexes)"], ["gargantuan", "Gargantuan (12 hexes)"]] as const) {
        const html = render("bar", shape, size);
        const live = /<span aria-live="polite"[^>]*>([^<]*)<\/span>/.exec(html)?.[1]?.replace(/\s+/g, " ");
        assert.equal(live, words);
        assert.match(html, /visibility:hidden[^>]*>Gargantuan\s+\(12 hexes\)<\/span>/);
      }
    }
    assert.match(render("bar", undefined), /aria-live="polite"[^>]*>Large<\/span>/);
  });

  test("a locked token still names its hex footprint in both places", () => {
    for (const shape of ["hexRows", "hexColumns"] as const) {
      for (const kind of ["panel", "bar"] as const) assert.match(render(kind, shape, "large", true).replace(/\s+/g, " "), /Large \(3 hexes\)/);
    }
  });
});
