import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodeHeights } from "#shared/rules/heights.ts";
import { actor, character, room, token } from "#shared/testutil.ts";
import { CARRIED_LIGHTS, clampFeet, isCustom, isPreset, lightText, PLACED_LIGHTS, presetOf } from "./presets.ts";
import { parseSenses, sensesLines, sensesShort } from "./senses.ts";
import { noSightText, partyReport } from "./sources.ts";

describe("senses", () => {
  test("reads darkvision, blindsight and truesight in feet, the largest of each, capped at 150", () => {
    assert.deepEqual(parseSenses("Darkvision 60 ft., Passive Perception 12"), { darkvision: 60, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses("Blindsight 10 ft. (blind beyond this radius), darkvision 120 ft"), { darkvision: 120, blindsight: 10, truesight: 0 });
    assert.deepEqual(parseSenses("truesight: 300 ft"), { darkvision: 0, blindsight: 0, truesight: 150 });
    assert.deepEqual(parseSenses("darkvision 30 ft, Darkvision 60 ft"), { darkvision: 60, blindsight: 0, truesight: 0 });
    // Tremorsense is not sight.
    assert.deepEqual(parseSenses("Tremorsense 60 ft."), { darkvision: 0, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses(undefined), { darkvision: 0, blindsight: 0, truesight: 0 });
  });

  test("words them for the token panel, as the design does", () => {
    assert.deepEqual(sensesLines(parseSenses("Darkvision 60 ft."), 5), ["Sees in the dark to 60 ft"]);
    assert.deepEqual(sensesLines(parseSenses(""), 5), ["Sees only where there is light"]);
    assert.equal(sensesLines(parseSenses("truesight 120 ft, blindsight 10 ft"), 5).length, 2);
    assert.equal(sensesShort(parseSenses("Darkvision 60 ft, blindsight 10 ft"), 5), "darkvision 60 ft, blindsight 10 ft");
    assert.equal(sensesShort(parseSenses(""), 5), "needs light");
  });
});

describe("light presets", () => {
  test("the SRD's sources, a torch and the Light cantrip alike", () => {
    assert.deepEqual(
      CARRIED_LIGHTS.map((p) => `${p.name} ${p.bright}/${p.dim}`),
      ["Candle 5/5", "Torch 20/20", "Lamp 15/30", "Hooded Lantern 30/30", "Light 20/20"],
    );
    assert.equal(PLACED_LIGHTS.at(-1)?.name, "Daylight");
    const torch = { bright: 20, dim: 20 };
    assert.deepEqual(CARRIED_LIGHTS.filter((p) => isPreset(torch, p)).map((p) => p.name), ["Torch", "Light"]);
    assert.equal(isCustom(torch, CARRIED_LIGHTS), false);
    assert.equal(isCustom({ bright: 10, dim: 5 }, CARRIED_LIGHTS), true);
    assert.equal(isCustom(undefined, CARRIED_LIGHTS), false);
  });

  test("one preset shows as chosen: the one named, when it has the radii, else the first that has them", () => {
    const twenty = { bright: 20, dim: 20 };
    // A placed light keeps its preset's name, so a Light cantrip lights only Light, not Torch too.
    assert.equal(presetOf(twenty, PLACED_LIGHTS, "Light")?.name, "Light");
    assert.equal(presetOf(twenty, PLACED_LIGHTS, "Torch")?.name, "Torch");
    // A name the DM gave it, or none (a token's light), falls back to the first with those radii.
    assert.equal(presetOf(twenty, PLACED_LIGHTS, "Brazier")?.name, "Torch");
    assert.equal(presetOf(twenty, CARRIED_LIGHTS, null)?.name, "Torch");
    // A name whose preset has other radii does not win: the radii were changed since.
    assert.equal(presetOf({ bright: 15, dim: 30 }, PLACED_LIGHTS, "Light")?.name, "Lamp");
    assert.equal(presetOf({ bright: 25, dim: 20 }, PLACED_LIGHTS, "Torch"), null);
    assert.equal(presetOf(undefined, PLACED_LIGHTS, "Torch"), null);
    // Exactly one of the list is lit for any light.
    for (const light of [twenty, { bright: 60, dim: 60 }, { bright: 5, dim: 5 }]) {
      for (const name of [null, "Torch", "Light", "Daylight"]) {
        const chosen = presetOf(light, PLACED_LIGHTS, name);
        assert.equal(PLACED_LIGHTS.filter((p) => p.name === chosen?.name).length, 1);
      }
    }
  });

  test("radii typed by hand stop at 120 ft, and read as the rings draw them", () => {
    assert.equal(clampFeet(500), 120);
    assert.equal(clampFeet(-5), 0);
    assert.equal(clampFeet(12.6), 13);
    assert.equal(clampFeet(Number.NaN), 0);
    assert.equal(lightText({ bright: 15, dim: 30 }), "15 ft bright, dim to 45 ft");
    assert.equal(lightText({ bright: 20, dim: 0 }), "20 ft bright");
    assert.equal(lightText({ bright: 0, dim: 10 }), "dim to 10 ft");
    assert.equal(lightText(undefined), "No light");
  });
});

describe("who lends the party sight", () => {
  test("party members are the players' creatures and the ones the DM marked, sources first", () => {
    const state = room({
      characters: { c1: character("c1", { actor: actor({ senses: "Darkvision 60 ft." }) }) },
      tokens: {
        pc: token("pc", { kind: "pc", actor: { ref: "c1" } }),
        owl: token("owl", { kind: "npc", ownerIds: ["p1"], light: { bright: 20, dim: 20 } }),
        ally: token("ally", { kind: "npc", partyVision: true }),
        goblin: token("goblin"),
        elsewhere: token("elsewhere", { sceneId: "s2", partyVision: true }),
      },
    });
    const { rows, overCap } = partyReport(state, "s1");
    assert.deepEqual(
      rows.map((r) => r.token.id),
      ["pc", "owl", "ally"],
    );
    assert.equal(overCap, 0);
    assert.ok(rows.every((r) => r.lends));
    assert.equal(rows[0]!.senses.darkvision, 60);
    assert.deepEqual(rows[1]!.light, { bright: 20, dim: 20 });
  });

  test("hidden, objects, the fallen and creatures inside the ground lend none, and say why", () => {
    const below = new Array(256).fill(0);
    below[3 * 16 + 3] = 10;
    const state = room({
      buildChunks: { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(below)! } },
      tokens: {
        a: token("a", { ownerIds: ["p1"], visibility: "dm" }),
        b: token("b", { ownerIds: ["p1"], kind: "object", x: 6 }),
        c: token("c", { ownerIds: ["p1"], x: 7, actor: { inline: actor({ life: "dying" }) } }),
        d: token("d", { ownerIds: ["p1"], x: 8, actor: { inline: actor({ effects: [{ id: "e", key: "unconscious" }] }) } }),
        e: token("e", { ownerIds: ["p1"], x: 3, y: 3, elevation: 0 }),
        f: token("f", { ownerIds: ["p1"], x: 9, kind: "object", partyVision: true }),
        g: token("g", { ownerIds: ["p1"], x: 10, actor: { inline: actor({ effects: [{ id: "e", key: "blinded" }] }) } }),
      },
    });
    const byId = new Map(partyReport(state, "s1").rows.map((r) => [r.token.id, r]));
    assert.equal(byId.get("a")?.reason, "hidden");
    assert.equal(byId.get("b")?.reason, "object");
    assert.equal(byId.get("c")?.reason, "down");
    assert.equal(byId.get("d")?.reason, "down");
    assert.equal(byId.get("e")?.reason, "ground");
    assert.equal(byId.get("e")?.belowFt, 10);
    assert.equal(noSightText(byId.get("e")!), "Inside the ground (10 ft below): lends no sight");
    // An object the DM marked lends sight, and a blinded creature still does by blindsight.
    assert.equal(byId.get("f")?.lends, true);
    assert.equal(byId.get("g")?.lends, true);
    assert.equal(byId.get("g")?.blinded, true);
  });

  test("past twelve sources the rest are shown and lend nothing, player characters first", () => {
    const tokens: Record<string, ReturnType<typeof token>> = {};
    for (let i = 0; i < 14; i++) {
      const id = `t${String(i).padStart(2, "0")}`;
      tokens[id] = token(id, i < 2 ? { partyVision: true } : { ownerIds: ["p1"], kind: i < 6 ? "pc" : "npc" });
    }
    const { rows, overCap } = partyReport(room({ tokens }), "s1");
    assert.equal(overCap, 2);
    // The two the DM marked come last in the order, so they are the ones left out.
    assert.deepEqual(
      rows.filter((r) => r.reason === "cap").map((r) => r.token.id),
      ["t00", "t01"],
    );
    assert.equal(rows.filter((r) => r.lends).length, 12);
    assert.match(noSightText({ reason: "cap" }), /^Past the 12 creatures/);
  });

  test("a creature whose eye cannot step off a wall lends none, a reason only the server's rules know", () => {
    // Eight walls through one point, one along each line the sight step's directions lie on, so every direction slides along one.
    const lines: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1], [1, 2], [2, 1], [1, -2], [2, -1]];
    const walls = lines.map(([a, b], i) => ({ id: `w${String(i).padStart(11, "0")}`, a: [10 - a, 10 - b] as [number, number], b: [10 + a, 10 + b] as [number, number], f: { kind: "wall" as const } }));
    const state = room({
      buildChunks: { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, walls } },
      tokens: {
        // A Large creature at (9, 9) has its eye on the point every wall passes through.
        stuck: token("stuck", { kind: "pc", ownerIds: ["p1"], size: "large", x: 9, y: 9 }),
        free: token("free", { kind: "pc", ownerIds: ["p1"], x: 2, y: 2 }),
      },
    });
    const byId = new Map(partyReport(state, "s1").rows.map((r) => [r.token.id, r]));
    assert.equal(byId.get("stuck")?.lends, false);
    assert.equal(byId.get("stuck")?.reason, "wall");
    assert.equal(noSightText(byId.get("stuck")!), "Standing on a wall it cannot step off: lends no sight");
    assert.equal(byId.get("free")?.lends, true);
  });
});
