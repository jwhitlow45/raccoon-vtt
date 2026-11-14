import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writes that survive a power loss in a known order (docs/design/design-v1-local-app.md
 * 8.3, D-261113-091). The restore journal and the owner record are written
 * this way: a temp file in the same folder, fsync, rename over the target,
 * then an fsync of the folder, so the new name is on disk before anything
 * that depends on it runs. Node's fsync issues F_FULLFSYNC on macOS.
 *
 * Windows can neither open a folder to fsync it nor rename with
 * MOVEFILE_WRITE_THROUGH from Node, so there the renamed file is opened
 * again and flushed, as PostgreSQL does for its own files. That makes the
 * data durable and the name as durable as NTFS makes a flushed rename: best
 * effort, which the restore's table of states is built to tolerate.
 */

/** The file calls a durable write makes, so a test can record their order or make one fail. */
export type DurableFs = {
  open(path: string, flags: string, mode?: number): Promise<{ writeFile(data: string | Uint8Array): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

export const nodeFs: DurableFs = { open, rename, unlink };

export type DurableOptions = { platform?: NodeJS.Platform; fs?: DurableFs; mode?: number };

/** Codes some file systems give for an fsync of a folder they cannot flush. Nothing more can be done there. */
const DIR_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);

export async function syncDir(dir: string, opts: DurableOptions = {}): Promise<void> {
  if ((opts.platform ?? process.platform) === "win32") return;
  const fs = opts.fs ?? nodeFs;
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } catch (err) {
    if (!DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  } finally {
    await handle.close();
  }
}

/** Flushes a file's data to disk. Windows needs write access for that (FlushFileBuffers). */
export async function syncFile(path: string, opts: DurableOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  const handle = await fs.open(path, (opts.platform ?? process.platform) === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeDurable(path: string, data: string | Uint8Array, opts: DurableOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  const platform = opts.platform ?? process.platform;
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await fs.open(tmp, "w", opts.mode ?? 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  if (platform === "win32") await syncFile(path, { platform, fs });
  else await syncDir(dirname(path), { platform, fs });
}

/** Deletes a file and makes the deletion durable. A file already gone counts as deleted. */
export async function removeDurable(path: string, opts: DurableOptions = {}): Promise<void> {
  const fs = opts.fs ?? nodeFs;
  try {
    await fs.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await syncDir(dirname(path), opts);
}

/** Codes Windows gives a rename while another program has a file in the tree open. */
const RENAME_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

export type RenameRetry = {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to keep trying, 30 s unless set. */
  limitMs?: number;
};

/**
 * A rename, tried again on Windows. Windows refuses to rename a folder while
 * any file in it is open, and right after initdb writes a thousand files a
 * real-time antivirus scan or the search indexer often has one open. So on
 * EPERM, EACCES or EBUSY it waits 100 ms, then twice as long each time up to
 * 2 s, for up to 30 s in all, as graceful-fs does. Other systems and other
 * errors fail at once.
 */
export async function renameRetrying(from: string, to: string, opts: RenameRetry = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const doRename = opts.rename ?? rename;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const limit = opts.limitMs ?? 30_000;
  const started = now();
  let wait = 100;
  for (;;) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !RENAME_BUSY.has(code) || now() - started + wait > limit) throw err;
      await sleep(wait);
      wait = Math.min(wait * 2, 2_000);
    }
  }
}

