import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { panelSections, panelsFor, type PanelSection } from "./panels.ts";

describe("the panels' order and groups (docs/design-v1-layout-hierarchy.md M3)", () => {
  const titles = (role: "dm" | "player", wide: boolean) => panelsFor(role, wide).map((p) => p.title);
  const groups = (role: "dm" | "player", wide: boolean) => panelsFor(role, wide).map((p) => p.group);

  test("a DM's phone: the in-play panels first, then those for preparing, then Menu", () => {
    assert.deepEqual(titles("dm", false), ["Token", "Initiative", "Party", "Log", "Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"]);
    assert.deepEqual(groups("dm", false), ["play", "play", "play", "play", "play", "play", "play", "play", "prepare", "prepare", "prepare", "prepare", "prepare", "room"]);
  });

  test("a DM's side panel has no Party tab: the party bar sits atop it", () => {
    assert.deepEqual(titles("dm", true), ["Token", "Initiative", "Log", "Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"]);
  });

  test("a player's panels, phone and wide alike", () => {
    const player = ["Token", "Initiative", "Log", "Journal", "Areas", "Characters", "Library", "Menu"];
    assert.deepEqual(titles("player", false), player);
    assert.deepEqual(titles("player", true), player);
    assert.deepEqual(groups("player", false), ["play", "play", "play", "play", "play", "prepare", "prepare", "room"]);
  });

  test("the groups keep to the order's ranges, and Initiative stays the side panel's default", () => {
    for (const p of panelsFor("dm", false)) {
      if (p.group === "play") assert.ok(p.order >= 10 && p.order <= 24, p.id);
      if (p.group === "prepare") assert.ok(p.order >= 40 && p.order <= 48, p.id);
      if (p.group === "room") assert.equal(p.id, "menu");
    }
  });
});

/*
 * One grouping for a DM's phone list of panels and the side panel's More
 * (docs/design-v1-panel-tabs.md 4.1), over the whole list and over each
 * slice the tab row's fit can leave in More.
 */
describe("the panels in sections", () => {
  const shape = (sections: PanelSection[]) => sections.map((s) => [s.label ?? (s.line ? "---" : ""), s.panels.map((p) => p.title)]);

  test("a DM's whole phone list: In play and Prepare over their panels, and Menu after a line", () => {
    assert.deepEqual(shape(panelSections(panelsFor("dm", false), true)), [
      ["In play", ["Token", "Initiative", "Party", "Log", "Journal", "Areas", "DM", "Scenes"]],
      ["Prepare", ["Monsters", "Encounters", "Characters", "Outliner", "Library"]],
      ["---", ["Menu"]],
    ]);
  });

  test("a player's list has no labels and no line", () => {
    assert.deepEqual(shape(panelSections(panelsFor("player", false), false)), [["", ["Token", "Initiative", "Log", "Journal", "Areas", "Characters", "Library", "Menu"]]]);
    assert.deepEqual(panelSections([], false), []);
  });

  test("each slice More can hold keeps the registry's order, with a label only for a group it holds", () => {
    const dm = panelsFor("dm", true);
    for (let k = 0; k < dm.length; k++) {
      const slice = dm.slice(k);
      const sections = panelSections(slice, true);
      assert.deepEqual(
        sections.flatMap((s) => s.panels.map((p) => p.id)),
        slice.map((p) => p.id),
        `from ${k}`,
      );
      for (const s of sections) assert.ok(s.panels.every((p) => p.group === s.key), `one group a section, from ${k}`);
      assert.equal(sections.filter((s) => s.label === "In play").length, slice.some((p) => p.group === "play") ? 1 : 0, `In play from ${k}`);
      assert.equal(sections.filter((s) => s.label === "Prepare").length, slice.some((p) => p.group === "prepare") ? 1 : 0, `Prepare from ${k}`);
      assert.equal(sections.at(-1)?.line, true, "Menu is last, after a line");
    }
    assert.deepEqual(shape(panelSections(dm.slice(3), true)), [
      ["In play", ["Journal", "Areas", "DM", "Scenes"]],
      ["Prepare", ["Monsters", "Encounters", "Characters", "Outliner", "Library"]],
      ["---", ["Menu"]],
    ], "a DM's More at 1280 x 800");
    assert.deepEqual(shape(panelSections(dm.slice(8), true)), [["Prepare", ["Encounters", "Characters", "Outliner", "Library"]], ["---", ["Menu"]]]);
    assert.deepEqual(shape(panelSections(panelsFor("player", true).slice(3), false)), [["", ["Journal", "Areas", "Characters", "Library", "Menu"]]], "a player's More");
  });

  // docs/design-v1-split-panel.md 3.3: the bar's "Panel below" lists every panel the role has from 900 px up, grouped as More's.
  test("every panel from 900 px up, as the split's Panel below lists them", () => {
    assert.deepEqual(shape(panelSections(panelsFor("dm", true), true)), [
      ["In play", ["Token", "Initiative", "Log", "Journal", "Areas", "DM", "Scenes"]],
      ["Prepare", ["Monsters", "Encounters", "Characters", "Outliner", "Library"]],
      ["---", ["Menu"]],
    ]);
    assert.deepEqual(shape(panelSections(panelsFor("player", true), false)), [["", ["Token", "Initiative", "Log", "Journal", "Areas", "Characters", "Library", "Menu"]]]);
  });
});
