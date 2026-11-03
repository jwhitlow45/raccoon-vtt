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

/** How often a loop over edits or ranges reads the budget: often enough that no stretch between reads takes long. */
const BUDGET_EVERY = 1024;

/** `ranges` sorted by start, with overlapping and touching ones joined, so a sweep can pass over them once. */
function joined(ranges: readonly Range[], budget: Budget | undefined): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i % BUDGET_EVERY === 0) budget?.check();
    const r = sorted[i]!;
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

type Write = { offset: number; bytes: Buffer };

/**
 * What the check changes, applied only once the whole file has passed.
 * Every edit overwrites bytes in place, so no byte moves and the size and
 * every offset stay as they were. `protect` names the media data (MP4's
 * `mdat` payloads, WebM's block payloads), which no edit may touch: the
 * server never writes at offsets the file's own tables give (D-261102-514).
 *
 * A file may hold hundreds of thousands of each (AMBUILD-ASTRA-01,
 * AM-R1-01), so nothing here compares every edit with every range: the
 * guard and the writes sweep lists sorted once, under the check's budget.
 */
export class Edits {
  readonly writes: Write[] = [];
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

  /**
   * Throws when any edit reaches into the media data: a bug in the check,
   * never a property of the file. The media ranges are joined into sorted,
   * disjoint stretches and the edits sorted by start, so one pass finds,
   * for each edit, the first stretch that ends after it starts: the only
   * one it could reach into.
   */
  assertOutsideMedia(budget?: Budget): void {
    this.#outsideMedia(budget);
  }

  /** The guard, answering the media's joined stretches for the writer's own check. */
  #outsideMedia(budget: Budget | undefined): Range[] {
    const media = joined(this.protected, budget);
    const touched = this.touched().sort((a, b) => a.start - b.start);
    let next = 0;
    for (let i = 0; i < touched.length; i++) {
      if (i % BUDGET_EVERY === 0) budget?.check();
      const t = touched[i]!;
      while (next < media.length && media[next]!.end <= t.start) next++;
      const p = media[next];
      if (p && p.start < t.end) throw new EditIntoMediaError(`a video edit at ${t.start} to ${t.end} reaches into media data at ${p.start} to ${p.end}`);
    }
    return media;
  }

  /** The edits applied to a copy of `bytes`, for tests: zeroes first, then the headers that rename what they cleared. */
  applyTo(bytes: Buffer, budget?: Budget): Buffer {
    this.assertOutsideMedia(budget);
    this.#sortedWrites(budget);
    const out = Buffer.from(bytes);
    for (const z of this.zeroes) out.fill(0, z.start, z.end);
    for (const w of this.writes) w.bytes.copy(out, w.offset);
    return out;
  }

  /**
   * The writes by offset. Two writes over the same byte would make the
   * result hang on their order, and the check never asks for that, so it is
   * its bug. A zero under a write is how a renamed header clears what follows it.
   */
  #sortedWrites(budget: Budget | undefined): Write[] {
    const sorted = [...this.writes].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
      if (i % BUDGET_EVERY === 0) budget?.check();
      const prev = sorted[i - 1]!;
      if (prev.offset + prev.bytes.length > sorted[i]!.offset) throw new Error(`two video edits write at ${sorted[i]!.offset}`);
    }
    return sorted;
  }

  /**
   * The edits written into the file at `path`, at most a window at a time.
   * One write per edit would queue hundreds of thousands of small writes
   * on libuv's pool, which argon2 shares (process.ts). So every edited byte
   * is gathered into joined stretches, and stretches within a window of
   * each other go out together: the bytes between them are read first and
   * written back as they were. A stretch longer than a window is all
   * edits, so it is written a window at a time with nothing read.
   *
   * A batch never reaches across media data, though its bytes would come
   * back the same: the check never writes inside the media, and each write
   * is held to that before it runs (AMBUILD-SOL-007). `opener` stands in
   * for `open` in a test that records where the writes land.
   */
  async applyToFile(path: string, budget?: Budget, opener: (path: string, flags: string) => Promise<FileHandle> = open): Promise<void> {
    const media = this.#outsideMedia(budget);
    const writes = this.#sortedWrites(budget);
    const zeroes = joined(this.zeroes, budget);
    const stretches = joined(this.touched(), budget);
    const painter = new Painter(zeroes, writes);
    // Two cursors, since each is asked in rising order: the gaps a batch would cover, and the writes themselves.
    const between = new MediaCursor(media);
    const written = new MediaCursor(media);
    const handle = await opener(path, "r+");
    const write = async (buf: Buffer, at: number) => {
      if (written.meets(at, at + buf.length)) throw new EditIntoMediaError(`a video write at ${at} to ${at + buf.length} reaches into media data`);
      await handle.write(buf, 0, buf.length, at);
    };
    try {
      let i = 0;
      while (i < stretches.length) {
        budget?.check();
        const first = stretches[i]!;
        if (first.end - first.start >= WINDOW_BYTES) {
          for (let at = first.start; at < first.end; at += WINDOW_BYTES) {
            budget?.check();
            const buf = Buffer.alloc(Math.min(WINDOW_BYTES, first.end - at));
            painter.paint(buf, at);
            await write(buf, at);
          }
          i++;
          continue;
        }
        let last = i;
        while (last + 1 < stretches.length && stretches[last + 1]!.end - first.start <= WINDOW_BYTES && !between.meets(stretches[last]!.end, stretches[last + 1]!.start)) last++;
        const buf = Buffer.alloc(stretches[last]!.end - first.start);
        if (last > i) {
          const { bytesRead } = await handle.read(buf, 0, buf.length, first.start);
          if (bytesRead !== buf.length) throw refuse("bad_video");
        }
        painter.paint(buf, first.start);
        await write(buf, first.start);
        i = last + 1;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/**
 * Whether a span meets the media's sorted, disjoint stretches. The writer
 * asks in rising order, so a stretch is passed over once it ends before
 * the span asked about.
 */
class MediaCursor {
  readonly #media: readonly Range[];
  #at = 0;

  constructor(media: readonly Range[]) {
    this.#media = media;
  }

  meets(start: number, end: number): boolean {
    while (this.#at < this.#media.length && this.#media[this.#at]!.end <= start) this.#at++;
    const m = this.#media[this.#at];
    return m !== undefined && m.start < end;
  }
}

/**
 * Paints the edits that fall in a buffer standing for the file from `at`,
 * zeroes then writes. Buffers come in rising order, so each list is passed
 * over once: a range is left behind only once it ends before the buffer.
 */
class Painter {
  readonly #zeroes: readonly Range[];
  readonly #writes: readonly Write[];
  #z = 0;
  #w = 0;

  constructor(zeroes: readonly Range[], writes: readonly Write[]) {
    this.#zeroes = zeroes;
    this.#writes = writes;
  }

  paint(buf: Buffer, at: number): void {
    const end = at + buf.length;
    while (this.#z < this.#zeroes.length && this.#zeroes[this.#z]!.end <= at) this.#z++;
    for (let k = this.#z; k < this.#zeroes.length && this.#zeroes[k]!.start < end; k++) {
      const z = this.#zeroes[k]!;
      buf.fill(0, Math.max(z.start, at) - at, Math.min(z.end, end) - at);
    }
    while (this.#w < this.#writes.length && this.#writes[this.#w]!.offset + this.#writes[this.#w]!.bytes.length <= at) this.#w++;
    for (let k = this.#w; k < this.#writes.length && this.#writes[k]!.offset < end; k++) {
      const w = this.#writes[k]!;
      const from = Math.max(w.offset, at);
      w.bytes.copy(buf, from - at, from - w.offset, Math.min(w.offset + w.bytes.length, end) - w.offset);
    }
  }
}
