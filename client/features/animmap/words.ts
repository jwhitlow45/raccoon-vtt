import { VIDEO_LIMITS } from "#shared/limits.ts";
import type { MapVideo, VideoContainer } from "#shared/model.ts";
import { VIDEO_OFF, VIDEO_SHAPE } from "#shared/permissions.ts";
import { ApiError, type ApiErrorCodeOrNetwork } from "../../lib/api.ts";
import type { Playback, StillReason } from "./status.ts";

/**
 * Every word animated maps show (docs/design/design-v1-animated-maps.md 4.2,
 * 4.4 and 4.5), in one place so the board's lane, the DM's upload and the
 * Library say the same thing, and the tests pin them.
 */

export { VIDEO_OFF, VIDEO_SHAPE };

// ---------------------------------------------------------------- 4.2 the Map image row

/** A video's length as the Map image row and the Library tile show it, such as "0:42". A video runs 1 s to 10 min, so minutes never need hours. */
export function videoLength(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The Map image row's help for an animated map, in place of "A 1920 × 1080 px image.". */
export function videoRowHelp(video: Pick<MapVideo, "widthPx" | "heightPx" | "durationMs">): string {
  return `A ${video.widthPx} × ${video.heightPx} px video, ${videoLength(video.durationMs)}, looping. Its first frame is the still.`;
}

export const MOVING_HERE = "Moving on this device.";
export const STILL_HERE = "Still on this device:";

/** The codec part of "this device can't play WebM (VP9).", from the RFC 6381 string's first part. */
export function codecName(codec: string): string {
  const family = codec.split(".")[0]!.toLowerCase();
  if (family === "vp8") return "VP8";
  if (family === "vp9" || family === "vp09") return "VP9";
  if (family === "av01") return "AV1";
  if (family === "avc1" || family === "avc3") return "H.264";
  return codec;
}

const CONTAINER_NAME: Readonly<Record<VideoContainer, string>> = { webm: "WebM", mp4: "MP4" };

/** Why a device shows the still, after "Still on this device:". `codec` names the file's format, so it needs the video. */
export function stillReasonText(reason: StillReason, video?: Pick<MapVideo, "container" | "video">): string {
  switch (reason) {
    case "setting":
      return "Animated maps is set to Still.";
    case "lowPower":
      return "Low power is on.";
    case "reducedMotion":
      return "reduced motion is on.";
    case "stillView":
      return "Isometric and the Builder, Fog, Line up grid and Trap tools show the still.";
    case "codec":
      return video ? `this device can't play ${CONTAINER_NAME[video.container]} (${codecName(video.video)}).` : "this device can't play this video's format.";
    case "notSmooth":
      return "this device can't play this video smoothly or without draining its battery.";
    case "phoneSize":
      return `Phone size map detail plays videos up to ${VIDEO_LIMITS.phoneLongSidePx} × ${VIDEO_LIMITS.phoneShortSidePx} at 30 frames a second.`;
    case "notStarted":
      return "the browser didn't start it. Tap the map to try again.";
    case "slowing":
      return "the video was slowing this device, so it stays still until you reload.";
    case "slowingOrSaving":
      return "the video was slowing this device, or the browser is saving power, so it stays still until you reload.";
    case "loadFailed":
      return "the video didn't load.";
    case "serverOff":
      return "animated maps are off on this server.";
  }
}

/** The muted line under the Map image row's help: "Moving on this device." or "Still on this device: <why>". */
export function playbackLine(playback: Playback, video?: Pick<MapVideo, "container" | "video">): string {
  return playback.play ? MOVING_HERE : `${STILL_HERE} ${stillReasonText(playback.reason, video)}`;
}

export const USE_STILL_ONLY = "Use the still only";

/** Shown after a video phase's name in the phase list. */
export const PHASE_VIDEO_TAG = "Video";

// ---------------------------------------------------------------- 4.4 This device and the table display

export const ANIMATED_MAPS_CHOICES = ["moving", "still"] as const;
export type AnimatedMapsChoice = (typeof ANIMATED_MAPS_CHOICES)[number];

export const ANIMATED_MAPS_LABEL = "Animated maps";
export const ANIMATED_MAPS_WORDS: Readonly<Record<AnimatedMapsChoice, string>> = { moving: "Moving", still: "Still" };
export const ANIMATED_MAPS_HELP: Readonly<Record<AnimatedMapsChoice, string>> = {
  moving: `Animated maps move. Downloads each map's video, up to ${VIDEO_LIMITS.fileBytes / (1024 * 1024)} MB.`,
  still: "Shows the first frame. Downloads no video.",
};

/**
 * The help line under This device's Animated maps row when something other
 * than the choice keeps every animated map still. Reasons that depend on one
 * file (its format, its size) or on what the board shows have no line here,
 * since the row speaks for the device.
 */
export function deviceStillHelp(reason: StillReason): string | undefined {
  switch (reason) {
    case "lowPower":
      return "Low power keeps animated maps still.";
    case "reducedMotion":
      return "Reduced motion keeps animated maps still.";
    case "slowing":
      return "A video was slowing this device, so animated maps stay still until you reload.";
    case "slowingOrSaving":
      return "A video was slowing this device, or the browser is saving power, so animated maps stay still until you reload.";
    default:
      return undefined;
  }
}

/** Low power's help on This device, as weather left it, with animated maps added. */
export const LOW_POWER_HELP =
  "Draws the map at a lower resolution, skips small animations, keeps weather and animated maps still and shows rolls without dice, to save battery on long sessions. Text on the map looks softer.";

// ---------------------------------------------------------------- 4.5 a refused video

const MB = VIDEO_LIMITS.fileBytes / (1024 * 1024);

/** The upload's refusals, by the code the asset routes answer. */
export const VIDEO_REFUSALS: Readonly<Partial<Record<ApiErrorCodeOrNetwork, string>>> = {
  video_type: "That video isn't WebM or MP4. iPhone videos from Photos are MOV: save the map's MP4 to Files and pick it from there.",
  // The upload route answers 415 for a content type it does not take, before reading the body.
  unsupported_type: "That video isn't WebM or MP4. iPhone videos from Photos are MOV: save the map's MP4 to Files and pick it from there.",
  video_codec: "That video's format doesn't play in most browsers. Save it as MP4 (H.264) or WebM (VP9).",
  video_tracks: "That video holds more than one picture or sound track, or a track of another kind. Export it again with one video and at most one sound track.",
  video_sound: "That video's sound settings can't be checked. Export it again with AAC-LC or Opus sound.",
  video_vorbis: "That video's sound is Vorbis, which this app doesn't accept. Export it again with Opus sound, or with no sound.",
  video_alpha: "That video has see-through parts. Animated maps must be solid.",
  video_hdr: "That video is HDR, which looks washed out on the map. Export it in SDR.",
  video_size: `Videos can be ${VIDEO_LIMITS.minSidePx} to ${VIDEO_LIMITS.maxSidePx} pixels on a side and 8.3 megapixels in all (3840 × 2160).`,
  video_geometry: "That video's file turns or stretches its picture, as phone videos often do. Export it again without rotation.",
  video_length: "Videos can be 1 second to 10 minutes long.",
  video_fps: "Videos can be up to 60 frames a second.",
  video_unfinished: "That video doesn't say how long it is, as screen recordings often don't. Save it again with a video editor.",
  video_fragmented: "That MP4 is fragmented, as streaming exports are. Export it again as a regular MP4.",
  video_layout: "That video's timeline is edited, or its sound runs longer than its picture. Export it again as a plain loop.",
  video_off: VIDEO_OFF,
  too_large: `That video is too large. Videos can be up to ${MB} MB.`,
  // Today's words for a full room (features/images/errors.ts). They also
  // cover a live upload that would leave the room under its headroom.
  quota_exceeded: "This room is out of storage space. The DM can free some up.",
  bad_video: "That video could not be read.",
};

/**
 * The words for a failed video upload, or undefined when the error is not
 * a video refusal, so the caller falls back to the words it uses for images
 * (a cancel, a network failure, a read-only room).
 */
export function videoRefusalText(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || !err.code) return undefined;
  return VIDEO_REFUSALS[err.code];
}
