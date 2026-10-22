import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { actor, character } from "#shared/testutil.ts";
import { alsoLines, alsoPatch, alsoSet, pendingCharacter, readLine } from "./fill.ts";

/** The review's "Also set" (docs/design-v1-pc-stats.md 6.1). */

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

describe("the character as Save would leave it (docs/design-v1-resync.md 1.1)", () => {
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
