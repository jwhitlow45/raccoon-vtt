/**
 * Saving a handout to this device (features section 16): the image the
 * popup shows, as the server stores it (at most 2048 px on its long side,
 * downscale.ts), under the handout's title.
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
