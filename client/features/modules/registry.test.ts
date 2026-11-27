import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CLAIM_CONDITIONS, CLAIM_KINDS, CORE_PARTS, HOMES, MODULE_GROUPS, MODULE_IDS, MODULES, dependentsOf, helpFor, modulesFor, needsOf, simpleFor, type Role } from "./registry.ts";

/*
 * The registry's own rules (docs/design/design-v1-features.md 3 and 14):
 * 23 parts with unique ids, 15 of them a player's, help and homes for every
 * role a part has, needs that end and stay within a role, and Simple's
 * lists as its preset's words say them.
 */

const ROLES: readonly Role[] = ["dm", "player"];

describe("the parts registry", () => {
  test("23 parts with unique ids, 23 for a DM and 15 for a player, in five groups", () => {
    assert.equal(MODULES.length, 23);
    assert.equal(new Set(MODULE_IDS).size, 23);
    assert.equal(modulesFor("dm").length, 23);
    assert.equal(modulesFor("player").length, 15);
    const groups = MODULE_GROUPS.map((g) => g.id);
    assert.deepEqual(MODULE_GROUPS.map((g) => g.name), ["Characters", "Tools", "Maps", "Panels", "Visuals"]);
    for (const m of MODULES) assert.ok(groups.includes(m.group), m.id);
    // The page lists the registry's order, so each group's parts stand together.
    const order = MODULES.map((m) => groups.indexOf(m.group));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test("every role a part has gives it help, a default and at least one home", () => {
    for (const m of MODULES) {
      for (const role of ROLES) {
        const r = m.roles[role];
        if (!r) continue;
        assert.ok(helpFor(m, role).length > 0, `${m.id} ${role}`);
        assert.ok(r.homes.length > 0, `${m.id} ${role} homes`);
        for (const h of r.homes) assert.ok(HOMES.includes(h), `${m.id} ${h}`);
        assert.equal(r.shown, true, `${m.id}: nothing hides by default`);
      }
    }
  });

  test("needs name parts, end, and stay within each role the part has", () => {
    for (const m of MODULES) {
      for (const n of m.needs ?? []) assert.ok(MODULE_IDS.includes(n), `${m.id} needs ${n}`);
      assert.ok(!needsOf(m.id).includes(m.id), `${m.id} needs itself`);
      for (const role of ROLES) if (m.roles[role]) for (const n of needsOf(m.id)) assert.ok(MODULES.find((x) => x.id === n)?.roles[role], `${m.id} ${role} needs ${n}`);
    }
    assert.deepEqual(needsOf("dungeon"), ["builder"]);
    assert.deepEqual(dependentsOf("builder"), ["dungeon"]);
    assert.deepEqual(dependentsOf("dungeon"), []);
  });

  test("claims name a known kind, and conditions a known name", () => {
    const seen = new Set<string>();
    for (const m of MODULES) {
      for (const c of m.claims) {
        assert.ok(CLAIM_KINDS.includes(c.kind), `${m.id} ${c.kind}`);
        if (c.when) assert.ok(c.when in CLAIM_CONDITIONS, `${m.id} ${c.when}`);
        const key = `${c.kind}:${c.id}`;
        assert.ok(!seen.has(key), `${key} is claimed twice`);
        seen.add(key);
      }
    }
  });

  test("Simple keeps what its preset's words name", () => {
    // DM: "The map, tokens, monsters, fog, dice and turns, with Ruler, Areas, Draw and Ping." The dice keep their animation.
    assert.deepEqual([...simpleFor("dm")], ["ruler", "areas", "draw", "ping", "diceAnimation"]);
    // Player: "Your character's HP, conditions and rolls, turns, Ruler and Ping, and what the DM shares": Sound, the clock, the journal and the weather.
    assert.deepEqual([...simpleFor("player")], ["ruler", "ping", "sound", "time", "journal", "weather", "diceAnimation"]);
  });

  test("the Always shown list names the X-card", () => {
    assert.ok(CORE_PARTS.some((c) => c.names.includes("X-card")));
    for (const c of CORE_PARTS) assert.ok(!c.line.includes("\u2014") && !c.line.includes(";"), c.line);
  });
});
