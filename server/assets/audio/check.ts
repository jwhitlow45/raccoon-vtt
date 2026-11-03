import { open, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { Mp3Refusal } from "#shared/audio/mp3.ts";
import { SOUND_LIMITS } from "#shared/limits.ts";
import type { SoundFacts } from "#shared/model.ts";
import { AssetError } from "../errors.ts";
import { storedSoundSchema } from "../store.ts";

/**
 * A sound upload's check (docs/design/design-v1-music.md 7.1 and 7.2): the
 * frame walk of shared/audio/mp3.ts, which decodes nothing, run in a worker
 * thread (D-261102-539). The walk is linear, but a 24 MiB file is 130,000
 * frames, and every room's sockets share the main thread, so no upload's
 * check may hold it. The worker checks its own budget inside the walk, and
 * the main thread ends the worker at a deadline past that, so a worker that
 * hangs or never starts still answers.
 *
 * Only the walk's refusals become `sound_type` and `sound_length`. A read
 * that fails (a full disk, an I/O error) passes through as it is, a walk
 * out of time is `busy` (the file may be fine, the server is not), and a
 * worker that dies is the server's own error.
 */

/** The facts a walk answers, without the offsets the server never stores. */
export type WalkedFacts = { rateHz: number; kbps: number; channels: 1 | 2; frames: number; ms: number };

export type WalkRequest = { bytes: Uint8Array; budgetMs: number };

export type WalkAnswer = { kind: "walked"; walk: { ok: true; facts: WalkedFacts } | Mp3Refusal } | { kind: "budget" };

export type SoundCheckOptions = {
  /** The walk's own budget, read inside the worker. */
  budgetMs?: number;
  /** When the main thread ends the worker, from its start: the budget plus the worker's start-up. */
  deadlineMs?: number;
  /** The worker's module, for tests that need one that never answers. */
  workerUrl?: URL;
};

export const SOUND_CHECK = {
  /** A 24 MiB file walks in tens of milliseconds, so only a stalled machine meets this. */
  budgetMs: 5_000,
  deadlineMs: 8_000,
  /** The walk holds the file as an ArrayBuffer outside the heap, so the worker's own heap needs little. */
  heapMb: 64,
} as const;

const WALK_WORKER = new URL("./walk.worker.ts", import.meta.url);

/** A refusal of the walk, by its code: a file of another form is 415, as a video's is, and one of the wrong length 422. */
export function soundRefusal(code: Mp3Refusal["code"]): AssetError {
  return new AssetError(code === "sound_type" ? 415 : 422, code);
}

/**
 * The file's whole bytes in a buffer of their own, so they can be
 * transferred to the worker. The size is the one the caller checked, and a
 * file that changed under the read is an error, never a short check.
 */
async function readWhole(path: string, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  const handle = await open(path, "r");
  try {
    let at = 0;
    while (at < size) {
      const { bytesRead } = await handle.read(bytes, at, size - at, at);
      if (bytesRead === 0) throw new Error("a sound upload shrank while it was read");
      at += bytesRead;
    }
    const { bytesRead } = await handle.read(new Uint8Array(1), 0, 1, size);
    if (bytesRead !== 0) throw new Error("a sound upload grew while it was read");
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Walks `bytes` in a worker. `bytes` is transferred and unusable after. */
export function walkInWorker(bytes: Uint8Array, opts: SoundCheckOptions = {}): Promise<WalkAnswer> {
  const budgetMs = opts.budgetMs ?? SOUND_CHECK.budgetMs;
  const deadlineMs = opts.deadlineMs ?? Math.max(SOUND_CHECK.deadlineMs, budgetMs + 3_000);
  return new Promise<WalkAnswer>((resolve, reject) => {
    const worker = new Worker(opts.workerUrl ?? WALK_WORKER, { resourceLimits: { maxOldGenerationSizeMb: SOUND_CHECK.heapMb } });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Ended either way: a worker that answered has nothing left to do, and one that did not must not run on.
      void worker.terminate();
      finish();
    };
    const timer = setTimeout(() => settle(() => resolve({ kind: "budget" })), deadlineMs);
    worker.once("message", (answer: WalkAnswer) => settle(() => resolve(answer)));
    worker.once("error", (err) => settle(() => reject(err)));
    worker.once("exit", (code) => settle(() => reject(new Error(`the sound check's worker ended with code ${code} before it answered`))));
    const request: WalkRequest = { bytes, budgetMs };
    worker.postMessage(request, [bytes.buffer as ArrayBuffer]);
  });
}

/** The facts as the row keeps them, held to the bounds every reader of a row holds them to, so no stored row is refused later. */
export function soundFactsOf(walked: WalkedFacts): SoundFacts {
  const facts = storedSoundSchema.safeParse({ ms: walked.ms, channels: walked.channels, kbps: walked.kbps });
  if (!facts.success || !SOUND_LIMITS.ratesHz.includes(walked.rateHz)) throw soundRefusal("sound_type");
  return facts.data;
}

/** Checks bytes already in memory, which are transferred to the worker. */
export async function checkSoundBytes(bytes: Uint8Array, opts: SoundCheckOptions = {}): Promise<SoundFacts> {
  if (bytes.length > SOUND_LIMITS.fileBytes) throw new AssetError(413, "too_large");
  const answer = await walkInWorker(bytes, opts);
  if (answer.kind === "budget") throw new AssetError(503, "busy", { retryAfter: 5 });
  if (!answer.walk.ok) throw soundRefusal(answer.walk.code);
  return soundFactsOf(answer.walk.facts);
}

/**
 * Checks the sound file at `path`, which is stored as it is if this
 * answers: the server keeps the upload's own bytes, so nothing is edited.
 * It runs in the processing queue, as an image's encode does.
 */
export async function checkSound(path: string, opts: SoundCheckOptions = {}): Promise<SoundFacts> {
  const { size } = await stat(path);
  if (size > SOUND_LIMITS.fileBytes) throw new AssetError(413, "too_large");
  if (size === 0) throw soundRefusal("sound_type");
  return checkSoundBytes(await readWhole(path, size), opts);
}
