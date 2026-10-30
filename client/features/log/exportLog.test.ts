import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, dispositionFileName, FileCutShortError } from "../../lib/api.ts";
import { everythingLabel, EXPORT_LIMIT_NOTE, exportErrorText, LARGE_FILE_NOTE, sessionKey, sessionLabel, sessionRange, withOlderSessions } from "./exportLog.ts";

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
    // 10:00, then 16:00, then a clock set back to 09:00: three evenings, the last labeled before the first.
    const sessions = [
      { firstId: "300:0", lastId: "340:2", from: "2026-10-16T14:00:00Z", to: "2026-10-16T15:00:00Z", lines: 41 },
      { firstId: "200:0", lastId: "250:0", from: "2026-10-15T21:00:00Z", to: "2026-10-15T22:00:00Z", lines: 51 },
      { firstId: "100:0", lastId: "150:0", from: "2026-10-15T15:00:00Z", to: "2026-10-15T16:00:00Z", lines: 51 },
      { firstId: "90:0", lastId: "95:0", from: "2026-10-16T14:00:00Z", to: "2026-10-16T15:00:00Z", lines: 41 },
    ];
    const keys = sessions.map(sessionKey);
    assert.equal(new Set(keys).size, 4, "two sessions with one time range keep two keys");
    assert.equal(sessionLabel(sessions[0]!, opts), sessionLabel(sessions[3]!, opts));
    assert.deepEqual(sessionRange(sessions[3]!), { fromId: "90:0", toId: "95:0" });
    assert.equal(sessionLabel(sessions[0]!, opts), "Friday, October 16, 9:00 AM to 10:00 AM, 41 lines");
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
