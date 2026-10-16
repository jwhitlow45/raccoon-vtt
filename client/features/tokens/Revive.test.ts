import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { offersRevive } = await import("./Revive.tsx");

describe("where Revive shows (docs/design-v1-combat-flow.md 3.5)", () => {
  test("only on the dead, never dying or stable, and never on an object", () => {
    assert.equal(offersRevive("dead", "monster"), true);
    assert.equal(offersRevive("dead", "pc"), true);
    assert.equal(offersRevive("dead", "npc"), true);
    assert.equal(offersRevive("dead", undefined), true, "a character's row with no token");
    for (const life of ["alive", "dying", "stable", undefined] as const) assert.equal(offersRevive(life, "monster"), false, String(life));
    assert.equal(offersRevive("dead", "object"), false);
  });
});
