import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import type { ApiErrorCode } from "#shared/apiErrors.ts";
import { VIDEO_LIMITS } from "#shared/limits.ts";
import { checkedVideoFacts } from "#shared/protocol.ts";
import type { VideoContainer, VideoFacts } from "#shared/model.ts";
import { AssetError } from "../errors.ts";
import { parseMp4 } from "./mp4.ts";
import { parseWebm } from "./webm.ts";
import { Budget, BufferSource, EditIntoMediaError, FileWindow, refuse, type Edits, type Source } from "./window.ts";

/**
 * The video intake's header check (docs/design/design-v1-animated-maps.md
 * 10, D-261102-442). No transcoder and no decoder: a bounded parser of the
 * container's headers refuses what it cannot vouch for, keeps an allowlist
 * of what playback needs and zeroes everything else in place.
 */

/** What a container's parser learns, before the caps, with the edits it will make. */
export type ParsedVideo = Omit<VideoFacts, "kbps"> & { edits: Edits };

/**
 * The container by its first bytes, never by what the sender claimed.
 * Matroska that is not WebM, MOV and every other container is `video_type`.
 */
export function containerOf(ext: string | undefined): VideoContainer {
  if (ext === "webm") return "webm";
  if (ext === "mp4" || ext === "m4v") return "mp4";
  throw refuse("video_type");
}

/**
 * The caps of 6.3, then the facts, with `kbps` from the file's size and
 * length. Last, the facts must be ones the protocol takes (AM-R1-05): a
 * stored video whose facts the protocol refused would be in the Library and
 * in no map, as every op naming it would fail.
 */
export function capped(parsed: ParsedVideo, fileBytes: number): VideoFacts {
  const { edits: _edits, ...facts } = parsed;
  const L = VIDEO_LIMITS;
  const { widthPx: w, heightPx: h } = facts;
  if (Math.min(w, h) < L.minSidePx || Math.max(w, h) > L.maxSidePx || w * h > L.maxPixels) throw refuse("video_size");
  if (facts.durationMs < L.minDurationMs || facts.durationMs > L.maxDurationMs) throw refuse("video_length");
  if (facts.fps > L.maxFramesInASecond) throw refuse("video_fps");
  // Bits per millisecond is kilobits per second. At least 1, so a tiny file still reads as a rate.
  const checked = checkedVideoFacts({ ...facts, kbps: Math.max(1, Math.round((fileBytes * 8) / facts.durationMs)) });
  if (!checked) throw refuse("bad_video");
  return checked;
}

async function parse(src: Source, container: VideoContainer, budget: Budget): Promise<ParsedVideo> {
  return container === "webm" ? parseWebm(src, budget) : parseMp4(src, budget);
}

/**
 * A Node system error, such as ENOSPC or EIO: the disk's trouble, never
 * the file's, so it reaches the route as one (AM-R1-06) rather than telling
 * the DM their video could not be read.
 */
export function isSystemError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).syscall === "string";
}

/**
 * What a malformed file makes the sniff or the parser throw becomes
 * `bad_video`, so the route answers a 4.5 code and never a 500. A refusal
 * passes as it is, as do an edit into the media data, which is the check's
 * own bug and stays loud, and a disk's error.
 */
async function reading<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AssetError || err instanceof EditIntoMediaError || isSystemError(err)) throw err;
    throw new AssetError(422, "bad_video", { cause: err });
  }
}

/**
 * The check itself, in the thread that calls it: checkWorker.ts runs it.
 * It checks the video at `path` and zeroes, in place, everything its
 * allowlist does not keep. The file keeps its length and every offset.
 */
export async function checkVideoHere(path: string, budget: Budget = new Budget()): Promise<VideoFacts> {
  const { size } = await stat(path);
  if (size > VIDEO_LIMITS.fileBytes) throw new AssetError(413, "too_large");
  const container = await reading(async () => containerOf((await fileTypeFromFile(path))?.ext));
  const window = await FileWindow.open(path, budget);
  let parsed: ParsedVideo;
  try {
    parsed = await reading(() => parse(window, container, budget));
  } finally {
    await window.close();
  }
  const facts = await reading(() => capped(parsed, size));
  await parsed.edits.applyToFile(path, budget);
  return facts;
}

/** Past the budget, how long a worker may take to refuse on its own before it is ended. */
const WORKER_GRACE_MS = 250;
/** How long a worker may take to load its modules, which a busy machine slows, before the check's budget starts. */
const WORKER_LOAD_MS = 15_000;

/** What a refusal or an error looks like crossing from the worker. */
export type CheckFailure =
  | { kind: "refusal"; status: number; code: ApiErrorCode }
  | { kind: "media"; message: string }
  | { kind: "system"; message: string; code?: string; errno?: number; syscall?: string; path?: string }
  | { kind: "bug"; message: string };

export type CheckMessage = { t: "started" } | { t: "done"; facts: VideoFacts } | { t: "failed"; failure: CheckFailure };

export function failureOf(err: unknown): CheckFailure {
  if (err instanceof AssetError) return { kind: "refusal", status: err.status, code: err.code };
  if (err instanceof EditIntoMediaError) return { kind: "media", message: err.message };
  if (isSystemError(err)) {
    const { message, code, errno, syscall, path } = err;
    return { kind: "system", message, ...(code ? { code } : {}), ...(errno !== undefined ? { errno } : {}), ...(syscall ? { syscall } : {}), ...(path ? { path } : {}) };
  }
  return { kind: "bug", message: err instanceof Error ? (err.stack ?? err.message) : String(err) };
}

function errorOf(failure: CheckFailure): Error {
  if (failure.kind === "refusal") return new AssetError(failure.status, failure.code);
  if (failure.kind === "media") return new EditIntoMediaError(failure.message);
  if (failure.kind === "system") return Object.assign(new Error(failure.message), { code: failure.code, errno: failure.errno, syscall: failure.syscall, path: failure.path });
  return new Error(`the video check failed: ${failure.message}`);
}

/**
 * Checks the video at `path` in a worker thread (D-261102-539), so the
 * parse, the media-edit guard and the zeroing never hold the event loop
 * every room shares. The worker keeps the 5 s budget itself and refuses
 * past it. Should it fail to, say in a loop that never reads the budget,
 * it is ended at the deadline and the video refused as unreadable. The
 * check runs in the processing queue, as an image's encode does.
 *
 * `worker` stands in for checkWorker.ts in a test.
 */
export function checkVideo(path: string, opts: { budgetMs?: number; worker?: URL } = {}): Promise<VideoFacts> {
  const budgetMs = opts.budgetMs ?? VIDEO_LIMITS.parseBudgetMs;
  const worker = new Worker(opts.worker ?? new URL("./checkWorker.ts", import.meta.url), { workerData: { path, budgetMs } });
  return new Promise<VideoFacts>((resolve, reject) => {
    let settled = false;
    const end = (outcome: { facts: VideoFacts } | { err: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if ("facts" in outcome) resolve(outcome.facts);
      else reject(outcome.err);
    };
    let timer = setTimeout(() => end({ err: new Error("the video check's worker did not start") }), WORKER_LOAD_MS);
    worker.on("message", (message: CheckMessage) => {
      if (message.t === "started") {
        clearTimeout(timer);
        timer = setTimeout(() => end({ err: refuse("bad_video") }), budgetMs + WORKER_GRACE_MS);
      } else if (message.t === "done") end({ facts: message.facts });
      else end({ err: errorOf(message.failure) });
    });
    worker.once("error", (err) => end({ err }));
    worker.once("exit", (code) => end({ err: new Error(`the video check's worker stopped with exit code ${code}`) }));
  });
}

/** The same check on bytes in memory, answering the facts and the zeroed bytes, for tests. */
export async function checkVideoBytes(bytes: Buffer, opts: { budget?: Budget } = {}): Promise<{ facts: VideoFacts; zeroed: Buffer; edits: Edits }> {
  const budget = opts.budget ?? new Budget();
  if (bytes.length > VIDEO_LIMITS.fileBytes) throw new AssetError(413, "too_large");
  return reading(async () => {
    const container = containerOf((await fileTypeFromBuffer(bytes))?.ext);
    const parsed = await parse(new BufferSource(bytes), container, budget);
    const facts = capped(parsed, bytes.length);
    return { facts, zeroed: parsed.edits.applyTo(bytes, budget), edits: parsed.edits };
  });
}
