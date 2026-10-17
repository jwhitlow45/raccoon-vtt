import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { headerSink, panelSections, panelsFor, scrollOf, scrollToRestore, type PanelHeader, type PanelSection } from "./panels.ts";

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

/*
 * A host reused for another panel (W6-SOL-02): the phone's sheet keeps its
 * body when Initiative replaces Menu, so the host has taken Initiative's
 * listener before Menu's cleanup withdraws the Members subpage.
 */
describe("a panel's subpage and its host", () => {
  test("a withdrawal goes back to the listener the subpage was published to, never the host's latest", () => {
    const kept: Record<string, PanelHeader | null> = {};
    const listener = (id: string) => (header: PanelHeader | null) => void (kept[id] = header);
    const latest = { current: listener("menu") };
    const publish = headerSink(latest);
    const members: PanelHeader = { title: "Members", parent: "Menu", onBack: () => {} };
    const withdraw = publish(members);
    assert.equal(kept.menu, members);
    latest.current = listener("tracker");
    withdraw();
    assert.equal(kept.menu, null, "Menu's subpage is withdrawn from Menu");
    assert.equal("tracker" in kept, false, "and Initiative's entry is left alone");
    const initiative: PanelHeader = { title: "Round 2", parent: "Initiative", onBack: () => {} };
    publish(initiative);
    assert.equal(kept.tracker, initiative);
    assert.equal(kept.menu, null);
  });
});

/*
 * Each panel keeps its scroll as it leaves and shows again by any path: a
 * tab, More, a link, either pane of two, a phone's sheet (the project
 * owner, after wave 6).
 */
describe("a panel's scroll as it shows again", () => {
  const box = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollLeft: 0, scrollHeight, clientHeight });

  test("a panel left part way down opens where it was, on the page it showed", () => {
    const saved = scrollOf({ ...box(640), scrollLeft: 30 }, null);
    assert.deepEqual(saved, { top: 640, left: 30, end: false, page: null });
    assert.deepEqual(scrollToRestore(saved, null, box(0)), { top: 640, left: 30 });
  });

  test("a panel left at its end opens at its new end, so what arrived meanwhile shows", () => {
    const saved = scrollOf(box(1500), null);
    assert.equal(saved.end, true);
    assert.deepEqual(scrollToRestore(saved, null, box(0, 2600)), { top: 2100, left: 0 });
  });

  test("a panel at its top, or one that fit, is never at its end", () => {
    assert.equal(scrollOf(box(0), null).end, false, "scrolled back to its top");
    assert.equal(scrollOf(box(0, 400, 500), null).end, false, "it fit");
    assert.deepEqual(scrollToRestore(scrollOf(box(0), null), null, box(0, 2600)), { top: 0, left: 0 });
  });

  test("a remembered subpage waits for its header, and nothing remembered leaves the panel's own first scroll", () => {
    const saved = scrollOf(box(300), "Journal\nlore");
    assert.equal(scrollToRestore(saved, null, box(0)), "wait", "the page has yet to publish its header");
    assert.deepEqual(scrollToRestore(saved, "Journal\nlore", box(0)), { top: 300, left: 0 });
    assert.equal(scrollToRestore(undefined, null, box(0)), null, "the Log's own start at its newest line stays");
  });
});
