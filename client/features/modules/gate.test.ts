import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claimShown, EVERYTHING, hiddenAt, hiddenModules, moduleShown, ownerOf, partMark, presetOf, searchKey, showLabel, toolShown, unmetNeeds } from "./gate.ts";
import { MODULE_IDS, modulesFor } from "./registry.ts";
import { NO_CHOICES, withChoice, withPreset, type FeatureChoices } from "./store.ts";

/*
 * The gate's rules (docs/design/design-v1-features.md 8 and 13): a part
 * hides with its own choice or a hidden need, keeping its own choice, a
 * claim hides its entry only under its condition, a creature home names
 * only what the creature holds, and a Show's words name the needs it
 * turns on.
 */

const off = (role: "dm" | "player", ...ids: (typeof MODULE_IDS)[number][]): FeatureChoices => ids.reduce((c, id) => withChoice(c, role, id, false), NO_CHOICES as FeatureChoices);

describe("the parts gate", () => {
  test("no choices: every part shows, every entry shows", () => {
    for (const role of ["dm", "player"] as const) {
      assert.equal(hiddenModules(role, NO_CHOICES).size, 0);
      for (const m of modulesFor(role)) for (const c of m.claims) assert.equal(claimShown(c.kind, c.id, role, NO_CHOICES, { oneFloor: true }), true, `${m.id} ${c.id}`);
    }
    assert.equal(EVERYTHING, NO_CHOICES);
  });

  test("Map builder hidden hides Dungeon generator, whose own choice stays on", () => {
    const choices = off("dm", "builder");
    assert.deepEqual([...hiddenModules("dm", choices)], ["builder", "dungeon"]);
    assert.equal(moduleShown("dungeon", "dm", choices), false);
    assert.equal(claimShown("builderMode", "wing", "dm", choices), false);
    assert.deepEqual(unmetNeeds("dungeon", "dm", choices), ["builder"]);
    assert.equal(showLabel("dungeon", "dm", choices), "Show Dungeon generator and Map builder");
    assert.equal(showLabel("builder", "dm", choices), "Show Map builder");
  });

  test("a role's choices never touch the other role", () => {
    const choices = off("player", "ruler");
    assert.equal(moduleShown("ruler", "player", choices), false);
    assert.equal(moduleShown("ruler", "dm", choices), true);
    assert.equal(toolShown("ruler", "dm", choices), true);
    assert.equal(toolShown("ruler", "player", choices), false);
  });

  test("a borrowed tool shows while its part is hidden", () => {
    const choices = off("dm", "areas");
    assert.equal(toolShown("area", "dm", choices), false);
    assert.equal(toolShown("area", "dm", choices, true), true);
    assert.equal(toolShown("select", "dm", choices), true, "a core tool never hides");
  });

  test("a claim with a condition hides its entry only while the caller knows it holds", () => {
    const choices = off("dm", "floors");
    assert.equal(claimShown("anchor", "scenes.floors.add-above", "dm", choices, { oneFloor: true }), false);
    assert.equal(claimShown("anchor", "scenes.floors.add-above", "dm", choices, { oneFloor: false }), true);
    assert.equal(claimShown("anchor", "scenes.floors.add-above", "dm", choices), true);
  });

  test("a search claim is a prefix, and a creature's field is matched by its key", () => {
    const choices = off("dm", "sound", "companions");
    assert.equal(claimShown("search", "section:sound.now", "dm", choices), false);
    assert.equal(claimShown("search", "playlist:abc", "dm", choices), false);
    assert.equal(claimShown("search", "section:menu.this-device.sounds", "dm", choices), true, "the Sounds section keeps Turn sound and Ping sound");
    assert.equal(searchKey("field:token:t1:companions"), "field:companions");
    assert.equal(searchKey("panel:sound"), "panel:sound");
    assert.equal(claimShown("search", searchKey("field:character:c1:companions"), "dm", choices), false);
  });

  test("each entry has one owner, recorded with its condition", () => {
    assert.deepEqual(ownerOf("tool", "ruler"), { module: "ruler" });
    assert.deepEqual(ownerOf("anchor", "scenes.floors"), { module: "floors", when: "oneFloor" });
    assert.equal(ownerOf("tool", "fog"), null);
    assert.equal(ownerOf("panel", "dice"), null);
  });

  test("a creature home names a part only where the creature holds it", () => {
    const choices = off("player", "spellSlots", "classResources", "companions", "ddb", "sound");
    assert.deepEqual(hiddenAt("uses", "player", choices, {}).map((m) => m.id), [], "a fighter with nothing to show reads nothing");
    assert.deepEqual(hiddenAt("uses", "player", choices, { classes: [{}] }).map((m) => m.id), ["spellSlots"]);
    assert.deepEqual(hiddenAt("uses", "player", choices, { mayAdd: true }).map((m) => m.id), ["spellSlots", "classResources"], "a classless character's own page keeps its way back");
    assert.deepEqual(hiddenAt("companions", "player", choices, {}).map((m) => m.id), ["companions"]);
    assert.deepEqual(hiddenAt("statBlock", "player", choices, {}).map((m) => m.id), []);
    assert.deepEqual(hiddenAt("statBlock", "player", choices, { ddbSync: { at: 1 } }).map((m) => m.id), ["ddb"]);
    assert.deepEqual(hiddenAt("panels", "player", choices).map((m) => m.id), ["sound"]);
    assert.deepEqual(hiddenAt("panels", "dm", choices).map((m) => m.id), [], "the player's choices are not the DM's");
  });

  test("Weather's homes differ by role", () => {
    const choices = withChoice(off("dm", "weather"), "player", "weather", false);
    assert.deepEqual(hiddenAt("sceneSettings", "dm", choices).map((m) => m.id), ["weather"]);
    assert.deepEqual(hiddenAt("sceneSettings", "player", choices).map((m) => m.id), []);
    assert.deepEqual(hiddenAt("thisDevice", "player", choices).map((m) => m.id), ["weather"]);
  });

  test("presets match by what hides, not by what is stored", () => {
    assert.equal(presetOf("dm", NO_CHOICES), "everything");
    assert.equal(presetOf("dm", withPreset(NO_CHOICES, "dm", "simple")), "simple");
    assert.equal(presetOf("dm", withChoice(withPreset(NO_CHOICES, "dm", "simple"), "dm", "ruler", false)), null);
    // An id this build does not know hides nothing, so the role still reads Everything.
    assert.equal(presetOf("player", { dm: {}, player: { futurePart: false } }), "everything");
    // Hiding the builder's need by hand reads as Simple too: what hides is the same.
    assert.equal(presetOf("dm", withChoice(withPreset(NO_CHOICES, "dm", "simple"), "dm", "dungeon", true)), "simple");
  });

  test("a part's mark", () => {
    assert.deepEqual(partMark("sound"), { "data-part": "sound" });
  });
});
