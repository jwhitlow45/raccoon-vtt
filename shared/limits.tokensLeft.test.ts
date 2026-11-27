import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, sceneTokensLeft } from "./limits.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { room, token } from "./testutil.ts";

/*
 * The tokens a scene's group has room for (docs/design/design-v1-dungeon-stock.md 4):
 * 500 less every token on the scene and its floors, seat-held ones too, and
 * the whole cap for a scene the room does not hold.
 */

test("DSTOCK: a scene's tokens left count every token on its floors, and a scene not in the room has the whole cap", () => {
  let state = room({ tokens: { a: token("a", { sceneId: "s1" }), b: token("b", { sceneId: "s1" }), c: token("c", { sceneId: "s2" }) } });
  assert.equal(sceneTokensLeft(state, "s1"), LIMITS.tokensPerScene - 2);
  assert.equal(sceneTokensLeft(state, "s2"), LIMITS.tokensPerScene - 1);
  assert.equal(sceneTokensLeft(state, "nowhere"), LIMITS.tokensPerScene);
  const op: Op = { t: "scene.create", scene: { id: "f1", name: "Upstairs", bounds: { w: 20, h: 20 } }, floor: { beside: "s1", side: "above" } } as Op;
  const made = applyOp(state, op, { memberId: "dm1", role: "dm" }, { seq: 1, at: "2026-01-01T00:00:00.000Z" });
  assert.ok(made.ok, made.ok ? "" : made.message);
  state = { ...made.state, tokens: { ...made.state.tokens, d: token("d", { sceneId: "f1" }) } };
  assert.equal(sceneTokensLeft(state, "f1"), LIMITS.tokensPerScene - 3, "a floor shares its scene's tokens");
  assert.equal(sceneTokensLeft(state, "s1"), LIMITS.tokensPerScene - 3);
  const full = { ...state, tokens: Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`t${i}`, token(`t${i}`, { sceneId: "s1" })])) };
  assert.equal(sceneTokensLeft(full, "s1"), 0, "never below none");
});
