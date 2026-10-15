import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Drawing } from "#shared/model.ts";
import { drawAccess } from "./gate.ts";

const drawing = (id: string, ownerId: string, kind: Drawing["kind"] = "free", sceneId = "s1") => ({ id, ownerId, kind, sceneId });

describe("the Draw tool's gate", () => {
  const base = { role: "player" as const, memberId: "p1", drawings: {}, sceneId: "s1" };

  test("every answer of the setting, a room from before it letting everyone draw", () => {
    assert.equal(drawAccess({ ...base, settings: {} }), "draw");
    assert.equal(drawAccess({ ...base, settings: { playersDraw: "all" } }), "draw");
    assert.equal(drawAccess({ ...base, settings: { playersDraw: "none" } }), "none");
    assert.equal(drawAccess({ ...base, settings: { playersDraw: ["p1"] } }), "draw");
    assert.equal(drawAccess({ ...base, settings: { playersDraw: ["p2"] } }), "none");
    assert.equal(drawAccess({ ...base, settings: { playersDraw: [] } }), "none");
  });

  test("the DM always draws", () => {
    assert.equal(drawAccess({ ...base, role: "dm", settings: { playersDraw: "none" } }), "draw");
  });

  test("a player who may not draw keeps an eraser while drawings of their own are on the scene, kept rulers aside", () => {
    const settings = { playersDraw: "none" as const };
    assert.equal(drawAccess({ ...base, settings, drawings: { a: drawing("a", "p1") } }), "erase");
    assert.equal(drawAccess({ ...base, settings, drawings: { a: drawing("a", "p2") } }), "none", "someone else's");
    assert.equal(drawAccess({ ...base, settings, drawings: { a: drawing("a", "p1", "ruler") } }), "none", "a kept ruler is no drawing to erase here");
    assert.equal(drawAccess({ ...base, settings, drawings: { a: drawing("a", "p1", "free", "s2") } }), "none", "another scene's");
    assert.equal(drawAccess({ ...base, settings, sceneId: null, drawings: { a: drawing("a", "p1") } }), "none");
  });
});
