import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeReopen, encodeReopen } from "./reopen.ts";

describe("opening a panel again after a reload", () => {
  test("only the room that asked opens it", () => {
    const raw = encodeReopen("K7QH2MXA", { panel: "log" });
    assert.deepEqual(decodeReopen(raw, "K7QH2MXA"), { panel: "log" });
    assert.equal(decodeReopen(raw, "OTHER000"), null);
  });

  test("a tool comes back too, and anything else is ignored", () => {
    assert.deepEqual(decodeReopen(encodeReopen("R", { tool: "fog" }), "R"), { tool: "fog" });
    assert.equal(decodeReopen(null, "R"), null);
    assert.equal(decodeReopen("not json", "R"), null);
    assert.equal(decodeReopen(JSON.stringify({ roomId: "R", panel: 3 }), "R"), null);
  });
});
