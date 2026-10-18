import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { STARTER_KINDS, indexWorks, type FoundWork, type StarterKind, type StarterPack, type StarterWork } from "#shared/starter.ts";
import { STARTER_PACKS } from "#shared/starterArt.ts";

/**
 * The starter packs as the server copies them into a room
 * (docs/design-v1-starter-art.md 5): the shipped catalog, and the folder
 * its files are read from. A pick names a work by its key alone. The file
 * it reads and the credit it stores both come from here, never from the
 * request.
 */
export type StarterCatalog = { works: ReadonlyMap<string, FoundWork>; root: string };

/** Tests pass a small catalog of their own over files they made. */
export type StarterOptions = { packs: readonly StarterPack[]; root: string };

/**
 * The folder the app's own files are served from: the build's dist/ when
 * there is one, as server/app.ts decides, so a pick copies the very file
 * the Starter tab showed. Else public/, in development and tests, where
 * Vite serves it.
 */
export function shippedRoot(): string {
  const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
  return existsSync(dist) ? dist : fileURLToPath(new URL("../../public/", import.meta.url));
}

export function starterCatalog(opts: Partial<StarterOptions> = {}): StarterCatalog {
  return { works: indexWorks(opts.packs ?? STARTER_PACKS), root: resolve(opts.root ?? shippedRoot()) };
}

/**
 * A shipped work that cannot be copied as the catalog describes it: a path
 * of another shape, a file that is missing or changed, a credit the asset
 * schema refuses. The build is wrong, not the caller, so a pick answers
 * 500 and a room import takes the image from its zip instead.
 */
export class StarterWorkError extends Error {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts);
    this.name = "StarterWorkError";
  }
}

/** A copied work's served path. Both slugs as in STARTER_KEY, so the path can never climb out of its folder. */
const STARTER_FILE = /^\/starter\/[a-z0-9-]{1,40}\/[a-z0-9-]{1,40}\.(?:png|webp|jpg)$/;

/** The file on disk behind a work's served path, checked by shape and then by where it resolves. */
export function starterFilePath(root: string, file: string): string {
  if (!STARTER_FILE.test(file)) throw new StarterWorkError(`starter file ${JSON.stringify(file)} is not a starter path`);
  const path = resolve(root, file.slice(1));
  if (!path.startsWith(root + sep)) throw new StarterWorkError(`starter file ${JSON.stringify(file)} resolves outside its folder`);
  return path;
}

/**
 * Copies a shipped file to `to`, which must not exist, and answers the
 * SHA-256 of the bytes as they were copied. Hashing the copy rather than
 * the source leaves no moment for the file to change between the check
 * and the read.
 */
export async function copyHashing(from: string, to: string): Promise<Buffer> {
  const hash = createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(from), tap, createWriteStream(to, { flags: "wx", mode: 0o600 }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") throw new StarterWorkError(`starter file ${from} cannot be read`, { cause: err });
    throw err;
  }
  return hash.digest();
}

/** The catalog's work for a key, when it may be copied in as `kind`: a work whose uses hold it. */
export function workForKind(catalog: StarterCatalog, key: string, kind: string): FoundWork | undefined {
  const found = catalog.works.get(key);
  return found && (found.work.uses as readonly string[]).includes(kind) ? found : undefined;
}

export function isStarterKind(kind: string): kind is StarterKind {
  return (STARTER_KINDS as readonly string[]).includes(kind);
}

/**
 * A map pick's cell size on the image as the room stored it: the catalog's
 * measure on the shipped file, scaled when the pipeline made it smaller,
 * rounded as cellPxHint rounds a file name's.
 */
export function starterCellPx(work: Pick<StarterWork, "grid" | "width">, storedWidth: number): number | undefined {
  const cellPx = work.grid?.cellPx;
  if (cellPx === undefined || work.width <= 0) return undefined;
  return Math.round(((cellPx * storedWidth) / work.width) * 100) / 100;
}
