import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AssetError } from "./errors.ts";
import { assertFreeDisk, hasFreeDisk, ROOM_ARCHIVE_BYTES_SQL, ROOM_QUOTA_BYTES_SQL, RoomQuota } from "./quota.ts";

function quota413(err: unknown): boolean {
  return err instanceof AssetError && err.status === 413 && err.code === "quota_exceeded";
}

/** A fake room store: committed bytes per room, read with a delay like a real query. */
function fakeStore() {
  const stored = new Map<string, number>();
  return {
    stored,
    read: async (roomId: string) => {
      await new Promise((r) => setTimeout(r, 2));
      return stored.get(roomId) ?? 0;
    },
  };
}

describe("RoomQuota", () => {
  test("reserves within the quota and refuses past it", async () => {
    const store = fakeStore();
    store.stored.set("R", 600);
    const quota = new RoomQuota(1000, store.read);
    const a = await quota.reserve("R", 300);
    assert.equal(quota.reservedBytes("R"), 300);
    await assert.rejects(quota.reserve("R", 101), quota413);
    a.release();
    a.release();
    assert.equal(quota.reservedBytes("R"), 0);
  });

  test("concurrent reservations cannot overshoot", async () => {
    const store = fakeStore();
    const quota = new RoomQuota(1000, store.read);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => quota.reserve("R", 300)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal(quota.reservedBytes("R"), 900);
  });

  test("a commit no larger than the reservation always fits", async () => {
    const store = fakeStore();
    const quota = new RoomQuota(1000, store.read);
    const res = await quota.reserve("R", 1000);
    await res.commit(800, async () => void store.stored.set("R", 800));
    assert.equal(quota.reservedBytes("R"), 0);
    assert.equal(store.stored.get("R"), 800);
  });

  test("variants larger than the reservation reserve the difference before writing", async () => {
    const store = fakeStore();
    store.stored.set("R", 100);
    const quota = new RoomQuota(1000, store.read);
    const res = await quota.reserve("R", 50);
    let wrote = false;
    await res.commit(800, async () => {
      wrote = true;
      store.stored.set("R", 900);
    });
    assert.ok(wrote);
    assert.equal(quota.reservedBytes("R"), 0);
  });

  test("variants that outgrow the room's space are refused and nothing is written", async () => {
    const store = fakeStore();
    store.stored.set("R", 100);
    const quota = new RoomQuota(1000, store.read);
    const other = await quota.reserve("R", 500);
    const res = await quota.reserve("R", 50);
    let wrote = false;
    await assert.rejects(
      res.commit(450, async () => {
        wrote = true;
      }),
      quota413,
    );
    assert.equal(wrote, false);
    res.release();
    other.release();
    assert.equal(quota.reservedBytes("R"), 0);
  });

  test("a reservation is released only after its write, so no reader sees the bytes vanish", async () => {
    const store = fakeStore();
    const quota = new RoomQuota(1000, store.read);
    const first = await quota.reserve("R", 600);
    const commit = first.commit(600, async () => {
      await new Promise((r) => setTimeout(r, 10));
      store.stored.set("R", 600);
    });
    // Queued behind the commit on the room lock, so it sees 600 stored.
    await assert.rejects(quota.reserve("R", 600), quota413);
    await commit;
  });

  test("rooms are independent", async () => {
    const store = fakeStore();
    const quota = new RoomQuota(1000, store.read);
    await quota.reserve("A", 1000);
    await quota.reserve("B", 1000);
    assert.equal(quota.reservedBytes("A"), 1000);
  });
});

describe("the free-disk floor", () => {
  test("is one check for uploads and the log archive: met, not met, or off", async () => {
    const here = import.meta.dirname;
    assert.equal(await hasFreeDisk(here, 0), true);
    assert.equal(await hasFreeDisk(here, 1), true);
    assert.equal(await hasFreeDisk(here, Number.MAX_SAFE_INTEGER), false);
    await assert.rejects(assertFreeDisk(here, Number.MAX_SAFE_INTEGER), (err: unknown) => err instanceof AssetError && err.status === 507);
    await assert.rejects(hasFreeDisk("/no/such/volume/here", 1));
  });

  test("the quota's sum leaves the log archive out, which only a room's size on disk counts", () => {
    assert.doesNotMatch(ROOM_QUOTA_BYTES_SQL, /room_log/);
    assert.match(ROOM_ARCHIVE_BYTES_SQL, /from room_log/);
  });
});
