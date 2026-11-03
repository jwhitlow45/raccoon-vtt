import { stillFitsVideo } from "#shared/limits.ts";
import type { MapVideo } from "#shared/model.ts";
import { api, ApiError, type AssetRow, type ProgressUploadOptions } from "../../lib/api.ts";
import type { MapAsset } from "../scenes/create.ts";
import { uploadErrorText } from "../scenes/upload.ts";
import { FirstFrameError, readFirstFrame, stillFileName, type FirstFrame } from "./firstFrame.ts";
import { videoRefusalText } from "./words.ts";

/**
 * An animated map's upload (docs/design/design-v1-animated-maps.md 4.1,
 * D-261102-458): the first frame read on this device, the video, then the
 * still, each with its percent, and the grid search after, which the form
 * runs on the still as it does on an image. A failure or a cancel after the
 * video went up deletes the video, if this upload made its row. A video the
 * room already held stays.
 *
 * When this device cannot read the first frame, the form asks for a still
 * image instead. The video then goes up first, and the picked still must be
 * the video's shape by the server's facts, since a file that failed early
 * gave the device no size. A still of another shape is refused and the
 * video held (`HeldVideo`) while the DM picks another, so 64 MB never goes
 * up twice.
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
export const VIDEO_PICK_HELP = "A WebM or MP4 video makes an animated map, up to 64 MB. MP4 (H.264) plays on the most devices.";

/** The pickers' types: images, and videos while the server's switch is on. */
export function mapAccept(videos: boolean): string {
  return videos ? "image/*,video/webm,video/mp4" : "image/*";
}

/** A video already in the room for this upload, waiting for its still. */
export type HeldVideo = { video: MapVideo; created: boolean };

/** What the upload made: the still as a map image carrying its video, and the still's file for the grid search. */
export type AnimatedUpload = { asset: MapAsset & { video: MapVideo }; stillFile: File; created: boolean };

/** The step that failed, so its words are the video's refusals or the image's. */
export class AnimatedUploadError extends Error {
  readonly step: "video" | "still" | "shape";
  readonly cause: unknown;
  /** A still of the wrong shape keeps the video, for the next still the DM picks. */
  readonly held: HeldVideo | null;
  constructor(step: "video" | "still" | "shape", cause: unknown, held: HeldVideo | null = null) {
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

export function shapeRefusalText(video: { widthPx: number; heightPx: number }): string {
  return `That image isn't the video's shape (${aspectText(video)}). Pick one the same shape.`;
}

/** The words for a failed step: a video's refusal in 4.5's words, an image's as today, or the probe's own. */
export function animatedUploadText(err: unknown): string {
  if (err instanceof FirstFrameError) return err.message;
  if (err instanceof AnimatedUploadError) {
    if (err.step === "shape") return err.message;
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
  readFrame(file: File, options: { host: HTMLElement | null; signal?: AbortSignal }): Promise<FirstFrame>;
  upload(roomId: string, kind: "video" | "map", file: Blob, options: ProgressUploadOptions): Promise<AssetRow>;
  remove(roomId: string, ids: string[]): Promise<unknown>;
};

const liveDeps: UploadDeps = {
  readFrame: (file, options) => readFirstFrame(file, options),
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
    // Not in use in the Library, for the DM's Clean up.
  }
}

/** A file's type for the upload's content type: a picked file may come with none. */
function typed(file: File, type: string): Blob {
  return file.type === type ? file : new Blob([file], { type });
}

/**
 * Runs the steps for one picked video. `still` is the DM's own image when
 * the first frame could not be read, and `held` the video a shape refusal
 * kept. Throws a FirstFrameError when the probe fails (nothing has gone up
 * then), an AnimatedUploadError for a later step, or the signal's reason.
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
  let frame: FirstFrame | null = null;
  if (!input.still) {
    input.onStep({ t: "frame" });
    frame = await deps.readFrame(file, { host: input.host, signal });
  }

  let held: HeldVideo | null = input.held ?? null;
  if (!held) {
    input.onStep({ t: "video", percent: 0 });
    const container = file.name.toLowerCase().endsWith(".webm") || file.type === "video/webm" ? "video/webm" : "video/mp4";
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
    if (frame) {
      stillFile = new File([frame.blob], stillFileName(file.name, frame.blob.type), { type: frame.blob.type });
    } else {
      const picked = input.still!;
      const size = await imageSize(picked);
      // No size read means the server judges it, as for any map image, and the reducer's shape rule still holds.
      if (size && !stillFitsVideo(size, held.video)) throw new AnimatedUploadError("shape", shapeRefusalText(held.video), held);
      stillFile = picked;
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
    // A shape refusal keeps the video for the next pick. Anything else lets go of one this upload made.
    if (!(err instanceof AnimatedUploadError && err.step === "shape")) await discardVideo(roomId, held, deps);
    throw err;
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
