import { VIDEO_LIMITS } from "#shared/limits.ts";
import type { VideoContainer } from "#shared/model.ts";
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
 * Why no frame came: `unreadable`, the device cannot open the file (a WebM
 * before iOS 17.4, a file it cannot decode, the 20 s timeout), `lowPower`,
 * iOS Low Power Mode refused `play()`, or `refused`, a file the server
 * would refuse, said in its words at once (4.5).
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
  getContext(kind: "2d"): { drawImage(image: never, x: number, y: number, w: number, h: number): void } | null;
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

/** The container a picked file claims, by its type or else its name, or null for anything else. */
export function videoContainer(file: Pick<File, "type" | "name">): VideoContainer | null {
  const type = file.type.toLowerCase();
  if (type === "video/webm") return "webm";
  if (type === "video/mp4") return "mp4";
  // A file from cloud storage may come with no type at all.
  if (type === "" || type === "application/octet-stream") {
    if (/\.webm$/i.test(file.name)) return "webm";
    if (/\.(mp4|m4v)$/i.test(file.name)) return "mp4";
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
 * What the server would refuse of the size and length the browser read
 * (6.3). A length the file does not give, as a screen recording's WebM,
 * reads as Infinity or NaN, which the server calls unfinished.
 */
export function metadataRefusal(meta: { widthPx: number; heightPx: number; duration: number }): FirstFrameError | null {
  const { widthPx: w, heightPx: h } = meta;
  if (w > 0 && h > 0) {
    const sides = [w, h];
    if (sides.some((s) => s < VIDEO_LIMITS.minSidePx || s > VIDEO_LIMITS.maxSidePx) || w * h > VIDEO_LIMITS.maxPixels) return refusal("video_size");
  }
  if (!Number.isFinite(meta.duration)) return refusal("video_unfinished");
  const ms = meta.duration * 1000;
  if (ms < VIDEO_LIMITS.minDurationMs || ms > VIDEO_LIMITS.maxDurationMs) return refusal("video_length");
  return null;
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

/**
 * Reads the first frame of `file` with a probe in `host`. Rejects with a
 * FirstFrameError, or with the signal's reason once it aborts.
 */
export async function readFirstFrame(file: File, options: { host: HTMLElement | null; signal?: AbortSignal; deps?: FrameDeps; timeoutMs?: number }): Promise<FirstFrame> {
  const early = fileRefusal(file);
  if (early) throw early;
  const { signal } = options;
  if (signal?.aborted) throw signal.reason;
  if (!options.deps && !options.host) throw new FirstFrameError({ kind: "unreadable" });
  const deps = options.deps ?? browserDeps(options.host!);
  const video = deps.makeVideo();
  // Muted as a property and an attribute before the source, or a browser may count it as a video with sound.
  video.muted = true;
  video.setAttribute("muted", "");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.setAttribute("tabindex", "-1");
  // Through the style object, which the page's CSP allows, never a style attribute, which it refuses.
  Object.assign(video.style, { position: "absolute", left: "0", top: "0", width: "1px", height: "1px", pointerEvents: "none" });
  video.preload = "auto";
  deps.attach(video);
  const url = deps.url(file);

  const cleanups: (() => void)[] = [];
  const on = (type: string, listener: () => void) => {
    video.addEventListener(type, listener);
    cleanups.push(() => video.removeEventListener(type, listener));
  };
  let timer: unknown = null;
  try {
    return await new Promise<FirstFrame>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = (frame: FirstFrame) => {
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
      on("loadedmetadata", () => {
        metadata = true;
        const refused = metadataRefusal({ widthPx: video.videoWidth, heightPx: video.videoHeight, duration: video.duration });
        if (refused) fail(refused);
      });

      let drawn = false;
      const draw = () => {
        if (settled || drawn) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!(width > 0 && height > 0)) return;
        drawn = true;
        if (!metadata) {
          const refused = metadataRefusal({ widthPx: width, heightPx: height, duration: video.duration });
          if (refused) return fail(refused);
        }
        const canvas = deps.makeCanvas();
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail(new FirstFrameError({ kind: "unreadable" }));
        try {
          ctx.drawImage(video as never, 0, 0, width, height);
        } catch {
          return fail(new FirstFrameError({ kind: "unreadable" }));
        }
        void (async () => {
          const webp = await encode(canvas, "image/webp");
          // Safari hands back a PNG when asked for WebP, so the type that came back decides (as encodeThumb does).
          const blob = webp?.type === "image/webp" ? webp : await encode(canvas, "image/jpeg");
          canvas.width = 0;
          canvas.height = 0;
          if (!blob) return fail(new FirstFrameError({ kind: "unreadable" }));
          const seconds = video.duration;
          succeed({ blob, widthPx: width, heightPx: height, durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null });
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
    deps.revoke(url);
  }
}

/** A name for the still's own file: the video's name with an image's extension, so its type and its name agree. */
export function stillFileName(videoName: string, type: string): string {
  const base = videoName.replace(/\.[a-z0-9]{2,5}$/i, "") || "map";
  return `${base}.${type === "image/webp" ? "webp" : "jpg"}`;
}
