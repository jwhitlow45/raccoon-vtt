import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { panelsFor } from "./panels.ts";

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
