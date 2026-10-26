import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { cellVision } from "#shared/perPlayerTestutil.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { character, member, room, scene, token } from "#shared/testutil.ts";
import { HOLDERS_UNDER, holderRows, holdersAfter, lendsText, sharedOnlyText, unsharedMounts, untickQuestion } from "./holders.ts";

/** "Who sees for themselves", "Who lends sight" and the mount's note (docs/design-v1-per-player-vision.md 7.1), from the DM's view. */

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

/** A dark per-player scene with Ana and Ben seeing for themselves, Gus listed off, and Cy, who never joined. */
function table(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), ana: { ...member("ana"), name: "Ana" }, ben: { ...member("ben"), name: "Ben" }, gus: { ...member("gus"), name: "Gus" }, cy: { ...member("cy"), name: "Cy" } } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "ben", on: true }, { memberId: "ana", on: true }, { memberId: "gus", on: false }] };
  return s;
}

describe("who sees for themselves (7.1)", () => {
  test("every player of the roster, by name, ticked as the list says, and never the DM", () => {
    const rows = holderRows(table(), "s1");
    assert.deepEqual(
      rows.map((r) => [r.name, r.on, r.listed]),
      [
        ["Ana", true, true],
        ["Ben", true, true],
        ["Cy", false, false],
        ["Gus", false, true],
      ],
    );
    assert.deepEqual(holderRows({ ...table(), holders: {} }, "s1").map((r) => r.on), [false, false, false, false], "no list yet, no one ticked");
  });

  test("a tick asks for the players ticked and the new one, an untick for the rest, and a seventh is refused here", () => {
    const rows = holderRows(table(), "s1");
    assert.deepEqual(holdersAfter(rows, "cy", true), { on: ["ana", "ben", "cy"] });
    assert.deepEqual(holdersAfter(rows, "ana", false), { on: ["ben"] });
    assert.deepEqual(holdersAfter(rows, "gus", true), { on: ["ana", "ben", "gus"] }, "an entry that is off turns on");
    const six = Array.from({ length: 6 }, (_, k) => ({ memberId: `p${k}`, name: `P${k}`, on: true, listed: true }));
    const full = [...six, { memberId: "late", name: "Late", on: false, listed: false }];
    assert.deepEqual(holdersAfter(full, "late", true), { refused: "At most 6 players see for themselves here. Untick one first." });
    assert.deepEqual(holdersAfter(full, "p0", false), { on: ["p1", "p2", "p3", "p4", "p5"] }, "an untick at the cap is never refused");
    assert.deepEqual(holdersAfter(holderRows(table(), "s1").slice(0, 0), "x", true), { on: ["x"] });
  });

  test("its words", () => {
    assert.equal(untickQuestion("Ana"), "Untick Ana? They forget their map of this scene.");
    assert.equal(sharedOnlyText("Gus"), "Gus sees only what creatures that share sight see here.");
    assert.equal(HOLDERS_UNDER, "Players not ticked, and the table display, see only what creatures that share sight with the party see.");
  });
});

describe("who lends sight (7.1)", () => {
  test("a creature lends to the holders who own it, by name, one sharing sight to every player, and one whose players hold none to no player", () => {
    const s = table();
    s.characters.c1 = character("c1", { name: "Thorn", ownerIds: ["ben", "ana", "gus"] });
    const thorn = token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "c1" } });
    assert.equal(lendsText(s, "s1", thorn), "Lends its sight to Ana and Ben", "Gus is listed off");
    assert.equal(lendsText(s, "s1", token("owl", { ownerIds: ["ana"] })), "Lends its sight to Ana");
    assert.equal(lendsText(s, "s1", token("wolf", { ownerIds: ["gus", "cy"] })), "Lends its sight to no player");
    assert.equal(lendsText(s, "s1", token("ally", { partyVision: true })), "Lends its sight to every player");
    assert.equal(lendsText(s, "s1", token("ally", { partyVision: true, ownerIds: ["ana"] })), "Lends its sight to every player", "sharing sight reaches everyone, owners too");
    s.holders.s1!.entries.push({ memberId: "cy", on: true });
    assert.equal(lendsText(s, "s1", token("pack", { ownerIds: ["cy", "ben", "ana"] })), "Lends its sight to Ana, Ben and Cy");
    assert.equal(lendsText(s, "s1", token("dm", { ownerIds: ["dm1"] })), "Lends its sight to no player", "a DM holds no sight");
  });
});

describe("a mount not every player sees (7.1, risk 2)", () => {
  function riding(): RoomState {
    const s = table();
    s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["ana"], x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } });
    s.tokens.horse = token("horse", { kind: "npc", name: "Horse", x: 4, y: 4 });
    return s;
  }

  test("a rider every player sees on a controlled mount the shared sight misses is named, with what keeps the turn", () => {
    assert.deepEqual(unsharedMounts(riding(), "s1"), ["Thorn rides Horse, which not every player sees, so they share no turn. Make Horse always visible to keep it."]);
  });

  test("an always visible mount, one the DM hid, an independent ride and a whole-party scene say nothing", () => {
    const exempt = riding();
    exempt.tokens.horse = { ...exempt.tokens.horse!, fogExempt: true };
    assert.deepEqual(unsharedMounts(exempt, "s1"), []);
    const hidden = riding();
    hidden.tokens.horse = { ...hidden.tokens.horse!, visibility: "dm" };
    assert.deepEqual(unsharedMounts(hidden, "s1"), []);
    const free = riding();
    free.tokens.thorn = { ...free.tokens.thorn!, attached: { to: "horse", kind: "ride" } };
    assert.deepEqual(unsharedMounts(free, "s1"), []);
    const whole = riding();
    whole.scenes.s1 = { ...whole.scenes.s1!, vision: { on: true, light: "dark" } };
    assert.deepEqual(unsharedMounts(whole, "s1"), []);
    const lent = riding();
    lent.tokens.horse = { ...lent.tokens.horse!, partyVision: true };
    assert.deepEqual(unsharedMounts(lent, "s1"), [], "a mount sharing sight is always shown");
  });
});
