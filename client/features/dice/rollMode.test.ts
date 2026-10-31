import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsRollMode, effectiveRollMode, hasRollModeMenu, overrideRollSources, resolveRollMode, rollModeHint, rollModeItems, rollModeTo } from "./rollMode.ts";

test("manual modes replace only manual sources, preserving cancellation and all presets", () => {
  assert.deepEqual(resolveRollMode([], [{ kind: "dis", from: "pressed" }], "adv"), { mode: "adv" });
  assert.deepEqual(resolveRollMode([{ kind: "dis", from: "restrained" }], [], "adv"), { cancelled: true });
  assert.deepEqual(resolveRollMode([{ kind: "adv", from: "haste" }, { kind: "dis", from: "restrained" }], [], "adv"), { cancelled: true });
  assert.deepEqual(resolveRollMode([{ kind: "dis", from: "poisoned" }], [{ kind: "adv", from: "pressed" }], "normal"), { mode: "dis" });
  assert.deepEqual(overrideRollSources([{ kind: "adv", from: "typed" }, { kind: "dis", from: "restrained" }], [], "normal"), [{ kind: "dis", from: "restrained" }]);
  assert.deepEqual(resolveRollMode([], [{ kind: "adv", from: "pressed" }], "secret"), { mode: "adv" });
});
test("Normal keeps default secrecy, other modes read ordinary visibility", () => {
  assert.equal(rollModeTo("all", "dm", "normal"), "dm");
  assert.equal(rollModeTo("dm", "all", "normal"), "all");
  assert.equal(rollModeTo("dm", "all", "adv"), "dm");
  assert.equal(rollModeTo("all", "all", "secret"), "dm");
});
test("capabilities exclude meaningless fixed rolls and damage modes", () => {
  for (const f of ["1d20+5", "1d20+1d4-2"]) assert.ok(acceptsRollMode(f));
  for (const f of ["2d20", "2d20kh1", "1d6", "broken"]) assert.equal(acceptsRollMode(f), false);
  assert.equal(hasRollModeMenu({ d20: false, visibility: "creature" }), false);
  assert.equal(rollModeHint({ d20: false, visibility: "creature" }), undefined);
  assert.deepEqual(rollModeItems({ d20: true, damage: true, visibility: "selectable" }, false).map((i) => i.id), ["secret", "normal"]);
  const items = rollModeItems({ d20: true, visibility: "request" }, false);
  assert.deepEqual(items.map((i) => i.id), ["adv", "dis", "secret", "normal"]);
  assert.equal(items[2]?.disabled, true);
  assert.equal(items[2]?.description, "Roll secretly: request answers keep the request's visibility.");
  assert.equal(rollModeItems({ d20: false, visibility: "selectable" }, false)[0]?.description, "Roll secretly: you and the DM see the result.");
  assert.equal(rollModeHint({ d20: true, visibility: "creature" }), "Hold, right-click or Shift+F10 for Advantage, Disadvantage or Normal.");
});
test("returned fields describe the effective result", () => {
  assert.equal(effectiveRollMode({ formula: "1d20", cancelled: true }, true), "Normal: Advantage and Disadvantage cancelled, Secret");
  assert.equal(effectiveRollMode({ formula: "2d20kh1", mode: "adv" }), "Advantage");
  assert.equal(effectiveRollMode({ formula: "1d20" }), "Normal");
  assert.equal(effectiveRollMode({ formula: "1d6" }, true), "Secret");
});
