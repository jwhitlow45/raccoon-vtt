/**
 * Finding the image in a paste (docs/design-v1-paste.md 1.2 and 2.3). A
 * paste reaches the app two ways: a `paste` event's DataTransfer, read
 * while the event runs, and `navigator.clipboard.read()`'s items, read
 * after the Paste button's press. Both come here, so every entry that
 * takes a pasted image takes the same file, or refuses with the same
 * words. Pure, so it is tested without a browser.
 *
 * Text and HTML on the clipboard are read only to tell what the paste was,
 * then dropped (7). HTML is judged by a pattern on its markup alone, never
 * put into a document, so no `<img src>` in it loads.
 */

/** What an entry takes: an image, an image or an https link (Choose an image), or an image or a PDF (Show a handout). */
export type PasteAccepts = "image" | "image-or-link" | "image-or-pdf";

/** The parts of a paste event's DataTransfer read here. */
export type PasteData = {
  readonly files: ArrayLike<File>;
  readonly items: ArrayLike<{ readonly kind: string; readonly type: string; getAsFile(): File | null }>;
  readonly types: readonly string[];
  getData(type: string): string;
};

/** One of `clipboard.read()`'s items. */
export type ClipItem = { readonly types: readonly string[]; getType(type: string): Promise<Blob> };

/** Why a paste gave nothing to upload, each with its own words (pasteError). */
export type PasteRefusal = "empty" | "notImage" | "svg" | "link" | "insecureLink" | "page";

/**
 * What a paste holds for the entry: a file (an image, or a PDF where one is
 * taken) with the name it came with, if any, and how many images the
 * clipboard held, a link to import, or why there is nothing.
 */
export type Pasted =
  | { kind: "file"; blob: Blob; name: string | null; images: number }
  | { kind: "link"; url: string }
  | { kind: "none"; why: PasteRefusal };

const SVG = /^image\/svg/i;
/** A file a browser handed over with no type, named like an image, as some do for one picked from cloud storage. */
const IMAGE_NAME = /\.(jpe?g|png|webp|gif|avif|heic|heif|tiff?|bmp)$/i;
const LINK = /^https?:\/\/\S+$/i;
/** Copying part of a page puts its markup on the clipboard, an `<img>` with no bytes when the picture itself was not copied. */
const PAGE_IMAGE = /<img\b/i;

function isImageFile(file: File): boolean {
  if (SVG.test(file.type) || /\.svgz?$/i.test(file.name)) return false;
  return file.type.startsWith("image/") || (file.type === "" && IMAGE_NAME.test(file.name));
}

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** What text alone says: a link the entry imports, a link it refuses, part of a page, or nothing it can use. */
function fromText(text: string, html: string, accepts: PasteAccepts): Pasted {
  const trimmed = text.trim();
  if (LINK.test(trimmed)) {
    const secure = /^https:/i.test(trimmed);
    if (accepts === "image-or-link") return secure ? { kind: "link", url: trimmed } : { kind: "none", why: "insecureLink" };
    return { kind: "none", why: "link" };
  }
  if (PAGE_IMAGE.test(html)) return { kind: "none", why: "page" };
  return { kind: "none", why: "empty" };
}

/** The files a paste event carries: its `files`, else each file item's own, as some browsers fill only one of the two. */
function eventFiles(data: PasteData): File[] {
  const files = Array.from(data.files);
  if (files.length > 0) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function fromEvent(data: PasteData, accepts: PasteAccepts): Pasted {
  const files = eventFiles(data);
  const images = files.filter(isImageFile);
  const first = images[0];
  if (first) return { kind: "file", blob: first, name: first.name || null, images: images.length };
  const pdf = accepts === "image-or-pdf" ? files.find(isPdfFile) : undefined;
  if (pdf) return { kind: "file", blob: pdf, name: pdf.name || null, images: 0 };
  if (files.length > 0) return { kind: "none", why: files.every((f) => SVG.test(f.type) || /\.svgz?$/i.test(f.name)) ? "svg" : "notImage" };
  return fromText(data.getData("text/plain"), data.getData("text/html"), accepts);
}

/** The image type to read from an item: PNG, the type every browser's `read()` offers a picture as, else any image but SVG. */
function imageType(item: ClipItem): string | undefined {
  if (item.types.includes("image/png")) return "image/png";
  return item.types.find((t) => t.startsWith("image/") && !SVG.test(t));
}

async function textOf(items: readonly ClipItem[], type: string): Promise<string> {
  const item = items.find((i) => i.types.includes(type));
  return item ? (await item.getType(type)).text() : "";
}

async function fromItems(items: readonly ClipItem[], accepts: PasteAccepts): Promise<Pasted> {
  const withImage = items.filter((i) => imageType(i) !== undefined);
  const first = withImage[0];
  if (first) return { kind: "file", blob: await first.getType(imageType(first)!), name: null, images: withImage.length };
  if (items.some((i) => i.types.some((t) => SVG.test(t)))) return { kind: "none", why: "svg" };
  return fromText(await textOf(items, "text/plain"), await textOf(items, "text/html"), accepts);
}

/**
 * The image in a paste: from a paste event's DataTransfer, at once, since
 * it can be read only while the event runs, or from `clipboard.read()`'s
 * items, which are read one type at a time. The first image is the one
 * used, and `images` says how many there were. SVG is never read.
 */
export function clipboardImage(source: PasteData, accepts: PasteAccepts): Pasted;
export function clipboardImage(source: readonly ClipItem[], accepts: PasteAccepts): Promise<Pasted>;
export function clipboardImage(source: PasteData | readonly ClipItem[], accepts: PasteAccepts): Pasted | Promise<Pasted> {
  return isItemList(source) ? fromItems(source, accepts) : fromEvent(source, accepts);
}

function isItemList(source: PasteData | readonly ClipItem[]): source is readonly ClipItem[] {
  return Array.isArray(source);
}

/** Whether a paste event holds an image file the room-level offer could use (design 4: only an image fires it). */
export function holdsImage(data: PasteData): boolean {
  return eventFiles(data).some(isImageFile);
}

/**
 * Names a browser gives a pasted picture of its own accord, which say
 * nothing about it: "image.png", "blob", "Pasted Graphic 2.png". A name
 * the file came with otherwise stays, so `crypt_30x20.png` still sets a
 * map's scale.
 */
const STAND_IN = /^(image|blob|pasted graphic|untitled|clipboard)(?:[ _-]?\d+)?(?:\.[a-z0-9]{2,5})?$/i;

export function isStandInName(name: string): boolean {
  return STAND_IN.test(name.trim());
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

function extensionOf(type: string, name: string | null): string {
  const known = EXTENSIONS[type.toLowerCase()];
  if (known) return known;
  const fromName = name ? /\.([a-z0-9]{2,5})$/i.exec(name)?.[1] : undefined;
  if (fromName) return fromName.toLowerCase();
  const sub = /^image\/([a-z0-9]+)$/i.exec(type)?.[1];
  return sub ? sub.toLowerCase() : "png";
}

/** The time as this device writes it, "2:32 PM" or "14:32", with plain spaces so it reads the same in a file name. */
export function clockTime(now: Date): string {
  return now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
}

/**
 * The pasted file as an entry takes it: with its own name when it came
 * with a real one, else "Pasted image 2:32 PM.png", the extension from its
 * type. A scene, a phase and a handout take their names from it as from a
 * chosen file.
 */
export function pastedFile(blob: Blob, name: string | null, now: Date, time: (now: Date) => string = clockTime): File {
  const own = name?.trim() ?? "";
  if (own !== "" && !isStandInName(own)) return blob instanceof File && blob.name === own ? blob : new File([blob], own, { type: blob.type });
  return new File([blob], `Pasted image ${time(now)}.${extensionOf(blob.type, name)}`, { type: blob.type });
}

export const NO_IMAGE = "The clipboard has no image in it. Copy an image first, such as with Copy image on a web page.";
export const REFUSED = "The browser did not let the app read the clipboard.";

/** The words for a paste with nothing to upload, shown under its entry. */
export function pasteError(why: PasteRefusal | "refused"): string {
  switch (why) {
    case "empty":
      return NO_IMAGE;
    case "notImage":
      return "That file is not an image.";
    case "svg":
      return "SVG images are not supported. Use a JPEG, PNG, WebP, GIF or AVIF image.";
    case "link":
      return "That is a link, not an image. Copy the image itself, or save it and choose the file.";
    case "insecureLink":
      return "Only https:// links can be imported.";
    case "page":
      return "That copied part of a page, not the image. Use Copy image on the image instead.";
    case "refused":
      return REFUSED;
  }
}

/** The note under an entry when the clipboard held more than one image. */
export function severalImages(count: number): string | null {
  return count > 1 ? `The clipboard held ${count} images. The first one was used.` : null;
}

/**
 * The paste box's line (3.3): a phone's press and hold, or a keyboard's
 * paste and a right-click on a computer.
 */
export function boxLine(input: { touch: boolean; apple: boolean }): string {
  return input.touch ? "Press and hold here, then tap Paste." : `Press ${input.apple ? "Cmd+V" : "Ctrl+V"}, or right-click here and choose Paste.`;
}

/** What the words above the box add: where to paste instead. */
export function boxHint(input: { touch: boolean; apple: boolean }): string {
  return input.touch ? "Press and hold in the box, then tap Paste." : `Paste in the box with ${input.apple ? "Cmd+V" : "Ctrl+V"} or a right-click.`;
}

/** On iOS a `read()` that finds no picture opens the box too, since a photo held only as JPEG reaches the page there (3.2). */
export const IOS_NO_IMAGE = "If you copied a picture, press and hold in the box, then tap Paste.";
