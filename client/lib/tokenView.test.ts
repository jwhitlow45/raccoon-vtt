import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { projectState } from "#shared/project.ts";
import type { Actor } from "#shared/model.ts";
import { P1, actor, character, room, token } from "#shared/testutil.ts";
import { theme } from "./theme.ts";
import { badgeLeft, chipRow, DISPOSITION_RING, effectChip, effectCount, healthState, hpDisplay, hpText, initials } from "./tokenView.ts";

/**
 * A player's projection sends `hpLabel` or `hpBar` in place of numbers
 * (design 7.3), and no `hpVisibility` at all, so the readout has to work
 * from what arrived.
 */
describe("HP readout from a player's projection", () => {
  function playerView(hpVisibility: "hidden" | "label" | "bar" | "exact", hp = { cur: 3, max: 7, temp: 0 }) {
    const state = room();
    state.tokens.g = token("g", { hpVisibility, actor: { inline: actor({ hp }) } });
    const view = projectState(state, P1, { sceneId: null });
    const t = view.tokens.g!;
    assert.equal(t.hpVisibility, undefined, "players never receive the setting itself");
    return { actor: (t.actor as { inline: Partial<Actor> }).inline, hpVisibility: t.hpVisibility };
  }

  test("label: the server's label shows, Bloodied included", () => {
    const p = playerView("label");
    assert.deepEqual(hpDisplay({ ...p, fullAccess: false }), { kind: "label", label: "Bloodied" });
  });

  test("bar: the server's rounded fraction shows, with no numbers", () => {
    const p = playerView("bar", { cur: 5, max: 20, temp: 0 });
    assert.deepEqual(hpDisplay({ ...p, fullAccess: false }), { kind: "bar", fraction: 0.25 });
  });

  test("exact: the numbers show", () => {
    const p = playerView("exact", { cur: 5, max: 20, temp: 2 });
    assert.deepEqual(hpDisplay({ ...p, fullAccess: false }), { kind: "bar", fraction: 0.25, text: "5/20 +2" });
  });

  test("hidden: nothing", () => {
    const p = playerView("hidden");
    assert.deepEqual(hpDisplay({ ...p, fullAccess: false }), { kind: "none" });
  });

  test("another player's PC follows the party setting", () => {
    const state = room();
    state.characters.hero = character("hero", { ownerIds: ["p2"], actor: actor({ hp: { cur: 4, max: 20, temp: 0 } }) });
    state.meta.settings.pcHpVisibleToParty = false;
    const view = projectState(state, P1, { sceneId: null });
    const a = view.characters.hero!.actor;
    assert.deepEqual(hpDisplay({ actor: a, hpVisibility: undefined, fullAccess: false }), { kind: "label", label: "Bloodied" });
  });

  test("a character's token owned without the character shows the character's HP as the party's rule sends it", () => {
    const state = room();
    state.characters.hero = character("hero", { ownerIds: ["p2"], actor: actor({ hp: { cur: 4, max: 20, temp: 0 } }) });
    state.tokens.t = token("t", { kind: "pc", ownerIds: ["p1"], hpVisibility: "exact", actor: { ref: "hero" } });
    for (const party of [false, true]) {
      state.meta.settings.pcHpVisibleToParty = party;
      const view = projectState(state, P1, { sceneId: null });
      const t = view.tokens.t!;
      const shown = hpDisplay({ actor: view.characters.hero!.actor, hpVisibility: t.hpVisibility, fullAccess: true });
      assert.deepEqual(shown, party ? { kind: "bar", fraction: 0.2, text: "4/20" } : { kind: "label", label: "Bloodied" });
    }
  });

  test("one line of text for lists", () => {
    assert.equal(hpText({ kind: "none" }), null);
    assert.equal(hpText({ kind: "label", label: "Dying" }), "Dying");
    assert.equal(hpText({ kind: "bar", fraction: 0.5 }), "about 50%");
    assert.equal(hpText({ kind: "bar", fraction: 0.5, text: "5/10" }), "5/10");
  });
});

describe("what a viewer may know of a creature's state, for label priority and the Bloodied mark", () => {
  function playerView(hpVisibility: "hidden" | "label" | "bar" | "exact", hp = { cur: 3, max: 7, temp: 0 }, life: Actor["life"] = "alive") {
    const state = room();
    state.tokens.g = token("g", { hpVisibility, actor: { inline: actor({ hp, life }) } });
    const view = projectState(state, P1, { sceneId: null });
    const t = view.tokens.g!;
    return { actor: (t.actor as { inline: Partial<Actor> }).inline, hpVisibility: t.hpVisibility, fullAccess: false };
  }

  test("a player never learns a hidden creature is Bloodied", () => {
    assert.equal(healthState(playerView("hidden")), null);
    assert.equal(healthState(playerView("hidden", { cur: 1, max: 7, temp: 0 })), null);
    // Dying is public anyway: the server sends every viewer the life state, and the body is tinted for it.
    assert.equal(healthState(playerView("hidden", { cur: 0, max: 7, temp: 0 }, "dying")), "Dying");
  });

  test("a player who sees the word, the bar or the numbers knows", () => {
    assert.equal(healthState(playerView("label")), "Bloodied");
    assert.equal(healthState(playerView("bar", { cur: 5, max: 20, temp: 0 })), "Bloodied");
    assert.equal(healthState(playerView("bar", { cur: 15, max: 20, temp: 0 })), "Healthy");
    assert.equal(healthState(playerView("exact", { cur: 4, max: 7, temp: 0 })), "Healthy");
    assert.equal(healthState(playerView("exact", { cur: 3, max: 7, temp: 0 })), "Bloodied");
  });

  test("a bar viewer's state comes from the rounded bar they get, so at half it can differ from the rules", () => {
    // 11 of 21 is not Bloodied by the rules (11 > 10), but its bar rounds to 10/20, half, which reads as Bloodied.
    assert.equal(healthState(playerView("exact", { cur: 11, max: 21, temp: 0 })), "Healthy");
    assert.equal(healthState(playerView("bar", { cur: 11, max: 21, temp: 0 })), "Bloodied");
    // 12 of 21 rounds to 11/20, more than half: Healthy for both.
    assert.equal(healthState(playerView("bar", { cur: 12, max: 21, temp: 0 })), "Healthy");
  });

  test("the DM's numbers count, though the label shows numbers and not the word", () => {
    const dm = { actor: actor({ hp: { cur: 3, max: 9, temp: 0 } }), hpVisibility: "label" as const, fullAccess: true };
    assert.equal(hpDisplay(dm).kind, "bar");
    assert.equal(healthState(dm), "Bloodied");
    assert.equal(healthState({ ...dm, actor: actor({ hp: { cur: 0, max: 9, temp: 0 }, life: "dying" }) }), "Dying");
  });

  test("missing HP is no state at all", () => {
    assert.equal(healthState({ actor: undefined, hpVisibility: undefined, fullAccess: false }), null);
    assert.equal(healthState({ actor: { life: "alive" }, hpVisibility: undefined, fullAccess: true }), null);
  });
});

describe("telling numbered monsters apart", () => {
  test("initials keep the number, as the tracker shows it", () => {
    assert.equal(initials("Goblin Warrior 3"), "G3");
    assert.equal(initials("Goblin 12"), "G12");
    assert.equal(initials("Goblin Warrior"), "GW");
    assert.equal(initials("Thorn"), "Th");
    assert.equal(initials(""), "?");
  });
});

describe("the elevation badge and the chips", () => {
  test("the badge sits at the top right, and moves past the chips on a token too small for both", () => {
    assert.equal(badgeLeft(120, chipRow(120, 2, true).xs), 90);
    const small = chipRow(28, 2, true);
    assert.equal(small.xs.length, 2);
    assert.ok(badgeLeft(28, small.xs) >= small.xs[1]! + 18, "the badge starts after the last chip");
    assert.equal(badgeLeft(28, []), -2);
  });
});

describe("counters on status icons", () => {
  test("an exhaustion level and a counter on any other effect both show, and a counter can be 0", () => {
    assert.equal(effectCount({ key: "exhaustion", level: 3 }), 3);
    assert.equal(effectCount({ key: "exhaustion" }), null);
    assert.equal(effectCount({ key: "blessed", level: 4 }), 4);
    assert.equal(effectCount({ key: "custom", level: 0 }), 0);
    assert.equal(effectCount({ key: "poisoned" }), null);
  });

  test("the label names the count, and exhaustion keeps its own wording", () => {
    assert.equal(effectChip({ key: "exhaustion", level: 2 }).label, "Exhaustion 2");
    assert.equal(effectChip({ key: "blessed", level: 3 }).label, "Blessed (3)");
    assert.equal(effectChip({ key: "custom", label: "Charges", glyph: "Ch", level: 0 }).label, "Charges (0)");
    assert.equal(effectChip({ key: "concentrating", spell: "Bless", level: 9 }).label, "Concentrating: Bless (9)");
    assert.equal(effectChip({ key: "hasted" }).label, "Hasted");
  });
});

describe("the disposition ring", () => {
  test("one map colors a creature's ring, and no other client file spells out its own", () => {
    assert.deepEqual(DISPOSITION_RING, { ally: theme.color.ally, neutral: theme.color.neutral, hostile: theme.color.hostile });
    const client = fileURLToPath(new URL("..", import.meta.url));
    // The tracker's row pictures still hold a copy of their own, left for a later change to that file.
    const waiting = new Set([path.join("features", "encounter", "parts.tsx")]);
    const copies = readdirSync(client, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("node_modules") && file !== path.join("lib", "tokenView.ts") && !waiting.has(file))
      .filter((file) => /\bhostile:\s*theme\.color\.hostile\b/.test(readFileSync(path.join(client, file), "utf8")));
    assert.deepEqual(copies, [], "read DISPOSITION_RING from lib/tokenView.ts");
  });
});
