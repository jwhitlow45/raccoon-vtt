import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEvent, displayLog, mergeLog, olderCursor, rollText, trimmedOff, type LogNames } from "./logText.ts";
import type { LogEntry, LogEvent, RollTest } from "./model.ts";
import { character, room, token } from "./testutil.ts";

const DEX: RollTest = { kind: "save", choices: [{ ability: "dex" }] };
const GRAPPLE: RollTest = { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] };

test("FU23A-OPUS-9c: private turn-end lines precede the next turn without changing paging ids", () => {
  const line = (id: string, data: LogEvent): LogEntry => ({ id, at: "2026-10-29T00:00:00Z", kind: "event", data });
  const previous = line("1:0", { type: "turn", entryId: "old", round: 1 });
  const turn = line("2:0", { type: "turn", entryId: "next", round: 1 });
  const start = line("2:1", { type: "area", templateId: "a", tokenId: "next", trigger: "turnStart", area: "Fire" });
  const end = line("2:100000", { type: "area", templateId: "hidden", tokenId: "old", trigger: "turnEnd", area: "Secret", hidden: true });
  const save = line("2:100001", { type: "saveEnds", effectId: "fx", key: "poisoned", tokenId: "old", ability: "con", dc: 15 });
  const later = line("3:100000", { type: "area", templateId: "a", tokenId: "old", trigger: "turnEnd", area: "Fire" });
  const stored = [previous, turn, start, end, save, later];
  assert.deepEqual(displayLog(stored), [previous, end, save, turn, start, later]);
  assert.deepEqual(stored, [previous, turn, start, end, save, later], "storage order remains untouched");
  assert.deepEqual(displayLog([previous, turn, start]), [previous, turn, start], "a player's view gains no extra line");
  assert.deepEqual(displayLog([end, save]), [end, save], "a partial archive page retains its lines");
});

describe("roll lines (docs/design-v1-dm-tools.md 3.3)", () => {
  test("read the total, the test and what the viewer's line kept of the DC and the result", () => {
    assert.equal(rollText({ type: "roll", test: DEX, total: 17, dc: 15, dcShown: true, resultShown: true, result: "pass" }, "Thorn"), "Thorn rolled 17 on a Dexterity saving throw against DC 15: pass.");
    assert.equal(rollText({ type: "roll", test: DEX, total: 17 }, "Thorn"), "Thorn rolled 17 on a Dexterity saving throw.");
    assert.equal(rollText({ type: "roll", test: GRAPPLE, choice: 1, total: 12, result: "fail" }, "Thorn"), "Thorn rolled 12 on a Dexterity (Acrobatics) check: fail.");
    assert.equal(rollText({ type: "roll", test: DEX, result: "fail" }, "Thorn"), "Thorn failed a Dexterity saving throw.");
    assert.equal(rollText({ type: "roll", test: DEX, noRoll: true }, "Thorn"), "Thorn failed a Dexterity saving throw without rolling.");
    assert.equal(rollText({ type: "roll", test: DEX, noRoll: true, result: "fail", dc: 12 }, "Thorn"), "Thorn failed a Dexterity saving throw against DC 12 without rolling.");
    assert.equal(rollText({ type: "roll", test: DEX, noRoll: true, result: "pass" }, "Thorn"), "Thorn passed a Dexterity saving throw.");
    assert.equal(rollText({ type: "roll", test: GRAPPLE, result: "pass", dc: 12 }, "Vex"), "Vex passed a Strength (Athletics) or Dexterity (Acrobatics) check against DC 12.");
  });

  test("the panel and the export render a roll line through describeEvent with the viewer's names", () => {
    const state = room({ characters: { c1: character("c1", { name: "Thorn" }) }, tokens: { t1: token("t1", { name: "Owl" }) } });
    const names: LogNames = state;
    const line: LogEvent = { type: "roll", test: DEX, characterId: "c1", total: 9 };
    assert.equal(describeEvent(line, names), "Thorn rolled 9 on a Dexterity saving throw.");
    assert.equal(describeEvent({ ...line, characterId: "gone" }, names), "A creature rolled 9 on a Dexterity saving throw.");
  });
});

describe("teleport lines (docs/design-v1-maps-vision.md 4.1)", () => {
  test("name what stopped the walk, or nothing past what the player could not see (docs/design-v1-map-discovery.md 6)", () => {
    const names: LogNames = room({ tokens: { t1: token("t1", { name: "Thorn" }) } });
    assert.equal(describeEvent({ type: "teleport", tokenId: "t1", past: "wall" }, names), "Thorn teleported past a wall.");
    assert.equal(describeEvent({ type: "teleport", tokenId: "t1", past: "ledge" }, names), "Thorn teleported past a ledge.");
    assert.equal(describeEvent({ type: "teleport", tokenId: "t1", past: "unknown" }, names), "Thorn teleported past something they could not see.");
  });
});

describe("Show older beside the trap logs (client/panels/LogPanel.tsx)", () => {
  const line = (id: string, type: "chat" | "trap" | "trapSeen"): LogEntry =>
    type === "chat"
      ? { id, at: "", kind: "chat", text: id }
      : { id, at: "", kind: "event", data: type === "trap" ? { type, trapId: "t1", sceneId: "s1", name: "Pit", how: "enter", by: [], hits: 0, did: [] } : { type, by: [], message: "Click." } };

  test("pages from the room log's oldest line, never an older trap line, and keeps every line an update trims", () => {
    // A trap went off at 1:0, ten chat lines followed, then the room log's own ring moved its start to 12:0.
    const trapLog = [line("1:900000", "trap")];
    const trapSeen = [line("1:0", "trapSeen")];
    const mainLog = [line("12:0", "chat"), line("13:0", "chat")];
    const shown = mergeLog(mergeLog(trapLog, trapSeen), mainLog);
    assert.equal(shown[0]!.id, "1:0", "the merged log starts with the trap's line");
    assert.equal(olderCursor(mainLog, undefined), "12:0", "so the chat lines 2 to 11 come on the first page");
    assert.equal(olderCursor(mainLog, "5:0"), "5:0", "a later page starts where the last one said");
    // The next update trims 12:0 off the front of the room log, and the trap lines stay where they were.
    const next = [line("13:0", "chat"), line("14:0", "chat")];
    assert.deepEqual(trimmedOff(shown, next).map((e) => e.id), ["1:0", "1:900000", "12:0"]);
    assert.deepEqual(olderCursor(next, undefined), "13:0");
  });
});

