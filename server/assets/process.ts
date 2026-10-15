import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";
import { AssetError } from "./errors.ts";
import { KINDS, type AssetKind, type Variant } from "./kinds.ts";

/**
 * The image pipeline: magic-byte sniffing, then sharp, one job at a time
 * (design section 11.1).
 *
 * libvips can decode dozens of formats, several of them (SVG, PDF, TIFF with
 * exotic codecs, raw camera files) with a long history of parser bugs. Every
 * loader is blocked at boot and only the five formats the app accepts are let
 * back in. The pipeline always reads from a file on disk, so only the `File`
 * flavour of each loader is unblocked. A buffer or stream input is refused
 * outright, which keeps a future caller from bypassing the temp-file path
 * (and its size and hash accounting) by accident.
 *
 * GIF is `Nsgif` (libnsgif, the small decoder libvips prefers). AVIF comes
 * through the HEIF loader. The prebuilt libvips in sharp has no HEVC decoder,
 * so HEIC still fails there, and the magic-byte check refuses it first anyway.
 */
const ALLOWED_LOADERS = [
  "VipsForeignLoadJpegFile",
  "VipsForeignLoadPngFile",
  "VipsForeignLoadWebpFile",
  "VipsForeignLoadNsgifFile",
  "VipsForeignLoadHeifFile",
];

let configured = false;

/** Process-wide sharp settings. Safe to call more than once. */
export function configureSharp(): void {
  if (configured) return;
  configured = true;
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: ALLOWED_LOADERS });
  // One libvips thread per image and no operation cache: the queue already
  // runs one job at a time, and libuv's small thread pool is shared with
  // argon2, so a large map must not take every thread.
  sharp.concurrency(1);
  sharp.cache(false);
}

/** `file-type` extensions the app accepts. APNG is a PNG that the PNG loader reads as its first frame. */
const ALLOWED_TYPES = new Set(["jpg", "png", "apng", "webp", "gif", "avif"]);

/**
 * Checks the first bytes of the file, never the Content-Type the sender
 * claimed. SVG has no magic bytes (it is XML text), so it can never match.
 */
export async function sniffImage(path: string): Promise<string> {
  const type = await fileTypeFromFile(path);
  if (!type || !ALLOWED_TYPES.has(type.ext)) {
    throw new AssetError(415, "unsupported_type");
  }
  return type.ext;
}

export type ProcessedVariant = {
  name: Variant;
  /** A temporary file, owned by the caller once this returns. */
  path: string;
  width: number;
  height: number;
  bytes: number;
};

const INPUT_OPTIONS = {
  // About a 10,000 x 10,000 image. Bigger is refused before decoding, so a
  // small "decompression bomb" file cannot allocate gigabytes.
  limitInputPixels: 100_000_000,
  // Truncated or damaged files are refused instead of half-decoded.
  failOn: "warning",
} as const;

/**
 * Makes every variant of one image as WebP in `tmpDir`. Re-encoding is what
 * neutralizes polyglots: the output holds only decoded pixels, and sharp
 * writes no metadata unless asked, so EXIF (GPS included), comments and any
 * bytes smuggled after the image are gone.
 *
 * `autoOrient()` runs before the resize, so a phone photo with an EXIF
 * rotation keeps its orientation even when the client skipped its own
 * downscale. Variants are made from the original rather than from each
 * other, because JPEG shrink-on-load makes that both sharper and cheap.
 */
export async function processImage(srcPath: string, kind: AssetKind, tmpDir: string): Promise<ProcessedVariant[]> {
  configureSharp();
  const out: ProcessedVariant[] = [];
  try {
    for (const { name, maxSide } of KINDS[kind].variants) {
      const path = join(tmpDir, `variant-${randomUUID()}-${name}.webp`);
      out.push({ name, path, width: 0, height: 0, bytes: 0 });
      const info = await sharp(srcPath, INPUT_OPTIONS)
        .autoOrient()
        .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path);
      const last = out[out.length - 1]!;
      last.width = info.width;
      last.height = info.height;
      last.bytes = info.size;
    }
    return out;
  } catch (err) {
    await removeFiles(out.map((v) => v.path));
    if (err instanceof AssetError) throw err;
    throw new AssetError(422, "bad_image", { cause: err });
  }
}

export async function removeFiles(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => unlink(p).catch(() => undefined)));
}

/**
 * One sharp job at a time, at most `maxJobs` waiting or running. Live
 * uploads go ahead of background work (room imports), so an import of a
 * hundred images delays a phone's token upload by one job at most.
 *
 * A full queue answers 503 with Retry-After. The client keeps retrying for a
 * minute, so a burst at the start of a session just waits its turn.
 */
export class ProcessingQueue {
  readonly maxJobs: number;
  #running = false;
  #waiting: Array<{ start: () => void; background: boolean }> = [];

  constructor(maxJobs = 8) {
    this.maxJobs = maxJobs;
  }

  get size(): number {
    return this.#waiting.length + (this.#running ? 1 : 0);
  }

  run<T>(job: () => Promise<T>, opts: { background?: boolean } = {}): Promise<T> {
    if (this.size >= this.maxJobs) {
      return Promise.reject(new AssetError(503, "busy", { retryAfter: 5 }));
    }
    const background = opts.background ?? false;
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.#running = true;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.#running = false;
            this.#next();
          });
      };
      const entry = { start, background };
      if (background) {
        this.#waiting.push(entry);
      } else {
        const firstBackground = this.#waiting.findIndex((w) => w.background);
        if (firstBackground === -1) this.#waiting.push(entry);
        else this.#waiting.splice(firstBackground, 0, entry);
      }
      if (!this.#running) this.#next();
    });
  }

  #next(): void {
    if (this.#running) return;
    const entry = this.#waiting.shift();
    entry?.start();
  }
}
