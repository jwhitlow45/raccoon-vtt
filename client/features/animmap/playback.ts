import { phoneSizeAllows, VIDEO_LIMITS } from "#shared/limits.ts";
import type { MapVideo } from "#shared/model.ts";
import type { AnimatedMapsChoice } from "./words.ts";
import { MOVING, stillFor, type Playback } from "./status.ts";

/**
 * When a device plays a video map (docs/design/design-v1-animated-maps.md
 * 5.3), as one pure function of what the device knows. The board's
 * controller (board.ts) and the judge it provides for the Map image row and
 * the Library viewer both ask it, so the three never disagree.
 */

/** What the browser said of one video's format (capabilities.ts). */
export type Decodable = "smooth" | "codec" | "notSmooth";

export type PlaybackInput = {
  /** The server's ANIMATED_MAPS switch. */
  server: boolean;
  /** This device's Animated maps, or the table display's. */
  setting: AnimatedMapsChoice;
  lowPower: boolean;
  reducedMotion: boolean;
  /** The map size this device loads: Phone size holds videos to 5.3's rule 3. */
  variant: "full" | "mobile";
  /** Media Capabilities' answer for this file, asked with powerEfficient on Phone size. The board asks before it loads anything. */
  decodable: Decodable;
  /** The step-down (5.4) for this page: it lasts until the page reloads. */
  steppedDown: "slowing" | "slowingOrSaving" | null;
  /**
   * The size the board's element decodes: its frames' own size from their
   * frame callbacks, else the size it reported on `loadedmetadata` and
   * `resize` where that is not waiting for the first frame (board.ts).
   * Absent before either, or when the question is about a video the board
   * is not playing.
   */
  realSize?: { widthPx: number; heightPx: number };
  /** The element's media failed after its one retry. */
  loadFailed?: boolean;
  /** Isometric, or the Builder, Fog, Line up grid or Traps tool shows. */
  stillView?: boolean;
  /** The browser refused `play()`, until a tap on the board. */
  notStarted?: boolean;
};

/**
 * Whether a device plays `video` now, or shows the still and why. The
 * reasons come in order of what the person can do about them: the device's
 * own choices first, then what the browser or the file allows, then what
 * the board shows now.
 */
export function playback(video: Pick<MapVideo, "widthPx" | "heightPx" | "fps">, input: PlaybackInput): Playback {
  // Rule 1: the server's switch, the choice, Low power and reduced motion.
  if (!input.server) return stillFor("serverOff");
  if (input.setting === "still") return stillFor("setting");
  if (input.lowPower) return stillFor("lowPower");
  if (input.reducedMotion) return stillFor("reducedMotion");
  // Rule 2: the browser can play the file, smoothly, and on Phone size power-efficiently.
  if (input.decodable === "codec") return stillFor("codec");
  if (input.decodable === "notSmooth") return stillFor("notSmooth");
  // Rule 3: Phone size map detail and the file's size and peak rate.
  if (input.variant === "mobile" && !phoneSizeAllows(video)) return stillFor("phoneSize");
  // Rule 4: the step-down, the real size, the load and the browser's start.
  if (input.steppedDown) return stillFor(input.steppedDown);
  if (input.realSize) {
    const real = sizeProblem(input.realSize, video.fps, input.variant);
    if (real) return stillFor(real);
  }
  if (input.loadFailed) return stillFor("loadFailed");
  if (input.stillView) return stillFor("stillView");
  if (input.notStarted) return stillFor("notStarted");
  return MOVING;
}

/**
 * Whether a size the element reported before its first frame waits for that
 * frame's own size instead of being judged (docs/design/design-v1-video-turns.md
 * 6.3, D-261102-897): the coded size, or the stretched size within a pixel
 * of its width, as Gecko reports a stretched file before it rounds. A size
 * equal to the declared stretch is never taken on trust: a WebM that
 * declares 2560 x 720 for 1280 x 720 may really decode at 2560 x 720, so
 * the frame says which. The board holds such a size only while it expects
 * frame callbacks.
 */
export function reportWaitsForFrame(reported: { widthPx: number; heightPx: number }, video: Pick<MapVideo, "widthPx" | "heightPx" | "displayWidthPx">): boolean {
  if (reported.heightPx !== video.heightPx) return false;
  if (reported.widthPx === video.widthPx) return true;
  return video.displayWidthPx !== undefined && Math.abs(reported.widthPx - video.displayWidthPx) <= 1;
}

/**
 * Whether the element's real size breaks the rule (5.2 "The real size is
 * checked"). A stream can change size mid-file, as VP9 can, so the size the
 * decoder holds is checked against the same caps the facts passed: Phone
 * size's rule 3, and the server's caps on any device.
 */
export function sizeProblem(real: { widthPx: number; heightPx: number }, fps: number, variant: "full" | "mobile"): "phoneSize" | "notSmooth" | null {
  if (variant === "mobile" && !phoneSizeAllows({ ...real, fps })) return "phoneSize";
  const long = Math.max(real.widthPx, real.heightPx);
  if (long > VIDEO_LIMITS.maxSidePx || real.widthPx * real.heightPx > VIDEO_LIMITS.maxPixels) return "notSmooth";
  return null;
}
