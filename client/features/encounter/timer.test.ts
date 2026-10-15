import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { apply, DM, P1, room, token } from "#shared/testutil.ts";
import { MAX_TURN_TIMER_SEC } from "#shared/protocol.ts";
import { clockText, TIMER_CHOICES, timerChoices, timerState, turnStartedAt } from "./timer.ts";

const line = (id: string, at: string, data: LogEntry["data"]): LogEntry => ({ id, at, kind: "event", data });

describe("the turn timer", () => {
  test("a turn counts from its own log line, and Previous restarts the turn it goes back to", () => {
    const log = [
      line("1:0", "2026-10-13T20:00:00.000Z", { type: "turn", entryId: "a", round: 1, seen: true }),
      line("2:0", "2026-10-13T20:01:00.000Z", { type: "hp", tokenId: "t", change: "damage", amount: 3 }),
      line("3:0", "2026-10-13T20:02:00.000Z", { type: "turn", entryId: "b", round: 1, seen: true }),
    ];
    assert.equal(turnStartedAt(log, "b", 1), Date.parse("2026-10-13T20:02:00.000Z"));
    // The newest line is about another row, as when this turn began out of the viewer's sight: this device counts from when it saw the turn.
    assert.equal(turnStartedAt(log, "a", 1), null);
    const back = [...log, line("4:0", "2026-10-13T20:03:00.000Z", { type: "turn", entryId: "b", round: 1, back: true, seen: true, to: "a" })];
    assert.equal(turnStartedAt(back, "a", 1, 1), Date.parse("2026-10-13T20:03:00.000Z"), "a's turn, started by op 1, resumed");
    assert.equal(turnStartedAt(log, null, 1), null);
    assert.equal(turnStartedAt([], "a", 1), null);
  });

  test("a line taken back counts only for the turn it resumed", () => {
    const at = (m: number) => `2026-10-13T20:0${m}:00.000Z`;
    // b's turn is taken back at op 4 and a resumes. Then b's new turn starts at op 5 in the fog, a line this viewer lacks.
    const log = [
      line("1:0", at(0), { type: "turn", entryId: "a", round: 1, seen: true }),
      line("3:0", at(2), { type: "turn", entryId: "b", round: 1, seen: true }),
      line("4:0", at(3), { type: "turn", entryId: "b", round: 1, back: true, seen: true, to: "a" }),
    ];
    assert.equal(turnStartedAt(log, "b", 1, 5), null, "b's new turn did not start when its old one was taken back");
    // A later row's turn, after the same take-back, did not start then either.
    assert.equal(turnStartedAt(log, "c", 1, 6), null);
    assert.equal(turnStartedAt(log, "a", 1, 1), Date.parse(at(3)), "a, which it resumed");
    assert.equal(turnStartedAt(log, "a", 1), null, "without the turn's seq it cannot be placed");
    // One row alone: Previous resumes that same row's earlier turn.
    const alone = [line("7:0", at(4), { type: "turn", entryId: "a", round: 3, seen: true }), line("8:0", at(5), { type: "turn", entryId: "a", round: 3, back: true, seen: true, to: "a" })];
    assert.equal(turnStartedAt(alone, "a", 2, 6), Date.parse(at(5)));
  });

  test("two Previous presses over a hidden turn: the take-back players hold resumed the hidden turn, not the acting one", () => {
    // A and C in sight, B hidden. B's and C's turns run, then the DM goes back twice, to A.
    let state = room();
    state.tokens.a = token("a", { name: "A", x: 1, y: 1 });
    state.tokens.b = token("b", { name: "B", x: 2, y: 1, visibility: "dm" });
    state.tokens.c = token("c", { name: "C", x: 3, y: 1 });
    const ops: Op[] = [
      { t: "encounter.start", entries: [{ id: "na", tokenId: "a", value: 20 }, { id: "nb", tokenId: "b", value: 15, hidden: true }, { id: "nc", tokenId: "c", value: 10 }] },
      { t: "encounter.next" },
      { t: "encounter.next" },
      { t: "encounter.next" },
      { t: "encounter.prev" },
      { t: "encounter.prev" },
    ];
    ops.forEach((op, i) => (state = apply(state, op, DM, i + 1)));
    const theirs = projectState(state, P1, { sceneId: "s1" });
    assert.equal(theirs.encounter!.activeEntryId, "na");
    const backs = theirs.log.filter((e) => e.data?.type === "turn" && e.data.back);
    assert.deepEqual(backs.map((e) => e.data), [{ type: "turn", entryId: "nc", round: 1, back: true, seen: true }], "they never saw B resume, nor B's take-back");
    const turnSeq = theirs.encounter!.turnStart?.seq;
    assert.equal(turnStartedAt(theirs.log, "na", theirs.encounter!.round, turnSeq), null, "so A's clock counts from when the device saw it");
    // The DM, who holds every line, counts A from the last take-back, which resumed A.
    const mine = projectState(state, DM, { sceneId: "s1" });
    assert.equal(turnStartedAt(mine.log, "na", mine.encounter!.round, mine.encounter!.turnStart?.seq), Date.parse(mine.log.at(-1)!.at));
  });

  test("the same row's line from an earlier round is not this turn's start", () => {
    // Round 2's turns before b's, and b's own start, were out of this viewer's sight.
    const log = [line("3:0", "2026-10-13T20:02:00.000Z", { type: "turn", entryId: "b", round: 1, seen: true })];
    assert.equal(turnStartedAt(log, "b", 2), null);
    assert.equal(turnStartedAt(log, "b", 1), Date.parse("2026-10-13T20:02:00.000Z"));
  });

  test("the reducer's own turn lines carry the time the turn began", () => {
    let state = room();
    state.tokens.a = token("a");
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "a", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    assert.equal(turnStartedAt(state.log, "n1", state.encounter!.round), Date.parse(state.log.at(-1)!.at));
  });

  test("the choices reach the longest timer the room takes, and a timer that is none of them shows as its own", () => {
    assert.equal(Math.max(...TIMER_CHOICES.map((c) => c.value)), MAX_TURN_TIMER_SEC);
    assert.deepEqual(timerChoices(600), [...TIMER_CHOICES]);
    assert.deepEqual(
      timerChoices(250).map((c) => c.label),
      ["Off", "30 seconds", "1 minute", "2 minutes", "3 minutes", "4 min 10 s", "5 minutes", "10 minutes"],
    );
    assert.equal(timerChoices(45).find((c) => c.value === 45)?.label, "45 s");
    assert.equal(timerChoices(240).find((c) => c.value === 240)?.label, "4 min");
  });

  test("it counts down in whole seconds, warns near the end, and counts the time past it", () => {
    const start = 1_000_000;
    assert.deepEqual(timerState(60, start, start + 500), { left: 60, over: false, warning: false });
    assert.equal(clockText(timerState(60, start, start + 500)), "1:00");
    assert.deepEqual(timerState(60, start, start + 51_000), { left: 9, over: false, warning: true });
    assert.equal(clockText(timerState(60, start, start + 51_000)), "0:09");
    assert.deepEqual(timerState(60, start, start + 60_000), { left: 0, over: true, warning: false });
    assert.equal(clockText(timerState(60, start, start + 60_000)), "0:00");
    assert.equal(clockText(timerState(60, start, start + 72_400)), "+0:12");
    // A clock a little ahead of the server never shows more than the whole turn.
    assert.equal(timerState(30, start, start - 2_000).left, 30);
  });
});
