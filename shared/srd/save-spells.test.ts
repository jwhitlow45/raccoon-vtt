import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AREA_SPELLS } from "./area-spells.ts";
import { SAVE_SPELLS } from "./save-spells.ts";

describe("the save spells without an area preset (W7B-R2-3)", () => {
  test("each once, in name order, and none that has an area preset", () => {
    const names = SAVE_SPELLS.map((s) => s.name);
    assert.deepEqual(names, [...new Set(names)].sort());
    const areas = new Set(AREA_SPELLS.map((s) => s.name.toLowerCase()));
    assert.deepEqual(names.filter((n) => areas.has(n.toLowerCase())), []);
  });
});
