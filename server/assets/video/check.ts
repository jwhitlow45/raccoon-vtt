import { stat } from "node:fs/promises";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import { VIDEO_LIMITS } from "#shared/limits.ts";
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

/** The caps of 6.3, then the facts, with `kbps` from the file's size and length. */
export function capped(parsed: ParsedVideo, fileBytes: number): VideoFacts {
  const { edits: _edits, ...facts } = parsed;
  const L = VIDEO_LIMITS;
  const { widthPx: w, heightPx: h } = facts;
  if (Math.min(w, h) < L.minSidePx || Math.max(w, h) > L.maxSidePx || w * h > L.maxPixels) throw refuse("video_size");
  if (facts.durationMs < L.minDurationMs || facts.durationMs > L.maxDurationMs) throw refuse("video_length");
  if (facts.fps > L.maxFramesInASecond) throw refuse("video_fps");
  // Bits per millisecond is kilobits per second. At least 1, so a tiny file still reads as a rate.
  return { ...facts, kbps: Math.max(1, Math.round((fileBytes * 8) / facts.durationMs)) };
}

async function parse(src: Source, container: VideoContainer, budget: Budget): Promise<ParsedVideo> {
  return container === "webm" ? parseWebm(src, budget) : parseMp4(src, budget);
}

/**
 * Anything a malformed file makes the parser throw becomes `bad_video`, so
 * the route answers a 4.5 code and never a 500. An edit into the media
 * data is the check's own bug, and stays loud.
 */
function asRefusal(err: unknown): unknown {
  if (err instanceof AssetError || err instanceof EditIntoMediaError) return err;
  return new AssetError(422, "bad_video", { cause: err });
}

/**
 * Checks the video at `path` and zeroes, in place, everything its
 * allowlist does not keep. The file keeps its length and every offset. It
 * runs in the processing queue, as an image's encode does.
 */
export async function checkVideo(path: string, opts: { budget?: Budget } = {}): Promise<VideoFacts> {
  const budget = opts.budget ?? new Budget();
  try {
    const { size } = await stat(path);
    if (size > VIDEO_LIMITS.fileBytes) throw new AssetError(413, "too_large");
    const container = containerOf((await fileTypeFromFile(path))?.ext);
    const window = await FileWindow.open(path, budget);
    let parsed: ParsedVideo;
    try {
      parsed = await parse(window, container, budget);
    } finally {
      await window.close();
    }
    const facts = capped(parsed, size);
    await parsed.edits.applyToFile(path);
    return facts;
  } catch (err) {
    throw asRefusal(err);
  }
}

/** The same check on bytes in memory, answering the facts and the zeroed bytes, for tests. */
export async function checkVideoBytes(bytes: Buffer, opts: { budget?: Budget } = {}): Promise<{ facts: VideoFacts; zeroed: Buffer; edits: Edits }> {
  const budget = opts.budget ?? new Budget();
  try {
    if (bytes.length > VIDEO_LIMITS.fileBytes) throw new AssetError(413, "too_large");
    const container = containerOf((await fileTypeFromBuffer(bytes))?.ext);
    const parsed = await parse(new BufferSource(bytes), container, budget);
    const facts = capped(parsed, bytes.length);
    return { facts, zeroed: parsed.edits.applyTo(bytes), edits: parsed.edits };
  } catch (err) {
    throw asRefusal(err);
  }
}
