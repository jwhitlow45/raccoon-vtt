import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiceRoll, LogEntry, LogEvent } from "#shared/model.ts";
import { askedFormula, askedRoll, collapseBare, findRolls, headerRoll, readingOf, recentRolls, stepHistory, withHistory, type RecentRow } from "./logic.ts";
import type { ReceiptLookup } from "../../lib/api.ts";
import { ReceiptTracker, refusalWords } from "./useReceipt.ts";

/** What the Dice panel reads from the log (docs/design-v1-dice.md 8.3 and 8.6). */
let seq = 0;
function entry(data: LogEvent): LogEntry {
  return { id: `${++seq}:0`, at: "2026-10-17T20:00:00.000Z", kind: "event", data };
}

const ROLL: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 13, label: "Longsword" };
const dice = (extra: Partial<Extract<LogEvent, { type: "dice" }>> = {}): LogEvent => ({ type: "dice", by: "p1", to: "all", rolls: [ROLL], ...extra });

describe("Recent rolls", () => {
  test("newest first, every dice line and every rolled answer, and nothing else", () => {
    const log = [
      entry(dice()),
      { id: "x:0", at: "", kind: "chat", from: "p1", text: "hi" } as LogEntry,
      entry({ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "c1", total: 12 }),
      entry({ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "c1", total: 14, dice: { formula: "1d20+2", faces: [12], total: 14 }, tag: "t9" }),
      entry(dice({ by: "p2" })),
    ];
    const rows = recentRolls(log);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["dice", "answer", "dice"],
    );
    assert.equal((rows[0] as Extract<RecentRow, { kind: "dice" }>).by, "p2");
  });

  test("lines of one roller and one batch are one row in roll order, whatever lies between them", () => {
    const a = entry(dice({ batch: "B1", rolls: [{ ...ROLL, total: 1 }] }));
    const other = entry(dice({ by: "p2", batch: "B1" }));
    const b = entry(dice({ batch: "B1", rolls: [{ ...ROLL, total: 2 }] }));
    const rows = recentRolls([a, other, b]);
    assert.equal(rows.length, 2, "another roller's same batch id is another roll");
    const mine = rows.find((r) => r.kind === "dice" && r.by === "p1") as Extract<RecentRow, { kind: "dice" }>;
    assert.deepEqual(
      mine.rolls.map((r) => r.total),
      [1, 2],
    );
    assert.deepEqual(mine.ids.sort(), [a.id, b.id].sort());
  });

  test("one member's consecutive bare lines are one row, and a roll between them splits it", () => {
    const bare = () => entry({ type: "dice", by: "dm1", to: "dm", rolls: [] });
    const rows = recentRolls([bare(), bare(), entry(dice()), bare(), entry({ type: "dice", by: "dm2", to: "dm", rolls: [] })]);
    assert.deepEqual(
      rows.map((r) => (r.kind === "bare" ? `${r.by}x${r.count}` : r.kind)),
      ["dm2x1", "dm1x1", "dice", "dm1x2"],
    );
    const again = collapseBare([rows[1]!, { ...(rows[1] as Extract<RecentRow, { kind: "bare" }>), key: "k", ids: ["z"] }]);
    assert.equal(again.length, 1);
    assert.equal((again[0] as Extract<RecentRow, { kind: "bare" }>).count, 2);
  });

  test("a tag's lines, oldest first, a group's batches and a request's answer alike", () => {
    const one = entry(dice({ tag: "T", batch: "B" }));
    const two = entry(dice({ tag: "T", batch: "B" }));
    const answer = entry({ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "c1", total: 14, tag: "T2" });
    const log = [one, entry(dice({ tag: "U" })), two, answer];
    assert.deepEqual(
      findRolls(log, "T").map((e) => e.id),
      [one.id, two.id],
    );
    assert.deepEqual(
      findRolls(log, "T2").map((e) => e.id),
      [answer.id],
    );
  });

  test("a part's lines are its own: a line with no part is part 0, as a request's answer is", () => {
    const zero = entry(dice({ tag: "P" }));
    const two = entry(dice({ tag: "P", part: 2 }));
    const answer = entry({ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, characterId: "c1", total: 14, tag: "Q" });
    const log = [zero, two, answer];
    assert.deepEqual(
      findRolls(log, "P", 0).map((e) => e.id),
      [zero.id],
    );
    assert.deepEqual(
      findRolls(log, "P", 2).map((e) => e.id),
      [two.id],
    );
    assert.deepEqual(findRolls(log, "P", 1), []);
    assert.deepEqual(
      findRolls(log, "Q", 0).map((e) => e.id),
      [answer.id],
    );
  });
});

describe("the field", () => {
  test("its reading names the formula, the label and the range, or the refusal", () => {
    assert.deepEqual(readingOf("2d6+3 fire"), { ok: true, text: "2d6+3, fire: 5 to 15" });
    assert.deepEqual(readingOf("1d20+5 Stealth adv"), { ok: true, text: "1d20+5 with Advantage, Stealth: 6 to 25" });
    assert.deepEqual(readingOf("2d6 adv"), { ok: false, error: "Advantage and Disadvantage need one d20 in the roll." });
    assert.equal(readingOf("   "), null);
    assert.equal(readingOf("fire")?.ok, false);
  });

  test("Again sends the formula as asked, the mode beside it", () => {
    assert.equal(askedFormula({ formula: "2d20kh1+5", mode: "adv" }), "1d20+5");
    assert.equal(askedFormula({ formula: "2d20kl1+5+1d4", mode: "dis" }), "1d20+5+1d4");
    assert.equal(askedFormula({ formula: "4d6kh3" }), "4d6kh3");
    assert.equal(askedFormula({ formula: "2d6 words" }), null);
    // A critical hit's damage goes again as asked, marked critical, whatever rule it was rolled under (the critical hit rules addendum).
    assert.deepEqual(askedRoll({ formula: "4d6+3", crit: "rollTwice" }), { formula: "2d6+3", critical: true });
    assert.deepEqual(askedRoll({ formula: "1d8+4+3d6", crit: "maxPlusRoll" }), { formula: "1d8+4+3d6", critical: true });
    assert.deepEqual(askedRoll({ formula: "4d6+3" }), { formula: "4d6+3" }, "a line from before the setting rolls its doubled dice again");
    assert.deepEqual(askedRoll({ formula: "2d20kh1+5", mode: "adv" }), { formula: "1d20+5" });
  });

  test("the history keeps 20 different texts, newest first, and Up and Down walk it back to the draft", () => {
    let history: string[] = [];
    for (let i = 0; i < 25; i++) history = withHistory(history, `${i}d6`);
    assert.equal(history.length, 20);
    assert.equal(history[0], "24d6");
    history = withHistory(history, " 10d6 ");
    assert.equal(history[0], "10d6");
    assert.equal(history.filter((t) => t === "10d6").length, 1);
    assert.equal(stepHistory(history, -1, "up"), 0);
    assert.equal(stepHistory(history, 0, "up"), 1);
    assert.equal(stepHistory(history, 19, "up"), 19);
    assert.equal(stepHistory(history, 0, "down"), -1, "past the newest, back to what was being typed");
    assert.equal(stepHistory(history, -1, "down"), -1);
  });
});

describe("a tag's receipt (docs/design-v1-dice.md 8.7)", () => {
  function tracker(log: LogEntry[] = [], lookup: () => Promise<ReceiptLookup> = () => Promise.resolve({ parts: [] })) {
    const t = new ReceiptTracker();
    t.env = { lookup, log: () => log };
    return t;
  }

  test("sending until answered, committed with the tag's lines, refused with its words", () => {
    const line = entry(dice({ tag: "T" }));
    const t = tracker([line]);
    t.sending("T", 0);
    assert.deepEqual(t.state("T"), { state: "sending" });
    t.answer("T", 0, "taken");
    assert.deepEqual(t.state("T"), { state: "committed", lines: [line] });
    t.sending("R", 0);
    t.answer("R", 0, "refused", { code: "forbidden", message: "You roll only for your own creatures.", text: "You roll only for your own creatures." });
    assert.equal(t.state("R")?.state, "refused");
  });

  test("a group reads as its least settled part, and committed with the refusals of others", () => {
    const t = tracker([entry(dice({ tag: "G" }))]);
    t.sending("G", 0);
    t.sending("G", 1);
    t.answer("G", 0, "taken");
    assert.equal(t.state("G")?.state, "sending");
    t.answer("G", 1, "refused", { code: "quota", message: "You are going too fast. Wait a few seconds.", text: "Not saved. You are going too fast. Wait a few seconds." });
    const state = t.state("G");
    assert.ok(state?.state === "committed" && state.refused?.message.startsWith("You are going"));
  });

  test("a refusal reads in the server's words, never the store's \"Not saved.\" (LP7-DICE-3)", () => {
    const t = tracker();
    t.sending("Q", 0);
    t.answer("Q", 0, "refused", { code: "quota", message: "You are going too fast. Wait a few seconds.", text: "Not saved. You are going too fast. Wait a few seconds." });
    const state = t.state("Q");
    assert.ok(state?.state === "refused");
    assert.equal(state.text, "You are going too fast. Wait a few seconds.");
    assert.equal(refusalWords({ text: "Not saved. It was settled meanwhile.", message: "It was settled meanwhile." }), "It was settled meanwhile.");
    assert.equal(refusalWords({ text: "Not saved.", message: "" }), "Not saved.", "words with nothing after them stay");
  });

  test("an answer a snapshot swallowed is found in the log, or looked up once, and missing reads unknown", async () => {
    const line = entry(dice({ tag: "S" }));
    const found = tracker([line]);
    found.sending("S", 0);
    found.answer("S", 0, "unknown", undefined, "snapshot");
    assert.equal(found.state("S")?.state, "committed");
    let asked = 0;
    const lost = tracker([], () => {
      asked++;
      return Promise.resolve({ parts: [] });
    });
    lost.sending("L", 0);
    lost.answer("L", 0, "unknown", undefined, "expired");
    assert.equal(lost.state("L")?.state, "checking");
    await lost.lookup("L");
    assert.equal(lost.state("L")?.state, "unknown");
    await lost.lookup("L");
    assert.equal(asked, 1, "looked up once");
  });

  test("after a reconnect, each part settles from its own line, so another part's line never commits a refused one", async () => {
    const first = entry(dice({ tag: "G", part: 0 }));
    let asked = 0;
    const t = tracker([first], () => {
      asked++;
      return Promise.resolve({ parts: [{ part: 0, state: "committed", seq: 1, lines: [first] }, { part: 1, state: "refused", code: "forbidden", message: "You roll only for your own creatures." }] });
    });
    t.sending("G", 0);
    t.sending("G", 1);
    t.answer("G", 0, "unknown", undefined, "snapshot");
    t.answer("G", 1, "unknown", undefined, "snapshot");
    assert.equal(t.state("G")?.state, "checking", "part 1 has no line of its own, so it is looked up");
    await t.lookup("G");
    const state = t.state("G");
    assert.ok(state?.state === "committed" && state.refused?.code === "forbidden", "committed beside the refusal of part 1");
    assert.deepEqual(state.lines, [first]);
    assert.equal(asked, 1);
  });

  test("after a reconnect, a part the server never got stays unknown beside a committed one", async () => {
    const first = entry(dice({ tag: "H", part: 0 }));
    const t = tracker([first], () => Promise.resolve({ parts: [{ part: 0, state: "committed", seq: 1, lines: [first] }] }));
    t.sending("H", 0);
    t.sending("H", 1);
    t.answer("H", 0, "unknown", undefined, "snapshot");
    t.answer("H", 1, "unknown", undefined, "snapshot");
    await t.lookup("H");
    assert.equal(t.state("H")?.state, "unknown", "never committed on part 0's line");
  });

  test("a group's lines are every committed part's, kept and live merged by entry, the live one winning, in log order", async () => {
    const lines = [0, 1, 2].map((part) => entry(dice({ tag: "E", part })));
    const log = [...lines];
    const t = tracker(log);
    for (const part of [0, 1, 2]) t.sending("E", part);
    for (const part of [0, 1, 2]) t.answer("E", part, "taken");
    log.splice(0, 1);
    const trimmed = t.state("E");
    assert.ok(trimmed?.state === "committed");
    assert.deepEqual(
      trimmed.lines.map((l) => l.id),
      lines.map((l) => l.id),
      "trimming part 0's line from the live log loses nothing",
    );
    // A reload: the lookup holds every line, the live log only the newest, which may have changed since.
    const newer = { ...lines[2]!, at: "2026-10-17T21:00:00.000Z" };
    const reloaded = tracker([newer], () => Promise.resolve({ parts: lines.map((line, part) => ({ part, state: "committed" as const, seq: Number(line.id.split(":")[0]), lines: [line] })).reverse() }));
    await reloaded.lookup("E");
    const merged = reloaded.state("E");
    assert.ok(merged?.state === "committed");
    assert.deepEqual(merged.lines, [lines[0], lines[1], newer], "each line once, in log order, the live one in place of the kept");
  });

  test("a settled tag no surface shows is announced once, and one a surface showed never", () => {
    const t = tracker([entry(dice({ tag: "A" })), entry(dice({ tag: "B" }))]);
    t.sending("A", 0);
    t.answer("A", 0, "taken");
    const stop = t.watch("B");
    t.sending("B", 0);
    t.answer("B", 0, "taken");
    assert.deepEqual(
      t.unannounced().map((u) => u.tag),
      ["A"],
    );
    assert.deepEqual(t.unannounced(), []);
    stop();
    t.announced("B");
    assert.deepEqual(t.unannounced(), []);
  });
});

describe("the header line's roll (docs/design-v1-dice-ui.md 4.1)", () => {
  const bite = (type: string, extra: Partial<DiceRoll>): DiceRoll => ({ formula: "3d10+7", faces: [3, 6, 6], total: 22, label: `Bite critical damage, ${type}`, tokenId: "t1", ...extra });

  test("a damage of two types reads as its sum under their shared label, with both parts' dice and crit sums (LP8-COMBAT-1)", () => {
    const piercing = bite("piercing", { total: 52, crit: "maxPlusRoll" });
    const fire = bite("fire", { formula: "2d6", faces: [2, 6], total: 20, crit: "maxPlusRoll" });
    assert.deepEqual(headerRoll([piercing, fire]), { total: 72, label: "Bite critical damage", sums: "30 max + 22, 12 max + 8", dice: [piercing, fire], more: 0 });
  });

  test("a damage of two types rolled twice reads as its sum with no crit sums", () => {
    const piercing = bite("piercing", { formula: "6d10+7", faces: [7, 7, 6, 10, 7, 6], total: 50, crit: "rollTwice" });
    const fire = bite("fire", { formula: "4d6", faces: [3, 4, 3, 5], total: 15, crit: "rollTwice" });
    assert.deepEqual(headerRoll([piercing, fire]), { total: 65, label: "Bite critical damage", sums: null, dice: [piercing, fire], more: 0 });
  });

  test("any other line leads with its first roll and counts the rest", () => {
    const saves = [1, 2, 3].map((i): DiceRoll => ({ formula: "1d20+2", faces: [i], total: i + 2, label: "Dexterity save", tokenId: `g${i}` }));
    assert.deepEqual(headerRoll(saves), { total: 3, label: "Dexterity save", sums: null, dice: [saves[0]!], more: 2 });
    const crit: DiceRoll = { formula: "2d6+3", faces: [4, 6], total: 25, label: "Scimitar critical damage, slashing", crit: "maxPlusRoll" };
    assert.deepEqual(headerRoll([crit]), { total: 25, label: "Scimitar critical damage, slashing", sums: "12 max + 13", dice: [crit], more: 0 });
    assert.equal(headerRoll([]), null);
  });
});
