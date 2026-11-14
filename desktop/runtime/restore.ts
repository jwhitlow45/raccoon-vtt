import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { BACKUP_STORE, BACKUP_SUFFIX, BackupRecord, type RestoreJournal } from "../contract.ts";
import { readFileList } from "./backup.ts";
import { readable, type Build } from "./versionGuard.ts";

/**
 * Restore (docs/design/design-v1-local-app.md 8.3, D-261113-082, 090, 100,
 * 102, 104, 107, 108). The original database is never dropped or changed
 * until the restored one is complete, its images are on disk, and it is in
 * its place. Every next-start action is chosen from what the databases are,
 * so a crash or a lost journal write at any point ends with either the old
 * data or the restored data, whole.
 *
 * `raccoon` is the live database. The restore builds `raccoon_restoring`
 * and keeps the original as `raccoon_before_restore` until the end. The
 * database it builds carries the restore's id as its comment: restoring
 * while pg_restore runs, restored once complete and checked, finished once
 * the original is dropped. A drop only ever names `raccoon_restoring`,
 * `raccoon` while `raccoon_before_restore` exists beside it and it carries a
 * restored tag, or `raccoon_before_restore` while `raccoon` carries the
 * journal's id.
 */

export const LIVE = "raccoon";
export const BEFORE = "raccoon_before_restore";
export const RESTORING = "raccoon_restoring";
export type DbName = typeof LIVE | typeof BEFORE | typeof RESTORING;

export type TagKind = "restoring" | "restored" | "finished";
export type Tag = { kind: TagKind; id: string };

const TAG = /^raccoonvtt-(restoring|restored|finished):([0-9a-f]{32})$/;

export function tagText(tag: Tag): string {
  return `raccoonvtt-${tag.kind}:${tag.id}`;
}

export function parseTag(comment: string | null): Tag | null {
  const m = comment === null ? null : TAG.exec(comment);
  return m ? { kind: m[1] as TagKind, id: m[2] as string } : null;
}

/** Which of the three databases exist, with the tags of the two that can carry one. */
export type DbState = { live: { tag: Tag | null } | null; before: boolean; restoring: { tag: Tag | null } | null };

/** The database operations a restore makes. The supervisor's is restoreDb.ts, the randomized test's a model. */
export type RestoreDb = {
  state(): Promise<DbState>;
  /** Creates `raccoon_restoring` with its tag. */
  createRestoring(tag: Tag): Promise<void>;
  setTag(name: DbName, tag: Tag): Promise<void>;
  rename(from: DbName, to: DbName): Promise<void>;
  drop(name: DbName): Promise<void>;
  /** Ends every other session on these databases, so a rename or drop never waits on one (D-261113-104). */
  endSessions(names: DbName[]): Promise<void>;
  /** pg_restore into `raccoon_restoring` in one transaction, then a read of its rooms. */
  load(dumpFile: string): Promise<void>;
  /** Sets the restored stamp's app version to this build, keeping the backup's formats (D-261113-096). */
  stampRestored(build: Build, record: BackupRecord): Promise<void>;
};

/** The image file calls step 3 makes, so a test can check that every flush comes before the swap. */
export type ImageFs = {
  size(path: string): Promise<number | null>;
  isDir(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  syncDir(path: string): Promise<void>;
};

export type JournalStore = {
  read(): Promise<RestoreJournal | null>;
  write(journal: RestoreJournal): Promise<void>;
  delete(): Promise<void>;
};

/** The named moments a test can kill the supervisor at (RESTORE_TEST_CRASH_AT), or make fail. */
export type CrashPoint =
  | "preparing"
  | "images"
  | "created"
  | "loaded"
  | "restored"
  | "swapping"
  | "renamedLive"
  | "renamedRestoring"
  | "finishing"
  | "dropped"
  | "finished"
  | "journalDeleted"
  | "undoing"
  | "undoDropped"
  | "undoRenamed"
  | "undoDroppedRestoring";

export type RestoreHooks = {
  /** Called at each point. A test's hook ends the process, or throws to stand for its end. */
  at(point: CrashPoint): Promise<void> | void;
  /** True drops the journal write of this state, as a write lost to a power cut would be. */
  dropJournalWrite?(state: RestoreJournal["state"]): boolean;
  /** True makes the step before this point fail, for the undo paths. */
  failBefore?(point: CrashPoint): boolean;
};

export const noHooks: RestoreHooks = { at: () => undefined };

export type RestoreContext = {
  db: RestoreDb;
  journal: JournalStore;
  fs: ImageFs;
  backupsDir: string;
  assetsDir: string;
  build: Build;
  hooks: RestoreHooks;
  log: (msg: string) => void;
  freeBytes: () => Promise<number>;
  floorBytes: number;
  readRecord(name: string): Promise<BackupRecord | null>;
  readList?(name: string): Promise<string[] | null>;
};

// ---------------------------------------------------------------------------
// The next start's table (design 8.3)

export type RecoveryNotice = "restoreInterrupted" | "restoreFinished";

export type Action =
  | { do: "nothing" }
  | { do: "createLive" }
  | { do: "deleteJournal"; notice: RecoveryNotice }
  | { do: "markFinished" }
  | { do: "dropRestoring" }
  | { do: "renameBeforeBack"; dropRestoring: boolean; deleteJournal: boolean }
  | { do: "renameRestoringToLive" }
  | { do: "finish" }
  | { do: "undo" }
  | { do: "tangled" };

/**
 * One row of the table, from the databases and the journal. "Own" means
 * `raccoon`'s tag carries the journal's id. The journal only picks between
 * finishing and undoing when both are safe, and names the backup.
 */
export function planRecovery(s: DbState, j: RestoreJournal | null): Action {
  const R = s.live;
  const B = s.before;
  const N = s.restoring;
  const own = R !== null && j !== null && R.tag?.id === j.id;
  if (R && !B && !N) {
    if (!j) return { do: "nothing" };
    if (!own) return { do: "deleteJournal", notice: "restoreInterrupted" };
    if (R.tag?.kind === "finished") return { do: "deleteJournal", notice: "restoreFinished" };
    if (R.tag?.kind === "restored") return { do: "markFinished" };
    return { do: "tangled" };
  }
  if (R && N && !B) return { do: "dropRestoring" };
  if (!R && B && N) {
    if (N.tag?.kind === "restored") return j?.state === "undoing" ? { do: "renameBeforeBack", dropRestoring: true, deleteJournal: false } : { do: "renameRestoringToLive" };
    if (N.tag?.kind === "restoring") return { do: "renameBeforeBack", dropRestoring: true, deleteJournal: false };
    return { do: "tangled" };
  }
  if (R && B && !N) {
    if (R.tag?.kind !== "restored") return { do: "tangled" };
    if (own && (j.state === "swapping" || j.state === "finishing")) return { do: "finish" };
    return { do: "undo" };
  }
  if (!R && B && !N) return { do: "renameBeforeBack", dropRestoring: false, deleteJournal: true };
  if (!R && !B && !N && !j) return { do: "createLive" };
  return { do: "tangled" };
}

export type RecoveryResult = {
  notice: RecoveryNotice | null;
  /** The backup the journal named, for the notice's date. */
  backup: string | null;
  tangled: boolean;
  /** No database at all and no journal: a new cluster, whose `raccoon` the caller creates. */
  createLive: boolean;
};

/** Runs the table's rows until one leaves nothing to do. Each step does nothing when its database or file is already gone. */
export async function recover(ctx: RestoreContext): Promise<RecoveryResult> {
  let notice: RecoveryNotice | null = null;
  const first = await ctx.journal.read();
  const backup = first?.backup ?? null;
  for (let step = 0; step < 12; step++) {
    const journal = await ctx.journal.read();
    const action = planRecovery(await ctx.db.state(), journal);
    ctx.log(`restore recovery: ${action.do}${journal ? ` (journal ${journal.state})` : ""}`);
    switch (action.do) {
      case "nothing":
        return { notice, backup, tangled: false, createLive: false };
      case "createLive":
        return { notice, backup, tangled: false, createLive: true };
      case "tangled":
        return { notice, backup, tangled: true, createLive: false };
      case "deleteJournal":
        await ctx.journal.delete();
        notice = action.notice;
        break;
      case "markFinished":
        await checkImagesForFinish(ctx, journal);
        await ctx.db.setTag(LIVE, { kind: "finished", id: (journal as RestoreJournal).id });
        await ctx.hooks.at("finished");
        await ctx.journal.delete();
        notice = "restoreFinished";
        break;
      case "dropRestoring":
        await ctx.db.endSessions([RESTORING]);
        await ctx.db.drop(RESTORING);
        break;
      case "renameBeforeBack":
        await ctx.db.endSessions([BEFORE, RESTORING]);
        await ctx.db.rename(BEFORE, LIVE);
        if (action.dropRestoring) await ctx.db.drop(RESTORING);
        if (action.deleteJournal) await ctx.journal.delete();
        notice = "restoreInterrupted";
        break;
      case "renameRestoringToLive":
        await ctx.db.endSessions([RESTORING]);
        await ctx.db.rename(RESTORING, LIVE);
        break;
      case "finish":
        await checkImagesForFinish(ctx, journal);
        await stepSix(ctx, journal as RestoreJournal);
        notice = "restoreFinished";
        break;
      case "undo":
        await undo(ctx, journal);
        notice = "restoreInterrupted";
        break;
    }
  }
  return { notice, backup, tangled: true, createLive: false };
}

/**
 * Finishing checks every image the backup lists again from the store. A
 * backup or list deleted by hand is skipped: every row that finishes comes
 * after step 3 flushed every listed image.
 */
async function checkImagesForFinish(ctx: RestoreContext, journal: RestoreJournal | null): Promise<void> {
  if (!journal) return;
  const list = await (ctx.readList ?? ((name) => readFileList(ctx.backupsDir, name)))(journal.backup);
  if (list === null) {
    ctx.log(`restore recovery: the list of ${journal.backup} is gone, so its images are not checked again`);
    return;
  }
  const missing = await placeImages(ctx, list);
  if (missing.length > 0) ctx.log(`restore recovery: ${missing.length} listed images are in neither the store nor assets`);
}

// ---------------------------------------------------------------------------
// Steps

async function writeJournal(ctx: RestoreContext, journal: RestoreJournal): Promise<void> {
  if (ctx.hooks.dropJournalWrite?.(journal.state)) {
    ctx.log(`restore: the ${journal.state} journal write is dropped for a test`);
    return;
  }
  await ctx.journal.write(journal);
}

async function failable(ctx: RestoreContext, point: CrashPoint, work: () => Promise<void>): Promise<void> {
  if (ctx.hooks.failBefore?.(point)) throw new Error(`a test made the step before ${point} fail`);
  await work();
  await ctx.hooks.at(point);
}

/** Folders from `dir` up that do not exist yet, outermost first. */
async function missingFolders(fs: ImageFs, dir: string): Promise<string[]> {
  const missing: string[] = [];
  let d = dir;
  while (!(await fs.isDir(d))) {
    missing.unshift(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return missing;
}

/**
 * Step 3's images: each listed image at its path in assets/ by length, a
 * missing or short one copied from the store through a .restoring file,
 * never over a whole file. Then every listed image and every folder that
 * holds one is flushed, and every folder the copy created in its parent, up
 * to the first that existed (D-261113-100, 108). Answers the images found
 * in neither place.
 */
export async function placeImages(ctx: Pick<RestoreContext, "fs" | "assetsDir" | "backupsDir">, list: readonly string[]): Promise<string[]> {
  const { fs } = ctx;
  const store = join(ctx.backupsDir, BACKUP_STORE);
  const created: string[] = [];
  const missing: string[] = [];
  for (const path of list) {
    const target = join(ctx.assetsDir, path);
    const want = await fs.size(join(store, path));
    const have = await fs.size(target);
    if (have !== null && (want === null || have === want)) continue;
    if (want === null) {
      missing.push(path);
      continue;
    }
    for (const folder of await missingFolders(fs, dirname(target))) {
      await fs.mkdir(folder);
      created.push(folder);
    }
    const temp = `${target}.restoring`;
    await fs.copy(join(store, path), temp);
    if ((await fs.size(temp)) !== want) {
      await fs.unlink(temp);
      throw new Error(`an image did not copy whole: ${path}`);
    }
    await fs.rename(temp, target);
  }
  const present = list.filter((p) => !missing.includes(p));
  for (const path of present) await fs.syncFile(join(ctx.assetsDir, path));
  for (const dir of new Set(present.map((p) => dirname(join(ctx.assetsDir, p))))) await fs.syncDir(dir);
  for (const folder of created) await fs.syncDir(dirname(folder));
  return missing;
}

export type Refusal = { error: "noSpace"; bytes: number } | { error: "failed"; reason: string };

/** Step 1: what is refused before anything changes. */
export async function checkRestorable(ctx: RestoreContext, name: string): Promise<{ ok: true; record: BackupRecord; list: string[] } | { ok: false; refusal: Refusal }> {
  const record = await ctx.readRecord(name);
  if (!record) return { ok: false, refusal: { error: "failed", reason: "that backup is no longer on this computer" } };
  if (!readable(record, ctx.build)) return { ok: false, refusal: { error: "failed", reason: "that backup was made by a newer version of RaccoonVTT" } };
  if ((await ctx.fs.size(join(ctx.backupsDir, name + BACKUP_SUFFIX.dump))) === null) {
    return { ok: false, refusal: { error: "failed", reason: "that backup's database file is missing" } };
  }
  const list = await (ctx.readList ?? ((n) => readFileList(ctx.backupsDir, n)))(name);
  if (list === null) return { ok: false, refusal: { error: "failed", reason: "that backup's image list is missing" } };
  const store = join(ctx.backupsDir, BACKUP_STORE);
  let missing = 0;
  for (const path of list) if ((await ctx.fs.size(join(store, path))) === null) missing++;
  if (missing > 0) return { ok: false, refusal: { error: "failed", reason: `${missing} of its ${list.length} images are missing from the backups folder` } };
  const needed = record.dbBytes + ctx.floorBytes;
  const free = await ctx.freeBytes();
  if (free < needed) return { ok: false, refusal: { error: "noSpace", bytes: needed - free } };
  return { ok: true, record, list };
}

export type RestoreOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Steps 3 to 6. The caller has stopped the app server (step 2), and starts
 * it again after (step 7), whatever this answers. A failure in step 3 or 4
 * leaves `raccoon` untouched. A failure in step 5, or in step 6 before the
 * drop, is undone here. A failure after the drop is left to the recovery
 * the caller runs next, which finishes it.
 */
export async function runRestore(
  ctx: RestoreContext,
  name: string,
  checked: { record: BackupRecord; list: string[] },
  onStep: (step: "images" | "database") => void,
): Promise<RestoreOutcome> {
  const id = randomBytes(16).toString("hex");
  const journal: RestoreJournal = { id, backup: name, state: "preparing" };

  // 3 and 4: nothing here touches `raccoon`.
  try {
    await writeJournal(ctx, journal);
    await ctx.hooks.at("preparing");
    onStep("images");
    await failable(ctx, "images", async () => {
      const missing = await placeImages(ctx, checked.list);
      if (missing.length > 0) throw new Error(`${missing.length} images are missing from the backups folder`);
    });
    onStep("database");
    const state = await ctx.db.state();
    if (state.restoring) {
      // Only ever this app's own leftover.
      await ctx.db.endSessions([RESTORING]);
      await ctx.db.drop(RESTORING);
    }
    await failable(ctx, "created", () => ctx.db.createRestoring({ kind: "restoring", id }));
    await failable(ctx, "loaded", () => ctx.db.load(join(ctx.backupsDir, name + BACKUP_SUFFIX.dump)));
    await ctx.db.stampRestored(ctx.build, checked.record);
    await failable(ctx, "restored", () => ctx.db.setTag(RESTORING, { kind: "restored", id }));
  } catch (err) {
    const reason = reasonOf(err);
    ctx.log(`restore of ${name} failed before the swap: ${reason}`);
    await cleanUpBeforeSwap(ctx);
    return { ok: false, reason };
  }

  // 5: the swap. From here a failure is undone.
  try {
    await writeJournal(ctx, { ...journal, state: "swapping" });
    await ctx.hooks.at("swapping");
    await ctx.db.endSessions([LIVE, RESTORING]);
    await failable(ctx, "renamedLive", () => ctx.db.rename(LIVE, BEFORE));
    await failable(ctx, "renamedRestoring", () => ctx.db.rename(RESTORING, LIVE));
    await writeJournal(ctx, { ...journal, state: "finishing" });
    await ctx.hooks.at("finishing");
  } catch (err) {
    const reason = reasonOf(err);
    ctx.log(`restore of ${name} failed in the swap, undoing it: ${reason}`);
    await undo(ctx, { ...journal, state: "swapping" });
    return { ok: false, reason };
  }

  // 6: the original goes only now. A failure before the drop is undone, after it left for recovery.
  let dropped = false;
  try {
    await ctx.db.endSessions([BEFORE]);
    await failable(ctx, "dropped", async () => {
      await ctx.db.drop(BEFORE);
      dropped = true;
    });
    await failable(ctx, "finished", () => ctx.db.setTag(LIVE, { kind: "finished", id }));
    await ctx.journal.delete();
    await ctx.hooks.at("journalDeleted");
  } catch (err) {
    const reason = reasonOf(err);
    if (!dropped) {
      ctx.log(`restore of ${name} failed before the original was dropped, undoing it: ${reason}`);
      await undo(ctx, { ...journal, state: "finishing" });
      return { ok: false, reason };
    }
    ctx.log(`restore of ${name} failed after the original was dropped, left for recovery: ${reason}`);
  }
  return { ok: true };
}

async function cleanUpBeforeSwap(ctx: RestoreContext): Promise<void> {
  const state = await ctx.db.state();
  if (state.restoring) {
    await ctx.db.endSessions([RESTORING]);
    await ctx.db.drop(RESTORING);
  }
  await ctx.journal.delete();
}

/** Step 6 from the journal's `finishing`: drop the original, tag `raccoon` finished, delete the journal. */
async function stepSix(ctx: RestoreContext, journal: RestoreJournal): Promise<void> {
  await writeJournal(ctx, { ...journal, state: "finishing" });
  await ctx.hooks.at("finishing");
  const s = await ctx.db.state();
  if (s.before && s.live?.tag?.id === journal.id) {
    await ctx.db.endSessions([BEFORE]);
    await ctx.db.drop(BEFORE);
    await ctx.hooks.at("dropped");
  }
  await ctx.db.setTag(LIVE, { kind: "finished", id: journal.id });
  await ctx.hooks.at("finished");
  await ctx.journal.delete();
  await ctx.hooks.at("journalDeleted");
}

/** Undo: the restored copy dropped only beside the original, the original renamed back, the leftover dropped. */
async function undo(ctx: RestoreContext, journal: RestoreJournal | null): Promise<void> {
  if (journal) await writeJournal(ctx, { ...journal, state: "undoing" });
  await ctx.hooks.at("undoing");
  let s = await ctx.db.state();
  if (s.live && s.before && s.live.tag?.kind === "restored") {
    await ctx.db.endSessions([LIVE]);
    await ctx.db.drop(LIVE);
    await ctx.hooks.at("undoDropped");
    s = await ctx.db.state();
  }
  if (!s.live && s.before) {
    await ctx.db.endSessions([BEFORE]);
    await ctx.db.rename(BEFORE, LIVE);
    await ctx.hooks.at("undoRenamed");
  }
  if (s.restoring) {
    await ctx.db.endSessions([RESTORING]);
    await ctx.db.drop(RESTORING);
    await ctx.hooks.at("undoDroppedRestoring");
  }
  await ctx.journal.delete();
}

function reasonOf(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr && e.stderr.trim()) || e.message || String(err);
  return (text.trim().split(/\r?\n/)[0] ?? text).replace(/[.\s]+$/, "");
}

/** The record a backup's `.good.json` holds, or null. */
export function parseRecord(text: string): BackupRecord | null {
  try {
    const parsed = BackupRecord.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
