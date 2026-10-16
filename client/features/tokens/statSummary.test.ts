import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { statBlockOf } from "#shared/statBlock.ts";
import { P1, actor, character, customMonster, room, token } from "#shared/testutil.ts";
import { defenseLines, hpUnits, linkedBlockState, moreStatsShown, saveUnits, shortSplit, speedUnits, unitText, validSheetUrl, vitals, type VitalItem, type VitalUnit } from "./statSummary.ts";

/*
 * Arial's advance widths in ems, the face the canvas measures labels in
 * (canvas/measureText.ts), for the characters the vitals use. Node has no
 * canvas, and its flat fallback of 0.58 em a character overstates narrow
 * letters by a third. A unit's label is regular and its value at weight
 * 600, which runs about 6% wider.
 */
const ARIAL: Record<string, number> = {
  " ": 0.278, ",": 0.278, "/": 0.278, "+": 0.584, "(": 0.333, ")": 0.333, "%": 0.889, "↗": 1,
  ...Object.fromEntries([..."0123456789"].map((d) => [d, 0.556])),
  a: 0.556, b: 0.556, c: 0.5, d: 0.556, e: 0.556, f: 0.278, g: 0.556, h: 0.556, i: 0.222, k: 0.5, l: 0.222, m: 0.833, n: 0.556, o: 0.556, p: 0.556,
  r: 0.333, s: 0.5, t: 0.278, u: 0.556, v: 0.5, w: 0.722, y: 0.5, A: 0.667, C: 0.722, D: 0.722, H: 0.722, O: 0.778, P: 0.667, S: 0.667,
};
const ems = (text: string) => [...text].reduce((w, ch) => w + (ARIAL[ch] ?? 0.6), 0);
const unitWidth = (unit: VitalUnit) =>
  unit.kind === "text" ? (ems(unit.label ? `${unit.label} ` : "") + ems(`${unit.value}${unit.comma ? "," : ""}`) * 1.06) * 14 : ems(unitText(unit)) * 14 * 1.06;

const keys = (items: readonly VitalItem[]) => items.map((i) => i.key);
const words = (item: VitalItem | undefined) => item?.units.map(unitText) ?? [];
const inlineOf = (t: Token | { actor: unknown } | undefined) => (t?.actor as { inline?: Partial<Actor> } | undefined)?.inline;

describe("the vitals, by viewer", () => {
  test("the DM on a monster: AC, HP, speed and Passive Perception", () => {
    const a = actor({ ac: 15, hp: { cur: 10, max: 10, temp: 0 }, speeds: { walk: 30 }, passivePerception: 9 });
    const items = vitals({ actor: a, token: { kind: "monster", hpVisibility: "label" }, fullAccess: true, place: "bar" });
    assert.deepEqual(keys(items), ["ac", "hp", "speed", "passivePerception"]);
    assert.deepEqual(items.map(words), [["15"], ["HP 10/10"], ["Speed 30 ft"], ["Passive Perception 9"]]);
  });

  test("an owner on their character: the same, and in the panel the sheet link and no HP", () => {
    const state = room();
    state.characters.hero = character("hero", { ownerIds: ["p1"], actor: actor({ ac: 16, hp: { cur: 31, max: 38, temp: 5 }, passivePerception: 14, sheetUrl: "https://www.dndbeyond.com/characters/1" }) });
    state.tokens.t = token("t", { kind: "pc", actor: { ref: "hero" } });
    const view = projectState(state, P1, { sceneId: null });
    const a = view.characters.hero!.actor;
    const bar = vitals({ actor: a, token: { kind: "pc", hpVisibility: view.tokens.t!.hpVisibility }, fullAccess: true, place: "bar" });
    assert.deepEqual(keys(bar), ["ac", "hp", "speed", "passivePerception"]);
    assert.deepEqual(words(bar[1]), ["HP 31/38", "+5"]);
    const panel = vitals({ actor: a, token: { kind: "pc" }, fullAccess: true, place: "panel" });
    assert.deepEqual(keys(panel), ["ac", "speed", "passivePerception", "sheet"]);
  });

  test("a player who owns a character's token but not the character: its HP as the party's rule sends it, nothing else", () => {
    const state = room();
    state.characters.bree = character("bree", { ownerIds: ["p2"], actor: actor({ ac: 17, hp: { cur: 4, max: 20, temp: 0 }, passivePerception: 15 }) });
    state.tokens.t = token("t", { kind: "pc", ownerIds: ["p1"], hpVisibility: "exact", actor: { ref: "bree" } });
    for (const party of [true, false]) {
      state.meta.settings.pcHpVisibleToParty = party;
      const view = projectState(state, P1, { sceneId: null });
      const items = vitals({ actor: view.characters.bree!.actor, token: { kind: "pc", hpVisibility: view.tokens.t!.hpVisibility }, fullAccess: true, place: "bar" });
      assert.deepEqual(keys(items), ["hp"], `party HP ${party}`);
      assert.deepEqual(words(items[0]), party ? ["HP 4/20"] : ["Bloodied"]);
      assert.deepEqual(vitals({ actor: view.characters.bree!.actor, token: { kind: "pc" }, fullAccess: true, place: "panel" }), [], "no summary line in the panel");
    }
  });

  test("a player on another's monster: the HP the DM allows and nothing else, none when it shows nothing", () => {
    for (const [hpVisibility, expected] of [
      ["label", ["Bloodied"]],
      ["bar", ["HP about 30%"]],
      ["exact", ["HP 3/10"]],
      ["hidden", null],
    ] as const) {
      const state = room();
      state.tokens.g = token("g", { hpVisibility, actor: { inline: actor({ ac: 15, srdId: "goblin-warrior", hp: { cur: 3, max: 10, temp: 0 } }) } });
      const t = projectState(state, P1, { sceneId: null }).tokens.g!;
      const items = vitals({ actor: inlineOf(t), token: { kind: t.kind, hpVisibility: t.hpVisibility }, fullAccess: false, place: "bar" });
      assert.deepEqual(items.length === 0 ? null : items.map(words).flat(), expected, hpVisibility);
      assert.deepEqual(vitals({ actor: inlineOf(t), token: { kind: t.kind }, fullAccess: false, place: "panel" }), []);
    }
  });

  test("an object: its HP alone", () => {
    const items = vitals({ actor: actor({ ac: 15, hp: { cur: 8, max: 10, temp: 0 } }), token: { kind: "object", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    assert.deepEqual(keys(items), ["hp"]);
    assert.deepEqual(vitals({ actor: actor({ ac: 15 }), token: { kind: "object" }, fullAccess: true, place: "panel" }), []);
  });

  test("an HP-less token shows nothing of its HP or AC: max HP 0, an effect companion, and a creature companion turned into an effect, alive or dead", () => {
    const zero = actor({ ac: 0, hp: { cur: 0, max: 0, temp: 0 } });
    assert.deepEqual(keys(vitals({ actor: zero, token: { kind: "object" }, fullAccess: true, place: "bar" })), []);
    const effect = { kind: "object" as const, companion: { of: "c1", turn: "none" } };
    for (const life of ["alive", "dead"] as const) {
      const stored = actor({ ac: 13, life, hp: { cur: life === "dead" ? 0 : 15, max: 15, temp: 0 } });
      const items = vitals({ actor: stored, token: effect, fullAccess: true, place: "bar" });
      assert.deepEqual(keys(items), [], `${life}: no HP, life tag or AC`);
      // Turned back into a creature, all of it returns as stored.
      const back = vitals({ actor: stored, token: { kind: "npc", companion: { of: "c1", turn: "shared" } }, fullAccess: true, place: "bar" });
      assert.deepEqual(keys(back), life === "dead" ? ["hp", "speed", "passivePerception"] : ["ac", "hp", "speed", "passivePerception"]);
      if (life === "dead") assert.deepEqual(words(back[0]), ["HP 0/15", "Dead"]);
    }
    assert.deepEqual(keys(vitals({ actor: zero, token: { kind: "npc" }, fullAccess: true, place: "bar" })), ["speed", "passivePerception"], "a creature at 0 of 0 keeps its other numbers");
  });

  test("an actor missing each field in turn leaves only that item out", () => {
    const full = actor({ ac: 12, passivePerception: 11 });
    for (const [field, key] of [
      ["ac", "ac"],
      ["hp", "hp"],
      ["speeds", "speed"],
      ["passivePerception", "passivePerception"],
    ] as const) {
      const partial: Partial<Actor> = { ...full };
      delete partial[field];
      const got = keys(vitals({ actor: partial, token: { kind: "npc", hpVisibility: "exact" }, fullAccess: true, place: "bar" }));
      assert.deepEqual(got, ["ac", "hp", "speed", "passivePerception"].filter((k) => k !== key), field);
    }
    assert.deepEqual(vitals({ actor: undefined, token: { kind: "npc" }, fullAccess: true, place: "bar" }), []);
  });
});

describe("the vitals' units", () => {
  test("speed splits per mode, walk first, with the commas that join them", () => {
    assert.deepEqual(speedUnits({ walk: 30 }).map(unitText), ["Speed 30 ft"]);
    assert.deepEqual(speedUnits({ walk: 30, fly: 60, hover: true }).map(unitText), ["Speed 30 ft,", "fly 60 ft (hover)"]);
    assert.deepEqual(speedUnits({ walk: 0, fly: 30, hover: true }).map(unitText), ["Speed 0 ft,", "fly 30 ft (hover)"]);
    assert.deepEqual(speedUnits({ walk: 40, burrow: 30, fly: 80, swim: 40 }).map(unitText), ["Speed 40 ft,", "fly 80 ft,", "swim 40 ft,", "burrow 30 ft"]);
    const five = speedUnits({ walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: true }).map(unitText);
    assert.deepEqual(five, ["Speed 1000 ft,", "fly 1000 ft (hover),", "swim 1000 ft,", "climb 1000 ft,", "burrow 1000 ft"]);
  });

  test("HP and temporary HP are separate units from the tag", () => {
    const units = hpUnits({ actor: actor({ hp: { cur: 0, max: 30, temp: 5 }, life: "dying" }), hpVisibility: "exact", fullAccess: true });
    assert.deepEqual(units.map(unitText), ["HP 0/30", "+5", "Dying"]);
    assert.deepEqual(units.map((u) => u.kind), ["text", "text", "tag"]);
    const stable = hpUnits({ actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "stable" }), hpVisibility: "exact", fullAccess: true });
    assert.deepEqual(stable.at(-1), { kind: "tag", text: "Stable", tone: "warning" });
  });

  test("no unit is wider than about 140 px, the largest numbers included", () => {
    const big = actor({ ac: 100, hp: { cur: 100000, max: 100000, temp: 100000 }, speeds: { walk: 1000, fly: 1000, swim: 1000, climb: 1000, burrow: 1000, hover: true }, passivePerception: 60 });
    const items = vitals({ actor: big, token: { kind: "monster", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    for (const unit of items.flatMap((i) => i.units)) {
      const w = unitWidth(unit);
      // About 140: "Passive Perception 60" draws a fraction over it, and the narrowest box is 233 px.
      assert.ok(w <= 145, `"${unitText(unit)}" is ${Math.round(w)} px`);
    }
    assert.ok(unitWidth({ kind: "text", label: "HP", value: "100000/100000" }) >= 120, "the HP unit is about 130 px");
  });
});

describe("AC on the vitals line", () => {
  test("left out at 0 and on the dead, shown at 9, 99 and 100", () => {
    const ac = (a: Partial<Actor>) => vitals({ actor: a, token: { kind: "npc" }, fullAccess: true, place: "bar" }).find((i) => i.key === "ac")?.units[0];
    assert.equal(ac(actor({ ac: 0 })), undefined);
    assert.equal(ac(actor({ ac: 15, life: "dead", hp: { cur: 0, max: 10, temp: 0 } })), undefined);
    for (const n of [9, 99, 100]) assert.deepEqual(ac(actor({ ac: n })), { kind: "ac", ac: n });
  });
});

describe("a short bar's split", () => {
  test("AC and HP stay on the line, speed and Passive Perception go to More stats", () => {
    const items = vitals({ actor: actor({ ac: 15 }), token: { kind: "monster", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    const { line, more } = shortSplit(items);
    assert.deepEqual(keys(line), ["ac", "hp"]);
    assert.deepEqual(keys(more), ["speed", "passivePerception"]);
    assert.equal(moreStatsShown(more, { kind: "none" }), true);
  });

  test("no disclosure when all four are empty", () => {
    const items = vitals({ actor: { hp: { cur: 5, max: 5, temp: 0 }, life: "alive" }, token: { kind: "npc", hpVisibility: "exact" }, fullAccess: true, place: "bar" });
    const { more } = shortSplit(items);
    assert.deepEqual(more, []);
    assert.equal(moreStatsShown(more, { kind: "none" }), false);
    assert.equal(moreStatsShown(more, { kind: "loading" }), true, "saves on their way count");
  });
});

describe("saves and defenses", () => {
  test("from a room monster, in its own numbers", () => {
    const block = statBlockOf(customMonster("m1"));
    assert.deepEqual(saveUnits(block), ["Str +2", "Dex +2", "Con +1", "Int −4", "Wis +3", "Cha −2"]);
  });

  test("from an SRD monster, with the SRD's minus sign", async () => {
    const list = await loadMonsters();
    const state = linkedBlockState({ srdId: "goblin-warrior" }, {}, { list, failed: false });
    assert.equal(state.kind, "ready");
    assert.deepEqual(saveUnits(state.kind === "ready" ? state.block : statBlockOf(customMonster("x"))), ["Str −1", "Dex +2", "Con +0", "Int +0", "Wis −1", "Cha −1"]);
  });

  test("defense lines: none, each alone, and all three in the block's order", () => {
    const base = { vulnerabilities: "", resistances: "", immunities: "" };
    assert.deepEqual(defenseLines(base), []);
    assert.deepEqual(defenseLines({ ...base, vulnerabilities: "Fire" }), [{ label: "Vulnerabilities", text: "Fire" }]);
    assert.deepEqual(defenseLines({ ...base, resistances: "Cold" }), [{ label: "Resistances", text: "Cold" }]);
    assert.deepEqual(defenseLines({ ...base, immunities: "Poison; Charmed, Poisoned" }), [{ label: "Immunities", text: "Poison; Charmed, Poisoned" }]);
    assert.deepEqual(defenseLines({ immunities: "Poison", resistances: "Cold", vulnerabilities: "Fire" }).map((l) => l.label), ["Vulnerabilities", "Resistances", "Immunities"]);
  });
});

describe("the linked block's state", () => {
  const monsters = { m1: customMonster("m1") };
  const loaded = async () => ({ list: await loadMonsters(), failed: false });

  test("none, a room monster at once, and a deleted one as none", () => {
    assert.deepEqual(linkedBlockState({}, monsters, { list: null, failed: false }), { kind: "none" });
    assert.deepEqual(linkedBlockState(undefined, monsters, { list: null, failed: false }), { kind: "none" });
    const room = linkedBlockState({ monsterId: "m1" }, monsters, { list: null, failed: false });
    assert.equal(room.kind, "ready", "a room monster needs no chunk");
    assert.deepEqual(linkedBlockState({ monsterId: "gone" }, monsters, { list: null, failed: false }), { kind: "none" });
  });

  test("an SRD link: loading, failed, ready, and an id the chunk lacks as none", async () => {
    assert.deepEqual(linkedBlockState({ srdId: "goblin-warrior" }, {}, { list: null, failed: false }), { kind: "loading" });
    assert.deepEqual(linkedBlockState({ srdId: "goblin-warrior" }, {}, { list: null, failed: true }), { kind: "failed" });
    assert.equal(linkedBlockState({ srdId: "goblin-warrior" }, {}, await loaded()).kind, "ready");
    assert.deepEqual(linkedBlockState({ srdId: "no-such-monster" }, {}, await loaded()), { kind: "none" });
  });

  test("a block that does not read counts as none", () => {
    const broken = { srdId: "broken", name: "Broken", statBlock: "## Broken\n\nnot a stat block" } as SrdMonster;
    assert.deepEqual(linkedBlockState({ srdId: "broken" }, {}, { list: [broken], failed: false }), { kind: "none" });
  });

  test("a player's view never yields saves for a room monster's link, since it holds no monsterId", () => {
    const state = room();
    state.monsters.m1 = customMonster("m1");
    state.tokens.g = token("g", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ monsterId: "m1" }) } });
    const view = projectState(state, P1, { sceneId: null });
    assert.deepEqual(linkedBlockState(inlineOf(view.tokens.g), view.monsters, { list: null, failed: false }), { kind: "none" });
  });
});

describe("the sheet link", () => {
  test("https only, at most 500 characters", () => {
    assert.equal(validSheetUrl("https://www.dndbeyond.com/characters/1"), "https://www.dndbeyond.com/characters/1");
    assert.equal(validSheetUrl("http://example.com"), null);
    assert.equal(validSheetUrl("javascript:alert(1)"), null);
    assert.equal(validSheetUrl(`https://example.com/${"a".repeat(500)}`), null);
  });
});
