import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AssetError } from "./errors.ts";
import { hourlyChecks, WindowLimiter } from "./limits.ts";
import { RoomQuota } from "./quota.ts";

/*
 * A player's upload and the room's storage (docs/design/design-v1-player-limits.md
 * 6.5): it is refused for space only once the room is already at its quota,
 * never by what else is stored or on its way, and it spends a budget of the
 * player's own in place of the room's. So two rooms whose DMs uploaded
 * different amounts answer a player's upload alike while neither is full.
 */

const quota413 = (err: unknown) => err instanceof AssetError && err.status === 413 && err.code === "quota_exceeded";

function store(bytes: number) {
  const stored = new Map([["R", bytes]]);
  return { stored, read: async (roomId: string) => stored.get(roomId) ?? 0 };
}

describe("a player's upload and the room's quota", () => {
  test("is taken while the room is under its quota, whatever the DM stored or has on its way", async () => {
    for (const stored of [0, 900, 999]) {
      const s = store(stored);
      const quota = new RoomQuota(1_000, s.read);
      // The DM's own upload in flight, which a player's answer never reads.
      const dm = stored < 900 ? await quota.reserve("R", 50) : null;
      const mine = await quota.reserve("R", 400, { player: true });
      assert.equal(await mine.commit(500, async () => "written"), "written", `${stored} stored`);
      dm?.release();
    }
  });

  test("is refused once the room is at its quota, at its reservation and at its commit", async () => {
    const at = store(1_000);
    await assert.rejects(new RoomQuota(1_000, at.read).reserve("R", 1, { player: true }), quota413);
    const s = store(999);
    const quota = new RoomQuota(1_000, s.read);
    const mine = await quota.reserve("R", 400, { player: true });
    s.stored.set("R", 1_000);
    await assert.rejects(mine.commit(400, async () => "written"), quota413);
  });

  test("leaves the DM's upload answered as today: stored, reserved, its size and headroom", async () => {
    const s = store(600);
    const quota = new RoomQuota(1_000, s.read);
    const mine = await quota.reserve("R", 300, { player: true });
    await assert.rejects(quota.reserve("R", 101), quota413);
    await assert.rejects(quota.reserve("R", 50, { headroom: 51 }), quota413);
    mine.release();
    assert.equal(quota.reservedBytes("R"), 0);
  });
});

describe("a player's hourly upload budget", () => {
  test("is their member's own, 30 an hour, in place of the room's 120, and a new session does not renew it", () => {
    const checks = hourlyChecks("s1", "ip", "R", "token", { memberId: "p1" });
    assert.deepEqual(checks.map((c) => [c.key, c.limit]), [["s:s1", 30], ["ip:ip", 60], ["m:R:p1", 30]]);
    assert.deepEqual(hourlyChecks("s1", "ip", "R", "token").map((c) => c.key), ["s:s1", "ip:ip", "r:R"], "the DM's spends the room's");
    let now = 0;
    const hourly = new WindowLimiter(3_600_000, () => now);
    // The DM spends the room's whole budget: a player's upload still goes up.
    for (let i = 0; i < 120; i++) hourly.record(hourlyChecks(`dm${i % 4}`, `ip${i}`, "R", "token"));
    assert.equal(hourly.retryAfter(hourlyChecks("s1", "ipA", "R", "token", { memberId: "p1" })), 0);
    // The player's own 30, spread over sessions and addresses, spend their member's.
    for (let i = 0; i < 30; i++) hourly.record(hourlyChecks(`s${i}`, `ipP${i}`, "R", "map", { memberId: "p1" }));
    now = 1_000;
    assert.ok(hourly.retryAfter(hourlyChecks("fresh", "ipZ", "R", "token", { memberId: "p1" })) > 0);
    assert.equal(hourly.retryAfter(hourlyChecks("other", "ipY", "R", "token", { memberId: "p2" })), 0, "another player's is their own");
  });
});
