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
 * The soonest a player's starter pick answers, in ms. A pick of a work the
 * room already holds copies and encodes nothing, so it answered in a few
 * ms where a fresh copy took 13 to 105 (each shipped token and portrait
 * work, measured on a laptop), and a player who timed picks of the token
 * packs could learn which art the DM had picked, such as the image on a
 * hidden token. Both paths wait out this floor, nearly four times the
 * slowest fresh copy measured, so a slower server still hides it. The
 * picker shows Use busy and "Adding to the room…" from the tap, so the
 * wait never looks hung. The DM's picks keep the fast path, since the
 * DM's library lists every image the room holds.
 */
export const PLAYER_PICK_FLOOR_MS = 400;

/** The clock a floor waits on. Tests pass a fake one. */
export type FloorClock = { now(): number; wait(ms: number): Promise<void> };

export const REAL_FLOOR_CLOCK: FloorClock = { now: () => performance.now(), wait: (ms) => new Promise((done) => setTimeout(done, ms)) };

/** Resolves once `floorMs` have passed since `started` on `clock`, at once when they already have. */
export async function noSoonerThan(started: number, floorMs: number, clock: FloorClock): Promise<void> {
  const left = started + floorMs - clock.now();
  if (left > 0) await clock.wait(left);
}

/**
 * The folder the Starter tab's files come from, so a pick copies the very
 * file the tab showed. In production that is the build's dist/, which
 * server/app.ts serves. Anywhere else it is public/: in development Vite
 * serves public/, and a dist/ left from an older build would hold other
 * files, or none, so every pick would fail while the tab showed the works.
 * A built server outside production, as the e2e suite runs, serves dist/,
 * whose starter files the build copied from public/ unchanged.
 */
export function shippedRoot(production: boolean, exists: (path: string) => boolean = existsSync): string {
  const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
  return production && exists(dist) ? dist : fileURLToPath(new URL("../../public/", import.meta.url));
}

export function starterCatalog(opts: Partial<StarterOptions> = {}, production = false): StarterCatalog {
  return { works: indexWorks(opts.packs ?? STARTER_PACKS), root: resolve(opts.root ?? shippedRoot(production)) };
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
 * A map pick's drawn grid on the image as the room stored it: the
 * catalog's measure on the shipped file, scaled when the pipeline made it
 * smaller, rounded as cellPxHint rounds a file name's. The pick's answer
 * carries it, so the scene starts on the grid of the file this server
 * copied, never on a client's catalog, which a tab may hold from before a
 * rebuild. The origin is absent where the build found only the square's
 * size.
 */
export function starterGrid(work: Pick<StarterWork, "grid" | "width">, storedWidth: number): { cellPx: number; originPx?: { x: number; y: number } } | undefined {
  const grid = work.grid;
  if (grid === undefined || work.width <= 0) return undefined;
  const scale = (px: number) => Math.round(((px * storedWidth) / work.width) * 100) / 100;
  return { cellPx: scale(grid.cellPx), ...(grid.originPx ? { originPx: { x: scale(grid.originPx.x), y: scale(grid.originPx.y) } } : null) };
}
