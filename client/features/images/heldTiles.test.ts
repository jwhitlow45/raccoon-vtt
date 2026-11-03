import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssetRow, SearchResult } from "../../lib/api.ts";
import { theme } from "../../lib/theme.ts";
import type { IconEntry } from "./icons.ts";
import { tokenPattern } from "../../components/testing/tokenPattern.ts";

const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Held } = await import("../../components/Held.tsx");
const { createStore } = await import("zustand/vanilla");
const { RoomProvider } = await import("../../state/view.ts");
const { IconTile } = await import("./IconsTab.tsx");
const { SearchTile } = await import("./ImagePicker.tsx");
const { PickTile } = await import("./LibraryGrid.tsx");
const { MapStrip } = await import("../scenes/NewScene.tsx");

/*
 * LOCKED-LOOK for the picture tiles. A held group stops each tile's native
 * button, and a tile with no words to dim must still look stopped, without a
 * fade: its glyph and words take textDisabled, a thumbnail goes gray, and the
 * pointer stops inviting a press.
 */

const nothing = () => {};
const store = createStore(() => ({ roomId: "tile-room", view: null, you: { memberId: "dm1", role: "dm" }, connection: "open", accessVersion: 1 }));
const assets = { url: (id: string, variant: string) => `/a/${id}/${variant}` };
const inRoom = (child: ReturnType<typeof h>) => h(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, assets, children: child });
const draw = (child: ReturnType<typeof h>, held: boolean) => renderToStaticMarkup(inRoom(h(Held, { held, children: child })));
const dim = new RegExp(`color:${tokenPattern(theme.color.textDisabled)}`, "i");
const gray = /filter:grayscale\(1\)/;
const result: SearchResult = { title: "Cave", source: "openverse", thumbnail: "https://x/t.jpg", original: "https://x/o.jpg", credit: { license: "by", licenseVersion: "4.0", landingUrl: "https://x", attribution: "Cave" } };
const map: AssetRow = { id: "m1", kind: "map", width: 100, height: 100, variants: ["full", "thumb"] };
const icon: IconEntry = { key: "a", author: "lorc", name: "axe", title: "Axe", words: ["axe", "lorc"] };

const tiles = {
  "an icon tile": () => h(IconTile, { entry: icon, left: 0, top: 0, selected: false, disabled: false, onSelect: nothing }),
  "a chosen icon tile": () => h(IconTile, { entry: icon, left: 0, top: 0, selected: true, disabled: false, onSelect: nothing }),
  "a search tile": () => h(SearchTile, { result, source: "openverse", disabled: false, onPick: nothing }),
  "a library tile": () => h(PickTile, { id: "a", disabled: false, onPick: nothing }),
  "a map in the strip": () => h(MapStrip, { maps: [map], disabled: false, onPick: nothing }),
} as const;

describe("a held group stops every picture tile", () => {
  for (const [name, tile] of Object.entries(tiles)) {
    test(name, () => {
      const free = draw(tile() as never, false);
      const inHeld = draw(tile() as never, true);
      assert.doesNotMatch(free, /<button[^>]*\sdisabled=""/, "free, it is live");
      assert.match(inHeld, /<button[^>]*\sdisabled=""/);
      assert.match(inHeld, /cursor:default/);
      assert.doesNotMatch(free, /cursor:default/);
    });
  }

  test("a thumbnail goes gray, never faded", () => {
    for (const name of ["a search tile", "a library tile", "a map in the strip"] as const) {
      assert.doesNotMatch(draw(tiles[name]() as never, false), gray, name);
      const held = draw(tiles[name]() as never, true);
      assert.match(held, gray, name);
      assert.doesNotMatch(held, /opacity/, name);
    }
  });

  test("an icon tile's ink and chosen outline take the dim colors", () => {
    const chosen = draw(tiles["a chosen icon tile"]() as never, true);
    assert.match(chosen, dim);
    assert.match(chosen, new RegExp(`solid ${tokenPattern(theme.color.textDisabled)}`, "i"), "the chosen one keeps a dim outline");
    assert.match(draw(tiles["an icon tile"]() as never, true), new RegExp(`solid ${tokenPattern(theme.color.border)}`, "i"), "an unchosen one the quiet outline");
    assert.doesNotMatch(chosen, new RegExp(`solid ${theme.color.accent.replace(/[()]/g, "\\$&")}`), "no accent outline");
    assert.doesNotMatch(chosen, /background:var\(--rvtt-accent-tint|accentTint/i);
    assert.match(draw(tiles["an icon tile"]() as never, false), new RegExp(`color:${tokenPattern(theme.color.text)}`, "i"));
  });

  test("a tile's own disabled still dims with no group", () => {
    const own = renderToStaticMarkup(inRoom(h(PickTile, { id: "a", disabled: true, onPick: nothing })));
    assert.match(own, gray);
    assert.match(own, /<button[^>]*\sdisabled=""/);
  });
});
