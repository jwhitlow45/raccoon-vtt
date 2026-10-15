import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/api.ts";
import type { AdminRoom, BackupRun } from "./api.ts";
import { ago, backupLines, confirmsRoom, loginErrorText, sortRooms } from "./format.ts";

const room = (id: string, name: string, bytes: number, lastActiveAt: string): AdminRoom => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00Z",
  lastActiveAt,
  bytes,
  images: 0,
  loaded: false,
  sockets: 0,
  pinned: false,
  readOnly: false,
});

describe("the admin page's wording", () => {
  test("rooms sort by last activity or by size, ties by name and ID", () => {
    const rooms = [
      room("AAAAAAAA", "Crypt", 10, "2026-10-01T00:00:00Z"),
      room("BBBBBBBB", "Abbey", 30, "2026-10-14T00:00:00Z"),
      room("CCCCCCCC", "Bog", 30, "2026-10-01T00:00:00Z"),
    ];
    assert.deepEqual(sortRooms(rooms, "active").map((r) => r.id), ["BBBBBBBB", "CCCCCCCC", "AAAAAAAA"]);
    assert.deepEqual(sortRooms(rooms, "size").map((r) => r.id), ["BBBBBBBB", "CCCCCCCC", "AAAAAAAA"]);
    assert.deepEqual(rooms.map((r) => r.id), ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"], "the list given is left as it was");
  });

  test("times read as how long ago", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    assert.equal(ago("2026-10-14T11:59:30Z", now), "just now");
    assert.equal(ago("2026-10-14T11:55:00Z", now), "5 minutes ago");
    assert.equal(ago("2026-10-14T11:00:00Z", now), "1 hour ago");
    assert.equal(ago("2026-10-12T12:00:00Z", now), "2 days ago");
    assert.match(ago("2026-08-01T12:00:00Z", now), /^on /);
  });

  test("the room ID typed to confirm a delete may have the dash, any case and spaces", () => {
    assert.equal(confirmsRoom(" k7qh-2mxa ", "K7QH2MXA"), true);
    assert.equal(confirmsRoom("K7QH2MXA", "K7QH2MXA"), true);
    assert.equal(confirmsRoom("K7QH2MXB", "K7QH2MXA"), false);
    assert.equal(confirmsRoom("", "K7QH2MXA"), false);
  });

  test("a backup run says what became of it", () => {
    const run = (outcome: BackupRun["outcome"], extra: Partial<BackupRun> = {}): BackupRun => ({
      id: "r",
      startedAt: "2026-10-14T04:00:00Z",
      finishedAt: "2026-10-14T04:01:00Z",
      outcome,
      dump: "raccoon-2026-10-14-040000-r.dump",
      dumpBytes: 2_500_000,
      imagesCopied: 12,
      error: null,
      ...extra,
    });
    const good = backupLines(run("good"));
    assert.match(good.title, /^Good, /);
    assert.equal(good.detail, "3 MB dump, 12 images copied.");
    assert.match(backupLines(run("partial")).detail ?? "", /^The images did not all fit/);
    assert.match(backupLines(run("failed", { error: "pg_dump failed", dumpBytes: null, imagesCopied: null })).detail ?? "", /^pg_dump failed$/);
    assert.match(backupLines(run("running", { finishedAt: null })).title, /^Running, started /);
  });

  test("refused logins are worded for a person", () => {
    assert.equal(loginErrorText(new ApiError(403, "x", "bad_password", null)), "That is not the admin password.");
    assert.equal(loginErrorText(new ApiError(429, "x", "rate_limited", 90_000)), "Too many wrong passwords. Try again in 2 minutes.");
    assert.equal(loginErrorText(new ApiError(429, "x", "rate_limited", 3_600_000)), "Too many wrong passwords. Try again in 60 minutes.");
    assert.match(loginErrorText(new ApiError(403, "x", "turnstile_failed", null)), /human check/);
    assert.equal(loginErrorText(new Error("boom")), "Something went wrong. Try again.");
  });
});
