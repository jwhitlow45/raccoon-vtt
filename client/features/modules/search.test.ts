import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Catalog } from "../search/catalog/types.ts";
import { DM_CATALOG } from "../search/catalog/dm.ts";
import { EVERYONE } from "../search/catalog/everyone.ts";
import { searchRole } from "../search/index.ts";
import { DM_VIEW, PAT_VIEW } from "../search/search.testutil.ts";
import type { RoomView } from "../../state/types.ts";
import { resetAllFeatures, setModuleShown, withChoice, NO_CHOICES } from "./store.ts";
import { showEntries, switchAnchor } from "./search.ts";

/*
 * The Features page's results in the room search (docs/design/design-v1-features.md
 * 6, Search): one "Show" result for each hidden part, valued Hidden and
 * found by its name and other names, whose Enter presses its switch on the
 * page at the part's group, a hidden need named in its title, and a DM's
 * own part in the DM's catalog alone.
 */

describe("the parts' Show results", () => {
  test("none while every part shows", () => {
    for (const role of ["dm", "player"] as const) for (const which of ["everyone", "dm"] as const) assert.deepEqual(showEntries({ role }, which, NO_CHOICES), []);
  });

  test("a hidden part is one result that presses its switch, at its group's fold on the Features page", () => {
    const [ruler, ...rest] = showEntries({ role: "player" }, "everyone", withChoice(NO_CHOICES, "player", "ruler", false));
    assert.deepEqual(rest, []);
    assert.deepEqual(ruler, {
      id: `action:${switchAnchor("ruler")}`,
      kind: "action",
      title: "Show Ruler",
      where: "Menu · This device · Features",
      icon: "hidden",
      names: ["Ruler", "measure", "distance"],
      value: "Hidden",
      act: { t: "open", route: { panel: "menu", page: "features", section: "tools", anchor: "menu.this-device.features.ruler", press: true } },
    });
  });

  test("a DM's own part is the DM's catalog's, with a hidden need in its title, and a part both roles have is everyone's", () => {
    const choices = withChoice(withChoice(NO_CHOICES, "dm", "builder", false), "dm", "sound", false);
    assert.deepEqual(
      showEntries({ role: "dm" }, "dm", choices).map((e) => e.title),
      ["Show Map builder", "Show Dungeon generator and Map builder"],
    );
    assert.deepEqual(
      showEntries({ role: "dm" }, "everyone", choices).map((e) => e.title),
      ["Show Sound"],
    );
    assert.deepEqual(showEntries({ role: "player" }, "everyone", choices), [], "the DM's choices hold for the DM alone");
  });

  test("the catalogs offer them from this device's choices, a DM's own part in the DM's catalog alone", () => {
    const shows = (catalog: Catalog, state: RoomView) =>
      (catalog.items?.({ role: searchRole(state), memberId: state.you?.memberId ?? null, state, wide: true }) ?? []).filter((e) => e.id.startsWith("action:menu.this-device.features.")).map((e) => e.title);
    setModuleShown("ruler", "player", false);
    setModuleShown("builder", "dm", false);
    try {
      assert.deepEqual(shows(EVERYONE, PAT_VIEW()), ["Show Ruler"]);
      assert.deepEqual(shows(EVERYONE, DM_VIEW()), []);
      assert.deepEqual(shows(DM_CATALOG, DM_VIEW()), ["Show Map builder", "Show Dungeon generator and Map builder"]);
    } finally {
      resetAllFeatures();
    }
  });

  test("each anchor is the part's id in words", () => {
    assert.equal(switchAnchor("spellSlots"), "menu.this-device.features.spell-slots");
    assert.equal(switchAnchor("diceAnimation"), "menu.this-device.features.dice-animation");
    assert.equal(switchAnchor("ddb"), "menu.this-device.features.ddb");
  });
});
