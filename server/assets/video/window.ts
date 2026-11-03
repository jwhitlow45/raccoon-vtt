import { open, type FileHandle } from "node:fs/promises";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { AssetError } from "../errors.ts";

/**
 * The header check's bounded reads and its edits
 * (docs/design/design-v1-animated-maps.md 10).
 *
 * Reads go through one 64 KiB window rather than one `read()` per header,
 * because libuv's small thread pool is shared with argon2 (process.ts), and
 * a WebM walk visits every block header of a 64 MiB file. The check is
 * async and mostly synchronous between reads, so a timer could never stop
 * it: the budget is checked inside every loop instead.
 */

export const WINDOW_BYTES = 64 * 1024;

/** Every refusal the check makes, so nothing but an AssetError carrying a 4.5 code ever leaves it. */
export function refuse(code: ApiErrorCode): AssetError {
  return new AssetError(code === "video_type" ? 415 : 422, code);
}

/** The 5 s of work a check may take, read in every loop. */
export class Budget {
  readonly #deadline: number;
  readonly #now: () => number;

  constructor(ms: number = VIDEO_LIMITS.parseBudgetMs, now: () => number = () => performance.now()) {
    this.#now = now;
    this.#deadline = now() + ms;
  }

  check(): void {
    if (this.#now() > this.#deadline) throw refuse("bad_video");
  }
}

/** A count with a cap, such as the element headers a walk may read. */
export class Tally {
  count = 0;
  readonly #limit: number;
  readonly #code: ApiErrorCode;

  constructor(limit: number, code: ApiErrorCode = "bad_video") {
    this.#limit = limit;
    this.#code = code;
  }

  add(n = 1): void {
    this.count += n;
    if (this.count > this.#limit) throw refuse(this.#code);
  }
}

/** The bytes of a file the check may read, never past its end. */
export interface Source {
  readonly size: number;
  /** Up to `WINDOW_BYTES` at `offset`, fewer only at the file's end. Reading past the end is `bad_video`. */
  read(offset: number, length: number): Promise<Buffer>;
  /** One read of a whole region, for MP4's `moov`, which the caller has bounded. */
  readAll(offset: number, length: number): Promise<Buffer>;
}

export class FileWindow implements Source {
  readonly size: number;
  readonly #handle: FileHandle;
  readonly #budget: Budget;
  #start = 0;
  #bytes: Buffer = Buffer.alloc(0);

  private constructor(handle: FileHandle, size: number, budget: Budget) {
    this.#handle = handle;
    this.size = size;
    this.#budget = budget;
  }

  static async open(path: string, budget: Budget): Promise<FileWindow> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      return new FileWindow(handle, size, budget);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    within(this.size, offset, length);
    if (length > WINDOW_BYTES) throw new Error("a windowed read is at most one window");
    if (offset >= this.#start && offset + length <= this.#start + this.#bytes.length) {
      return this.#bytes.subarray(offset - this.#start, offset - this.#start + length);
    }
    this.#budget.check();
    const want = Math.min(WINDOW_BYTES, this.size - offset);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await this.#handle.read(buf, 0, want, offset);
    // A file that shrank under the check is no file to vouch for.
    if (bytesRead !== want) throw refuse("bad_video");
    this.#start = offset;
    this.#bytes = buf;
    return buf.subarray(0, length);
  }

  async readAll(offset: number, length: number): Promise<Buffer> {
    within(this.size, offset, length);
    this.#budget.check();
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.#handle.read(buf, 0, length, offset);
    if (bytesRead !== length) throw refuse("bad_video");
    return buf;
  }

  close(): Promise<void> {
    return this.#handle.close();
  }
}

/** A whole file held in memory, for tests and for checking bytes before they reach a disk. */
export class BufferSource implements Source {
  readonly size: number;
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
    this.size = bytes.length;
  }

  async read(offset: number, length: number): Promise<Buffer> {
    within(this.size, offset, length);
    return this.#bytes.subarray(offset, offset + length);
  }

  async readAll(offset: number, length: number): Promise<Buffer> {
    within(this.size, offset, length);
    return this.#bytes.subarray(offset, offset + length);
  }
}

function within(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw refuse("bad_video");
  }
}

export type Range = { start: number; end: number };

/** An edit that would reach into the media data: a bug in the check, so it is never turned into a refusal. */
export class EditIntoMediaError extends Error {}

/**
 * What the check changes, applied only once the whole file has passed.
 * Every edit overwrites bytes in place, so no byte moves and the size and
 * every offset stay as they were. `protect` names the media data (MP4's
 * `mdat` payloads, WebM's block payloads), which no edit may touch: the
 * server never writes at offsets the file's own tables give (D-261102-514).
 */
export class Edits {
  readonly writes: Array<{ offset: number; bytes: Buffer }> = [];
  readonly zeroes: Range[] = [];
  readonly protected: Range[] = [];

  put(offset: number, bytes: Buffer): void {
    if (bytes.length > 0) this.writes.push({ offset, bytes: Buffer.from(bytes) });
  }

  zero(start: number, end: number): void {
    if (end > start) this.zeroes.push({ start, end });
  }

  protect(start: number, end: number): void {
    if (end > start) this.protected.push({ start, end });
  }

  /** Every range an edit writes, the writes' bytes included. */
  touched(): Range[] {
    return [...this.writes.map((w) => ({ start: w.offset, end: w.offset + w.bytes.length })), ...this.zeroes];
  }

  /** Throws when any edit reaches into the media data: a bug in the check, never a property of the file. */
  assertOutsideMedia(): void {
    for (const t of this.touched()) {
      for (const p of this.protected) {
        if (t.start < p.end && p.start < t.end) throw new EditIntoMediaError(`a video edit at ${t.start} to ${t.end} reaches into media data at ${p.start} to ${p.end}`);
      }
    }
  }

  /** The edits applied to a copy of `bytes`, for tests. */
  applyTo(bytes: Buffer): Buffer {
    this.assertOutsideMedia();
    const out = Buffer.from(bytes);
    for (const z of this.zeroes) out.fill(0, z.start, z.end);
    for (const w of this.writes) w.bytes.copy(out, w.offset);
    return out;
  }

  /** The edits written into the file at `path`, zeroes first, then the headers that rename what they cleared. */
  async applyToFile(path: string): Promise<void> {
    this.assertOutsideMedia();
    const handle = await open(path, "r+");
    try {
      const zeros = Buffer.alloc(WINDOW_BYTES);
      for (const z of this.zeroes) {
        for (let at = z.start; at < z.end; at += WINDOW_BYTES) {
          const n = Math.min(WINDOW_BYTES, z.end - at);
          await handle.write(zeros, 0, n, at);
        }
      }
      for (const w of this.writes) await handle.write(w.bytes, 0, w.bytes.length, w.offset);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
