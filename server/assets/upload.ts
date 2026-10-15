import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { AssetError } from "./errors.ts";

/**
 * Streams a body to a temporary file on the asset volume, counting bytes and
 * hashing as it goes (design section 11.1).
 *
 * Nothing is buffered in memory beyond the stream's own chunks. The body is
 * cut off when it passes `maxBytes`, when it misses its deadline, or when it
 * averages under `minBytesPerSec` once `graceMs` has passed, so nobody can
 * hold an intake slot by trickling bytes.
 */
export type BodyLimits = {
  maxBytes: number;
  deadlineMs: number;
  /** 32 KiB/s for uploads. */
  minBytesPerSec: number;
  /** The rate check starts after this long (10 s), so a slow start on a phone is fine. */
  graceMs: number;
  /** How often the rate and deadline are checked. */
  checkEveryMs?: number;
};

export type Received = { size: number; sha256: Buffer };

export const UPLOAD_RATE = { minBytesPerSec: 32 * 1024, graceMs: 10_000 } as const;

/** A fresh name in the temp directory. The caller deletes the file when done. */
export function tempFile(tmpDir: string, prefix: "intake" | "fetch"): string {
  return join(tmpDir, `${prefix}-${randomUUID()}`);
}

/**
 * Writes `source` to `path`, which must not exist. The caller owns `path`
 * and deletes it however this ends.
 *
 * `onAbort` says what to do with the source when the body is refused. An
 * incoming request is only paused: destroying it would destroy the socket,
 * and the refusal could not be answered. A fetched body is destroyed, which
 * closes the outbound connection.
 */
export function receiveToFile(
  source: Readable,
  path: string,
  limits: BodyLimits,
  onAbort: "pause" | "destroy" = "pause",
): Promise<Received> {
  const hash = createHash("sha256");
  const out = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const started = Date.now();
  let size = 0;
  let ended = false;
  let settled = false;

  return new Promise<Received>((resolve, reject) => {
    const cleanup = (): void => {
      clearInterval(timer);
      source.off("data", onData);
      source.off("end", onEnd);
      source.off("error", onError);
      source.off("close", onClose);
      out.off("error", onError);
      out.off("finish", onFinish);
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Destroying a stream can still emit 'error' (undici bodies report the
      // abort that way), and with the listeners gone that would crash the
      // process, so later errors from either stream are ignored.
      source.on("error", ignore);
      out.on("error", ignore);
      if (onAbort === "destroy") source.destroy();
      else source.pause();
      out.destroy();
      reject(err instanceof AssetError ? err : new AssetError(400, "upload_failed", { cause: err, closeConnection: true }));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limits.maxBytes) {
        fail(new AssetError(413, "too_large", { closeConnection: true }));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        source.pause();
        out.once("drain", () => {
          if (!settled) source.resume();
        });
      }
    };
    const onEnd = (): void => {
      ended = true;
      out.end();
    };
    const onError = (err: unknown): void => fail(err);
    const onClose = (): void => {
      if (!ended) fail(new AssetError(400, "upload_aborted", { closeConnection: true }));
    };
    const onFinish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ size, sha256: hash.digest() });
    };
    const timer = setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed >= limits.deadlineMs) {
        fail(new AssetError(408, "too_slow", { closeConnection: true }));
      } else if (elapsed >= limits.graceMs && size < (limits.minBytesPerSec * elapsed) / 1000) {
        fail(new AssetError(408, "too_slow", { closeConnection: true }));
      }
    }, limits.checkEveryMs ?? 1000);

    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
    source.on("close", onClose);
    out.on("error", onError);
    out.on("finish", onFinish);
    source.resume();
  });
}

function ignore(): void {}
