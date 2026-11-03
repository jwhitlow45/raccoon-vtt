import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import { OWN_MS, ownKindOf, unclaimed } from "./useClockToasts.ts";

const line = (id: string, from?: "undo" | "redo"): LogEntry => ({ id, at: "", kind: "event", data: { type: "clock", date: "Day 1, 8:00 AM", by: 600, ...(from ? { from } : {}) } });

describe("ownKindOf", () => {
  it("claims clock ops and history ops only", () => {
    assert.equal(ownKindOf({ t: "clock.advance" }), "step");
    assert.equal(ownKindOf({ t: "clock.set" }), "step");
    assert.equal(ownKindOf({ t: "undo" }), "history");
    assert.equal(ownKindOf({ t: "redo" }), "history");
    assert.equal(ownKindOf({ t: "token.move" }), null);
  });
});

describe("unclaimed", () => {
  it("drops the line this device's step wrote and keeps another's", () => {
    const own = [{ kind: "step" as const, at: 1_000 }];
    assert.deepEqual(unclaimed([line("5:0")], own, 2_000), []);
    assert.equal(own.length, 0);
    assert.deepEqual(
      unclaimed([line("6:0")], own, 2_000).map((e) => e.id),
      ["6:0"],
    );
  });
  it("matches an undo line to an undo, not to a step", () => {
    const own = [{ kind: "step" as const, at: 1_000 }];
    assert.deepEqual(
      unclaimed([line("5:0", "undo")], own, 2_000).map((e) => e.id),
      ["5:0"],
    );
    assert.equal(own.length, 1);
    assert.deepEqual(unclaimed([line("6:0", "undo")], [{ kind: "history", at: 1_000 }], 2_000), []);
  });
  it("lets a claim from a refused op lapse", () => {
    const own = [{ kind: "step" as const, at: 1_000 }];
    assert.deepEqual(
      unclaimed([line("9:0")], own, 1_000 + OWN_MS + 1).map((e) => e.id),
      ["9:0"],
    );
    assert.equal(own.length, 0);
  });
  it("claims one line for one op", () => {
    const own = [{ kind: "step" as const, at: 1_000 }];
    assert.deepEqual(
      unclaimed([line("5:0"), line("6:0")], own, 2_000).map((e) => e.id),
      ["6:0"],
    );
  });
});
