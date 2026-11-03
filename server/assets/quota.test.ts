import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type pg from "pg";
import { loadConfig } from "../config.ts";
import { AssetError } from "./errors.ts";
import { assertFreeDisk, hasFreeDisk, ROOM_ARCHIVE_BYTES_SQL, ROOM_QUOTA_BYTES_SQL, RoomQuota } from "./quota.ts";
import { AssetService } from "./service.ts";

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

  test("a live video's reservation leaves its headroom free, at reserve and at commit (docs/design/design-v1-animated-maps.md 6.3)", async () => {
    const store = fakeStore();
    store.stored.set("R", 600);
    const quota = new RoomQuota(1000, store.read);
    await assert.rejects(quota.reserve("R", 300, { headroom: 101 }), quota413);
    const fits = await quota.reserve("R", 300, { headroom: 100 });
    assert.equal(quota.reservedBytes("R"), 300, "the headroom is no reservation of its own");
    fits.release();
    // Variants that outgrow the reservation must still leave the headroom beside them.
    const small = await quota.reserve("R", 100, { headroom: 100 });
    await assert.rejects(small.commit(301, async () => undefined), quota413);
    small.release();
    const again = await quota.reserve("R", 100, { headroom: 100 });
    await again.commit(300, async () => undefined);
  });

  test("a video's commit checks its headroom again, even at its reserved size (AMBUILD-SOL-004)", async () => {
    // The reviewer's interleaving: a video reserves 600 with 320 of headroom, an image reserves and stores 400 meanwhile.
    const store = fakeStore();
    const quota = new RoomQuota(1000, store.read);
    const video = await quota.reserve("R", 600, { headroom: 320 });
    const image = await quota.reserve("R", 400);
    await image.commit(400, async () => void store.stored.set("R", 400));
    let wrote = false;
    await assert.rejects(video.commit(600, async () => void (wrote = true)), quota413);
    assert.equal(wrote, false);
    video.release();
    assert.equal(quota.reservedBytes("R"), 0);
    // The room's own writes during a long upload count the same.
    store.stored.set("R", 600);
    const later = await quota.reserve("R", 300, { headroom: 100 });
    store.stored.set("R", 650);
    await assert.rejects(later.commit(300, async () => undefined), quota413);
    later.release();
    // With the headroom still free, it commits.
    store.stored.set("R", 600);
    const fits = await quota.reserve("R", 300, { headroom: 100 });
    await fits.commit(300, async () => undefined);
  });

  test("the headroom is checked again at commit when the upload's size is its reservation, as other writes may have taken it (docs/design/design-v1-music.md 7.2)", async () => {
    const store = fakeStore();
    const quota = new RoomQuota(1000, store.read);
    const sound = await quota.reserve("R", 600, { headroom: 320 });
    const image = await quota.reserve("R", 300);
    await image.commit(300, async () => void store.stored.set("R", 300));
    // 300 stored, the sound's 600 and its 320 of headroom are 1,220: the headroom is gone, though the size never grew.
    await assert.rejects(sound.commit(600, async () => assert.fail("wrote past the headroom")), quota413);
    sound.release();
    const fits = await quota.reserve("R", 300, { headroom: 320 });
    let wrote = false;
    await fits.commit(300, async () => void (wrote = true));
    assert.ok(wrote);
    // An upload with no headroom keeps the old rule: a size within its reservation needs no second look.
    store.stored.set("R", 990);
    const plain = new RoomQuota(1000, store.read);
    store.stored.set("R", 0);
    const held = await plain.reserve("R", 500);
    store.stored.set("R", 990);
    await held.commit(500, async () => undefined);
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

  test("the log archive checks DATABASE_DISK_DIR's disk when it is set, the asset folder's when not, and uploads always the asset folder's", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "raccoon-disk-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // statfs fails on a folder that is not there, naming it, so each check
    // shows which folder it reads.
    const missing = join(root, "missing");
    const services: AssetService[] = [];
    t.after(() => Promise.all(services.map((s) => s.close())));
    const service = (env: Record<string, string>): AssetService => {
      const config = loadConfig({ DATABASE_URL: "postgres://unused", ...env });
      const made = new AssetService({ pool: {} as pg.Pool, config, minFreeBytes: 1 });
      services.push(made);
      return made;
    };
    const readsMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT" && (err as NodeJS.ErrnoException).path === missing;

    const apart = service({ ASSET_DIR: root, DATABASE_DISK_DIR: missing });
    await assert.rejects(apart.archiveDiskOk(), readsMissing);
    await apart.assertFreeDisk();

    const uploadsApart = service({ ASSET_DIR: missing, DATABASE_DISK_DIR: root });
    assert.equal(await uploadsApart.archiveDiskOk(), true);
    await assert.rejects(uploadsApart.assertFreeDisk(), readsMissing);

    const shared = service({ ASSET_DIR: missing });
    await assert.rejects(shared.archiveDiskOk(), readsMissing);
    const emptyIsUnset = service({ ASSET_DIR: missing, DATABASE_DISK_DIR: "" });
    await assert.rejects(emptyIsUnset.archiveDiskOk(), readsMissing);
  });

  test("the quota's sum leaves the log archive out, which only a room's size on disk counts", () => {
    assert.doesNotMatch(ROOM_QUOTA_BYTES_SQL, /room_log/);
    assert.match(ROOM_ARCHIVE_BYTES_SQL, /from room_log/);
  });
});
