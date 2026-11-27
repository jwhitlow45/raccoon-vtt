import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { actor, character } from "#shared/testutil.ts";
import { alsoLines, alsoPatch, alsoSet, classesWords, pendingCharacter, readLine } from "./fill.ts";
import { alsoLine, keptRow, overwriteWords } from "./resync.ts";

/** The review's "Other fields" (docs/design/design-v1-pc-stats.md 6.1). */

const FILL: PcFill = {
  source: "ddb",
  stats: { rolls: [] },
  level: 5,
  name: "Bree Tallow",
  actor: { ac: 16, hpMax: 38, speeds: { walk: 30 }, senses: "Darkvision 60 ft.", sheetUrl: "https://www.dndbeyond.com/characters/12345678" },
  warnings: [],
};

describe("the review", () => {
  test("what was read", () => {
    assert.equal(readLine(FILL), "Read from D&D Beyond: Bree Tallow, level 5.");
    assert.equal(readLine({ ...FILL, source: "paste" }), "Read from the pasted text.");
  });

  test("a line for each field that would change, new then current, the name off, and the sheet link only where there is none", () => {
    const bree = character("bree", { name: "Bree", level: 4, actor: actor({ ac: 15, hp: { cur: 33, max: 33, temp: 0 }, speeds: { walk: 25 }, senses: "" }) });
    assert.deepEqual(alsoLines(FILL, bree), [
      { key: "level", text: "Level 5, now 4", on: true },
      { key: "ac", text: "AC 16, now 15", on: true },
      { key: "hpMax", text: "Max HP 38, now 33", on: true },
      { key: "speeds", text: "Speed 30 ft, now 25 ft", on: true },
      { key: "senses", text: "Senses Darkvision 60 ft, now none", on: true },
      { key: "sheetUrl", text: "Sheet link https://www.dndbeyond.com/characters/12345678", on: true },
      { key: "name", text: "Name Bree Tallow, now Bree", on: false },
    ]);
    const same = character("bree", { name: "Bree Tallow", level: 5, actor: actor({ ac: 16, hp: { cur: 38, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "Darkvision 60 ft", sheetUrl: "https://example.com" }) });
    assert.deepEqual(alsoLines(FILL, same), [], "nothing changes, and a sheet link already chosen stays");
  });

  test("in a shape, no AC or speeds line, as both are the creature's until End the shape puts the character's back (W7B-P-9)", () => {
    const bear = character("bree", { name: "Bree", level: 5, actor: actor({ srdId: "brown-bear", wildShape: true, ac: 11, hp: { cur: 38, max: 38, temp: 5 }, speeds: { walk: 40, climb: 30 }, senses: "Darkvision 60 ft" }) });
    assert.deepEqual(alsoLines(FILL, bear).map((l) => l.key), ["sheetUrl", "name"]);
  });

  test("only the ticked fields are set", () => {
    const bree = character("bree", { name: "Bree", actor: actor({ ac: 15 }) });
    const lines = alsoLines(FILL, bree).map((l) => (l.key === "ac" ? { ...l, on: false } : l));
    const also = alsoSet(FILL, lines);
    assert.equal(also.ac, undefined);
    assert.equal(also.name, undefined, "the name starts off");
    assert.equal(also.level, 5);
  });
});

describe("max HP by one rule", () => {
  test("a living character at its maximum stays at it, and any other keeps its HP, cut by the reducer when higher", () => {
    assert.deepEqual(alsoPatch({ hpMax: 38 }, character("c", { actor: actor({ hp: { cur: 33, max: 33, temp: 0 } }) })).actor, { hp: { max: 38, cur: 38 } });
    assert.deepEqual(alsoPatch({ hpMax: 20 }, character("c", { actor: actor({ hp: { cur: 25, max: 33, temp: 0 } }) })).actor, { hp: { max: 20 } });
    assert.deepEqual(alsoPatch({ hpMax: 38 }, character("c", { actor: actor({ hp: { cur: 0, max: 33, temp: 0 }, life: "dying" }) })).actor, { hp: { max: 38 } }, "never brings one back");
    assert.deepEqual(alsoPatch({ hpMax: 38 }, character("c", { actor: actor({ hp: { cur: 33, max: 33, temp: 0 }, life: "dead" }) })).actor, { hp: { max: 38 } }, "nor raises a dead one's");
    assert.equal(alsoPatch({ hpMax: 33 }, character("c", { actor: actor({ hp: { cur: 10, max: 33, temp: 0 } }) })).actor, undefined);
  });

  test("the name, level and the other fields go in the same op", () => {
    assert.deepEqual(alsoPatch({ name: "Bree Tallow", level: 5, ac: 16, senses: "x", speeds: { walk: 30 }, sheetUrl: "https://a" }, character("c")), {
      name: "Bree Tallow",
      level: 5,
      actor: { ac: 16, speeds: { walk: 30 }, senses: "x", sheetUrl: "https://a" },
    });
  });
});

describe("the character as Save would leave it (docs/design/design-v1-resync.md 1.1)", () => {
  test("takes the fields a fill set and its record, else keeps the saved ones", () => {
    const saved = { name: "Bree", actor: actor({ ac: 14, hp: { cur: 30, max: 30, temp: 2 }, speeds: { walk: 25 }, senses: "" }), ddbSync: { at: "2026-10-20T19:00:00.000Z", base: { ac: 14 }, rolls: {} } };
    const record = { base: { ac: 16 }, rolls: {} };
    const p = pendingCharacter(saved, { name: "Bree Tallow", ac: 16, hpMax: 38, speeds: { walk: 30 }, senses: "Darkvision 60 ft." }, record);
    assert.deepEqual([p.name, p.actor.ac, p.actor.hp, p.actor.speeds, p.actor.senses, p.ddbSync], ["Bree Tallow", 16, { cur: 38, max: 38, temp: 2 }, { walk: 30 }, "Darkvision 60 ft.", record]);
    assert.equal(saved.actor.ac, 14, "the saved character is left as it was");
    assert.equal(pendingCharacter(saved, {}, null).ddbSync, saved.ddbSync);
    assert.equal("ddbSync" in pendingCharacter({ name: "Bree", actor: actor() }, {}, null), false);
  });
});

/** The classes' line (docs/design/design-v1-slots.md 8), in the import's review and a re-sync's. */
describe("the classes in the review", () => {
  const read = { ...FILL, classes: [{ id: "fighter" as const, level: 3, third: true as const }, { id: "wizard" as const, level: 2 }], classNames: ["Fighter", "Wizard"] };

  test("Classes: Fighter 3 (its subclass casts spells), Wizard 2, now none, ticked, and Save sends them without spent counts", () => {
    const bree = character("bree", { name: "Bree Tallow", level: 5, actor: actor({ ac: 16, hp: { cur: 38, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "Darkvision 60 ft.", sheetUrl: FILL.actor.sheetUrl }) });
    const lines = alsoLines(read, bree);
    assert.deepEqual(lines, [{ key: "classes", text: "Classes: Fighter 3 (its subclass casts spells), Wizard 2, now none", on: true }]);
    const also = alsoSet(read, lines);
    assert.deepEqual(alsoPatch(also, bree), { classes: read.classes });
    assert.deepEqual(pendingCharacter(bree, also, null).classes, read.classes);
    assert.deepEqual(alsoSet(read, lines.map((l) => ({ ...l, on: false }))), {}, "unticked, they stay as they are");
  });

  test("an Other class by D&D Beyond's name, the same classes in another order no line, and classes not read none", () => {
    const bree = character("bree", { name: "Bree Tallow", level: 5, classes: [{ id: "wizard", level: 2 }, { id: "fighter", level: 3, third: true }], actor: actor({ ac: 16, hp: { cur: 38, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "Darkvision 60 ft.", sheetUrl: FILL.actor.sheetUrl }) });
    assert.deepEqual(alsoLines(read, bree), []);
    assert.deepEqual(alsoLines({ ...FILL }, bree), []);
    const artificer = { ...FILL, classes: [{ id: "other" as const, level: 3, die: 8 as const }, { id: "wizard" as const, level: 2 }], classNames: ["Artificer", "Wizard"] };
    assert.deepEqual(alsoLines(artificer, bree).map((l) => l.text), ["Classes: Artificer 3 (Other class, d8), Wizard 2, now Wizard 2, Fighter 3 (its subclass casts spells)"]);
    assert.equal(classesWords([{ id: "other", level: 3, die: 8 }]), "Other class 3 (d8)");
    assert.equal(classesWords([]), "none");
  });

  test("a re-sync's lines: Also set, Kept with D&D Beyond's classes, and Overwrite", () => {
    const also = alsoLine({ type: "also", id: "also:classes", key: "classes", now: [], theirs: [{ id: "other", level: 3, die: 8 }], on: true, names: ["Artificer"] }, character("bree", {}), "ddb");
    assert.equal(also.text, "Classes: Artificer 3 (Other class, d8), now none");
    const kept = keptRow({ type: "field", id: "field:classes", key: "classes", group: "Features", section: "kept", base: [{ id: "wizard", level: 5 }], now: [{ id: "wizard", level: 6 }], theirs: [{ id: "wizard", level: 7 }], conflict: true }, { now: { stats: { rolls: [] } as never, level: 6 }, after: { stats: { rolls: [] } as never, level: 7 } });
    assert.deepEqual(kept, { first: "Classes: Wizard 6", tag: "Also changed in D&D Beyond", theirs: "D&D Beyond now says Wizard 7. At the last sync it said Wizard 5.", tick: "Overwrite with Wizard 7" });
    assert.equal(overwriteWords({ key: "classes", theirs: [] }), "Overwrite with D&D Beyond's", "never Overwrite with none");
  });
});
