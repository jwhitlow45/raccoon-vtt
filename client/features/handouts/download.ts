/**
 * Saving a handout to this device (features section 16): the image the
 * popup shows, as the server stores it (at most 2048 px on its long side,
 * downscale.ts), under the handout's title.
 *
 * It fetches the image rather than pointing a download link at it, so a
 * dropped connection or a handout the DM has just closed says so in the
 * popup, in words, instead of leaving a failed file in the browser's
 * downloads. The image is in the browser's cache already, since the popup
 * shows it, so the fetch is quick. The file then goes out through an
 * object URL and a download link, which iOS Safari 13 and later honors.
 */

/** Characters that Windows, macOS or Linux refuse in a file name, and control characters. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Names Windows keeps for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
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
  else if (RESERVED.test(base)) base = `${base} handout`;
  return `${base}.${extensionFor(type)}`;
}

function extensionFor(type: string): string {
  const mime = type.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[mime] ?? DEFAULT_EXTENSION;
}

/** How long the object URL outlives the click. Revoked at once, some browsers lose the download. */
const REVOKE_AFTER_MS = 60_000;

/** Fetches the handout's image and saves it under its title. Throws when the image cannot be fetched. */
export async function downloadHandout(url: string, title: string, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok) throw new Error(`The handout's image answered ${res.status}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = handoutFileName(title, blob.type);
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), REVOKE_AFTER_MS);
}
