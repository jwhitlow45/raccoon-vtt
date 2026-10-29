import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import { room } from "#shared/testutil.ts";
import type { FoundNote } from "./store.ts";

/*
 * Line up grid's options line (docs/design-v1-design-pass.md 2.4 rules 5
 * and 6, LP24-B-FIND-4): a search past the shared delay is a muted wait in
 * the small loading line that keeps a reading's place, never the success
 * green, which is for a grid applied or saved.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { gridOfShape, SQUARES } = await import("#shared/rules/grid.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { OptionsStrip } = await import("../measure/controls.tsx");
const { default: GridOptions, gridLine } = await import("./Options.tsx");
const { RoomProvider } = await import("../../state/view.ts");
const { gridSlot } = await import("./store.ts");
const { theme } = await import("../../lib/theme.ts");

const color = (c: string) => new RegExp(`color:${c.replace(/[()]/g, "\\$&")}`);

function drawn(line: ReturnType<typeof gridLine>): { attrs: string; inner: string } {
  const html = renderToStaticMarkup(createElement(RoomScopeProvider, { scope: new RoomScope(), children: createElement(OptionsStrip, { tool: "Line up grid", line, slots: [] }) }));
  const found = /<div([^>]*data-options-line="shown"[^>]*)>(.*?)<\/div>/.exec(html);
  assert.ok(found, "the line is drawn");
  return { attrs: found[1]!, inner: found[2]! };
}

describe("Line up grid's line", () => {
  const box = { x: 0, y: 0, size: 141 };

  test("a search past the shared delay says Looking for a grid… muted, with the small spinner, keeping a reading's place", () => {
    for (const grid of [SQUARES, gridOfShape("hexRows")]) {
      const line = gridLine({ slow: true, note: null, saved: "Grid saved at 50 px per square.", grid });
      assert.equal(line.tone, "hint");
      const { attrs, inner } = drawn(line);
      assert.ok(inner.includes("Looking for a grid…"));
      assert.match(inner, /<svg[^>]*width="16"/, "the small spinner");
      assert.match(inner, color(theme.color.textMuted));
      assert.doesNotMatch(attrs, color(theme.color.success), "the success green");
      assert.doesNotMatch(inner, /<div/);
      assert.match(attrs, /data-options-reading=""/);
      assert.match(attrs, /data-finding=""/);
    }
  });

  test("before the delay, and after, the line says what it said: the note, Grid saved in green, or the hint", () => {
    assert.deepEqual(gridLine({ slow: false, note: { sceneId: "s1", outcome: "none", cellPx: 0, box }, saved: null, grid: SQUARES }), { tone: "warning", content: "No grid found. Drag a box over 3 by 3 squares instead." });
    assert.deepEqual(gridLine({ slow: false, note: null, saved: "Grid saved at 50 px per square.", grid: SQUARES }), { tone: "status", content: "Grid saved at 50 px per square." });
    assert.equal(gridLine({ slow: false, note: null, saved: null, grid: SQUARES }).tone, "hint");
    assert.match(drawn(gridLine({ slow: false, note: null, saved: "Grid saved at 50 px per square.", grid: SQUARES })).attrs, color(theme.color.success));
  });

  test("Use default stays beside Apply after only the shape switched, but an ordinary offer has none", () => {
    const map = { assetId: "a1", widthPx: 760, heightPx: 600, cellPx: 47, originPx: { x: 0, y: 0 } };
    for (const switched of [true, false]) {
      const scope = new RoomScope();
      const grid = scope.get(gridSlot);
      const note: FoundNote = { sceneId: "s1", outcome: "offered", cellPx: 70, box, cal: { cellPx: 70, originPx: { x: 9, y: 4 } }, shape: "hexRows", ...(switched ? { switched: true, fallback: { ...map, bounds: { w: 29, h: 21 }, shape: "squares" } } : {}) };
      grid.setState({ box, found: note, sceneId: "s1" });
      grid.getInitialState = grid.getState;
      const view = room();
      view.scenes.s1 = { ...view.scenes.s1!, gridShape: "hexRows", map };
      const store = createStore(() => ({ view, sceneId: "s1", you: { memberId: "dm1", role: "dm" } }));
      const html = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope, children: createElement(GridOptions) }) }));
      assert.match(html, />Apply</);
      assert.equal(html.includes("Use default"), switched);
      if (switched) assert.match(html, /The grid is hex rows now/);
    }
  });
});
