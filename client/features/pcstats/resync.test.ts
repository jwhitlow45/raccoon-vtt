import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, PcRoll, PcStats } from "#shared/model.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { afterSync, defaultTicks, planSync, syncPatch, syncResult, type SyncPlan } from "#shared/rules/pcSync.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor, character } from "#shared/testutil.ts";
import {
  alsoLine,
  bareValue,
  blockTooBigText,
  changeLine,
  checkLines,
  doneLine,
  goneDroppedLine,
  keptRow,
  lateApplyText,
  lateUndoText,
  lossesText,
  recordTooBigText,
  refusalText,
  replacesLine,
  resyncNumber,
  sayValue,
  syncedOn,
  syncReadLine,
  groupSummary,
  unlinkedLine,
  type ReadingBlocks,
} from "./resync.ts";
import { ddbCharacterId } from "#shared/ddb/link.ts";

/** A re-sync's words (docs/design-v1-resync.md 3), over the merge's own items. */

const SHEET = "https://www.dndbeyond.com/characters/12345678";
const AT = "2026-10-20T19:00:00.000Z";
const NOW = new Date("2026-10-22T12:00:00.000Z");
const empty = (): PcStats => structuredClone(EMPTY_PC_STATS) as PcStats;

function fillOf(stats: Partial<PcStats>, over: Partial<PcFill> = {}): PcFill {
  const s = { ...empty(), ...stats };
  return {
    source: "ddb",
    stats: { abilities: s.abilities, saves: s.saves, skills: s.skills, adjust: s.adjust, defenses: s.defenses, spellAbility: s.spellAbility ?? null, jack: false, alert: false, evasion: false, critOn: s.critOn ?? null, rolls: s.rolls },
    level: 5,
    name: "Bree Tallow",
    actor: { ac: 15, hpMax: 38, speeds: { walk: 30 }, sheetUrl: SHEET },
    warnings: [],
    ...over,
  };
}

const bree = (stats?: PcStats, over: Partial<Character> = {}): Character =>
  character("bree", { name: "Bree", level: 5, ...(stats ? { stats } : {}), actor: actor({ ac: 15, hp: { cur: 20, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "", sheetUrl: SHEET }), ...over });

function plan(c: Character, fill: PcFill): SyncPlan {
  return planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill });
}

/** Bree after a first sync of this read. */
function synced(fill: PcFill): Character {
  const c = bree();
  const p = plan(c, fill);
  return { ...c, ...afterSync(c, syncPatch(c, syncResult(p, defaultTicks(p)))!.patch, AT) } as Character;
}

const blocks = (p: SyncPlan): ReadingBlocks => {
  const r = syncResult(p, defaultTicks(p));
  return { now: { stats: p.input.stats ?? empty(), level: p.input.level }, after: { stats: r.stats, level: r.level } };
};

const shillelagh = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "s", name: "Shillelagh", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "bludgeoning" }], ...over });
const sling = (over: Partial<PcRoll> = {}): PcRoll => ({ id: "w", name: "Sling", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d4", mod: true, type: "bludgeoning" }], ...over });

describe("a field's words", () => {
  test("the new value, then now and the current one, as today's review says it", () => {
    assert.equal(sayValue("abilities.wis", 18), "Wisdom 18");
    assert.equal(`${sayValue("saves.dex", true)}, now ${bareValue("saves.dex", false)}`, "Dexterity save: Proficient, now not proficient");
    assert.equal(`${sayValue("skills.perception", "expert")}, now ${bareValue("skills.perception", "prof")}`, "Perception: Expertise, now Proficient");
    assert.equal(`${sayValue("adjust.skills.perception", 2)}, now ${bareValue("adjust.skills.perception", 0)}`, "Perception bonus +2, now +0");
    assert.equal(`${sayValue("defenses.fire", "resistant")}, now ${bareValue("defenses.fire", null)}`, "Fire: Resistant, now none");
    assert.equal(`${sayValue("critOn", 19)}, now ${bareValue("critOn", 20)}`, "Critical hits on 19 and 20, now 20");
    assert.equal(sayValue("spellAbility", "cha"), "Spellcasting ability: Charisma");
    assert.equal(sayValue("jack", true), "Jack of All Trades: Yes");
    assert.equal(sayValue("speeds", { walk: 35, fly: 30 }), "Speed 35 ft, Fly 30 ft");
  });
});

describe("the review's lines (3.3)", () => {
  test("changes from D&D Beyond: a field, a roll added, updated and removed, and a first sync without now", () => {
    const first = synced(fillOf({ abilities: { ...empty().abilities, wis: 16 }, rolls: [shillelagh({ id: "r1" }), sling({ id: "r2" })] }));
    const p = plan(first, fillOf({ abilities: { ...empty().abilities, wis: 18 }, rolls: [shillelagh({ id: "r3", dice: [{ formula: "1d10", mod: true, type: "bludgeoning" }] }), { id: "r4", name: "Moonbeam", kind: "spell", ability: "spell", level: 2, save: { ability: "con" }, dice: [{ formula: "2d10", type: "radiant" }] }] }));
    const lines = p.items.filter((i) => i.section === "changes").map((i) => changeLine(i, blocks(p), false));
    assert.deepEqual(lines, ["Wisdom 18, now 16", "Updates Shillelagh (cantrip): +3 to hit, 1d10 Bludgeoning, now +3 to hit, 1d8 Bludgeoning", "Removes Sling", "Adds Moonbeam (level 2): DC 11 Constitution save, 2d10 Radiant"]);
    const fresh = plan(bree(), fillOf({ abilities: { ...empty().abilities, str: 8 } }));
    assert.equal(changeLine(fresh.items[0]!, blocks(fresh), true), "Strength 8");
  });

  test("a kept row: its value now, its tag when changed there too, D&D Beyond's, and its checkbox", () => {
    const first = synced(fillOf({ spellAbility: "int" }));
    const mine = { ...first, stats: { ...first.stats!, spellAbility: "cha" as const } };
    const p = plan(mine, fillOf({ spellAbility: "wis" }));
    assert.deepEqual(keptRow(p.items[0]!, blocks(p)), {
      first: "Spellcasting ability: Charisma",
      tag: "Also changed in D&D Beyond",
      theirs: "D&D Beyond now says Wisdom. At the last sync it said Intelligence.",
      tick: "Overwrite with Wisdom",
    });
    const kept = plan(mine, fillOf({ spellAbility: "int" }));
    assert.deepEqual(keptRow(kept.items[0]!, blocks(kept)), { first: "Spellcasting ability: Charisma", theirs: "D&D Beyond says Intelligence.", tick: "Overwrite with Intelligence" });
  });

  test("a roll kept, removed by the player, and gone from D&D Beyond", () => {
    const first = synced(fillOf({ rolls: [shillelagh({ id: "r1" }), sling({ id: "r2" })] }));
    const edited = { ...first, stats: { ...first.stats!, rolls: [{ ...first.stats!.rolls[0]!, attack: { prof: true, bonus: 1 } }] } };
    const p = plan(edited, fillOf({ rolls: [shillelagh({ id: "r3" }), sling({ id: "r4" })] }));
    const rows = p.items.map((i) => keptRow(i, blocks(p)));
    assert.equal(rows[0]!.first, "Shillelagh (cantrip), as you changed it: +4 to hit, 1d8 Bludgeoning");
    assert.equal(rows[0]!.tick, "Overwrite with D&D Beyond’s");
    assert.equal(rows[1]!.first, "Sling: you removed it.");
    assert.equal(rows[1]!.tick, "Add it back");
    const gone = plan(edited, fillOf({ rolls: [sling({ id: "r5" })] }));
    const row = keptRow(gone.items.find((i) => i.type === "roll" && i.case === "goneThere")!, blocks(gone));
    assert.deepEqual([row.theirs, row.tick], ["D&D Beyond no longer has it.", "Remove it"]);
  });

  test("the editor's Replaces line and a group's summary", () => {
    const typed = bree({ ...empty(), spellAbility: "cha", abilities: { ...empty().abilities, wis: 16, dex: 12, con: 14 } });
    const fill = fillOf({ spellAbility: "wis", abilities: { ...empty().abilities, wis: 18, dex: 14, con: 15 } });
    const e = planSync({ mode: "editor", stats: typed.stats, level: 5, character: typed, fill });
    assert.equal(replacesLine(e.items.find((i) => i.id === "field:spellAbility")!, blocks(e)), "Spellcasting ability: Charisma, becomes Wisdom");
    const d = plan(typed, fill);
    const scores = d.items.filter((i) => i.group === "Ability scores");
    assert.equal(groupSummary(scores, blocks(d)), "3: Dexterity 12, D&D Beyond says 14, and 2 more");
  });

  test("Also set: AC's help, Max HP's for hurt and unhurt, and a sheet link to another number", () => {
    const first = synced(fillOf({}));
    const hurt = plan(first, fillOf({}, { actor: { ac: 16, hpMax: 45, sheetUrl: "https://www.dndbeyond.com/characters/87654321" } }));
    const lines = hurt.also.map((a) => alsoLine(a, first, "ddb"));
    assert.deepEqual(lines, [
      { text: "AC 16, now 15", help: "Worked out from the armor. Check it." },
      { text: "Max HP 45, now 38", help: "Bree keeps 20 HP, now out of 45." },
      { text: `Sheet link https://www.dndbeyond.com/characters/87654321, now ${SHEET}`, help: "So the next re-sync gets this character." },
      { text: "Name Bree Tallow, now Bree" },
    ]);
    const full = { ...first, actor: { ...first.actor, hp: { cur: 38, max: 38, temp: 0 } } };
    assert.equal(alsoLine(hurt.also[1]!, full, "ddb").help, "Bree is unhurt and stays at full HP: 45 of 45.");
  });

  test("the read line says when it last synced, with the year only when it is not this year, or that the character is another", () => {
    assert.equal(syncedOn(AT, { now: NOW, timeZone: "UTC" }), "Oct 20");
    assert.equal(syncedOn("2025-10-20T19:00:00.000Z", { now: NOW, timeZone: "UTC" }), "Oct 20, 2025");
    const first = synced(fillOf({}));
    assert.equal(syncReadLine(plan(first, fillOf({})), { now: NOW, timeZone: "UTC" }), "Read from D&D Beyond: Bree Tallow, level 5. Last synced on Oct 20.");
    const other = plan(first, fillOf({}, { actor: { sheetUrl: "https://www.dndbeyond.com/characters/87654321" } }));
    assert.equal(syncReadLine(other), "Read from D&D Beyond: Bree Tallow, level 5. This is a different character from the last sync, so nothing is compared with it.");
  });

  test("the D&D Beyond number fetched: the sheet link's, else the record's", () => {
    const first = synced(fillOf({}));
    assert.equal(resyncNumber(first, ddbCharacterId), "12345678");
    assert.equal(resyncNumber({ ...first, actor: { ...first.actor, sheetUrl: "https://example.com/bree" } }, ddbCharacterId), "12345678");
    assert.equal(resyncNumber(bree(empty(), { actor: actor({ sheetUrl: "https://example.com" }) }), ddbCharacterId), null);
  });
});

describe("Check these and the warnings (3.3)", () => {
  test("rolls that did not fit, a shape, and a proficiency beside a kept bonus", () => {
    const first = synced(fillOf({}));
    const mine = { ...first, stats: { ...first.stats!, adjust: { skills: { stealth: 3 } } }, actor: { ...first.actor, srdId: "brown-bear", wildShape: true as const } };
    const p = plan(mine, fillOf({ skills: { stealth: "prof" } }, { warnings: ["Whether a pass halves the damage is not known."] }));
    const r = syncResult(p, defaultTicks(p));
    assert.deepEqual(checkLines(p, { ...r, notFit: 3 }, "Bree"), [
      "Whether a pass halves the damage is not known.",
      "3 rolls from D&D Beyond did not fit, since a block holds 40. They come in once there is room.",
      "AC and Speed are not compared while Bree is in Wild Shape. Re-sync after the shape ends to update them.",
      "Stealth gets proficiency from D&D Beyond and keeps your +3 bonus, so it rolls +6. Overwrite the bonus if it stood for the proficiency.",
    ]);
    const polymorph = { ...mine, actor: { ...mine.actor, wildShape: undefined } };
    delete polymorph.actor.wildShape;
    assert.match(checkLines(plan(polymorph, fillOf({})), { ...r, notFit: 1, besideBonus: [] }, "Bree").join(" "), /1 roll from D&D Beyond did not fit, since a block holds 40\. It comes in once there is room\. AC and Speed are not compared while Bree is in a shape\./);
  });

  test("a deleted roll the 40 cap forgets: its names up to three, then a count", () => {
    assert.equal(goneDroppedLine([{ k: "w:1", name: "Shortbow" }]), "Your deleted Shortbow may come back on a later re-sync. Only 40 deleted rolls are remembered.");
    assert.equal(goneDroppedLine([{ k: "w:1", name: "Shortbow" }, { k: "w:2", name: "Sling" }]), "Your deleted Shortbow and Sling may come back on a later re-sync. Only 40 deleted rolls are remembered.");
    assert.equal(goneDroppedLine(["Shortbow", "Sling", "Dagger"].map((name, i) => ({ k: `w:${i}`, name }))), "Your deleted Shortbow, Sling and Dagger may come back on a later re-sync. Only 40 deleted rolls are remembered.");
    assert.equal(goneDroppedLine(["Shortbow", "Sling", "Dagger", "Club"].map((name, i) => ({ k: `w:${i}`, name }))), "4 rolls you deleted may come back on a later re-sync. Only 40 deleted rolls are remembered.");
    assert.equal(goneDroppedLine([{ k: "w:1" }]), "A roll you deleted may come back on a later re-sync. Only 40 deleted rolls are remembered.");
    assert.equal(goneDroppedLine([{ k: "w:1" }, { k: "w:2", name: "Sling" }]), "2 rolls you deleted may come back on a later re-sync. Only 40 deleted rolls are remembered.");
    assert.equal(goneDroppedLine([]), null);
  });

  test("an own roll the full record could not link: its name, up to three, then a count (RSBUILD-ASTRA-01)", () => {
    assert.equal(unlinkedLine(["Shillelagh"]), "Shillelagh is in D&D Beyond too, but a sync remembers at most 40 rolls, so it stays your own until there is room.");
    assert.equal(unlinkedLine(["Shillelagh", "Sling"]), "Shillelagh and Sling are in D&D Beyond too, but a sync remembers at most 40 rolls, so they stay your own until there is room.");
    assert.equal(unlinkedLine(["A", "B", "C", "D"]), "4 of your own rolls are in D&D Beyond too, but a sync remembers at most 40 rolls, so they stay your own until there is room.");
    assert.equal(unlinkedLine([]), null);
  });

  test("the losses warning", () => {
    const skills = Object.fromEntries(["arcana", "history", "nature", "religion", "insight", "medicine", "perception", "survival", "stealth", "acrobatics", "athletics", "deception", "intimidation", "performance"].map((s) => [s, "prof"])) as PcStats["skills"];
    const first = synced(fillOf({ skills }, { level: 6 }));
    assert.equal(lossesText(plan(first, fillOf({}, { level: 1 })), "Bree"), "This lowers Bree’s level from 6 to 1 and takes away 14 proficiencies. If that is not what changed in D&D Beyond, its format may have changed. Cancel, and check the character there.");
  });
});

describe("the done line, the size refusals and the answers (3.4, 3.5)", () => {
  test("counts what came in, removals and restores apart, and what stayed, leaving out a 0", () => {
    assert.equal(doneLine({ cameIn: 1, removed: 0, cameBack: 0, stayed: 0 }), "1 change came in.");
    assert.equal(doneLine({ cameIn: 6, removed: 0, cameBack: 0, stayed: 2 }), "6 changes came in, and 2 of your changes stayed.");
    assert.equal(doneLine({ cameIn: 6, removed: 1, cameBack: 1, stayed: 2 }), "6 changes came in, 1 roll was removed, 1 came back, and 2 of your changes stayed.");
    assert.equal(doneLine({ cameIn: 0, removed: 0, cameBack: 2, stayed: 0 }), "2 rolls came back.");
  });

  test("too big, refused, and answered after closing", () => {
    assert.equal(blockTooBigText("Bree", 12.4 * 1024), "This would make Bree’s stat block 12.4 KiB of the 12 KiB it may hold. Remove a few of your own rolls first.");
    assert.equal(recordTooBigText("Bree"), "Bree’s sync record would be too large to save. Remove a few rolls first.");
    assert.equal(refusalText("Not re-synced", "that is not yours"), "Not re-synced: That is not yours.");
    assert.equal(lateApplyText("Bree", "refused", "the room is too full."), "Bree was not re-synced. The room is too full.");
    assert.equal(lateApplyText("Bree", "unknown"), "The connection dropped before the server answered, so Bree may not have been re-synced. Check the stat block.");
    assert.equal(lateApplyText("Bree", "taken"), null);
    assert.equal(lateUndoText("Bree", "refused", "no"), "Bree’s re-sync was not undone. No.");
  });
});
