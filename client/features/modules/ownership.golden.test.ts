import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";

/*
 * The ownership golden (docs/design/design-v1-features.md 14, D-261127-125):
 * every id of every registry a part may claim, with its owner and the
 * condition it is owned under, or "core". A new entry changes the golden,
 * so its owner is decided in review, and every claim must name an entry
 * that exists. To take a meant change, run this file with
 * UPDATE_GOLDEN=1 and read the diff.
 */

const { ownershipOf, strayClaims } = await import("./ownership.ts");
const { PANELS } = await import("../panels.ts");
const { TOOLS } = await import("../tools.ts");
const { BEHAVIORS, SHORTCUTS, SURFACES, VIEW_BEHAVIORS, VIEW_SHORTCUTS } = await import("../../state/shortcuts.ts");
const { TOP_BAR_ORDER } = await import("../../pages/topBarFit.ts");
const { BUILD_MODES } = await import("../builder/store.ts");
const { THIS_DEVICE_SECTIONS } = await import("../../lib/folds.ts");
const { EVERYONE } = await import("../search/catalog/everyone.ts");
const { DM_CATALOG } = await import("../search/catalog/dm.ts");
const { VIEW_ANCHORS } = await import("../search/index.ts");

type Registries = import("./ownership.ts").Registries;

const GOLDEN_URL = new URL("ownership.golden.json", import.meta.url);

/** The anchor a catalog entry routes to: its id after its kind. */
const anchorOf = (id: string) => id.slice(id.indexOf(":") + 1);

/**
 * The search's entry ids: the catalogs' own, a creature field's by its key
 * (gate.ts searchKey), and the index's own rows by their id's pattern
 * (search/index.ts), each standing for every id of its kind.
 */
const INDEX_ROWS = ["panel:*", "key:*", "condition:*", "moveToFloor:*", "floor:*", "token:*", "character:*", "scene:*", "monster:*", "playlist:*", "action:play:*", "track:*", "handout:doc:*", "page:*", "handout:*", "dice:*", "item:*"];

function registries(): Registries {
  const catalogs = [EVERYONE, DM_CATALOG];
  const entries = catalogs.flatMap((c) => c.entries.map((e) => e.id));
  const fields = catalogs.flatMap((c) => c.fields);
  return {
    panel: PANELS.map((p) => p.id),
    tool: TOOLS.map((t) => t.id),
    shortcut: [...SHORTCUTS, ...VIEW_SHORTCUTS].map((s) => s.id),
    behavior: [...BEHAVIORS, ...VIEW_BEHAVIORS].map((b) => b.id),
    surface: [...SURFACES],
    topBar: [...TOP_BAR_ORDER],
    search: [...entries, ...fields.map((f) => `field:${f.key}`), ...INDEX_ROWS],
    deviceSection: [...THIS_DEVICE_SECTIONS],
    builderMode: BUILD_MODES.map((m) => m.value),
    anchor: [...entries.map(anchorOf), ...fields.flatMap((f) => [f.token?.anchor, f.page?.anchor].filter((a): a is string => a !== undefined)), ...VIEW_ANCHORS],
  };
}

describe("the ownership golden", () => {
  test("every registry id has the owner the golden records", () => {
    const now = ownershipOf(registries());
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN_URL, `${JSON.stringify(now, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8")) as unknown;
    assert.deepEqual(now, golden, "an id's owner changed or a registry gained or lost an id: decide its owner, then take the change with UPDATE_GOLDEN=1");
  });

  test("every claim names an entry its registry holds", () => {
    assert.deepEqual(strayClaims(registries()), []);
  });

  test("the claims are where section 3 puts them", () => {
    const own = ownershipOf(registries());
    assert.equal(own.panel.sound, "sound");
    assert.equal(own.panel.dice, "core");
    assert.equal(own.tool.fog, "core");
    assert.equal(own.tool.build, "builder");
    assert.equal(own.shortcut["tool:ruler"], "ruler");
    assert.equal(own.anchor["scenes.floors.add-above"], "floors when oneFloor");
    assert.equal(own.search["field:companions"], "companions");
    assert.equal(own.search["field:spell-slots"], "spellSlots");
    assert.equal(own.search["field:hit-dice"], "hitDice");
    assert.equal(own.search["field:classes"], "core", "the Classes line hides only with both slot parts, in tokens/search.ts");
    assert.equal(own.search["playlist:*"], "sound");
    assert.equal(own.builderMode.wing, "dungeon");
    assert.equal(own.topBar.clock, "time");
    assert.equal(own.deviceSection.weather, "weather");
  });
});
