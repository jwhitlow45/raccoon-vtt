import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeReopen, encodeReopen } from "./reopen.ts";

describe("opening a panel again after a reload", () => {
  test("only the room that asked opens it", () => {
    const raw = encodeReopen("K7QH2MXA", { panel: "log" });
    assert.deepEqual(decodeReopen(raw, "K7QH2MXA"), { panel: "log" });
    assert.equal(decodeReopen(raw, "OTHER000"), null);
  });

  test("an id from before a rename opens the panel that took its place (docs/design/design-v1-sound-layout.md 3.3)", () => {
    assert.deepEqual(decodeReopen(encodeReopen("R", { panel: "ambiance" }), "R"), { panel: "sound" });
    assert.deepEqual(decodeReopen(encodeReopen("R", { panel: "time" }), "R"), { panel: "time" });
    assert.deepEqual(decodeReopen(encodeReopen("R", { panel: "sound" }), "R"), { panel: "sound" });
    assert.deepEqual(decodeReopen(encodeReopen("R", { panel: "scenes" }), "R"), { panel: "scenes" });
  });

  test("a tool comes back too, and anything else is ignored", () => {
    assert.deepEqual(decodeReopen(encodeReopen("R", { tool: "fog" }), "R"), { tool: "fog" });
    assert.equal(decodeReopen(null, "R"), null);
    assert.equal(decodeReopen("not json", "R"), null);
    assert.equal(decodeReopen(JSON.stringify({ roomId: "R", panel: 3 }), "R"), null);
  });
});
