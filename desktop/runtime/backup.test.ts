import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKUP_STORE, BACKUP_SUFFIX } from "../contract.ts";
import { applyRetention, type RetentionIo } from "./backup.ts";

const temps: string[] = [];

after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** A store path in a shard, its hash filled out with one digit. */
const image = (shard: string, digit: string): string => `${shard}/${shard}${digit.repeat(62)}-map-full-v1.webp`;

test("retention removes a shard whose files it all removed though the listing still shows one, and never a shard holding a file it did not delete", async () => {
  const backups = await mkdtemp(join(tmpdir(), "rvtt-retention-"));
  temps.push(backups);
  const store = join(backups, BACKUP_STORE);
  // One kept backup, whose list names one image.
  const name = "raccoon-2026-11-16-120000-abcdefgh";
  const started = new Date(Date.now() - 60_000).toISOString();
  const kept = image("aa", "1");
  await writeFile(join(backups, name + BACKUP_SUFFIX.good), JSON.stringify({ started, finished: started, kind: "manual", dataApp: "0.4.2", snapshotVersion: 44, opVersion: 58, pgMajor: 17, dumpBytes: 1, dbBytes: 1, images: 1 }));
  await writeFile(join(backups, name + BACKUP_SUFFIX.dump), "x");
  await writeFile(join(backups, name + BACKUP_SUFFIX.files), `${kept}\n`);
  const held = image("ff", "3");
  const orphans = [image("aa", "2"), held, image("bb", "4")];
  for (const path of [kept, ...orphans]) {
    await mkdir(join(store, path.slice(0, 2)), { recursive: true });
    await writeFile(join(store, path), "x");
  }
  const late = image("bb", "5");
  const listings = new Map<string, number>();
  const io: RetentionIo = {
    readdir: async (path) => {
      const seen = (listings.get(path) ?? 0) + 1;
      listings.set(path, seen);
      if (seen === 1) return readdir(path);
      // Windows lists a deleted file while another process, such as an antivirus scan, still holds it.
      if (path === join(store, "ff")) return [...(await readdir(path)), held.slice(3)];
      // A file written after the first listing, which this pass never deleted.
      if (path === join(store, "bb")) await writeFile(join(store, late), "x");
      return readdir(path);
    },
  };
  assert.deepEqual(await applyRetention(backups, Date.now(), io), [], "the one backup is kept");
  for (const path of orphans) assert.equal(existsSync(join(store, path)), false, `${path}, which no kept list names, is removed`);
  assert.equal(existsSync(join(store, kept)), true, "a kept backup's image stays");
  assert.equal(existsSync(join(store, "ff")), false, "a shard listing only what this pass removed goes");
  assert.equal(existsSync(join(store, late)), true, "a shard listing a file this pass did not delete stays, with that file");
});
