import { closeSync, fstatSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, extname, join, basename } from "node:path";
import { mkdirSync } from "node:fs";
import { LOG_KEEP, LOG_ROTATE_BYTES } from "../contract.ts";

/**
 * The data folder's logs (docs/design/design-v1-local-app.md 8.1): each
 * process writes its own file, rotated at 10 MB with 5 kept, so a computer
 * left running for months never fills its disk with them.
 */

/** `server.log` is the newest, then `server.1.log` up to `server.4.log`. */
export function rotatedPath(path: string, n: number): string {
  if (n === 0) return path;
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.${n}${ext}`);
}

/** Shifts each older file up one, dropping the oldest, so `path` is free for a new file. */
export function rotate(path: string, keep: number = LOG_KEEP): void {
  rmSync(rotatedPath(path, keep - 1), { force: true });
  for (let n = keep - 2; n >= 0; n--) {
    try {
      renameSync(rotatedPath(path, n), rotatedPath(path, n + 1));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/** Rotates a file another process appends to (PostgreSQL's), only while nothing has it open. */
export function rotateIfLarge(path: string, maxBytes: number = LOG_ROTATE_BYTES, keep: number = LOG_KEEP): void {
  try {
    if (statSync(path).size >= maxBytes) rotate(path, keep);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * A log this process appends to. Writes are synchronous, so the last lines
 * before a crash are on disk, and a log is written only a line at a time.
 */
export class RotatingLog {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private fd: number | null = null;
  private size = 0;

  constructor(path: string, maxBytes: number = LOG_ROTATE_BYTES, keep: number = LOG_KEEP) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.keep = keep;
  }

  /**
   * A line that cannot be written is dropped, and the next one opens the
   * file again. A full disk is when backups and restores fail, and a log
   * line that threw there would skip their clean-up, or stop the supervisor
   * without stopping PostgreSQL.
   */
  write(text: string): void {
    try {
      this.append(text);
    } catch {
      this.close();
    }
  }

  private append(text: string): void {
    if (this.fd === null) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.fd = openSync(this.path, "a", 0o600);
      this.size = fstatSync(this.fd).size;
    }
    const bytes = Buffer.from(text, "utf8");
    if (this.size > 0 && this.size + bytes.length > this.maxBytes) {
      this.close();
      rotate(this.path, this.keep);
      this.fd = openSync(this.path, "a", 0o600);
      this.size = 0;
    }
    writeSync(this.fd, bytes);
    this.size += bytes.length;
  }

  line(text: string): void {
    this.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  close(): void {
    const fd = this.fd;
    this.fd = null;
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // Already closed, or the disk is gone: there is nothing left to do.
    }
  }
}

/**
 * The last thing a log said, for the window's "The log says: ..." (design 9).
 * The app server logs JSON lines, whose message and error are what a person
 * can read, so those are taken out of the JSON.
 */
export async function lastLogLine(path: string, tailBytes = 64 * 1024): Promise<string> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, tailBytes);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      text = buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "no log was written";
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines.at(-1);
  return last === undefined ? "no log was written" : readableLine(last);
}

export function readableLine(line: string): string {
  if (!line.startsWith("{")) return line;
  try {
    const parsed = JSON.parse(line) as { msg?: unknown; err?: { message?: unknown } };
    const msg = typeof parsed.msg === "string" ? parsed.msg : "";
    const err = typeof parsed.err?.message === "string" ? parsed.err.message : "";
    const joined = [msg, err].filter((s) => s.length > 0).join(": ");
    return joined.length > 0 ? joined : line;
  } catch {
    return line;
  }
}
