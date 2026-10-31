import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, dispositionFileName, FileCutShortError } from "../../lib/api.ts";
import { everythingLabel, EXPORT_LIMIT_NOTE, exportErrorText, LARGE_FILE_NOTE, sessionKey, sessionLabel, sessionRange, whileOpen, withOlderAnswer, withOlderSessions, type SessionList } from "./exportLog.ts";

const now = new Date("2026-10-20T12:00:00Z");
const opts = { locale: "en-US", timeZone: "America/Chicago", now };

describe("the log export sheet", () => {
  test("a session reads as its evening in the device's time", () => {
    assert.equal(sessionLabel({ firstId: "1:0", lastId: "2:0", from: "2026-10-15T00:02:00Z", to: "2026-10-15T03:48:00Z", lines: 412 }, opts), "Wednesday, October 14, 7:02 PM to 10:48 PM, 412 lines");
  });

  test("a session past midnight names its second day, a lone line has no range, and an older year is named", () => {
    assert.equal(sessionLabel({ firstId: "1:0", lastId: "2:0", from: "2026-10-15T03:30:00Z", to: "2026-10-15T06:10:00Z", lines: 2 }, opts), "Wednesday, October 14, 10:30 PM to Thursday, October 15, 1:10 AM, 2 lines");
    assert.equal(sessionLabel({ firstId: "1:0", lastId: "2:0", from: "2026-10-15T00:02:00Z", to: "2026-10-15T00:02:00Z", lines: 1 }, opts), "Wednesday, October 14, 7:02 PM, 1 line");
    assert.equal(sessionLabel({ firstId: "1:0", lastId: "2:0", from: "2026-10-15T00:02:05Z", to: "2026-10-15T00:02:40Z", lines: 3 }, opts), "Wednesday, October 14, 7:02 PM, 3 lines");
    assert.match(sessionLabel({ firstId: "1:0", lastId: "2:0", from: "2025-10-15T00:02:00Z", to: "2025-10-15T01:00:00Z", lines: 3 }, opts), /^Tuesday, October 14, 2025, 7:02 PM to 8:00 PM, 3 lines$/);
  });

  test("everything counts every line", () => {
    assert.equal(everythingLabel(2104, "en-US"), "Everything, 2,104 lines");
  });

  test("the server's refusals in plain words", () => {
    assert.match(exportErrorText(new ApiError(429, "x", "busy", 2000)), /exporting the log right now/);
    assert.equal(exportErrorText(new ApiError(429, "x", "rate_limited", 125_000)), "Too many log exports this hour. Try again in 3 minutes.");
    assert.equal(exportErrorText(new ApiError(429, "x", "rate_limited", 20_000)), "Too many log exports this hour. Try again in a minute.");
    assert.match(exportErrorText(new ApiError(0, "x", "network", null)), /Could not reach the server/);
    assert.equal(exportErrorText(new FileCutShortError()), "The log could not be exported. The file stopped before its end. Try again.");
  });

  test("sessions whose clock ran back keep apart by their ids, label by their times, and export by their ids", () => {
    // One day in Chicago: an evening from 10:00, one from 16:00, then a clock set back to 09:00. The newest
    // session by id is labeled earliest, and a fourth repeats its times exactly.
    const sessions = [
      { firstId: "300:0", lastId: "340:2", from: "2026-10-15T14:00:00Z", to: "2026-10-15T15:00:00Z", lines: 41 },
      { firstId: "200:0", lastId: "250:0", from: "2026-10-15T21:00:00Z", to: "2026-10-15T22:00:00Z", lines: 51 },
      { firstId: "100:0", lastId: "150:0", from: "2026-10-15T15:00:00Z", to: "2026-10-15T16:00:00Z", lines: 51 },
      { firstId: "90:0", lastId: "95:0", from: "2026-10-15T14:00:00Z", to: "2026-10-15T15:00:00Z", lines: 41 },
    ];
    const labels = sessions.map((s) => sessionLabel(s, opts));
    assert.deepEqual(labels.slice(0, 3), [
      "Thursday, October 15, 9:00 AM to 10:00 AM, 41 lines",
      "Thursday, October 15, 4:00 PM to 5:00 PM, 51 lines",
      "Thursday, October 15, 10:00 AM to 11:00 AM, 51 lines",
    ]);
    assert.equal(new Set(sessions.map(sessionKey)).size, 4, "two sessions with one time range keep two keys");
    assert.equal(labels[0], labels[3]);
    assert.deepEqual(sessions.map(sessionRange), [
      { fromId: "300:0", toId: "340:2" },
      { fromId: "200:0", toId: "250:0" },
      { fromId: "100:0", toId: "150:0" },
      { fromId: "90:0", toId: "95:0" },
    ]);
  });

  test("an Older sessions answer lands only on the list it was asked for, and a failure says so in place", () => {
    const s = (id: number) => ({ firstId: `${id}:0`, lastId: `${id}:9`, from: "2026-10-15T14:00:00Z", to: "2026-10-15T15:00:00Z", lines: 10 });
    const list: SessionList = { kind: "ready", sessions: [s(300), s(200)], lines: 20, next: "200:0", more: { kind: "busy" } };
    const landed = withOlderAnswer(list, "200:0", { sessions: [s(100)], lines: 31, nextSessionsBefore: null });
    assert.deepEqual(landed.kind === "ready" ? [landed.sessions.map(sessionKey), landed.lines, landed.next, landed.more.kind] : null, [["300:0|300:9", "200:0|200:9", "100:0|100:9"], 31, null, "idle"]);
    // Asked before 200:0, answered after the list moved on: nothing changes.
    const moved: SessionList = { ...list, next: "100:0" };
    assert.equal(withOlderAnswer(moved, "200:0", { sessions: [s(50)], lines: 40, nextSessionsBefore: null }), moved);
    assert.equal(withOlderAnswer(moved, "200:0", { failed: "x" }), moved);
    const failed = withOlderAnswer(list, "200:0", { failed: "The log could not be exported. Try again." });
    assert.deepEqual(failed.kind === "ready" ? [failed.sessions.length, failed.next, failed.more] : null, [2, "200:0", { kind: "error", message: "The log could not be exported. Try again." }]);
  });

  test("the sheet is open again after StrictMode's setup, cleanup and setup", () => {
    const open = { current: false };
    let closed = 0;
    const close = () => closed++;
    const cleanup = whileOpen(open, close);
    assert.equal(open.current, true);
    cleanup();
    assert.deepEqual([open.current, closed], [false, 1]);
    whileOpen(open, close);
    assert.equal(open.current, true, "an answer after the second setup would be dropped");
  });

  test("an older page of sessions goes after the held ones, each once", () => {
    const a = { firstId: "300:0", lastId: "340:2", from: "x", to: "y", lines: 1 };
    const b = { firstId: "200:0", lastId: "250:0", from: "x", to: "y", lines: 1 };
    const c = { firstId: "100:0", lastId: "150:0", from: "x", to: "y", lines: 1 };
    assert.deepEqual(withOlderSessions([a, b], [b, c]), [a, b, c]);
  });

  test("the sheet's words", () => {
    assert.equal(LARGE_FILE_NOTE, "This file is large. Use Download to save it. Download uses another export request.");
    assert.equal(EXPORT_LIMIT_NOTE, "Opening this list, Older sessions, and each export or download count toward 10 an hour.");
  });

  test("the file keeps the name the server gave it", () => {
    assert.equal(dispositionFileName('attachment; filename="crypt-crawlers-log-2026-10-14.md"'), "crypt-crawlers-log-2026-10-14.md");
    assert.equal(dispositionFileName(null), null);
    assert.equal(dispositionFileName("attachment"), null);
  });
});
