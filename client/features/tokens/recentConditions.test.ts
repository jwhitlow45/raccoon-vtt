import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { forgetRecentConditions, noteConditionUsed, parseRecentConditions, RECENT_CONDITIONS_KEY, recentConditions, withUsed, type ConditionStorage } from "./recentConditions.ts";

function memory(start: Record<string, string> = {}): ConditionStorage & { data: Record<string, string> } {
  const data = { ...start };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe("the conditions this device used last (docs/design/design-v1-qol.md 3, Q13)", () => {
  beforeEach(forgetRecentConditions);

  test("the newest first, once each, three kept", () => {
    let list = withUsed([], "prone");
    list = withUsed(list, "grappled");
    list = withUsed(list, "poisoned");
    assert.deepEqual(list, ["poisoned", "grappled", "prone"]);
    list = withUsed(list, "prone");
    assert.deepEqual(list, ["prone", "poisoned", "grappled"], "used again, it comes first and is not listed twice");
    assert.deepEqual(withUsed(["prone"], "prone"), ["prone"], "once, with room for more");
    list = withUsed(list, "blinded");
    assert.deepEqual(list, ["blinded", "prone", "poisoned"], "the oldest gives way");
  });

  test("a status counts, and a custom status or an unknown key leaves the list as it was", () => {
    assert.deepEqual(withUsed(["prone"], "concentrating"), ["concentrating", "prone"]);
    assert.deepEqual(withUsed(["prone"], "custom"), ["prone"]);
    assert.deepEqual(withUsed(["prone"], "flying-high"), ["prone"]);
  });

  test("storage reads back what was written, and anything unreadable is an empty list", () => {
    assert.deepEqual(parseRecentConditions(JSON.stringify(["prone", "poisoned"])), ["prone", "poisoned"]);
    assert.deepEqual(parseRecentConditions(null), []);
    assert.deepEqual(parseRecentConditions("{"), []);
    assert.deepEqual(parseRecentConditions(JSON.stringify({ prone: true })), []);
    assert.deepEqual(parseRecentConditions(JSON.stringify(["prone", 3, "custom", "prone", "stunned", "blinded", "deafened"])), ["prone", "stunned", "blinded"]);
  });

  test("using a condition writes this device's list, and a blocked or full storage keeps it for the page", () => {
    const storage = memory({ [RECENT_CONDITIONS_KEY]: JSON.stringify(["grappled"]) });
    assert.deepEqual(recentConditions(storage), ["grappled"]);
    noteConditionUsed("prone", storage);
    assert.deepEqual(recentConditions(storage), ["prone", "grappled"]);
    assert.deepEqual(JSON.parse(storage.data[RECENT_CONDITIONS_KEY]!), ["prone", "grappled"]);
    forgetRecentConditions();
    const full: ConditionStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    assert.deepEqual(recentConditions(full), []);
    noteConditionUsed("restrained", full);
    assert.deepEqual(recentConditions(full), ["restrained"]);
  });
});
