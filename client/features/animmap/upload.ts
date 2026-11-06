import { stillFitsVideo } from "#shared/limits.ts";
import type { MapVideo } from "#shared/model.ts";
import { drawnSize, isPlainGeometry } from "#shared/videoGeometry.ts";
import { api, ApiError, assetUrl, type AssetRow, type ProgressUploadOptions } from "../../lib/api.ts";
import type { MapAsset } from "../scenes/create.ts";
import { uploadErrorText } from "../scenes/upload.ts";
import { FirstFrameError, readFirstFrame, readStoredFrame, stillFileName, videoContainer, type FirstFrame } from "./firstFrame.ts";
import { videoRefusalText } from "./words.ts";

/**
 * An animated map's upload (docs/design/design-v1-animated-maps.md 4.1,
 * D-261102-458): the first frame read on this device, the video, then the
 * still, each with its percent, and the grid search after, which the form
 * runs on the still as it does on an image. A failure or a cancel after the
 * video went up deletes the video, if this upload made its row. A video the
 * room already held stays.
 *
 * The local frame is the still only when it came and the server's facts
 * are plain (docs/design/design-v1-video-turns.md 8, D-261102-853 and 898).
 * Otherwise, a turned or stretched video or a file this device could not
 * read as picked, the still is read from the stored copy once the video is
 * up, drawn as the board draws it. When that fails too, the form asks for a
 * still image, with the video held (`HeldVideo`), so 64 MB never goes up
 * twice. A picked still must be the video's shape as it shows, by the
 * server's facts. A still of another shape is refused and the video held
 * while the DM picks another.
 */

/** Where the upload is, as the busy button says it. */
export type UploadStep = { t: "frame" } | { t: "video"; percent: number } | { t: "still"; percent: number } | { t: "grid" };

export const READING_FRAME = "Reading the first frame…";
export const FINDING_GRID = "Looking for a grid…";

export function stepText(step: UploadStep): string {
  switch (step.t) {
    case "frame":
      return READING_FRAME;
    case "video":
      return `Uploading the video… ${step.percent}%`;
    case "still":
      return `Uploading the still… ${step.percent}%`;
    case "grid":
      return FINDING_GRID;
  }
}

/** The help under the ways to bring an image, while the server takes videos. */
export const VIDEO_PICK_HELP = "A WebM, MP4 or MOV video makes an animated map, up to 64 MB. H.264 plays on the most devices.";

/** The pickers' types: images, and videos while the server's switch is on. A MOV by its extension too, for a computer's picker that does not know its type. */
export function mapAccept(videos: boolean): string {
  return videos ? "image/*,video/webm,video/mp4,video/quicktime,.mov" : "image/*";
}

/** A video already in the room for this upload, waiting for its still. */
export type HeldVideo = { video: MapVideo; created: boolean };

/** What the upload made: the still as a map image carrying its video, and the still's file for the grid search. */
export type AnimatedUpload = { asset: MapAsset & { video: MapVideo }; stillFile: File; created: boolean };

/**
 * The step that failed, so its words are the video's refusals, the image's
 * or the probe's. `frame` is the stored copy's first frame, which this
 * device could not read.
 */
export class AnimatedUploadError extends Error {
  readonly step: "video" | "still" | "shape" | "frame";
  readonly cause: unknown;
  /** A still of the wrong shape, or a stored copy whose frame could not be read, keeps the video for the next still the DM picks. */
  readonly held: HeldVideo | null;
  constructor(step: "video" | "still" | "shape" | "frame", cause: unknown, held: HeldVideo | null = null) {
    super(step === "shape" ? String(cause) : cause instanceof Error ? cause.message : "The upload failed.");
    this.name = "AnimatedUploadError";
    this.step = step;
    this.cause = cause;
    this.held = held;
  }
}

/** A video's aspect as the shape refusal names it: "16:9" in small whole numbers, else to two places, "2.39:1". */
export function aspectText(size: { widthPx: number; heightPx: number }): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const w = Math.round(size.widthPx);
  const h = Math.round(size.heightPx);
  const d = w > 0 && h > 0 ? gcd(w, h) : 1;
  if (w / d <= 32 && h / d <= 32) return `${w / d}:${h / d}`;
  return `${(w / h).toFixed(2).replace(/\.?0+$/, "")}:1`;
}

/** The words for a picked still of another shape, which name the video's shape as it shows: a portrait phone video's is 9:16. */
export function shapeRefusalText(video: Parameters<typeof drawnSize>[0]): string {
  return `That image isn't the video's shape (${aspectText(drawnSize(video))}). Pick one the same shape.`;
}

/** The words for a failed step: a video's refusal in 4.5's words, an image's as today, or the probe's own. */
export function animatedUploadText(err: unknown): string {
  if (err instanceof FirstFrameError) return err.message;
  if (err instanceof AnimatedUploadError) {
    if (err.step === "shape" || err.step === "frame") return err.message;
    if (err.step === "video") return videoRefusalText(err.cause) ?? uploadErrorText(err.cause);
    return uploadErrorText(err.cause);
  }
  return videoRefusalText(err) ?? uploadErrorText(err);
}

/** The video's facts from its upload answer, which the server read from the file's headers. */
export function mapVideoOf(row: AssetRow): MapVideo {
  if (!row.video) throw new ApiError(422, "That video could not be read.", "bad_video", null);
  return { assetId: row.id, ...row.video };
}

export type UploadDeps = {
  /** The picked file's first frame, or null when this device made none (firstFrame.ts readFirstFrame). */
  readFrame(file: File, options: { host: HTMLElement | null; signal?: AbortSignal }): Promise<FirstFrame | null>;
  /** The stored copy's first frame, drawn as the board draws it (firstFrame.ts readStoredFrame). */
  readStored(video: MapVideo, options: { host: HTMLElement | null; signal?: AbortSignal }): Promise<FirstFrame>;
  upload(roomId: string, kind: "video" | "map", file: Blob, options: ProgressUploadOptions): Promise<AssetRow>;
  remove(roomId: string, ids: string[]): Promise<unknown>;
};

const liveDeps: UploadDeps = {
  readFrame: (file, options) => readFirstFrame(file, options),
  // The DM reads any asset of the room, and the CSP's media-src 'self' takes it.
  readStored: (video, options) => readStoredFrame(assetUrl(video.assetId, "full"), video, options),
  upload: (roomId, kind, file, options) => api.uploadAssetWithProgress(roomId, kind, file, options),
  remove: (roomId, ids) => api.deleteAssets(roomId, ids),
};

/**
 * Deletes a video this upload made, after a later step failed or was
 * cancelled. A failure to delete is left alone: the video then shows as
 * Not in use in the Library, where the DM can delete it.
 */
export async function discardVideo(roomId: string, held: HeldVideo | null, deps: Pick<UploadDeps, "remove"> = liveDeps): Promise<void> {
  if (!held?.created) return;
  try {
    await deps.remove(roomId, [held.video.assetId]);
  } catch {
    // Not in use in the Library, for the DM's Cleanup.
  }
}

/** A file's type for the upload's content type: a picked file may come with none. */
function typed(file: File, type: string): Blob {
  return file.type === type ? file : new Blob([file], { type });
}

/**
 * Runs the steps for one picked video. `still` is the DM's own image when
 * no first frame could be read, and `held` the video a shape refusal or a
 * failed read of the stored copy kept: with a still, the still goes up for
 * it, and without one, as Try again after Low Power Mode, its stored copy
 * is read again. Throws a FirstFrameError when the picked file is refused
 * or Low Power Mode stops its probe (nothing has gone up then), an
 * AnimatedUploadError for a later step, or the signal's reason.
 */
export async function uploadAnimatedMap(input: {
  roomId: string;
  file: File;
  host: HTMLElement | null;
  signal: AbortSignal;
  onStep(step: UploadStep): void;
  onWaiting?: (waiting: boolean) => void;
  still?: File;
  held?: HeldVideo | null;
  deps?: UploadDeps;
}): Promise<AnimatedUpload> {
  const deps = input.deps ?? liveDeps;
  const { roomId, file, signal } = input;
  let held: HeldVideo | null = input.held ?? null;
  let frame: FirstFrame | null = null;
  if (!input.still && !held) {
    input.onStep({ t: "frame" });
    frame = await deps.readFrame(file, { host: input.host, signal });
  }

  if (!held) {
    if (signal.aborted) throw signal.reason;
    input.onStep({ t: "video", percent: 0 });
    // A MOV goes up as the MP4 the server checks and stores it as, so the route takes it as it does any MP4.
    const container = videoContainer(file) === "webm" ? "video/webm" : "video/mp4";
    let row: AssetRow;
    try {
      row = await deps.upload(roomId, "video", typed(file, container), {
        name: file.name,
        signal,
        onWaiting: input.onWaiting,
        onProgress: (fraction) => input.onStep({ t: "video", percent: Math.floor(fraction * 100) }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AnimatedUploadError("video", err);
    }
    held = { video: mapVideoOf(row), created: row.created === true };
  }

  try {
    let stillFile: File;
    if (input.still) {
      const picked = input.still;
      const size = await imageSize(picked);
      // No size read means the server judges it, as for any map image, and the reducer's shape rule still holds.
      if (size && !stillFitsVideo(size, held.video)) throw new AnimatedUploadError("shape", shapeRefusalText(held.video), held);
      stillFile = picked;
    } else {
      // The local frame shows the file as this browser turned it, which differs by engine, so only a plain video's is the still.
      const still = frame && isPlainGeometry(held.video) ? frame : await storedFrame(deps, held, { host: input.host, signal, onStep: input.onStep });
      stillFile = new File([still.blob], stillFileName(file.name, still.blob.type), { type: still.blob.type });
    }
    if (signal.aborted) throw signal.reason;
    input.onStep({ t: "still", percent: 0 });
    let row: AssetRow;
    try {
      // The video's name rides with the still, so `crypt_30x20.webm` still sets the scale.
      row = await deps.upload(roomId, "map", stillFile.type.startsWith("image/") ? stillFile : new Blob([stillFile], { type: "image/jpeg" }), {
        name: file.name,
        signal,
        onWaiting: input.onWaiting,
        onProgress: (fraction) => input.onStep({ t: "still", percent: Math.floor(fraction * 100) }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AnimatedUploadError("still", err);
    }
    if (!stillFitsVideo({ widthPx: row.width, heightPx: row.height }, held.video)) throw new AnimatedUploadError("shape", shapeRefusalText(held.video), held);
    const asset: AnimatedUpload["asset"] = {
      id: row.id,
      width: row.width,
      height: row.height,
      cellPx: row.cellPx,
      ...(row.hexCellPx ? { hexCellPx: row.hexCellPx } : null),
      video: held.video,
    };
    return { asset, stillFile, created: held.created };
  } catch (err) {
    // A hold keeps the video for the next pick. Anything else lets go of one this upload made.
    if (!(err instanceof AnimatedUploadError && err.held)) await discardVideo(roomId, held, deps);
    throw err;
  }
}

/** The stored copy's first frame, with the busy button saying so again. A failure to read it holds the video for a still the DM picks. */
async function storedFrame(deps: UploadDeps, held: HeldVideo, options: { host: HTMLElement | null; signal: AbortSignal; onStep(step: UploadStep): void }): Promise<FirstFrame> {
  const { signal } = options;
  if (signal.aborted) throw signal.reason;
  options.onStep({ t: "frame" });
  try {
    return await deps.readStored(held.video, { host: options.host, signal });
  } catch (err) {
    if (signal.aborted || !(err instanceof FirstFrameError)) throw err;
    throw new AnimatedUploadError("frame", err, held);
  }
}

/** What a form's run came to: the upload, or a still image to ask for and why. */
export type RunOutcome = { t: "done"; upload: AnimatedUpload } | { t: "ask"; lowPower: boolean; problem: string | null };

/**
 * The video a form holds between runs, and when it lets go
 * (docs/design/design-v1-video-turns.md 8 step 5): kept for the next still
 * the DM picks or a Try again of the same file, and deleted, when this
 * upload made it, on cancel, on another file or when the form goes.
 * MapVideoRow.tsx's hook keeps one per form.
 */
export class VideoHold {
  #held: HeldVideo | null = null;
  #file: File | null = null;
  readonly #roomId: () => string;
  readonly #deps: Pick<UploadDeps, "remove">;

  constructor(roomId: () => string, deps: Pick<UploadDeps, "remove"> = liveDeps) {
    this.#roomId = roomId;
    this.#deps = deps;
  }

  get held(): HeldVideo | null {
    return this.#held;
  }

  /** The video a run for `file` goes on from: the held one for a still pick or a Try again of its own file. Any other run lets go of it first. */
  forRun(file: File, still: boolean): HeldVideo | null {
    if (still || file === this.#file) return this.#held;
    this.release();
    return null;
  }

  /** A run for `file` ended holding `held`: a hold the form shows, or the made map until the op takes it. */
  hold(file: File, held: HeldVideo | null): void {
    this.#held = held;
    this.#file = held ? file : null;
  }

  /** The map took the video: it is no longer this form's to delete. */
  taken(): void {
    this.#held = null;
    this.#file = null;
  }

  /** The form let it go: a video this upload made is deleted. */
  release(): void {
    const held = this.#held;
    this.taken();
    void discardVideo(this.#roomId(), held, this.#deps);
  }

  /**
   * Runs the steps for a picked video, for its still once picked, or again
   * for its stored copy's frame on Try again, going on from the video this
   * form holds where that is the one. "ask" when the form must ask for a
   * still first, with Try again after Low Power Mode, or a still that did
   * not fit. Throws what the steps throw, having let go of what they made.
   */
  async run(input: Omit<Parameters<typeof uploadAnimatedMap>[0], "held">): Promise<RunOutcome> {
    // A new video lets go of one an earlier pick left waiting for its still.
    const held = this.forRun(input.file, input.still !== undefined);
    try {
      const upload = await uploadAnimatedMap({ ...input, held });
      this.hold(input.file, { video: upload.asset.video, created: upload.created });
      return { t: "done", upload };
    } catch (err) {
      // A cancel wins over a hold that raced it, so a form that let go holds nothing.
      if (input.signal.aborted) {
        if (err instanceof AnimatedUploadError && err.held) await discardVideo(input.roomId, err.held, this.#deps);
        this.hold(input.file, null);
        throw input.signal.reason;
      }
      if (err instanceof FirstFrameError && err.failure.kind !== "refused") return { t: "ask", lowPower: err.failure.kind === "lowPower", problem: null };
      if (err instanceof AnimatedUploadError && err.held) {
        this.hold(input.file, err.held);
        const lowPower = err.step === "frame" && err.cause instanceof FirstFrameError && err.cause.failure.kind === "lowPower";
        return { t: "ask", lowPower, problem: err.step === "shape" ? err.message : null };
      }
      // The steps already let go of a video they made, so the form has nothing to hold.
      this.hold(input.file, null);
      throw err;
    }
  }
}

/** A picked image's size from its decode, or null when this browser cannot tell. */
async function imageSize(file: Blob): Promise<{ widthPx: number; heightPx: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { widthPx: bitmap.width, heightPx: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}
