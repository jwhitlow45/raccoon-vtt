import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, dispositionFileName } from "../../lib/api.ts";
import { everythingLabel, exportErrorText, sessionLabel } from "./exportLog.ts";

const now = new Date("2026-10-20T12:00:00Z");
const opts = { locale: "en-US", timeZone: "America/Chicago", now };

describe("the log export sheet", () => {
  test("a session reads as its evening in the device's time", () => {
    assert.equal(sessionLabel({ from: "2026-10-15T00:02:00Z", to: "2026-10-15T03:48:00Z", lines: 412 }, opts), "Wednesday, October 14, 7:02 PM to 10:48 PM, 412 lines");
  });

  test("a session past midnight names its second day, a lone line has no range, and an older year is named", () => {
    assert.equal(sessionLabel({ from: "2026-10-15T03:30:00Z", to: "2026-10-15T06:10:00Z", lines: 2 }, opts), "Wednesday, October 14, 10:30 PM to Thursday, October 15, 1:10 AM, 2 lines");
    assert.equal(sessionLabel({ from: "2026-10-15T00:02:00Z", to: "2026-10-15T00:02:00Z", lines: 1 }, opts), "Wednesday, October 14, 7:02 PM, 1 line");
    assert.equal(sessionLabel({ from: "2026-10-15T00:02:05Z", to: "2026-10-15T00:02:40Z", lines: 3 }, opts), "Wednesday, October 14, 7:02 PM, 3 lines");
    assert.match(sessionLabel({ from: "2025-10-15T00:02:00Z", to: "2025-10-15T01:00:00Z", lines: 3 }, opts), /^Tuesday, October 14, 2025, 7:02 PM to 8:00 PM, 3 lines$/);
  });

  test("everything counts every line", () => {
    assert.equal(everythingLabel(2104, "en-US"), "Everything, 2,104 lines");
  });

  test("the server's refusals in plain words", () => {
    assert.match(exportErrorText(new ApiError(429, "x", "busy", 2000)), /exporting the log right now/);
    assert.equal(exportErrorText(new ApiError(429, "x", "rate_limited", 125_000)), "Too many log exports this hour. Try again in 3 minutes.");
    assert.equal(exportErrorText(new ApiError(429, "x", "rate_limited", 20_000)), "Too many log exports this hour. Try again in a minute.");
    assert.match(exportErrorText(new ApiError(0, "x", "network", null)), /Could not reach the server/);
  });

  test("the file keeps the name the server gave it", () => {
    assert.equal(dispositionFileName('attachment; filename="crypt-crawlers-log-2026-10-14.md"'), "crypt-crawlers-log-2026-10-14.md");
    assert.equal(dispositionFileName(null), null);
    assert.equal(dispositionFileName("attachment"), null);
  });
});
