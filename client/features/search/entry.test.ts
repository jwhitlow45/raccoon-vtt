import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSearchId, searchSelector } from "./entry.ts";

describe("an anchor's data-search id (docs/design/design-v1-qol.md 5, What keeps it current)", () => {
  test("is lowercase words joined by hyphens, in dotted parts from the panel to the control", () => {
    for (const id of ["dm.screens.blackout", "menu.room-settings.combat.crit-rule", "token.hp", "this-device.sound.room-sound", "tracker.start2"]) assert.ok(isSearchId(id), id);
  });

  test("refuses a panel alone, capitals, spaces, quotes, empty parts and anything a selector would need escaped", () => {
    for (const id of ["dm", "", "DM.screens", "dm.Screens", "dm screens.x", "dm.screens.", ".dm.x", "dm..x", "dm.-x", "dm.x-", 'dm.x"]', "dm.x_y", "2d.x", `dm.${"a".repeat(100)}`]) {
      assert.ok(!isSearchId(id), id);
    }
  });

  test("finds its control by the attribute alone", () => {
    assert.equal(searchSelector("dm.screens.blackout"), '[data-search="dm.screens.blackout"]');
  });
});
