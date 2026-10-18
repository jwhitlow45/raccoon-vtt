import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HANDOUT_HOURLY, STARTER_HOURLY, WindowLimiter, hourlyChecks, starterHourlyChecks } from "./limits.ts";

describe("hourlyChecks (design 10.3, docs/design-v1-pdf-handouts.md 3.7)", () => {
  test("a token, a map and a URL import spend the shared budget, per session, IP and room", () => {
    const shared = [
      { key: "s:sess", limit: 30 },
      { key: "ip:1.2.3.0/24", limit: 60 },
      { key: "r:ROOM0001", limit: 120 },
    ];
    assert.deepEqual(hourlyChecks("sess", "1.2.3.0/24", "ROOM0001", "token"), shared);
    assert.deepEqual(hourlyChecks("sess", "1.2.3.0/24", "ROOM0001", "map"), shared);
    assert.deepEqual(hourlyChecks("sess", "1.2.3.0/24", "ROOM0001"), shared);
  });

  test("a thumbnail and a handout spend only their own, per session and per room", () => {
    assert.deepEqual(hourlyChecks("sess", "ip", "ROOM0001", "thumb"), [
      { key: "thumb:s:sess", limit: 240 },
      { key: "thumb:r:ROOM0001", limit: 240 },
    ]);
    assert.deepEqual(hourlyChecks("sess", "ip", "ROOM0001", "handout"), [
      { key: "handout:s:sess", limit: HANDOUT_HOURLY.session },
      { key: "handout:r:ROOM0001", limit: HANDOUT_HOURLY.room },
    ]);
  });

  test("a starter pick spends a budget of its own, per session, IP and room, apart from every upload's", () => {
    assert.deepEqual(starterHourlyChecks("sess", "1.2.3.0/24", "ROOM0001"), [
      { key: "starter:s:sess", limit: STARTER_HOURLY.session },
      { key: "starter:ip:1.2.3.0/24", limit: STARTER_HOURLY.ip },
      { key: "starter:r:ROOM0001", limit: STARTER_HOURLY.room },
    ]);
    const hourly = new WindowLimiter(3600_000, () => 0);
    const picks = starterHourlyChecks("dm", "ip", "ROOM0001");
    for (let i = 0; i < STARTER_HOURLY.session; i++) hourly.record(picks);
    assert.ok(hourly.retryAfter(picks) > 0, "past its own limit");
    for (const kind of ["map", "token", "handout"] as const) assert.equal(hourly.retryAfter(hourlyChecks("dm", "ip", "ROOM0001", kind)), 0, kind);
  });

  test("two documents at the page cap fit in an hour, and the next page waits while maps and tokens still go up", () => {
    let now = 0;
    const hourly = new WindowLimiter(3600_000, () => now);
    const pages = hourlyChecks("dm", "ip", "ROOM0001", "handout");
    for (let i = 0; i < 2 * 100; i++) {
      assert.equal(hourly.retryAfter(pages), 0, `page ${i + 1}`);
      hourly.record(pages);
      now += 1_000;
    }
    for (let i = 200; i < HANDOUT_HOURLY.session; i++) hourly.record(pages);
    assert.ok(hourly.retryAfter(pages) > 0, "past its own limit");
    assert.equal(hourly.retryAfter(hourlyChecks("dm", "ip", "ROOM0001", "map")), 0);
    assert.equal(hourly.retryAfter(hourlyChecks("dm", "ip", "ROOM0001", "token")), 0);
  });
});
