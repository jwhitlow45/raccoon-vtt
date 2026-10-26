import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { hexCenter, hexDistance, hexInScene, hexKey, sceneHexes, type HexGrid } from "#shared/rules/hex.ts";
import { clientOpSchema, MAX_LEGENDARY_USES, MAX_NAME, monsterInputSchema } from "#shared/protocol.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { monsterView } from "#shared/statBlock.ts";
import { snapPosition } from "../../lib/scene.ts";
import { DM, actor, apply, blockOf, character, companionBlock, customMonster, room, token } from "#shared/testutil.ts";
import {
  blankToken,
  characterToken,
  cornerFor,
  duplicateToken,
  hasLairValues,
  monsterToken,
  newCharacter,
  occupiedBoxes,
  spreadPositions,
} from "./factory.ts";

const MONSTERS = JSON.parse(readFileSync(new URL("../../../shared/srd/monsters.json", import.meta.url), "utf8")) as SrdMonster[];
const byId = (id: string) => MONSTERS.find((m) => m.srdId === id)!;

function valid(op: unknown): void {
  const parsed = clientOpSchema.safeParse(op);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
}

describe("monsters to tokens", () => {
  test("a goblin gets its stat block's numbers, average HP and a hostile ring", () => {
    const goblin = byId("goblin-warrior");
    const t = monsterToken(goblin, { hp: null, hidden: false, inLair: false }, { id: "t1", sceneId: "s1", at: { x: 2, y: 3 } });
    assert.equal(t.kind, "monster");
    assert.equal(t.name, "Goblin Warrior");
    assert.equal(t.size, "small");
    assert.equal(t.disposition, "hostile");
    assert.equal(t.visibility, "all");
    assert.equal(t.hpVisibility, "label");
    assert.deepEqual([t.x, t.y], [2, 3]);
    assert.ok("inline" in t.actor);
    const a = t.actor.inline;
    assert.deepEqual(a.hp, { cur: 10, max: 10, temp: 0 });
    assert.equal(a.ac, 15);
    assert.deepEqual(a.speeds, { walk: 30 });
    assert.equal(a.initBonus, 2);
    assert.equal(a.initScore, 12);
    assert.equal(a.passivePerception, 9);
    assert.equal(a.senses, "Darkvision 60 ft.");
    assert.equal(a.cr, "1/4");
    assert.equal(a.srdId, "goblin-warrior");
    assert.equal(a.legendary, undefined);
  });

  test("the room's own monster drops the same way, with no SRD id and its legendary uses from its entries", () => {
    const lurker = monsterView(
      customMonster("m1", {
        speed: "30 ft., Climb 30 ft., Fly 40 ft. (hover)",
        xpInLair: 700,
        traits: [{ name: "Legendary Resistance (2/Day, or 3/Day in Lair)", text: "It shrugs it off." }],
        legendaryActions: [{ name: "Legendary Action Uses: 2", text: "It acts between turns." }],
      }),
    );
    assert.equal(hasLairValues(lurker), true);
    const t = monsterToken(lurker, { hp: null, hidden: true, inLair: true }, { id: "t1", sceneId: "s1", at: { x: 4, y: 4 } });
    valid({ t: "token.create", token: t });
    assert.equal(t.name, "Cave Lurker");
    assert.equal(t.size, "large");
    assert.equal(t.visibility, "dm");
    assert.ok("inline" in t.actor);
    const a = t.actor.inline;
    assert.equal("srdId" in a, false);
    assert.deepEqual(a.hp, { cur: 22, max: 22, temp: 0 });
    assert.deepEqual(a.speeds, { walk: 30, climb: 30, fly: 40, hover: true });
    assert.equal(a.initScore, 12);
    assert.equal(a.creatureType, "Monstrosity");
    assert.equal(a.xp, 700);
    assert.deepEqual(a.legendary, { actionsMax: 2, actionsUsed: 0, resistMax: 3, resistUsed: 0 });
    assert.equal("monsterId" in a, false, "no link unless the caller names the monster");
  });

  test("a token placed from one of the room's monsters keeps its link, and an SRD one keeps its SRD id alone", () => {
    const lurker = monsterView(customMonster("m1"));
    const linked = monsterToken(lurker, { hp: null, hidden: false, inLair: false }, { id: "t1", sceneId: "s1", at: { x: 4, y: 4 }, monsterId: "m1" });
    valid({ t: "token.create", token: linked });
    assert.ok("inline" in linked.actor);
    assert.equal(linked.actor.inline.monsterId, "m1");
    const goblin = monsterToken(byId("goblin-warrior"), { hp: null, hidden: false, inLair: false }, { id: "t2", sceneId: "s1", at: { x: 1, y: 1 } });
    assert.ok("inline" in goblin.actor);
    assert.equal(goblin.actor.inline.srdId, "goblin-warrior");
    assert.equal("monsterId" in goblin.actor.inline, false);
  });

  test("a custom monster at every bound the editor allows still makes a valid token.create op", () => {
    const uses = "99999";
    for (const initiative of [-20, 40]) {
      for (const senses of ["S".repeat(500), `${"S".repeat(78)}${"\u{1F441}".repeat(60)}`]) {
        const block = blockOf(
          customMonster("m1", {
            name: "N".repeat(MAX_NAME),
            type: "T".repeat(120),
            senses,
            ac: 100,
            initiative,
            hp: { average: 100_000, formula: "" },
            speed: "999999 ft., Burrow 999999 ft., Climb 999999 ft., Fly 999999 ft. (hover), Swim 999999 ft.",
            passivePerception: 60,
            cr: "30",
            xp: 1_000_000,
            xpInLair: 1_000_000,
            traits: [{ name: `Legendary Resistance (${uses}/Day, or ${uses}/Day in Lair)`, text: "It shrugs it off." }],
            legendaryActions: [{ name: `Legendary Action Uses: ${uses} (${uses} in Lair)`, text: "It acts between turns." }],
          }),
        );
        const accepted = monsterInputSchema.safeParse({ id: "m1", ...block });
        assert.ok(accepted.success, accepted.success ? "" : accepted.error.message);
        for (const inLair of [false, true]) {
          const t = monsterToken(monsterView(block), { hp: null, hidden: false, inLair }, { id: "t1", sceneId: "s1", at: { x: 1, y: 1 } });
          valid({ t: "token.create", token: t });
          assert.ok("inline" in t.actor);
          assert.deepEqual(t.actor.inline.legendary, { actionsMax: MAX_LEGENDARY_USES, actionsUsed: 0, resistMax: MAX_LEGENDARY_USES, resistUsed: 0 });
          assert.equal(t.actor.inline.creatureType, `${"T".repeat(MAX_NAME - 1)}…`);
        }
      }
    }
  });

  test("typed HP, hidden, and lair numbers", () => {
    const dragon = byId("adult-red-dragon");
    assert.equal(hasLairValues(dragon), true);
    assert.equal(hasLairValues(byId("goblin-warrior")), false);
    const t = monsterToken(dragon, { hp: 300, hidden: true, inLair: true }, { id: "t1", sceneId: "s1", at: { x: 0, y: 0 } });
    assert.equal(t.visibility, "dm");
    assert.equal(t.size, "huge");
    assert.ok("inline" in t.actor);
    assert.deepEqual(t.actor.inline.hp, { cur: 300, max: 300, temp: 0 });
    assert.deepEqual(t.actor.inline.legendary, { actionsMax: 4, actionsUsed: 0, resistMax: 4, resistUsed: 0 });
    assert.equal(t.actor.inline.xp, 20_000);
    assert.deepEqual(t.actor.inline.speeds, { walk: 40, climb: 40, fly: 80 });
    const out = monsterToken(dragon, { hp: 0, hidden: false, inLair: false }, { id: "t2", sceneId: "s1", at: { x: 0, y: 0 } });
    assert.ok("inline" in out.actor);
    assert.equal(out.actor.inline.hp.max, 1, "a typed 0 still makes a live creature");
    assert.deepEqual(out.actor.inline.legendary, { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 });
  });

  test("every one of the 330 stat blocks makes a valid token.create op", () => {
    assert.equal(MONSTERS.length, 330);
    for (const m of MONSTERS) {
      for (const inLair of [false, true]) {
        const t = monsterToken(m, { hp: null, hidden: false, inLair }, { id: "t1", sceneId: "s1", at: { x: 1, y: 1 } });
        valid({ t: "token.create", token: t });
      }
    }
  });

  test("dropped monsters number themselves through the reducer", () => {
    let state = room();
    const goblin = byId("goblin-warrior");
    for (const id of ["a", "b", "c"]) {
      state = apply(state, { t: "token.create", token: monsterToken(goblin, { hp: null, hidden: false, inLair: false }, { id, sceneId: "s1", at: { x: 1, y: 1 } }) }, DM);
    }
    assert.deepEqual(["a", "b", "c"].map((id) => state.tokens[id]!.number), [1, 2, 3]);
  });
});

describe("other token sources", () => {
  test("a blank token per kind", () => {
    for (const kind of ["pc", "npc", "monster", "object"] as const) {
      const t = blankToken({ id: "t1", sceneId: "s1", kind, at: { x: 1, y: 2 } });
      valid({ t: "token.create", token: t });
      assert.equal(t.kind, kind);
    }
    assert.equal(blankToken({ id: "t1", sceneId: "s1", kind: "object", at: { x: 0, y: 0 } }).hpVisibility, "hidden");
  });

  test("a character's token points at the character and carries its image", () => {
    const c = character("hero", { name: "Thorn", size: "small", defaultImage: { assetId: "img", crop: { cx: 0.5, cy: 0.4, zoom: 1.2 } } });
    const t = characterToken(c, { id: "t1", sceneId: "s1", at: { x: 4, y: 4 } });
    valid({ t: "token.create", token: t });
    assert.deepEqual(t.actor, { ref: "hero" });
    assert.equal(t.kind, "pc");
    assert.equal(t.size, "small");
    assert.deepEqual(t.image, c.defaultImage);
    assert.equal(t.disposition, "ally");
  });

  test("a new character is a valid op with full HP", () => {
    const c = newCharacter({ id: "c1", name: "Vex", ownerIds: ["p1"], size: "small", hpMax: 21, ac: 14, walk: 25, initBonus: 3, passivePerception: 13 });
    valid({ t: "character.create", character: c });
    assert.deepEqual(c.actor.hp, { cur: 21, max: 21, temp: 0 });
    assert.deepEqual(c.actor.speeds, { walk: 25 });
  });

  test("a duplicate is a fresh copy with no view-only fields, numbered by the reducer", () => {
    let state = room();
    const wounded: Token & { aboveFog?: boolean } = token("g1", {
      name: "Goblin",
      image: { assetId: "img", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      rangeRings: [30, 120],
      fogExemptAuto: true,
      actor: {
        inline: actor({
          hp: { cur: 2, max: 7, temp: 3 },
          life: "dying",
          effects: [{ id: "e1", key: "poisoned" }],
          deathSaves: { ok: 1, fail: 2 },
          legendary: { actionsMax: 3, actionsUsed: 2, resistMax: 1, resistUsed: 1 },
        }),
      },
    });
    wounded.aboveFog = true;
    state.tokens.g1 = wounded;
    const copy = duplicateToken(wounded, { id: "g2", at: { x: 4, y: 3 }, chunks: state.buildChunks });
    valid({ t: "token.create", token: copy });
    assert.ok("inline" in copy.actor);
    assert.deepEqual(copy.actor.inline.hp, { cur: 7, max: 7, temp: 0 });
    assert.equal(copy.actor.inline.life, "alive");
    assert.deepEqual(copy.actor.inline.effects, []);
    assert.deepEqual(copy.actor.inline.deathSaves, { ok: 0, fail: 0 });
    assert.deepEqual(copy.actor.inline.legendary, { actionsMax: 3, actionsUsed: 0, resistMax: 1, resistUsed: 0 });
    state = apply(state, { t: "token.create", token: copy });
    assert.equal(state.tokens.g1!.number, 1);
    assert.equal(state.tokens.g2!.number, 2);
    assert.equal(state.tokens.g2!.fogExemptAuto, false);
    assert.deepEqual(state.tokens.g2!.rangeRings, [30, 120]);
  });

  test("a duplicate starts with no spent uses, damage types, turn record or unshaped numbers, so the op the bar sends is one the server takes (docs/design-v1-combat-controls.md 2.4)", () => {
    const dragon = token("dragon", {
      actor: {
        inline: actor({
          hp: { cur: 120, max: 256, temp: 0 },
          legendary: { actionsMax: 3, actionsUsed: 1, resistMax: 3, resistUsed: 1 },
          uses: { "actions:fire-breath": { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 }, "legendaryActions:fiery-rays": { kind: "turn", name: "Fiery Rays", used: 1, max: 1 } },
          hurt: ["fire"],
          turnRecord: { id: 40, entryId: "e1", round: 2, hp: 130, life: "alive", took: ["cold"], due: ["actions:fire-breath"], settled: { "recharge:actions:fire-breath": { state: "done", total: 2, outcome: "used" } } },
          unshaped: { ac: 12, speeds: { walk: 30 } },
        }),
      },
    });
    const copy = duplicateToken(dragon, { id: "dragon2", at: { x: 4, y: 3 }, chunks: {} });
    valid({ t: "token.create", token: copy });
    assert.ok("inline" in copy.actor);
    for (const field of ["uses", "hurt", "turnRecord", "unshaped"]) assert.equal(field in copy.actor.inline, false, field);
    assert.deepEqual(copy.actor.inline.legendary, { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 });
  });

  test("a carried token's duplicate comes without its link, and the op the bar sends is one the server takes (docs/design-v1-attach.md 5.2)", () => {
    const torch = token("torch", { kind: "object", size: "tiny", attached: { to: "thorn", kind: "carry" } });
    const copy = duplicateToken(torch, { id: "torch2", at: { x: 4, y: 3 }, chunks: {} });
    assert.equal("attached" in copy, false);
    assert.ok(clientOpSchema.safeParse({ t: "token.create", token: copy }).success);
  });

  test("a PC's duplicate shares the character", () => {
    const pc = token("pc", { kind: "pc", actor: { ref: "hero" } });
    assert.deepEqual(duplicateToken(pc, { id: "pc2", at: { x: 0, y: 0 }, chunks: {} }).actor, { ref: "hero" });
  });

  test("a companion's duplicate takes its link alone, its Reaction unspent and no number, and the reducer gives it the character's owners (docs/design-v1-combat-flow.md 4.3)", () => {
    const state = room({ characters: { hero: character("hero", { ownerIds: ["p1"] }) } });
    state.tokens.ws = token("ws", { kind: "npc", name: "Wildfire Spirit", ownerIds: ["p1"], companion: { of: "hero", turn: "shared", reactionUsed: true } });
    const copy = duplicateToken(state.tokens.ws, { id: "ws2", at: { x: 4, y: 3 }, chunks: {} });
    assert.deepEqual(copy.companion, { of: "hero", turn: "shared" });
    assert.ok(clientOpSchema.safeParse({ t: "token.create", token: copy }).success, "the strict schema takes it");
    const made = apply(state, { t: "token.create", token: copy }, DM).tokens.ws2!;
    assert.deepEqual(made.companion, { of: "hero", turn: "shared" });
    assert.deepEqual(made.ownerIds, ["p1"]);
    assert.equal(made.number, undefined);
  });

  test("a companion's duplicate keeps its block link, and drops one to a block deleted since, which a new link may not name (docs/design-v1-companion-stat-blocks.md 3.2)", () => {
    const state = room({ characters: { hero: character("hero", { ownerIds: ["p1"] }) } });
    state.companionBlocks.moth = companionBlock("moth", "hero");
    const linked = (blockId: string) => token("ws", { kind: "npc", ownerIds: ["p1"], companion: { of: "hero", turn: "shared" }, actor: { inline: actor({ blockId }) } });
    const kept = duplicateToken(linked("moth"), { id: "ws2", at: { x: 4, y: 3 }, chunks: {}, blocks: state.companionBlocks });
    assert.equal("inline" in kept.actor && kept.actor.inline.blockId, "moth");
    const made = apply({ ...state, tokens: { ws: linked("moth") } }, { t: "token.create", token: kept }, DM).tokens.ws2!;
    assert.equal("inline" in made.actor && made.actor.inline.blockId, "moth");
    const dropped = duplicateToken(linked("gone"), { id: "ws3", at: { x: 4, y: 3 }, chunks: {}, blocks: state.companionBlocks });
    assert.equal("inline" in dropped.actor && "blockId" in dropped.actor.inline, false);
    apply({ ...state, tokens: { ws: linked("gone") } }, { t: "token.create", token: dropped }, DM);
  });

  test("a duplicate lands where it goes as its original would if dropped there", () => {
    // A 10 ft platform over (4, 3) and (5, 3), the floor around it at 0.
    const { buildChunks: chunks } = apply(room(), { t: "build.height", sceneId: "s1", cells: ["4,3", "5,3"], height: 10 });
    const onFloor = token("g1");
    assert.equal(duplicateToken(onFloor, { id: "g2", at: { x: 4, y: 3 }, chunks }).elevation, 10, "from the floor onto the platform");
    assert.equal(duplicateToken(onFloor, { id: "g3", at: { x: 2, y: 3 }, chunks }).elevation, 0, "from the floor onto the floor");
    const onPlatform = token("g4", { x: 4, elevation: 10 });
    assert.equal(duplicateToken(onPlatform, { id: "g5", at: { x: 5, y: 3 }, chunks }).elevation, 10, "across the platform");
    assert.equal(duplicateToken(onPlatform, { id: "g6", at: { x: 6, y: 3 }, chunks }).elevation, 0, "off the platform onto the floor");
    const flier = token("bat", { elevation: 25 });
    assert.equal(duplicateToken(flier, { id: "bat2", at: { x: 5, y: 3 }, chunks }).elevation, 25, "a flier keeps its height");
    const lowFlier = token("owl", { x: 2, elevation: 5 });
    assert.equal(duplicateToken(lowFlier, { id: "owl2", at: { x: 4, y: 3 }, chunks }).elevation, 10, "a low flier rises to the platform");
    const burrower = token("mole", { x: 2, elevation: -10 });
    assert.equal(duplicateToken(burrower, { id: "mole2", at: { x: 4, y: 3 }, chunks }).elevation, -10, "a burrower keeps its depth");
  });
});

describe("placement", () => {
  test("a tap centers the footprint and snaps like a drag", () => {
    assert.deepEqual(cornerFor({ x: 5.4, y: 5.6 }, { w: 1, h: 1 }), { x: 5, y: 5 });
    assert.deepEqual(cornerFor({ x: 5.4, y: 5.6 }, { w: 2, h: 2 }), { x: 4, y: 5 });
    assert.deepEqual(cornerFor({ x: 5.4, y: 5.6 }, { w: 0.5, h: 0.5 }), { x: 5, y: 5.5 });
  });

  test("several creatures spread to the nearest free cells, never overlapping", () => {
    const occupied = occupiedBoxes([{ sceneId: "s1", x: 6, y: 5, size: "medium" }, { sceneId: "s2", x: 4, y: 5, size: "medium" }], "s1");
    const spots = spreadPositions({ grid: SQUARES, center: { x: 5.5, y: 5.5 }, footprint: { w: 1, h: 1 }, count: 4, bounds: { w: 30, h: 20 }, occupied });
    assert.equal(spots.length, 4);
    assert.deepEqual(spots[0], { x: 5, y: 5 });
    const keys = new Set(spots.map((p) => `${p.x},${p.y}`));
    assert.equal(keys.size, 4);
    assert.ok(!keys.has("6,5"));
    for (const p of spots) assert.ok(Math.max(Math.abs(p.x - 5), Math.abs(p.y - 5)) <= 1, `${p.x},${p.y} is next to the tap`);
  });

  test("large creatures do not overlap each other, and everything stays inside the scene", () => {
    const spots = spreadPositions({ grid: SQUARES, center: { x: 0.2, y: 0.2 }, footprint: { w: 2, h: 2 }, count: 3, bounds: { w: 10, h: 10 }, occupied: [] });
    for (const [i, a] of spots.entries()) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + 2 <= 10 && a.y + 2 <= 10);
      for (const b of spots.slice(i + 1)) assert.ok(Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2);
    }
  });

  test("a full scene stacks the rest on the tap rather than fail", () => {
    const spots = spreadPositions({ grid: SQUARES, center: { x: 0.5, y: 0.5 }, footprint: { w: 1, h: 1 }, count: 3, bounds: { w: 1, h: 1 }, occupied: [] });
    assert.deepEqual(spots, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
  });
});

describe("placement on a hex scene (docs/design-v1-hex-grids.md 4.2)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    const hexesOf = (p: { x: number; y: number }, side: number) => occupiedHexes(g, { size: "custom", w: side, h: side, ...p });

    test(`${orient}: four goblins spread round the tapped hex, each on its anchor, none on a hex already taken`, () => {
      const taken = placedOnHex(g, { size: "medium", x: 0, y: 0 }, { col: 6, row: 5 });
      const occupied = occupiedBoxes([{ sceneId: "s1", size: "medium", ...taken }], "s1");
      const tap = hexCenter(g, { col: 5, row: 5 });
      const spots = spreadPositions({ grid: g, center: { x: tap.x + 0.2, y: tap.y - 0.1 }, footprint: { w: 1, h: 1 }, count: 4, bounds: { w: 30, h: 20 }, occupied });
      assert.equal(spots.length, 4);
      assert.deepEqual(tokenRefHex(g, { size: "medium", ...spots[0]! }), { col: 5, row: 5 }, "the first on the tapped hex");
      const seen = new Set([hexKey({ col: 6, row: 5 })]);
      for (const p of spots) {
        assert.deepEqual(snapPosition(g, p.x, p.y, { w: 1, h: 1 }), p, `${p.x},${p.y} stands on its anchor, as a drop snaps`);
        const [h] = hexesOf(p, 1);
        assert.ok(hexDistance(g, h!, { col: 5, row: 5 }) <= 1, `${h!.col},${h!.row} is next to the tap`);
        assert.ok(!seen.has(hexKey(h!)), `${h!.col},${h!.row} is free`);
        seen.add(hexKey(h!));
      }
    });

    test(`${orient}: Large ogres tapped at the corner stay inside the scene, as the server judges it, and never share a hex`, () => {
      const spots = spreadPositions({ grid: g, center: { x: 0.2, y: 0.2 }, footprint: { w: 2, h: 2 }, count: 3, bounds: { w: 10, h: 10 }, occupied: [] });
      const state = room();
      state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 10, h: 10 }, gridShape: orient === "rows" ? "hexRows" : "hexColumns" };
      const seen = new Set<string>();
      for (const [i, p] of spots.entries()) {
        const hexes = hexesOf(p, 2);
        assert.equal(hexes.length, 3);
        for (const h of hexes) {
          assert.ok(hexInScene(g, { w: 10, h: 10 }, h), `${h.col},${h.row} inside`);
          assert.ok(!seen.has(hexKey(h)), `${h.col},${h.row} held once`);
          seen.add(hexKey(h));
        }
        const op = { t: "token.create" as const, token: blankToken({ id: `ogre${i}`, sceneId: "s1", kind: "npc", at: p }) };
        const ogre = { ...op, token: { ...op.token, size: "large" as const } };
        assert.ok(canApply(ogre, DM, state, { canUseAsset: () => true }).ok);
      }
    });

    test(`${orient}: a scene with room for one stacks the rest on its spot rather than fail`, () => {
      const spots = spreadPositions({ grid: g, center: { x: 0.6, y: 0.6 }, footprint: { w: 1, h: 1 }, count: 3, bounds: { w: 1.2, h: 1.2 }, occupied: [] });
      assert.equal(spots.length, 3);
      assert.deepEqual(spots[1], spots[0]);
      assert.deepEqual(spots[2], spots[0]);
      assert.ok(hexInScene(g, { w: 1.2, h: 1.2 }, hexesOf(spots[0]!, 1)[0]!));
      // A full scene stacks the rest on a spot whose hexes all lie inside it, the server's test (HX3-ASTRA-02).
      const full = { w: 6, h: 6 };
      const occupied = occupiedBoxes(sceneHexes(g, full).map((h) => ({ sceneId: "s1", size: "medium" as const, ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, h) })), "s1");
      for (const tap of [{ x: 6, y: 6 }, { x: 0, y: 0 }, { x: 6, y: 0 }, { x: 3, y: 6 }]) {
        const [stacked] = spreadPositions({ grid: g, center: tap, footprint: { w: 1, h: 1 }, count: 1, bounds: full, occupied });
        assert.ok(hexesOf(stacked!, 1).every((h) => hexInScene(g, full, h)), `${tap.x},${tap.y}: ${JSON.stringify(stacked)} inside`);
      }
      // A tap well off the scene stacks on its nearest spot inside.
      const off = spreadPositions({ grid: g, center: { x: -4, y: -4 }, footprint: { w: 1, h: 1 }, count: 2, bounds: { w: 1.2, h: 1.2 }, occupied: [] });
      assert.deepEqual(off, [spots[0], spots[0]]);
    });
  }
});
