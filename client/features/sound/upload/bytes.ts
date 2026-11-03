/**
 * A file read by ranges (docs/design/design-v1-sound.md 4.2 step 1), so the
 * header checks before any decoding read kilobytes of a 200 MB file, not
 * all of it.
 */
export type ByteSource = {
  readonly size: number;
  /** Bytes `start` to `end`, fewer at the file's end. */
  read(start: number, end: number): Promise<Uint8Array>;
};

/** How much a Blob source reads ahead at once, so walking many small headers costs few reads. */
const WINDOW = 256 * 1024;

/** A Blob read through `slice`, a window at a time, never the whole file unless asked for it. */
export function blobSource(blob: Blob): ByteSource {
  let cached: { start: number; bytes: Uint8Array } | null = null;
  return {
    size: blob.size,
    async read(start, end) {
      const from = Math.max(0, start);
      const to = Math.min(blob.size, end);
      if (to <= from) return new Uint8Array(0);
      if (cached && from >= cached.start && to <= cached.start + cached.bytes.length) return cached.bytes.subarray(from - cached.start, to - cached.start);
      if (to - from > WINDOW) return new Uint8Array(await blob.slice(from, to).arrayBuffer());
      const windowEnd = Math.min(blob.size, from + WINDOW);
      cached = { start: from, bytes: new Uint8Array(await blob.slice(from, windowEnd).arrayBuffer()) };
      return cached.bytes.subarray(0, to - from);
    },
  };
}

/** Bytes already in memory, for tests and for a file read whole. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: (start, end) => Promise.resolve(bytes.subarray(Math.max(0, start), Math.min(bytes.length, end))),
  };
}
