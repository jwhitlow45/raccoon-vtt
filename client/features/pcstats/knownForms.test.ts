import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { actor } from "#shared/testutil.ts";
import { isCurrentForm, formLabel, formMark, knownFormCountWords, knownFormPatch, knownFormsIn, missingFormText, rememberDruidLevel, rememberedDruidLevel, startDruidLevel, toggleKnownForm } from "./knownForms.ts";
import { shapeLimit } from "./shapeLevel.ts";
import { shapeTempHp } from "./shape.ts";

/** This device's localStorage, which a test may block as a private window or full storage does. */
const device = new Map<string, string>();
let blocked = false;
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => {
      if (blocked) throw new Error("blocked");
      return device.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (blocked) throw new Error("blocked");
      device.set(k, String(v));
    },
  },
});

/** A Druid's known forms in Take a shape (docs/design-v1-known-forms.md 5). */
describe("a Druid's known forms", () => {
  let SRD: readonly SrdMonster[] = [];
  before(async () => {
    SRD = await loadMonsters();
  });
  const named = (name: string) => {
    const m = SRD.find((x) => x.name === name);
    assert.ok(m, name);
    return m;
  };

  test("a tap adds a form at the end or takes it out, keeps the order, and adds none past 8", () => {
    assert.deepEqual(toggleKnownForm(undefined, "wolf"), ["wolf"]);
    assert.deepEqual(toggleKnownForm(["wolf", "owl"], "black-bear"), ["wolf", "owl", "black-bear"]);
    assert.deepEqual(toggleKnownForm(["wolf", "owl", "black-bear"], "owl"), ["wolf", "black-bear"]);
    assert.deepEqual(toggleKnownForm(["wolf"], "wolf"), [], "the last one out is an empty list, which clears them");
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
    assert.deepEqual(toggleKnownForm(eight, "ape"), eight);
    assert.deepEqual(toggleKnownForm(eight, "c"), ["a", "b", "d", "e", "f", "g", "h"]);
  });

  test("the count's four cases, the first that holds, with their short forms", () => {
    assert.deepEqual(knownFormCountWords(7, 4), { text: "7 known forms, 1 more than a level 4 Druid knows.", short: "7 of 6 at Druid level 4", over: true });
    assert.deepEqual(knownFormCountWords(4, 4), { text: "4 of 6 known forms at Druid level 4.", short: "4 of 6 at Druid level 4", over: false });
    assert.deepEqual(knownFormCountWords(8, 8), { text: "8 of 8 known forms at Druid level 8.", short: "8 of 8 at Druid level 8", over: false }, "a level comes before the most");
    assert.deepEqual(knownFormCountWords(8, null), { text: "8 known forms, the most there are.", short: "8 of 8", over: false });
    assert.deepEqual(knownFormCountWords(4, null), { text: "4 known forms.", short: "4", over: false });
    assert.equal(knownFormCountWords(1, null).text, "1 known form.");
    assert.equal(knownFormCountWords(5, 2).text, "5 known forms, 1 more than a level 2 Druid knows.");
  });

  test("the forms sort highest CR first, then by name, and an id the SRD list lacks is kept apart in its order", () => {
    const { forms, missing } = knownFormsIn(["wolf", "cave-bear", "owl", "black-bear", "mastiff", "dire-badger"], SRD);
    assert.deepEqual(forms.map((m) => m.name), ["Black Bear", "Wolf", "Mastiff", "Owl"]);
    assert.deepEqual(missing, ["cave-bear", "dire-badger"]);
    assert.equal(missingFormText("cave-bear"), "cave-bear: not in this app's SRD list");
    assert.deepEqual(knownFormsIn(undefined, SRD), { forms: [], missing: [] });
  });

  test("a mark against the picked level, and the reason a row's name adds", () => {
    assert.equal(formMark(null, named("Owl")), null, "no level, no marks");
    assert.deepEqual(formMark(shapeLimit(4), named("Owl")), { tag: "Fly Speed", reason: "has a Fly Speed" });
    assert.deepEqual(formMark(shapeLimit(2), named("Black Bear")), { tag: "Over CR 1/4", reason: "over CR 1/4" });
    assert.deepEqual(formMark(shapeLimit(4), named("Brown Bear")), { tag: "Over CR 1/2", reason: "over CR 1/2" });
    assert.equal(formMark(shapeLimit(8), named("Owl")), null);
    assert.equal(formLabel("Wolf", null), "Wild Shape as Wolf");
    assert.equal(formLabel("Owl", formMark(shapeLimit(4), named("Owl"))), "Wild Shape as Owl, has a Fly Speed");
  });

  test("the select starts at the level or Any remembered, else the character's from level 2 once it has known forms, else Any", () => {
    const forms = ["wolf"];
    assert.equal(startDruidLevel(4, { level: 9, knownForms: forms }), 4);
    assert.equal(startDruidLevel(null, { level: 9, knownForms: forms }), null, "Any picked stays Any, for Polymorph");
    assert.equal(startDruidLevel(undefined, { level: 9, knownForms: forms }), 9);
    assert.equal(startDruidLevel(undefined, { level: 1, knownForms: forms }), null, "a level 1 character reopened starts at Any");
    assert.equal(startDruidLevel(undefined, { knownForms: forms }), null, "no level");
    assert.equal(startDruidLevel(undefined, { level: 9 }), null, "no known forms");
  });

  test("the level is remembered per character and room, Any is remembered as Any, and storage that throws or holds junk remembers none", () => {
    blocked = false;
    device.clear();
    assert.equal(rememberedDruidLevel("ROOM", "bree"), undefined);
    rememberDruidLevel("ROOM", "bree", 4);
    rememberDruidLevel("ROOM", "cy", 8);
    assert.equal(rememberedDruidLevel("ROOM", "bree"), 4);
    assert.equal(rememberedDruidLevel("OTHER", "bree"), undefined);
    assert.deepEqual(JSON.parse(device.get("rvtt.druidLevel.ROOM")!), { bree: 4, cy: 8 });
    rememberDruidLevel("ROOM", "bree", null);
    assert.equal(rememberedDruidLevel("ROOM", "bree"), null);
    assert.deepEqual(JSON.parse(device.get("rvtt.druidLevel.ROOM")!), { bree: null, cy: 8 });
    assert.equal(rememberedDruidLevel("ROOM", "cy"), 8);
    device.set("rvtt.druidLevel.ROOM", JSON.stringify({ bree: 1, cy: "4", dee: 21, eve: 6 }));
    assert.deepEqual(["bree", "cy", "dee", "eve"].map((id) => rememberedDruidLevel("ROOM", id)), [undefined, undefined, undefined, 6]);
    device.set("rvtt.druidLevel.ROOM", "{not json");
    assert.equal(rememberedDruidLevel("ROOM", "eve"), undefined);
    blocked = true;
    assert.equal(rememberedDruidLevel("ROOM", "eve"), undefined);
    assert.doesNotThrow(() => rememberDruidLevel("ROOM", "eve", 4));
    blocked = false;
  });

  test("Wild Shape's Temporary HP follow a remembered level, else the character's, and come only where more than held", () => {
    const wolf = named("Wolf");
    assert.equal(shapeTempHp("wild", { level: 9 }, wolf, 4), 4);
    assert.equal(shapeTempHp("wild", { level: 9 }, wolf), 9);
    assert.equal(shapeTempHp("other", { level: 9 }, wolf, 4), wolf.hp.average, "Polymorph ignores the Druid level");
    const bree = (temp: number) => ({ level: 9, actor: actor({ hp: { cur: 30, max: 30, temp } }) });
    assert.deepEqual(knownFormPatch(wolf, bree(0), 4), { srdId: "wolf", wildShape: true, ac: wolf.ac, speeds: wolf.speeds, hp: { temp: 4 } });
    assert.deepEqual(knownFormPatch(wolf, bree(0), undefined).hp, { temp: 9 });
    assert.deepEqual(knownFormPatch(wolf, bree(0), null).hp, { temp: 9 }, "Any picked names no Druid level");
    assert.equal(knownFormPatch(wolf, bree(9), 4).hp, undefined, "Bree's 9 stay");
  });
});

describe("the form a druid is in (5.3)", () => {
  test("only Wild Shape's own form counts as current, so a tap on it does nothing and Polymorph's never does", () => {
    const wolf = (over: Record<string, unknown>) => ({ actor: actor({ srdId: "wolf", ...over }) });
    assert.equal(isCurrentForm(wolf({ wildShape: true }), "wolf"), true);
    assert.equal(isCurrentForm(wolf({ wildShape: true }), "owl"), false);
    assert.equal(isCurrentForm(wolf({}), "wolf"), false, "Polymorph is another shape");
    assert.equal(isCurrentForm({ actor: actor({}) }, "wolf"), false, "no shape");
  });
});
