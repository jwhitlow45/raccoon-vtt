import { VIDEO_LIMITS, videoSizeFits } from "#shared/limits.ts";
import type { MapVideo, VideoContainer } from "#shared/model.ts";
import { drawnSize } from "#shared/videoGeometry.ts";
import { placementTransform } from "./turn.ts";
import { VIDEO_REFUSALS } from "./words.ts";

/**
 * Step 1 of an animated map's upload (docs/design/design-v1-animated-maps.md
 * 4.1): the video's first frame, made on this device as the map's still.
 *
 * A probe `<video>` in the upload form itself opens the picked file from a
 * `blob:` URL, so it works before any scene exists and no board is mounted.
 * It is 1 × 1 px, hidden from screen readers, muted and inline. It calls
 * `play()` and then `pause()`, because iOS loads no media data until
 * `play()`, seeks to 0, and takes the frame at the first of a frame
 * callback, `seeked` and `loadeddata`. Whatever happens, it clears its `src`
 * and revokes the URL before the upload starts, so it never holds a decoder
 * beside the board's (5.2).
 *
 * The probe on the picked file only tries (docs/design/design-v1-video-turns.md
 * 8, D-261102-898). A size past the caps or a file this device cannot read
 * gives no frame, and the upload goes on: the server may make the file one
 * that plays, as a WebM declaring 5120 x 2880 for 2560 x 1440 or a MOV in
 * Firefox. The still then comes from the stored copy (`readStoredFrame`),
 * drawn turned and stretched as the board draws it.
 */

/** How long the probe may take before the form offers to pick a still instead. */
export const FIRST_FRAME_TIMEOUT_MS = 20_000;

/** WebP where the browser makes it, else JPEG, at this quality: the server encodes the still again anyway. */
export const STILL_QUALITY = 0.92;

export type FirstFrame = {
  /** The still, as WebP or JPEG. */
  blob: Blob;
  widthPx: number;
  heightPx: number;
  /** The length the browser read, when it read one. The server's own facts are what the map keeps. */
  durationMs: number | null;
};

/**
 * Why no frame came: `unreadable`, the device cannot open the stored copy
 * (a WebM before iOS 17.4, a file it cannot decode, the 20 s timeout),
 * `lowPower`, iOS Low Power Mode refused `play()`, or `refused`, a picked
 * file the server would refuse, said in its words at once (4.5). The probe
 * on the picked file never fails as unreadable: it gives no frame instead.
 */
export type FirstFrameFailure = { kind: "unreadable" } | { kind: "lowPower" } | { kind: "refused"; text: string };

export class FirstFrameError extends Error {
  readonly failure: FirstFrameFailure;
  constructor(failure: FirstFrameFailure) {
    super(failure.kind === "refused" ? failure.text : failure.kind === "lowPower" ? LOW_POWER_STOPPED : NO_FIRST_FRAME);
    this.name = "FirstFrameError";
    this.failure = failure;
  }
}

export const NO_FIRST_FRAME = "This device can't read that video's first frame. Pick a still image for it, such as the one that came with the map.";
export const LOW_POWER_STOPPED = "Low Power Mode stopped the video from opening. Tap Try again, or pick a still image.";

/** The parts of a `<video>` the probe uses, so a test can stand in for one. */
export type ProbeVideo = {
  muted: boolean;
  playsInline: boolean;
  preload: string;
  src: string;
  currentTime: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly duration: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  remove(): void;
  readonly style: Record<string, string>;
};

export type ProbeCanvas = {
  width: number;
  height: number;
  getContext(kind: "2d"): { drawImage(image: never, x: number, y: number, w: number, h: number): void; setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void } | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
};

export type FrameDeps = {
  makeVideo(): ProbeVideo;
  /** Puts the probe in the form. */
  attach(video: ProbeVideo): void;
  makeCanvas(): ProbeCanvas;
  url(file: Blob): string;
  revoke(url: string): void;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/**
 * The container a picked file claims, by its type or else its name, or null
 * for anything else. A MOV counts as an MP4: the server checks it as one and
 * stores it as one (docs/design/design-v1-video-turns.md 4.5).
 */
export function videoContainer(file: Pick<File, "type" | "name">): VideoContainer | null {
  const type = file.type.toLowerCase();
  if (type === "video/webm") return "webm";
  if (type === "video/mp4" || type === "video/quicktime") return "mp4";
  // A file from cloud storage may come with no type at all.
  if (type === "" || type === "application/octet-stream") {
    if (/\.webm$/i.test(file.name)) return "webm";
    if (/\.(mp4|m4v|mov)$/i.test(file.name)) return "mp4";
  }
  return null;
}

/** Whether a picked file is a video, which the upload treats as an animated map rather than an image. */
export function isVideoFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.toLowerCase().startsWith("video/") || videoContainer(file) !== null;
}

function refusal(code: keyof typeof VIDEO_REFUSALS): FirstFrameError {
  return new FirstFrameError({ kind: "refused", text: VIDEO_REFUSALS[code]! });
}

/** What the server would refuse of the file as picked, before the probe opens it: its type and its size. */
export function fileRefusal(file: Pick<File, "type" | "name" | "size">): FirstFrameError | null {
  if (videoContainer(file) === null) return refusal("video_type");
  if (file.size > VIDEO_LIMITS.fileBytes) return refusal("too_large");
  return null;
}

/**
 * What the server would refuse of the length the browser read (6.3), said
 * at once. A length the file does not give, as a screen recording's WebM,
 * reads as Infinity or NaN, which the server calls unfinished. The size is
 * not judged here: a browser may read a size the server's rewrite changes.
 */
export function lengthRefusal(duration: number): FirstFrameError | null {
  if (!Number.isFinite(duration)) return refusal("video_unfinished");
  const ms = duration * 1000;
  if (ms < VIDEO_LIMITS.minDurationMs || ms > VIDEO_LIMITS.maxDurationMs) return refusal("video_length");
  return null;
}

/** Whether the probe makes a canvas of the size the browser read: none past the caps (docs/design/design-v1-video-turns.md 8 step 1). */
export function probeSizeFits(widthPx: number, heightPx: number): boolean {
  return videoSizeFits({ widthPx, heightPx });
}

function browserDeps(host: HTMLElement): FrameDeps {
  return {
    makeVideo: () => document.createElement("video") as unknown as ProbeVideo,
    attach: (video) => void host.appendChild(video as unknown as HTMLVideoElement),
    makeCanvas: () => document.createElement("canvas") as unknown as ProbeCanvas,
    url: (file) => URL.createObjectURL(file),
    revoke: (url) => URL.revokeObjectURL(url),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

function encode(canvas: ProbeCanvas, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, STILL_QUALITY));
}

/** How one probe takes its frame: what it judges at `loadedmetadata`, and the canvas it draws into. */
type ProbeHow = {
  /** A refusal said at once, "skip" for no frame and no canvas, or null to go on. */
  judge(widthPx: number, heightPx: number, duration: number): FirstFrameError | "skip" | null;
  /** The canvas's size and how the frame fills it, from the size the browser read. */
  canvas(widthPx: number, heightPx: number): { width: number; height: number; matrix: readonly [number, number, number, number, number, number] | null; box: { width: number; height: number } };
  /** The frame's length for the result, in ms, when known. */
  durationMs(seconds: number): number | null;
};

/**
 * Reads the first frame of the picked `file` with a probe in `host`: the
 * frame at the size the browser read, or null when there is none to make
 * here (a size past the caps, a file this device cannot read, the 20 s
 * timeout), which the upload takes as a still to read from the stored copy.
 * Rejects with a FirstFrameError for a refusal or Low Power Mode, or with
 * the signal's reason once it aborts.
 */
export async function readFirstFrame(file: File, options: { host: HTMLElement | null; signal?: AbortSignal; deps?: FrameDeps; timeoutMs?: number }): Promise<FirstFrame | null> {
  const early = fileRefusal(file);
  if (early) throw early;
  if (options.signal?.aborted) throw options.signal.reason;
  if (!options.deps && !options.host) return null;
  const deps = options.deps ?? browserDeps(options.host!);
  const url = deps.url(file);
  try {
    return await probe(deps, url, options, {
      judge: (w, h, seconds) => lengthRefusal(seconds) ?? (w > 0 && h > 0 && !probeSizeFits(w, h) ? "skip" : null),
      canvas: (width, height) => ({ width, height, matrix: null, box: { width, height } }),
      durationMs: (seconds) => (Number.isFinite(seconds) ? Math.round(seconds * 1000) : null),
    });
  } catch (err) {
    if (err instanceof FirstFrameError && err.failure.kind === "unreadable") return null;
    throw err;
  } finally {
    deps.revoke(url);
  }
}

/**
 * Reads the first frame of a video already in the room from `url`, its
 * stored copy, after the upload (docs/design/design-v1-video-turns.md 8
 * step 4). The stored file is plain in every engine, so the frame is drawn
 * turned and mirrored as the board draws it (turn.ts), into a canvas of the
 * drawn size, which it fills whatever size the browser read. Rejects with a
 * FirstFrameError, unreadable or Low Power Mode, or with the signal's
 * reason once it aborts.
 */
export async function readStoredFrame(url: string, video: MapVideo, options: { host: HTMLElement | null; signal?: AbortSignal; deps?: FrameDeps; timeoutMs?: number }): Promise<FirstFrame> {
  if (options.signal?.aborted) throw options.signal.reason;
  if (!options.deps && !options.host) throw new FirstFrameError({ kind: "unreadable" });
  const deps = options.deps ?? browserDeps(options.host!);
  const drawn = drawnSize(video);
  const frame = await probe(deps, url, options, {
    judge: () => null,
    canvas: () => {
      const place = placementTransform({ x: 0, y: 0, width: drawn.widthPx, height: drawn.heightPx }, video);
      return { width: drawn.widthPx, height: drawn.heightPx, matrix: place.matrix, box: place.box };
    },
    durationMs: () => video.durationMs,
  });
  // A probe with no judge always makes its frame.
  return frame!;
}

/** One probe on `url`: the steps of 4.1, and its clean-up whatever happens. Null when `judge` skipped the frame. */
async function probe(deps: FrameDeps, url: string, options: { signal?: AbortSignal; timeoutMs?: number }, how: ProbeHow): Promise<FirstFrame | null> {
  const { signal } = options;
  const video = deps.makeVideo();
  // Muted as a property and an attribute before the source, or a browser may count it as a video with sound.
  video.muted = true;
  video.setAttribute("muted", "");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.setAttribute("tabindex", "-1");
  // The e2e steps find the form's probes by this, apart from the board's and the viewer's elements.
  video.setAttribute("data-animmap-probe", "");
  // Through the style object, which the page's CSP allows, never a style attribute, which it refuses.
  Object.assign(video.style, { position: "absolute", left: "0", top: "0", width: "1px", height: "1px", pointerEvents: "none" });
  video.preload = "auto";
  deps.attach(video);

  const cleanups: (() => void)[] = [];
  const on = (type: string, listener: () => void) => {
    video.addEventListener(type, listener);
    cleanups.push(() => video.removeEventListener(type, listener));
  };
  let timer: unknown = null;
  try {
    return await new Promise<FirstFrame | null>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = (frame: FirstFrame | null) => {
        if (settled) return;
        settled = true;
        resolve(frame);
      };
      timer = deps.setTimeout(() => fail(new FirstFrameError({ kind: "unreadable" })), options.timeoutMs ?? FIRST_FRAME_TIMEOUT_MS);
      const onAbort = () => fail(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal?.removeEventListener("abort", onAbort));
      on("error", () => fail(new FirstFrameError({ kind: "unreadable" })));

      let metadata = false;
      /** True when the judge ended the probe. */
      const judged = (width: number, height: number): boolean => {
        const verdict = how.judge(width, height, video.duration);
        if (verdict === "skip") succeed(null);
        else if (verdict) fail(verdict);
        return verdict !== null;
      };
      on("loadedmetadata", () => {
        metadata = true;
        judged(video.videoWidth, video.videoHeight);
      });

      let drawn = false;
      const draw = () => {
        if (settled || drawn) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!(width > 0 && height > 0)) return;
        drawn = true;
        if (!metadata && judged(width, height)) return;
        const place = how.canvas(width, height);
        const canvas = deps.makeCanvas();
        canvas.width = place.width;
        canvas.height = place.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail(new FirstFrameError({ kind: "unreadable" }));
        try {
          if (place.matrix) ctx.setTransform(...place.matrix);
          ctx.drawImage(video as never, 0, 0, place.box.width, place.box.height);
        } catch {
          return fail(new FirstFrameError({ kind: "unreadable" }));
        }
        void (async () => {
          const webp = await encode(canvas, "image/webp");
          // Safari hands back a PNG when asked for WebP, so the type that came back decides (as encodeThumb does).
          const blob = webp?.type === "image/webp" ? webp : await encode(canvas, "image/jpeg");
          const size = { widthPx: canvas.width, heightPx: canvas.height };
          canvas.width = 0;
          canvas.height = 0;
          if (!blob) return fail(new FirstFrameError({ kind: "unreadable" }));
          succeed({ blob, ...size, durationMs: how.durationMs(video.duration) });
        })();
      };

      video.src = url;
      video
        .play()
        .then(
          () => {
            if (settled) return;
            video.pause();
            // The frame wait starts only once the seek is asked, so a `loadeddata` that came during play does not stand for frame 0.
            on("seeked", draw);
            on("loadeddata", draw);
            if (video.requestVideoFrameCallback) {
              const handle = video.requestVideoFrameCallback(draw);
              cleanups.push(() => video.cancelVideoFrameCallback?.(handle));
            }
            video.currentTime = 0;
          },
          (err: unknown) => {
            const name = err instanceof DOMException || (err instanceof Error && "name" in err) ? (err as Error).name : "";
            fail(new FirstFrameError({ kind: name === "NotAllowedError" ? "lowPower" : "unreadable" }));
          },
        );
    });
  } finally {
    if (timer !== null) deps.clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    try {
      video.pause();
    } catch {
      // A probe that never loaded has nothing to pause.
    }
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

/** A name for the still's own file: the video's name with an image's extension, so its type and its name agree. */
export function stillFileName(videoName: string, type: string): string {
  const base = videoName.replace(/\.[a-z0-9]{2,5}$/i, "") || "map";
  return `${base}.${type === "image/webp" ? "webp" : "jpg"}`;
}
