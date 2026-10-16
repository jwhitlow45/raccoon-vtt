import { writePdf, type PdfImagePage } from "./pdfWrite.ts";

/**
 * Saving a handout to this device (features section 16): the image the
 * popup shows, as the server stores it (at most 2048 px on its long side,
 * downscale.ts), under the handout's title. A handout of several pages
 * saves as a PDF built in the browser (docs/design-v1-pdf-handouts.md
 * section 6, pdfWrite.ts), with its own lifecycle below.
 *
 * It fetches the image rather than pointing a download link at it, so a
 * dropped connection or a handout the DM has just closed says so in the
 * popup, in words, instead of leaving a failed file in the browser's
 * downloads. The image is in the browser's cache already, since the popup
 * shows it, so the fetch is quick.
 *
 * A computer saves the file through a download link. A touch device that
 * can share files gets the share sheet instead (Save Image, Save to Files,
 * AirDrop), as the map export and the log export do: on an iPhone a
 * download lands in the Files app's Downloads folder at best, and a Home
 * Screen app may not download at all (mapexport/save.ts). The share sheet
 * opens only from a tap, with no wait between, so the popup fetches the
 * image as it opens and the tap shares it at once (downloadAction).
 */

/** Characters that Windows, macOS or Linux refuse in a file name, and control characters. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Names Windows keeps for devices, with or without an extension: "CON" and "CON.v2" alike. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Long enough for any title a DM types, short of every file system's limit once the extension is on. */
const MAX_BASE = 100;
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/avif": "avif",
};
/** The server stores and serves every image as WebP (server/assets/serve.ts), so a response with no usable type is one. */
const DEFAULT_EXTENSION = "webp";

/**
 * The file name a handout saves under: its title, made safe for every file
 * system (no reserved characters, no leading or trailing dots or spaces, no
 * device name, at most 100 characters), "handout" when nothing is left,
 * then the extension of the image's type.
 */
export function handoutFileName(title: string, type: string): string {
  const cleaned = title.replace(UNSAFE, " ").replace(/\s+/g, " ");
  const trim = (s: string) => s.replace(/^[\s.]+|[\s.]+$/g, "");
  // By code point, so a cut never splits an emoji in half.
  let base = trim([...trim(cleaned)].slice(0, MAX_BASE).join(""));
  if (base === "") base = "handout";
  // A device name takes its word right after it, since Windows reads only the part before the first dot.
  const device = RESERVED.exec(base);
  if (device) base = `${device[1]} handout${device[2] ?? ""}`;
  return `${base}.${extensionFor(type)}`;
}

function extensionFor(type: string): string {
  const mime = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[mime] ?? DEFAULT_EXTENSION;
}

/**
 * One handout's Download, held by the press that last began on it: what
 * that press is doing (fetching, sharing, waiting for a second tap to
 * share) or why it failed. Each press gets a new `op`.
 */
export type SaveEntry = { op: number; state: "busy" | "sharing" | "share" | "failed"; why?: "fetch" | "share" };

/**
 * Every handout's Download, by the handout's key. One handout's press never
 * touches another's: a download of a handout whose popup has closed goes
 * on, and saving the next handout meanwhile must not take its "Downloading…"
 * away, or a second tap would save it twice (P3R-9).
 */
export type SaveStates = Readonly<Record<string, SaveEntry>>;

/** A press begins on a handout, and its entry is now this press's. */
export function saveBegin(states: SaveStates, key: string, op: number, state: "busy" | "sharing"): SaveStates {
  return { ...states, [key]: { op, state } };
}

export type SaveOutcome = "done" | "share" | "fetch failed" | "share failed";

/**
 * A press ends. Only the press a handout's entry holds may change it, so an
 * older press that ends after a newer one began, a share that fails late
 * above all, never clears or overwrites the newer (P3-ASTRA-03,
 * P3-ASTRA-04). Every end goes through here, so no path can skip the check.
 */
export function saveSettled(states: SaveStates, key: string, op: number, outcome: SaveOutcome): SaveStates {
  const entry = states[key];
  if (entry?.op !== op) return states;
  if (outcome === "done") {
    const { [key]: _done, ...rest } = states;
    return rest;
  }
  if (outcome === "share") return { ...states, [key]: { op, state: "share" } };
  return { ...states, [key]: { op, state: "failed", why: outcome === "share failed" ? "share" : "fetch" } };
}

/** The popup closed on a handout: a failure there is forgotten, and a download under way goes on (P3R-6). */
export function saveForget(states: SaveStates, key: string): SaveStates {
  if (states[key]?.state !== "failed") return states;
  const { [key]: _failed, ...rest } = states;
  return rest;
}

/**
 * What a tap on Download does (P3R-7). With the image in hand, a device
 * that shares files (mapexport/save.ts prefersShare) opens the share sheet
 * within the tap, and anything else saves through a link. Without it yet
 * the tap fetches it first, and a share then waits for a second tap.
 */
export function downloadAction(ready: boolean, shares: boolean): "share" | "link" | "fetch" {
  if (!ready) return "fetch";
  return shares ? "share" : "link";
}

/** The image as the file a handout saves as, named after its title. */
export function handoutFile(blob: Blob, title: string): File {
  return new File([blob], handoutFileName(title, blob.type), { type: blob.type || `image/${DEFAULT_EXTENSION}` });
}

/** Fetches a handout's image. Throws when it cannot be fetched. */
export async function fetchHandoutImage(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { credentials: "same-origin", ...(signal ? { signal } : null) });
  if (!res.ok) throw new Error(`The handout's image answered ${res.status}`);
  return res.blob();
}

/** How long the object URL outlives the click. Revoked at once, some browsers lose the download. */
const REVOKE_AFTER_MS = 60_000;

/** Saves a file through an object URL and a download link, as a computer expects. */
export function saveThroughLink(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = file.name;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_AFTER_MS);
}

// ---------------------------------------------------------------- a handout of pages as a PDF (docs/design-v1-pdf-handouts.md 6)

/** A prepared PDF unused this long is dropped, and its Share with it, so a phone does not hold tens of MB of pages for a tap that never comes. */
export const PREPARED_MS = 3 * 60_000;

/**
 * The device's one PDF build, or the one prepared file, owned by the
 * showing in the popup (`key`) and the press that started it (`op`).
 * `building` counts the pages done. `ready` holds the built file for the
 * share sheet's tap, since a share opens only inside a tap and building
 * takes longer than one. `failed` says why, as the one-image Download does.
 */
export type PdfBuild =
  | { t: "building"; key: string; op: number; done: number; pages: number }
  | { t: "ready"; key: string; op: number; file: File; at: number }
  | { t: "failed"; key: string; op: number; why: "fetch" | "share" };

export type PdfBuildEvent =
  | { t: "start"; key: string; op: number; pages: number }
  | { t: "progress"; op: number; done: number }
  /** Built. `keep` holds it for a share's tap. A computer saved it through a link already, and drops it. */
  | { t: "built"; op: number; file: File; keep: boolean; at: number }
  | { t: "failed"; op: number; why: "fetch" | "share" }
  /** The lead line's Cancel. */
  | { t: "cancel" }
  /** The showing in the popup now, or null once it closed. */
  | { t: "showing"; key: string | null }
  /** The showings still open in the room, so a prepared file goes with its handout. */
  | { t: "open"; keys: ReadonlySet<string> }
  | { t: "time"; now: number }
  /** The prepared file was shared, which counts as a use. */
  | { t: "used"; at: number };

/**
 * One step of the PDF build's lifecycle (section 6). One build runs at a
 * time, and only its own press's progress and end count. Cancel stops it.
 * The popup closing or moving to another showing cancels a build and drops
 * a prepared file or a failure, as its handout closing does, and a prepared
 * file unused for PREPARED_MS goes too. Leaving the room unmounts the popup,
 * which holds it.
 */
export function pdfBuildStep(state: PdfBuild | null, e: PdfBuildEvent): PdfBuild | null {
  switch (e.t) {
    case "start":
      return { t: "building", key: e.key, op: e.op, done: 0, pages: e.pages };
    case "progress":
      return state?.t === "building" && state.op === e.op ? { ...state, done: e.done } : state;
    case "built":
      if (state?.t !== "building" || state.op !== e.op) return state;
      return e.keep ? { t: "ready", key: state.key, op: e.op, file: e.file, at: e.at } : null;
    case "failed":
      if (state === null || state.op !== e.op || state.t === "failed") return state;
      return { t: "failed", key: state.key, op: e.op, why: e.why };
    case "cancel":
      return state?.t === "building" ? null : state;
    case "showing":
      return state && state.key !== e.key ? null : state;
    case "open":
      return state && !e.keys.has(state.key) ? null : state;
    case "time":
      return state?.t === "ready" && e.now - state.at >= PREPARED_MS ? null : state;
    case "used":
      return state?.t === "ready" ? { ...state, at: e.at } : state;
  }
}

/** "Preparing the PDF: page 3 of 12", the page being prepared now. */
export function pdfProgressText(build: Extract<PdfBuild, { t: "building" }>): string {
  return `Preparing the PDF: page ${Math.min(build.done + 1, build.pages)} of ${build.pages}`;
}

/** A JPEG's quality for a page, as the design's 0.92: text stays crisp, and a page with art stays far smaller than a PNG. */
const JPEG_QUALITY = 0.92;

/**
 * Builds the PDF of a handout's pages in order: each page's `full` image,
 * from the browser's cache when seen, decoded, drawn on a canvas and
 * encoded as a JPEG, whose blob alone is kept. Throws when a page cannot
 * be fetched or decoded, or when `signal` aborts.
 */
export async function buildHandoutPdf(input: { urls: readonly string[]; title: string; signal: AbortSignal; onPage(done: number): void }): Promise<File> {
  const pages: PdfImagePage[] = [];
  const canvas = document.createElement("canvas");
  try {
    for (const [i, url] of input.urls.entries()) {
      const blob = await fetchHandoutImage(url, input.signal);
      const bitmap = await createImageBitmap(blob);
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("No canvas to draw the page on");
        ctx.drawImage(bitmap, 0, 0);
        const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
        if (!jpeg) throw new Error("The page could not be encoded");
        pages.push({ jpeg, width: bitmap.width, height: bitmap.height });
      } finally {
        bitmap.close();
        // Let go of the page's pixels before the next one draws.
        canvas.width = 0;
        canvas.height = 0;
      }
      input.signal.throwIfAborted();
      input.onPage(i + 1);
    }
  } finally {
    canvas.width = 0;
  }
  return new File([writePdf(pages, input.title)], handoutFileName(input.title, "application/pdf"), { type: "application/pdf" });
}
