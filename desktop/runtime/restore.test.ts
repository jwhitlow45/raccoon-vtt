import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { BACKUP_STORE, type BackupRecord, type RestoreJournal } from "../contract.ts";
import {
  BEFORE,
  LIVE,
  RESTORING,
  checkRestorable,
  parseTag,
  placeImages,
  planRecovery,
  recover,
  runRestore,
  tagText,
  type DbName,
  type DbState,
  type ImageFs,
  type JournalStore,
  type RestoreContext,
  type RestoreDb,
  type Tag,
} from "./restore.ts";
import { nodeImageFs } from "./restoreDb.ts";
import type { Build } from "./versionGuard.ts";

/**
 * The restore's logic without PostgreSQL (docs/design/design-v1-local-app.md 8.3):
 * the next start's table, its recovery loop over a model of the three
 * databases, step 3's images on a real folder with every file call
 * recorded, and step 1's refusals. restore.itest.ts does the same with the
 * real cluster and a killed supervisor.
 */

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const j = (state: RestoreJournal["state"], id = ID): RestoreJournal => ({ id, backup: "raccoon-2026-11-01-040000-abcd1234", state });
const tag = (kind: Tag["kind"], id = ID): Tag => ({ kind, id });
const st = (live: Tag | null | undefined, before: boolean, restoring: Tag | null | undefined): DbState => ({
  live: live === undefined ? null : { tag: live },
  before,
  restoring: restoring === undefined ? null : { tag: restoring },
});

describe("planRecovery: one row of the 8.3 table each", () => {
  test("R, no B, no N, no journal: nothing (also with a tag left from an older restore)", () => {
    assert.deepEqual(planRecovery(st(null, false, undefined), null), { do: "nothing" });
    assert.deepEqual(planRecovery(st(tag("restored", OTHER), false, undefined), null), { do: "nothing" });
  });
  test("R not own, no B, no N, any journal: delete the journal, nothing changed", () => {
    for (const state of ["preparing", "swapping", "finishing", "undoing"] as const) {
      assert.deepEqual(planRecovery(st(null, false, undefined), j(state)), { do: "deleteJournal", notice: "restoreInterrupted" });
      assert.deepEqual(planRecovery(st(tag("finished", OTHER), false, undefined), j(state)), { do: "deleteJournal", notice: "restoreInterrupted" });
    }
  });
  test("R own and finished: delete the journal, without the backup", () => {
    assert.deepEqual(planRecovery(st(tag("finished"), false, undefined), j("preparing")), { do: "deleteJournal", notice: "restoreFinished" });
  });
  test("R own and restored, no B, no N: check images, tag finished, delete the journal", () => {
    assert.deepEqual(planRecovery(st(tag("restored"), false, undefined), j("finishing")), { do: "markFinished" });
  });
  test("R and N, no B: drop N first, whatever N's tag or the journal", () => {
    for (const n of [tag("restoring"), tag("restored"), null]) {
      assert.deepEqual(planRecovery(st(null, false, n), null), { do: "dropRestoring" });
      assert.deepEqual(planRecovery(st(null, false, n), j("swapping")), { do: "dropRestoring" });
    }
  });
  test("no R, B, N restored, undoing: rename B back and drop N", () => {
    assert.deepEqual(planRecovery(st(undefined, true, tag("restored")), j("undoing")), { do: "renameBeforeBack", dropRestoring: true, deleteJournal: false });
  });
  test("no R, B, N restored, any other journal or none: rename N to raccoon", () => {
    for (const journal of [j("preparing"), j("swapping"), j("finishing"), null]) {
      assert.deepEqual(planRecovery(st(undefined, true, tag("restored")), journal), { do: "renameRestoringToLive" });
    }
  });
  test("R own and restored, B, no N, swapping or finishing: finish", () => {
    assert.deepEqual(planRecovery(st(tag("restored"), true, undefined), j("swapping")), { do: "finish" });
    assert.deepEqual(planRecovery(st(tag("restored"), true, undefined), j("finishing")), { do: "finish" });
  });
  test("R restored, B, no N, journal none, preparing, undoing, or R not own: undo", () => {
    assert.deepEqual(planRecovery(st(tag("restored"), true, undefined), null), { do: "undo" });
    assert.deepEqual(planRecovery(st(tag("restored"), true, undefined), j("preparing")), { do: "undo" });
    assert.deepEqual(planRecovery(st(tag("restored"), true, undefined), j("undoing")), { do: "undo" });
    assert.deepEqual(planRecovery(st(tag("restored", OTHER), true, undefined), j("swapping")), { do: "undo" });
  });
  test("no R, B, no N: rename B back and delete the journal", () => {
    assert.deepEqual(planRecovery(st(undefined, true, undefined), j("undoing")), { do: "renameBeforeBack", dropRestoring: false, deleteJournal: true });
    assert.deepEqual(planRecovery(st(undefined, true, undefined), null), { do: "renameBeforeBack", dropRestoring: false, deleteJournal: true });
  });
  test("no R, B, N restoring: rename B back and drop N", () => {
    assert.deepEqual(planRecovery(st(undefined, true, tag("restoring")), j("swapping")), { do: "renameBeforeBack", dropRestoring: true, deleteJournal: false });
  });
  test("anything else stops with nothing destructive", () => {
    const tangled = { do: "tangled" };
    // R without a restored tag beside B.
    assert.deepEqual(planRecovery(st(null, true, undefined), j("swapping")), tangled);
    assert.deepEqual(planRecovery(st(tag("finished"), true, undefined), j("finishing")), tangled);
    assert.deepEqual(planRecovery(st(tag("restoring"), true, undefined), j("swapping")), tangled);
    // R, B and N together.
    assert.deepEqual(planRecovery(st(tag("restored"), true, tag("restored")), j("swapping")), tangled);
    // N with no R and no B.
    assert.deepEqual(planRecovery(st(undefined, false, tag("restored")), j("swapping")), tangled);
    // No databases, with a journal.
    assert.deepEqual(planRecovery(st(undefined, false, undefined), j("preparing")), tangled);
    // R own but still tagged restoring, which no step leaves.
    assert.deepEqual(planRecovery(st(tag("restoring"), false, undefined), j("swapping")), tangled);
    // N beside B with no tag of this app's.
    assert.deepEqual(planRecovery(st(undefined, true, null), j("swapping")), tangled);
  });
  test("no databases and no journal is a new cluster", () => {
    assert.deepEqual(planRecovery(st(undefined, false, undefined), null), { do: "createLive" });
  });
  test("tags read back as written, and nothing else reads as one", () => {
    for (const kind of ["restoring", "restored", "finished"] as const) assert.deepEqual(parseTag(tagText(tag(kind))), tag(kind));
    assert.equal(parseTag(null), null);
    assert.equal(parseTag("raccoonvtt-restored:xyz"), null);
    assert.equal(parseTag(`a raccoonvtt-restored:${ID}`), null);
  });
});

// ---------------------------------------------------------------------------
// A model of the databases, for recover() and runRestore()

type ModelDb = { content: string; tag: Tag | null };

class Model implements RestoreDb {
  dbs = new Map<DbName, ModelDb>();
  log: string[] = [];
  dumpContent = "restored";
  failLoad = false;

  constructor(live: string | null = "old") {
    if (live !== null) this.dbs.set(LIVE, { content: live, tag: null });
  }

  async state(): Promise<DbState> {
    const R = this.dbs.get(LIVE);
    const N = this.dbs.get(RESTORING);
    return { live: R ? { tag: R.tag } : null, before: this.dbs.has(BEFORE), restoring: N ? { tag: N.tag } : null };
  }
  async createRestoring(t: Tag) {
    assert.ok(!this.dbs.has(RESTORING));
    this.dbs.set(RESTORING, { content: "empty", tag: t });
    this.log.push("create");
  }
  async setTag(name: DbName, t: Tag) {
    const db = this.dbs.get(name);
    assert.ok(db, `setTag on a missing ${name}`);
    db.tag = t;
    this.log.push(`tag ${name} ${t.kind}`);
  }
  async rename(from: DbName, to: DbName) {
    const db = this.dbs.get(from);
    assert.ok(db, `rename of a missing ${from}`);
    assert.ok(!this.dbs.has(to), `rename onto an existing ${to}`);
    this.dbs.delete(from);
    this.dbs.set(to, db);
    this.log.push(`rename ${from} ${to}`);
  }
  async drop(name: DbName) {
    // The drop rules (design 8.3): only N, R beside B with a restored tag, or B while R carries an id.
    const R = this.dbs.get(LIVE);
    if (name === LIVE) assert.ok(this.dbs.has(BEFORE) && R?.tag?.kind === "restored", "raccoon dropped outside the rules");
    if (name === BEFORE) assert.ok(R?.tag !== null && R?.tag !== undefined, "raccoon_before_restore dropped while raccoon carries no id");
    this.dbs.delete(name);
    this.log.push(`drop ${name}`);
  }
  async endSessions() {}
  async load() {
    if (this.failLoad) throw new Error("pg_restore: error: could not read input file");
    const n = this.dbs.get(RESTORING);
    assert.ok(n);
    n.content = this.dumpContent;
    this.log.push("load");
  }
  async stampRestored() {
    this.log.push("stamp");
  }
}

class MemoryJournal implements JournalStore {
  value: RestoreJournal | null = null;
  async read() {
    return this.value;
  }
  async write(journal: RestoreJournal) {
    this.value = { ...journal };
  }
  async delete() {
    this.value = null;
  }
}

const BUILD: Build = { app: "0.5.0", snapshotVersion: 46, opVersion: 60, pgMajor: 17 };
const RECORD: BackupRecord = {
  started: "2026-11-01T04:00:00.000Z",
  finished: "2026-11-01T04:00:05.000Z",
  kind: "daily",
  dataApp: "0.5.0",
  snapshotVersion: 46,
  opVersion: 60,
  pgMajor: 17,
  dumpBytes: 100,
  dbBytes: 1000,
  images: 0,
};

const memFs: ImageFs = {
  size: async () => null,
  isDir: async () => true,
  mkdir: async () => undefined,
  copy: async () => undefined,
  rename: async () => undefined,
  unlink: async () => undefined,
  syncFile: async () => undefined,
  syncDir: async () => undefined,
};

function context(model: Model, journal: MemoryJournal, extra: Partial<RestoreContext> = {}): RestoreContext {
  return {
    db: model,
    journal,
    fs: memFs,
    backupsDir: "/backups",
    assetsDir: "/assets",
    build: BUILD,
    hooks: { at: () => undefined },
    log: () => undefined,
    freeBytes: async () => 10 * 1024 ** 3,
    floorBytes: 2 * 1024 ** 3,
    readRecord: async () => RECORD,
    readList: async () => [],
    ...extra,
  };
}

/** Builds the model state a row needs, as the steps would leave it. */
function seed(model: Model, s: { R?: [string, Tag | null]; B?: string; N?: [string, Tag | null] }): void {
  model.dbs.clear();
  if (s.R) model.dbs.set(LIVE, { content: s.R[0], tag: s.R[1] });
  if (s.B) model.dbs.set(BEFORE, { content: s.B, tag: null });
  if (s.N) model.dbs.set(RESTORING, { content: s.N[0], tag: s.N[1] });
}

describe("recover() from each state ends with old or restored data, alone", () => {
  const cases: Array<{ name: string; seed: Parameters<typeof seed>[1]; journal: RestoreJournal | null; live: string; notice: string | null }> = [
    { name: "no restore", seed: { R: ["old", null] }, journal: null, live: "old", notice: null },
    { name: "interrupted before N", seed: { R: ["old", null] }, journal: j("preparing"), live: "old", notice: "restoreInterrupted" },
    { name: "finished, journal left", seed: { R: ["restored", tag("finished")] }, journal: j("finishing"), live: "restored", notice: "restoreFinished" },
    { name: "after the drop", seed: { R: ["restored", tag("restored")] }, journal: j("finishing"), live: "restored", notice: "restoreFinished" },
    { name: "N loading", seed: { R: ["old", null], N: ["empty", tag("restoring")] }, journal: j("preparing"), live: "old", notice: "restoreInterrupted" },
    { name: "N restored, no swap", seed: { R: ["old", null], N: ["restored", tag("restored")] }, journal: j("swapping"), live: "old", notice: "restoreInterrupted" },
    { name: "undo of a failed second rename", seed: { B: "old", N: ["restored", tag("restored")] }, journal: j("undoing"), live: "old", notice: "restoreInterrupted" },
    { name: "between the renames", seed: { B: "old", N: ["restored", tag("restored")] }, journal: j("swapping"), live: "restored", notice: "restoreFinished" },
    { name: "between the renames, journal lost", seed: { B: "old", N: ["restored", tag("restored")] }, journal: j("preparing"), live: "old", notice: "restoreInterrupted" },
    { name: "between the renames, no journal", seed: { B: "old", N: ["restored", tag("restored")] }, journal: null, live: "old", notice: "restoreInterrupted" },
    { name: "swapped", seed: { R: ["restored", tag("restored")], B: "old" }, journal: j("swapping"), live: "restored", notice: "restoreFinished" },
    { name: "swapped, journal lost", seed: { R: ["restored", tag("restored")], B: "old" }, journal: j("preparing"), live: "old", notice: "restoreInterrupted" },
    { name: "undo after R dropped", seed: { B: "old" }, journal: j("undoing"), live: "old", notice: "restoreInterrupted" },
    { name: "N restoring beside B", seed: { B: "old", N: ["empty", tag("restoring")] }, journal: j("swapping"), live: "old", notice: "restoreInterrupted" },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const model = new Model();
      seed(model, c.seed);
      const journal = new MemoryJournal();
      journal.value = c.journal;
      const result = await recover(context(model, journal));
      assert.equal(result.tangled, false);
      assert.equal(result.notice, c.notice);
      assert.deepEqual([...model.dbs.keys()], [LIVE]);
      assert.equal(model.dbs.get(LIVE)?.content, c.live);
      // Restored data ends tagged finished, so a journal that comes back later is known as done.
      if (c.live === "restored") assert.equal(model.dbs.get(LIVE)?.tag?.kind, "finished");
      assert.equal(journal.value, null);
    });
  }
  test("a tangled state is left as it is", async () => {
    const model = new Model();
    seed(model, { R: ["restored", tag("restored")], B: "old", N: ["x", tag("restored")] });
    const journal = new MemoryJournal();
    journal.value = j("swapping");
    const result = await recover(context(model, journal));
    assert.equal(result.tangled, true);
    assert.deepEqual(model.log, []);
    assert.ok(journal.value);
  });
  test("a restore.json that does not read is deleted, with a line in the log, only once the databases need nothing", async () => {
    // The last one's undo deletes the journal as its own last step.
    for (const [s, ownLine] of [
      [{ R: ["old", null] }, true],
      [{ R: ["old", null], N: ["empty", tag("restoring")] }, true],
      [{ B: "old", N: ["restored", tag("restored")] }, false],
    ] as const) {
      const model = new Model();
      seed(model, s as Parameters<typeof seed>[1]);
      let present = true;
      const damaged: JournalStore = {
        read: async () => null,
        write: async () => undefined,
        delete: async () => {
          model.log.push("delete restore.json");
          present = false;
        },
        present: async () => present,
      };
      const lines: string[] = [];
      const result = await recover(context(model, new MemoryJournal(), { journal: damaged, log: (l) => lines.push(l) }));
      assert.equal(result.tangled, false);
      assert.equal(present, false, JSON.stringify(s));
      assert.equal(model.log.at(-1), "delete restore.json", "after every database step");
      assert.equal(model.log.filter((l) => l === "delete restore.json").length, 1);
      assert.deepEqual([...model.dbs.keys()], [LIVE]);
      assert.equal(lines.includes("restore recovery: restore.json does not read and the databases need nothing, so it is deleted"), ownLine);
    }
    // Nothing there: nothing deleted.
    const model = new Model();
    seed(model, { R: ["old", null] });
    let deleted = false;
    await recover(context(model, new MemoryJournal(), { journal: { read: async () => null, write: async () => undefined, delete: async () => void (deleted = true), present: async () => false } }));
    assert.equal(deleted, false);
  });
  test("a new cluster asks for raccoon to be made", async () => {
    const model = new Model(null);
    const result = await recover(context(model, new MemoryJournal()));
    assert.equal(result.createLive, true);
  });
});

describe("runRestore over the model", () => {
  test("a restore swaps in the new data and leaves only raccoon, tagged finished", async () => {
    const model = new Model();
    const journal = new MemoryJournal();
    const steps: string[] = [];
    const out = await runRestore(context(model, journal), "raccoon-2026-11-01-040000-abcd1234", { record: RECORD, list: [] }, (s) => steps.push(s));
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(steps, ["images", "database"]);
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    assert.equal(model.dbs.get(LIVE)?.content, "restored");
    assert.equal(model.dbs.get(LIVE)?.tag?.kind, "finished");
    assert.equal(journal.value, null);
    // The original goes only after the swap, and the restored copy is tagged before it.
    const order = model.log;
    assert.ok(order.indexOf("tag raccoon_restoring restored") < order.indexOf("rename raccoon raccoon_before_restore"));
    assert.ok(order.indexOf("rename raccoon_restoring raccoon") < order.indexOf("drop raccoon_before_restore"));
  });
  test("a failed load leaves raccoon untouched and no journal", async () => {
    const model = new Model();
    model.failLoad = true;
    const journal = new MemoryJournal();
    const out = await runRestore(context(model, journal), "raccoon-2026-11-01-040000-abcd1234", { record: RECORD, list: [] }, () => undefined);
    assert.equal(out.ok, false);
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    assert.equal(model.dbs.get(LIVE)?.content, "old");
    assert.equal(journal.value, null);
  });
  test("a failed second rename is undone", async () => {
    const model = new Model();
    const journal = new MemoryJournal();
    const out = await runRestore(
      context(model, journal, { hooks: { at: () => undefined, failBefore: (p) => p === "renamedRestoring" } }),
      "raccoon-2026-11-01-040000-abcd1234",
      { record: RECORD, list: [] },
      () => undefined,
    );
    assert.equal(out.ok, false);
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    assert.equal(model.dbs.get(LIVE)?.content, "old");
    assert.equal(journal.value, null);
  });
  test("a failed first rename never drops an original that still carries an old restored tag", async () => {
    // A journal lost after an earlier restore's drop leaves raccoon tagged restored for good (design 8.3's first row).
    const model = new Model();
    (model.dbs.get(LIVE) as ModelDb).tag = tag("restored", OTHER);
    const journal = new MemoryJournal();
    const out = await runRestore(
      context(model, journal, { hooks: { at: () => undefined, failBefore: (p) => p === "renamedLive" } }),
      "raccoon-2026-11-01-040000-abcd1234",
      { record: RECORD, list: [] },
      () => undefined,
    );
    assert.equal(out.ok, false);
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    assert.equal(model.dbs.get(LIVE)?.content, "old");
    assert.equal(journal.value, null);
  });

  test("a failure after the drop is left for recovery, which finishes it", async () => {
    const model = new Model();
    const journal = new MemoryJournal();
    const out = await runRestore(
      context(model, journal, { hooks: { at: () => undefined, failBefore: (p) => p === "finished" } }),
      "raccoon-2026-11-01-040000-abcd1234",
      { record: RECORD, list: [] },
      () => undefined,
    );
    assert.deepEqual(out, { ok: true });
    assert.ok(journal.value, "the journal stays for recovery");
    const rec = await recover(context(model, journal));
    assert.equal(rec.notice, "restoreFinished");
    assert.equal(model.dbs.get(LIVE)?.content, "restored");
    assert.equal(model.dbs.get(LIVE)?.tag?.kind, "finished");
    assert.equal(journal.value, null);
  });
});

// ---------------------------------------------------------------------------
// Step 3's images on a real folder

const tmpRoots: string[] = [];
after(async () => {
  for (const dir of tmpRoots) await rm(dir, { recursive: true, force: true });
});

async function folder(): Promise<{ data: string; assets: string; backups: string; store: string }> {
  const data = await mkdtemp(join(tmpdir(), "rvtt-restore-unit-"));
  tmpRoots.push(data);
  const backups = join(data, "backups");
  const store = join(backups, BACKUP_STORE);
  await mkdir(store, { recursive: true });
  return { data, assets: join(data, "assets"), backups, store };
}

function recording(calls: string[]): ImageFs {
  const wrap =
    <A extends unknown[], R>(name: string, f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (name !== "size" && name !== "isDir") calls.push(`${name} ${a.join(" ")}`);
      return f(...a);
    };
  return {
    size: wrap("size", nodeImageFs.size),
    isDir: wrap("isDir", nodeImageFs.isDir),
    mkdir: wrap("mkdir", nodeImageFs.mkdir),
    copy: wrap("copy", nodeImageFs.copy),
    rename: wrap("rename", nodeImageFs.rename),
    unlink: wrap("unlink", nodeImageFs.unlink),
    syncFile: wrap("syncFile", nodeImageFs.syncFile),
    syncDir: wrap("syncDir", nodeImageFs.syncDir),
  };
}

const IMG = (hex: string) => `${hex.slice(0, 2)}/${hex}-map-full-v1.webp`;
const A = IMG("aa".repeat(32));
const B = IMG("bb".repeat(32));
const C = IMG("cc".repeat(32));

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("placeImages (step 3)", () => {
  test("missing and short images are copied, whole ones left alone, and every listed one flushed with its folder", async () => {
    const f = await folder();
    for (const [p, text] of [[A, "aaaa"], [B, "bbbbbb"], [C, "cc"]] as const) await put(join(f.store, p), text);
    await put(join(f.assets, A), "aaaa"); // whole
    await put(join(f.assets, B), "bb"); // short
    await mkdir(join(f.assets, "cc"), { recursive: true }); // C missing, its folder there
    const calls: string[] = [];
    const missing = await placeImages({ fs: recording(calls), assetsDir: f.assets, backupsDir: f.backups }, [A, B, C]);
    assert.deepEqual(missing, []);
    assert.equal(await readFile(join(f.assets, A), "utf8"), "aaaa");
    assert.equal(await readFile(join(f.assets, B), "utf8"), "bbbbbb");
    assert.equal(await readFile(join(f.assets, C), "utf8"), "cc");
    assert.ok(!calls.some((c) => c.startsWith("copy") && c.includes(A)), "a whole image is never copied over");
    for (const p of [A, B, C]) {
      assert.ok(calls.includes(`syncFile ${join(f.assets, p)}`), `flushed ${p}`);
      assert.ok(calls.includes(`syncDir ${dirname(join(f.assets, p))}`), `flushed the folder of ${p}`);
    }
    // Every copy lands through a .restoring file, renamed only once its length checks.
    assert.ok(calls.some((c) => c === `rename ${join(f.assets, B)}.restoring ${join(f.assets, B)}`));
  });

  test("a shard folder the copy made is flushed in assets/ after it was made", async () => {
    const f = await folder();
    await put(join(f.store, A), "aaaa");
    await mkdir(f.assets);
    const calls: string[] = [];
    await placeImages({ fs: recording(calls), assetsDir: f.assets, backupsDir: f.backups }, [A]);
    const made = calls.indexOf(`mkdir ${join(f.assets, "aa")}`);
    const synced = calls.indexOf(`syncDir ${f.assets}`);
    assert.ok(made >= 0 && synced > made, calls.join("\n"));
  });

  test("a missing assets/ folder is made and flushed in the data folder", async () => {
    const f = await folder();
    await put(join(f.store, A), "aaaa");
    const calls: string[] = [];
    await placeImages({ fs: recording(calls), assetsDir: f.assets, backupsDir: f.backups }, [A]);
    assert.ok(calls.indexOf(`syncDir ${f.data}`) > calls.indexOf(`mkdir ${f.assets}`), calls.join("\n"));
    assert.ok(calls.indexOf(`syncDir ${f.assets}`) > calls.indexOf(`mkdir ${join(f.assets, "aa")}`), calls.join("\n"));
  });

  test("an image in neither the store nor assets is answered as missing", async () => {
    const f = await folder();
    await mkdir(f.assets);
    const missing = await placeImages({ fs: nodeImageFs, assetsDir: f.assets, backupsDir: f.backups }, [A]);
    assert.deepEqual(missing, [A]);
  });

  test("a copy that comes out short fails and leaves no file", async () => {
    const f = await folder();
    await put(join(f.store, A), "aaaa");
    await mkdir(f.assets);
    const shortFs: ImageFs = { ...nodeImageFs, copy: async (_from, to) => writeFile(to, "a") };
    await assert.rejects(placeImages({ fs: shortFs, assetsDir: f.assets, backupsDir: f.backups }, [A]), /did not copy whole/);
    assert.equal(await nodeImageFs.size(join(f.assets, A)), null);
    assert.equal(await nodeImageFs.size(`${join(f.assets, A)}.restoring`), null);
  });
});

describe("checkRestorable (step 1)", () => {
  const NAME = "raccoon-2026-11-01-040000-abcd1234";
  async function ready(list: string[] = [A]): Promise<{ f: Awaited<ReturnType<typeof folder>>; ctx: RestoreContext }> {
    const f = await folder();
    await writeFile(join(f.backups, `${NAME}.dump`), "PGDMP");
    for (const p of list) await put(join(f.store, p), "x");
    const ctx = context(new Model(), new MemoryJournal(), {
      fs: nodeImageFs,
      backupsDir: f.backups,
      assetsDir: f.assets,
      readList: async () => list,
    });
    return { f, ctx };
  }

  test("a backup this build reads, whole, with room on the disk, passes", async () => {
    const { ctx } = await ready();
    const out = await checkRestorable(ctx, NAME);
    assert.equal(out.ok, true);
  });
  test("newer formats are refused, by snapshot or by op", async () => {
    for (const newer of [{ snapshotVersion: 47 }, { opVersion: 61 }]) {
      const { ctx } = await ready();
      ctx.readRecord = async () => ({ ...RECORD, ...newer });
      const out = await checkRestorable(ctx, NAME);
      assert.deepEqual(out, { ok: false, refusal: { error: "failed", reason: "that backup was made by a newer version of RaccoonVTT" } });
    }
  });
  test("a missing record, dump or list is refused", async () => {
    const gone = await ready();
    gone.ctx.readRecord = async () => null;
    assert.equal((await checkRestorable(gone.ctx, NAME)).ok, false);
    const noDump = await ready();
    await rm(join(noDump.f.backups, `${NAME}.dump`));
    assert.deepEqual(await checkRestorable(noDump.ctx, NAME), { ok: false, refusal: { error: "failed", reason: "that backup's database file is missing" } });
    const noList = await ready();
    noList.ctx.readList = async () => null;
    assert.deepEqual(await checkRestorable(noList.ctx, NAME), { ok: false, refusal: { error: "failed", reason: "that backup's image list is missing" } });
  });
  test("an image missing from the store is refused", async () => {
    const { f, ctx } = await ready([A, B]);
    await rm(join(f.store, B));
    assert.deepEqual(await checkRestorable(ctx, NAME), { ok: false, refusal: { error: "failed", reason: "1 of its 2 images are missing from the backups folder" } });
  });
  test("less free space than the database and the floor asks for how much more", async () => {
    const { ctx } = await ready();
    ctx.freeBytes = async () => 2 * 1024 ** 3 + 400;
    assert.deepEqual(await checkRestorable(ctx, NAME), { ok: false, refusal: { error: "noSpace", bytes: 600 } });
    ctx.freeBytes = async () => 2 * 1024 ** 3 + 1000;
    assert.equal((await checkRestorable(ctx, NAME)).ok, true);
  });
});

describe("two recoveries at once (D-261114-026)", () => {
  /** The model with one call held until `gate` opens, the first time it is made. */
  function holding(model: Model, gate: Promise<void>): RestoreDb {
    let held = false;
    return {
      state: () => model.state(),
      createRestoring: (t) => model.createRestoring(t),
      setTag: (n, t) => model.setTag(n, t),
      rename: (a, b) => model.rename(a, b),
      drop: (n) => model.drop(n),
      load: () => model.load(),
      stampRestored: () => model.stampRestored(),
      endSessions: async () => {
        if (!held) {
          held = true;
          await gate;
        }
        await model.endSessions();
      },
    };
  }

  test("an undo held between its state read and its drop, while a second recovery puts the original back, never drops the original", async () => {
    const model = new Model();
    seed(model, { R: ["restored", tag("restored")], B: "old" });
    const journal = new MemoryJournal();
    journal.value = j("undoing");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const first = recover(context(model, journal, { db: holding(model, gate) }));
    await new Promise((resolve) => setImmediate(resolve));
    // The second runs whole meanwhile: the restored copy goes, the original comes back as raccoon.
    await recover(context(model, journal));
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    open();
    await first;
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    assert.equal(model.dbs.get(LIVE)?.content, "old", "the original survives the first recovery's stale step");
    assert.equal(model.log.filter((l) => l === `drop ${LIVE}`).length, 1, "raccoon was dropped once, as the restored copy");
  });

  test("a rename held while a second recovery renames first is skipped, not repeated over the database already there", async () => {
    const model = new Model();
    seed(model, { B: "old" });
    const journal = new MemoryJournal();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const first = recover(context(model, journal, { db: holding(model, gate) }));
    await new Promise((resolve) => setImmediate(resolve));
    await recover(context(model, journal));
    open();
    await first;
    assert.deepEqual([...model.dbs.keys()], [LIVE]);
    assert.equal(model.dbs.get(LIVE)?.content, "old");
  });
});

describe("recovery's progress and its end between steps", () => {
  const sized: ImageFs = { ...memFs, size: async () => 1 };

  test("placeImages counts each image placed and flushed, so a long run shows how far it is", async () => {
    const seen: string[] = [];
    await placeImages({ fs: sized, assetsDir: "/assets", backupsDir: "/backups", progress: (done, total) => seen.push(`${done}/${total}`) }, ["a", "b", "c"]);
    assert.deepEqual(seen, ["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
  });

  test("a cancelled recovery ends before its next image or step, and changes nothing more", async () => {
    const abort = new AbortController();
    const synced: string[] = [];
    const fs: ImageFs = { ...sized, syncFile: async (p) => void synced.push(p) };
    let ticks = 0;
    const progress = () => {
      if (++ticks === 4) abort.abort();
    };
    await assert.rejects(placeImages({ fs, assetsDir: "/assets", backupsDir: "/backups", progress, signal: abort.signal }, ["a", "b", "c"]), { name: "AbortError" });
    assert.equal(synced.length, 1, "one flush, then the end");

    const model = new Model();
    seed(model, { B: "old" });
    const done = new AbortController();
    done.abort();
    await assert.rejects(recover(context(model, new MemoryJournal(), { signal: done.signal })), { name: "AbortError" });
    assert.deepEqual([...model.dbs.keys()], [BEFORE], "nothing was renamed");
  });
});
