/**
 * Builds the starter packs (docs/design-v1-starter-art.md section 8): the
 * files in public/starter/ and the packs' stamps in public/stamps/, the
 * catalog in shared/starterArt.ts, the stamps' list in
 * shared/starterStamps.ts, and the "Starter packs" section of CREDITS.md.
 * Run by hand when the set changes:
 *
 *   node scripts/starter-art.ts [--cache <dir>] [--pin] [--only <pack,...>]
 *
 * Its input, scripts/starter-art.json, names every pack and work with its
 * license as its page states it, a Wayback snapshot of that page, and where
 * each file came from, pinned by SHA-256. A changed upstream file fails
 * loudly, so its license is checked again before it is pinned anew.
 * `--pin` fills in pins the input lacks (a new archive, a new Poly Haven
 * model's files) from what it fetched, and never replaces one it has.
 * `--only` rebuilds the files of the packs named, for a quick look, and
 * leaves the catalog and the credits alone.
 *
 * Downloads are untrusted data. They live in a cache directory of their
 * own, named by their hash, so a second run fetches nothing, and nothing in
 * it is ever run. Archives are read one named entry at a time, never
 * unpacked onto disk. itch.io gives a fresh download link per request,
 * which this script asks the pack's page for, as a browser does.
 *
 * Every change is mechanical and recorded per work: resizing, reducing a
 * line-art map to four gray levels, upscaling pixel art by nearest
 * neighbor, cropping a sprite to its art, rendering a 3D model from above,
 * and the format. The outputs are committed, as the stamps are. No AI art.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import sharp, { type Metadata } from "sharp";
import yauzl from "yauzl";
import { z } from "zod";
import { defaultStep, detectGrid, lineProfiles, lineReach } from "../client/features/grid/detect.ts";
import { LICENSES, type LicenseId } from "../shared/licenses.ts";
import type { StarterPack, StarterStamp, StarterUse, StarterWork } from "../shared/starter.ts";
import { STAMP_ART } from "../shared/stamps.ts";
import {
  KEY as STAMP_KEY,
  checkGltfNames,
  checkPin,
  checkThree,
  encode as encodeStamp,
  frame,
  launchRenderer,
  openRenderer,
  renderModelStamp,
  sha256Of,
  spriteSize,
  toRaw,
  type Renderer,
} from "./stamps.ts";

const ROOT = join(import.meta.dirname, "..");
const INPUT = join(ROOT, "scripts", "starter-art.json");
const OUT_DIR = join(ROOT, "public", "starter");
const STAMPS_DIR = join(ROOT, "public", "stamps");
const CATALOG = join(ROOT, "shared", "starterArt.ts");
const STAMP_LIST = join(ROOT, "shared", "starterStamps.ts");
const CREDITS_MD = join(ROOT, "CREDITS.md");

/**
 * The size rules of design section 10, which credits.test.ts holds the
 * shipped files to, so growing the set is a decision rather than a drift.
 * `folderBytes` is what public/starter may hold in all, and `stampBytes`
 * what the packs' stamps add to public/stamps.
 */
export const STARTER_CAPS = {
  lineMapPx: 4096,
  lineMapBytes: 1024 * 1024,
  colorMapPx: 4096,
  colorMapBytes: 2.5 * 1024 * 1024,
  tokenPx: 512,
  picturePx: 1600,
  pictureBytes: 300 * 1024,
  thumbPx: 256,
  thumbBytes: 30 * 1024,
  folderBytes: 34 * 1024 * 1024,
  stampBytes: 1024 * 1024,
} as const;

/** How every work of a pack is encoded (design 7 and 8). */
const ENCODINGS = ["line-map", "painted-map", "token", "picture", "pixel", "stamp-sprite", "stamp-whole", "stamp-render"] as const;
type Encoding = (typeof ENCODINGS)[number];

/** WebP quality for painted and photographed art. A picture over its cap steps down from here, 5 at a time. */
const QUALITY = 80;
const MIN_QUALITY = 60;
/** The smallest a capped picture is made to fit its bytes: a handout still reads at this size. */
const MIN_PICTURE_PX = 1024;
/**
 * libwebp's effort. 6 took about 40 times as long as 4 on a 1024 px
 * picture with alpha, for files 4% smaller.
 */
const WEBP_EFFORT = 4;
const THUMB_QUALITY = 75;
/** DCSS tiles are 32 px. Eight times, by nearest neighbor, keeps every pixel a crisp 8 px block at the token's size. */
const PIXEL_SCALE = 8;
/** The least score a fit at a map's measured square size needs before its lines give the grid's origin. */
const FIT_SCORE = 0.3;
/** How far a grid's period must stand above periods no grid has before its phase gives the origin. */
const PHASE_CONTRAST = 4;
/** The scene's grid on a paper map: the board's own dark ink color, so the squares show on white paper. */
const PAPER_GRID = "#1b1b20";

// ---------------------------------------------------------------------------
// Input

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const url = z.string().url().startsWith("https://");
const licenseId = z.enum(["CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0", "public-domain-dedication"]);
const slug = z.string().regex(/^[a-z0-9-]{1,40}$/);

const archiveSchema = z.strictObject({
  kind: z.enum(["zip", "tar.gz"]),
  url: url.optional(),
  itch: z.strictObject({ page: url, upload: z.string().min(1) }).optional(),
  sha256: sha.optional(),
});

const fromSchema = z.union([
  z.strictObject({ url, sha256: sha }),
  z.strictObject({ archive: z.string(), entry: z.string().min(1), sha256: sha, crc32: z.string().optional() }),
]);

const workSchema = z.strictObject({
  id: z.string().regex(/^[A-Z]{1,2}-\d{2}$/),
  name: z.string().min(1).max(80),
  category: z.string().min(1).max(40),
  tags: z.array(z.string().min(1).max(40)).max(20),
  uses: z.array(z.enum(["map", "token", "handout", "stamp"])).min(1),
  from: fromSchema.optional(),
  credit: z.strictObject({
    title: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    source: url,
    license: licenseId,
    wayback: url.optional(),
    attribution: z.string().max(400).optional(),
    /** A museum's object number, as its caption gives it. */
    object: z.string().optional(),
  }),
  grid: z.strictObject({ cellPx: z.number().positive().optional(), feetPerCell: z.number().positive().optional() }).optional(),
  stamp: z.strictObject({ key: slug, w: z.number().positive().optional(), h: z.number().positive().optional() }).optional(),
  model: z
    .strictObject({
      id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
      nodes: z.array(z.string()).optional(),
      files: z.record(z.string(), z.strictObject({ url, sha256: sha })),
    })
    .optional(),
});

const packSchema = z.strictObject({
  id: slug,
  title: z.string().min(1).max(80),
  author: z.string().min(1).max(200),
  authorUrl: z.string().url().optional(),
  page: url,
  wayback: url.startsWith("https://web.archive.org/web/"),
  licenses: z.array(licenseId).min(1),
  licenseAsStated: z.string().min(1),
  aiCheck: z.string().min(1),
  attribution: z.string().max(400).optional(),
  encoding: z.enum(ENCODINGS),
  maxSide: z.number().int().positive().optional(),
  works: z.array(workSchema).min(1),
});

const inputSchema = z.strictObject({ archives: z.record(z.string(), archiveSchema), packs: z.array(packSchema).min(1) });

type Input = z.infer<typeof inputSchema>;
type InputPack = z.infer<typeof packSchema>;
type InputWork = z.infer<typeof workSchema>;
type Archive = z.infer<typeof archiveSchema>;

// ---------------------------------------------------------------------------
// Fetching

const USER_AGENT = "RaccoonVTT-starter-art/1.0";

/**
 * Streams a download into the cache, hashing as it goes, and files it under
 * its hash. A pinned file already there is used again once its hash checks.
 * Nothing a server sends ever picks a path.
 */
async function fetchToCache(cache: string, source: string | (() => Promise<string>), sha256: string | undefined, label: string): Promise<{ path: string; sha256: string }> {
  if (sha256) {
    const path = join(cache, sha256);
    if (await hashFile(path).then((h) => h === sha256, () => false)) return { path, sha256 };
  }
  const href = typeof source === "string" ? source : await source();
  const res = await fetch(href, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(900_000) });
  if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status}`);
  const partial = join(cache, `partial-${randomUUID()}`);
  const hash = createHash("sha256");
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial, { flags: "wx" }),
    );
    const actual = hash.digest("hex");
    if (sha256 && actual !== sha256) throw new Error(`${label} changed upstream (sha256 ${actual}). Re-check its license before re-pinning.`);
    const path = join(cache, actual);
    await rename(partial, path);
    return { path, sha256: actual };
  } finally {
    await unlink(partial).catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The cookies one itch.io visit sets, sent back on its later requests as a browser would. */
class CookieJar {
  readonly #cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * A fresh signed link to one upload of a free itch.io page: the page's CSRF
 * token, the download page it opens for a pay-nothing download, the upload
 * found there by its file name, and the link itch.io answers for it, good
 * for about a minute. The HTML is read with patterns only, never run.
 */
async function itchLink(page: string, upload: string): Promise<string> {
  const jar = new CookieJar();
  const call = async (href: string, form?: Record<string, string>): Promise<string> => {
    const res = await fetch(href, {
      method: form ? "POST" : "GET",
      headers: {
        "user-agent": USER_AGENT,
        cookie: jar.header(),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    jar.take(res);
    if (!res.ok) throw new Error(`${href}: HTTP ${res.status}`);
    return res.text();
  };
  // A pause between steps, as a person's clicks have: asked at once, the
  // download page now and then comes back without its uploads.
  const pause = () => new Promise((done) => setTimeout(done, 2000));
  const base = page.replace(/\/$/, "");
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(await call(base))?.[1];
  if (!csrf) throw new Error(`${page}: no CSRF token on the page`);
  await pause();
  const download = (JSON.parse(await call(`${base}/download_url`, { csrf_token: csrf })) as { url?: string }).url;
  if (!download) throw new Error(`${page}: no download page`);
  await pause();
  const html = await call(download);
  await pause();
  const id = [...html.matchAll(/data-upload_id="(\d+)"[\s\S]*?<strong title="([^"]+)" class="name"/g)].find((m) => m[2] === upload)?.[1];
  if (!id) throw new Error(`${page}: no upload named ${upload}`);
  const file = JSON.parse(await call(`${base}/file/${id}?source=view_game&as_props=1&after_download_lightbox=true`, { csrf_token: csrf })) as { url?: string };
  if (!file.url) throw new Error(`${page}: no link for ${upload}`);
  return file.url;
}

/**
 * itch.io links are asked for one at a time: two download pages of one
 * artist opened at once each came back without their uploads.
 */
let itchTurn: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(step: () => Promise<T>): Promise<T> {
  const turn = itchTurn.then(step, step);
  itchTurn = turn.catch(() => undefined);
  return turn;
}

/** itch.io now and then answers a download page without its uploads, so a link is asked for up to three times. */
async function withRetries<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= 3) throw err;
      console.log(`${(err as Error).message}: trying again`);
      await new Promise((done) => setTimeout(done, 5000 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Archives

type ArchiveReader = { read(entry: string): Promise<Buffer>; close(): void };

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;

function openZip(path: string): Promise<ArchiveReader> {
  return new Promise((done, fail) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return fail(err);
      const entries = new Map<string, yauzl.Entry>();
      zip.on("error", fail);
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on("end", () =>
        done({
          read: (name) =>
            new Promise((ok, no) => {
              const entry = entries.get(name);
              if (!entry) return no(new Error(`${name} is not in the zip`));
              if (entry.uncompressedSize > MAX_ENTRY_BYTES) return no(new Error(`${name} is too large`));
              zip.openReadStream(entry, (streamErr, stream) => {
                if (streamErr) return no(streamErr);
                const chunks: Buffer[] = [];
                stream.on("data", (c: Buffer) => chunks.push(c));
                stream.on("error", no);
                stream.on("end", () => ok(Buffer.concat(chunks)));
              });
            }),
          close: () => zip.close(),
        }),
      );
      zip.readEntry();
    });
  });
}

/** A gzipped tar, read whole into memory: the one tar here is a few MB. Only regular files are kept, by their names. */
async function openTarGz(path: string): Promise<ArchiveReader> {
  const tar = gunzipSync(await readFile(path), { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map<string, Buffer>();
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, length: number) => header.subarray(from, from + length).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    const body = tar.subarray(at + 512, at + 512 + size);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "") files.set(name, Buffer.from(body));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return {
    read: async (name) => {
      const file = files.get(name);
      if (!file) throw new Error(`${name} is not in the tar`);
      return file;
    },
    close: () => undefined,
  };
}

class Sources {
  readonly #open = new Map<string, Promise<ArchiveReader>>();
  readonly cache: string;
  readonly input: Input;
  readonly pin: boolean;
  /** Pins `--pin` found, written back into the input at the end. */
  pinned = false;

  constructor(cache: string, input: Input, pin: boolean) {
    this.cache = cache;
    this.input = input;
    this.pin = pin;
  }

  archive(name: string): Promise<ArchiveReader> {
    let reader = this.#open.get(name);
    if (!reader) {
      reader = this.#openArchive(name);
      this.#open.set(name, reader);
    }
    return reader;
  }

  async #openArchive(name: string): Promise<ArchiveReader> {
    const archive: Archive | undefined = this.input.archives[name];
    if (!archive) throw new Error(`no archive named ${name}`);
    if (!archive.sha256 && !this.pin) throw new Error(`archive ${name} is not pinned: run with --pin`);
    const itch = archive.itch;
    const source = itch ? () => oneAtATime(() => withRetries(() => itchLink(itch.page, itch.upload))) : archive.url;
    if (!source) throw new Error(`archive ${name} has no source`);
    const got = await fetchToCache(this.cache, source, archive.sha256, `archive ${name}`);
    if (!archive.sha256) {
      archive.sha256 = got.sha256;
      this.pinned = true;
      console.log(`pinned archive ${name} at ${got.sha256}`);
    }
    return archive.kind === "zip" ? openZip(got.path) : openTarGz(got.path);
  }

  async original(work: InputWork): Promise<Buffer> {
    const from = work.from;
    if (!from) throw new Error(`${work.id}: no source`);
    if ("url" in from) return readFile((await fetchToCache(this.cache, from.url, from.sha256, `${work.id} ${from.url}`)).path);
    const data = await (await this.archive(from.archive)).read(from.entry);
    return checkPin(`${work.id} ${from.archive}/${from.entry}`, data, from.sha256);
  }

  /**
   * A Poly Haven model's 1k glTF and every file it names. `--pin` asks
   * Poly Haven's API which files those are and pins what it fetched.
   */
  async model(work: InputWork): Promise<{ gltf: string; files: Map<string, Buffer> }> {
    const model = work.model;
    if (!model) throw new Error(`${work.id}: no model`);
    if (Object.keys(model.files).length === 0) {
      if (!this.pin) throw new Error(`${work.id}: the model's files are not pinned: run with --pin`);
      const res = await fetch(`https://api.polyhaven.com/files/${model.id}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${model.id}: Poly Haven API HTTP ${res.status}`);
      const listed = (await res.json()) as { gltf?: { "1k"?: { gltf?: { url: string; include?: Record<string, { url: string }> } } } };
      const gltf = listed.gltf?.["1k"]?.gltf;
      if (!gltf) throw new Error(`${model.id}: no 1k glTF`);
      const name = gltf.url.split("/").pop() ?? "";
      const folder = gltf.url.slice(0, gltf.url.length - name.length);
      for (const [path, file] of [[name, { url: gltf.url }] as const, ...Object.entries(gltf.include ?? {})]) {
        // The API names the buffer in the largest resolution's folder, where
        // a model updated since can hold a buffer of another layout (the
        // cannon's), so the buffer beside the 1k glTF is the one taken.
        const href = path.endsWith(".bin") ? `${folder}${path}` : file.url;
        const got = await fetchToCache(this.cache, href, undefined, `${model.id} ${path}`);
        model.files[path] = { url: href, sha256: got.sha256 };
      }
      this.pinned = true;
      console.log(`pinned ${Object.keys(model.files).length} files of ${model.id}`);
    }
    const files = new Map<string, Buffer>();
    for (const [path, file] of Object.entries(model.files)) {
      files.set(path, await readFile((await fetchToCache(this.cache, file.url, file.sha256, `${model.id} ${path}`)).path));
    }
    const gltf = Object.keys(model.files).find((path) => path.endsWith(".gltf"));
    if (!gltf) throw new Error(`${model.id}: no glTF among its files`);
    checkBuffers(model.id, files.get(gltf) ?? Buffer.alloc(0), files);
    return { gltf, files };
  }

  close(): void {
    for (const reader of this.#open.values()) void reader.then((r) => r.close(), () => undefined);
  }
}

/** Each buffer a glTF names must be the length it says, or the model's vertices are read from the wrong bytes. */
function checkBuffers(id: string, gltf: Buffer, files: Map<string, Buffer>): void {
  const json = JSON.parse(gltf.toString("utf8")) as { buffers?: { uri?: string; byteLength?: number }[] };
  for (const buffer of json.buffers ?? []) {
    const data = buffer.uri ? files.get(buffer.uri) : undefined;
    if (!data || data.length !== buffer.byteLength) throw new Error(`${id}: ${buffer.uri} is ${data?.length ?? 0} bytes, the glTF says ${buffer.byteLength}`);
  }
}

// ---------------------------------------------------------------------------
// Encoding

type Encoded = {
  data: Buffer;
  ext: "png" | "webp";
  width: number;
  height: number;
  changes: string;
  /** A thumbnail of its own, or none when the file itself is thumbnail sized. */
  thumb: Buffer | null;
  /** The original's size. A render has no picture of its own, so it gives its own. */
  original: { width: number; height: number };
  grid?: StarterWork["grid"];
  stamp?: { w: number; h: number };
};

const fit = (width: number, height: number, max: number) => {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

/** Whether an embedded color profile is anything but sRGB, which the build converts from, so the credit says so. */
function profileNote(meta: Metadata): string {
  if (!meta.icc) return "";
  const text = meta.icc.toString("latin1");
  return /sRGB/i.test(text) ? "" : ", its color profile converted to sRGB";
}

function resizeNote(from: { width: number; height: number }, to: { width: number; height: number }): string | null {
  return from.width === to.width && from.height === to.height ? null : `Resized from ${from.width} x ${from.height} to ${to.width} x ${to.height}`;
}

/** "Resized from A to B and converted to WebP", or "Converted from TIFF, reduced to four gray levels and saved as PNG". */
function sentence(parts: (string | null)[], tail: string): string {
  const said = parts.filter((p): p is string => p !== null);
  if (said.length === 0) return tail[0]!.toUpperCase() + tail.slice(1);
  return `${said.join(", ")}${tail.includes(" and ") ? ", " : " and "}${tail}`;
}

async function thumbOf(data: Buffer, kernel: "lanczos3" | "nearest" = "lanczos3"): Promise<Buffer> {
  return sharp(data)
    .resize(STARTER_CAPS.thumbPx, STARTER_CAPS.thumbPx, { fit: "inside", withoutEnlargement: true, kernel })
    .webp({ quality: THUMB_QUALITY, alphaQuality: 90, effort: WEBP_EFFORT })
    .toBuffer();
}

async function upright(input: Buffer, id: string): Promise<Metadata> {
  const meta = await sharp(input).metadata();
  // Sharp would turn such an image upright on its own, a change the credit would have to name. None here needs it.
  if (meta.orientation !== undefined && meta.orientation !== 1) throw new Error(`${id}: EXIF orientation ${meta.orientation} needs a look`);
  return meta;
}

/**
 * Ink on white paper as four gray levels in a palette PNG (design 7): a
 * quarter of the bytes of WebP at no visible loss, since the hatching and
 * the grid are already one or two inks. No dithering, which would speckle
 * the paper.
 */
async function lineMap(input: Buffer, work: InputWork): Promise<Encoded> {
  const meta = await upright(input, work.id);
  const size = fit(meta.width, meta.height, STARTER_CAPS.lineMapPx);
  let image = sharp(input);
  if (size.width !== meta.width) image = image.resize(size.width, size.height, { kernel: "lanczos3" });
  const data = await image.greyscale().png({ palette: true, colours: 4, dither: 0, compressionLevel: 9, effort: 10 }).toBuffer();
  const from = meta.format === "tiff" ? "Converted from TIFF" : null;
  const changes = `${sentence([from, resizeNote(meta, size)], "reduced to four gray levels and saved as PNG")}.`;
  return { data, ext: "png", ...size, changes, thumb: await thumbOf(data), original: dims(meta), grid: await mapGrid(data, work, size.width / meta.width) };
}

const dims = (meta: { width: number; height: number }) => ({ width: meta.width, height: meta.height });

async function paintedMap(input: Buffer, work: InputWork): Promise<Encoded> {
  const meta = await upright(input, work.id);
  const size = fit(meta.width, meta.height, STARTER_CAPS.colorMapPx);
  let image = sharp(input);
  if (size.width !== meta.width) image = image.resize(size.width, size.height, { kernel: "lanczos3" });
  const data = await image.webp({ quality: QUALITY, effort: WEBP_EFFORT }).toBuffer();
  const changes = `${sentence([resizeNote(meta, size)], `converted to WebP${profileNote(meta)}`)}.`;
  return { data, ext: "webp", ...size, changes, thumb: await thumbOf(data), original: dims(meta), grid: await mapGrid(data, work, size.width / meta.width) };
}

/**
 * Painted or photographed art at most `max` px on its long side. A picture
 * with a byte cap that would pass it is made smaller, a tenth at a time, to
 * no less than 1024 px (design 10: a picture is 1024 to 1600 px and at
 * most 300 KB), and only then is its quality stepped down.
 */
async function picture(input: Buffer, work: InputWork, max: number, cap: number | null): Promise<Encoded> {
  const meta = await upright(input, work.id);
  const floor = Math.min(max, MIN_PICTURE_PX);
  let side = max;
  let quality = QUALITY;
  for (;;) {
    const size = fit(meta.width, meta.height, side);
    const data = await sharp(input).resize(size.width, size.height, { kernel: "lanczos3" }).webp({ quality, alphaQuality: 100, effort: WEBP_EFFORT }).toBuffer();
    if (cap === null || data.length <= cap) {
      const changes = `${sentence([resizeNote(meta, size)], `converted to WebP${profileNote(meta)}`)}.`;
      return { data, ext: "webp", ...size, changes, thumb: await thumbOf(data), original: dims(meta) };
    }
    if (Math.max(size.width, size.height) > floor) side = Math.max(floor, Math.round(Math.max(size.width, size.height) * 0.9));
    else if (quality > MIN_QUALITY) quality -= 5;
    else throw new Error(`${work.id}: ${data.length} bytes at ${side} px and quality ${quality}, over the cap`);
  }
}

async function pixel(input: Buffer, work: InputWork): Promise<Encoded> {
  const meta = await upright(input, work.id);
  const size = { width: meta.width * PIXEL_SCALE, height: meta.height * PIXEL_SCALE };
  const data = await sharp(input).resize(size.width, size.height, { kernel: "nearest" }).webp({ lossless: true, effort: WEBP_EFFORT }).toBuffer();
  const changes = `Upscaled ${PIXEL_SCALE} times from ${meta.width} x ${meta.height} px with nearest neighbor and converted to lossless WebP.`;
  return { data, ext: "webp", ...size, changes, thumb: size.width > STARTER_CAPS.thumbPx ? await thumbOf(data, "nearest") : null, original: dims(meta) };
}

/** A Warlock's Gauntlet sprite, cropped to its art in a box of its footprint's shape, as the shipped stamps are (scripts/stamps.ts). */
async function spriteStamp(input: Buffer, work: InputWork): Promise<Encoded> {
  const { w, h } = footprint(work);
  const original = await toRaw(input);
  const { raw, added } = frame(original, w, h);
  const size = spriteSize(raw);
  const data = await encodeStamp(raw, size.width, size.height);
  if (added) console.log(`${work.id}: ${added} transparent px added to fit its footprint`);
  return { data, ext: "webp", ...size, changes: "Cropped and converted to WebP.", thumb: null, original: dims(original), stamp: { w, h } };
}

/** A Gosbell prop, already drawn at its footprint's size, 70 px a square: kept whole, so its margin stays its own. */
async function wholeStamp(input: Buffer, work: InputWork): Promise<Encoded> {
  const { w, h } = footprint(work);
  const raw = await toRaw(input);
  if (Math.abs((raw.width * h) / w - raw.height) > 1) throw new Error(`${work.id}: ${raw.width} x ${raw.height} is not ${w} by ${h}`);
  const size = spriteSize(raw);
  const data = await encodeStamp(raw, size.width, size.height);
  return { data, ext: "webp", ...size, changes: "Converted to WebP.", thumb: null, original: dims(raw), stamp: { w, h } };
}

function footprint(work: InputWork): { w: number; h: number } {
  const { w, h } = work.stamp ?? {};
  if (!w || !h) throw new Error(`${work.id}: no footprint`);
  return { w, h };
}

/**
 * A map's drawn grid on the file as shipped. The square's size comes from
 * the candidate list's measurement, scaled to the shipped file. The app's
 * own grid finder (client/features/grid/detect.ts) then looks for the lines
 * at that size, which gives where they fall. When it does not agree within
 * 2%, the measured size stands alone and the DM aligns the origin.
 */
async function mapGrid(data: Buffer, work: InputWork, scale: number): Promise<StarterWork["grid"]> {
  const measured = work.grid?.cellPx;
  const feet = work.grid?.feetPerCell;
  if (!measured) return undefined;
  const cellPx = measured * scale;
  const { data: px, info } = await sharp(data).greyscale().raw().toBuffer({ resolveWithObject: true });
  // Dyson's grids are dashed, broken at every crossing, which the finder's
  // last check reads as joints rather than lines. Its fit at the measured
  // size still says where the lines fall, so the best one that passed every
  // other check gives the origin.
  type Fit = { across: { period: number; phase: number }; down: { period: number; phase: number }; score: number };
  let best: Fit | null = null;
  const onCandidate = (c: Fit & { failed: string | null }) => {
    const period = (c.across.period + c.down.period) / 2;
    if (c.failed === null && Math.abs(period - cellPx) / cellPx < 0.01 && (best === null || c.score > best.score)) best = c;
  };
  const found = detectGrid({ width: info.width, height: info.height, data: px, channels: 1 }, { hintCellPx: cellPx, onCandidate });
  const round = (n: number) => Math.round(n * 100) / 100;
  const mod = (n: number, m: number) => ((n % m) + m) % m;
  const withFeet = feet ? { feetPerCell: feet } : {};
  if (found.found && Math.abs(found.cellPx - cellPx) / cellPx < 0.02) {
    console.log(`${work.id}: grid ${round(found.cellPx)} px at ${round(found.originPx.x)}, ${round(found.originPx.y)} (found, confidence ${found.confidence.toFixed(2)})`);
    return { cellPx: round(found.cellPx), originPx: { x: round(found.originPx.x), y: round(found.originPx.y) }, ...withFeet };
  }
  const fit = best as Fit | null;
  if (fit && fit.score >= FIT_SCORE) {
    const size = (fit.across.period + fit.down.period) / 2;
    const origin = { x: round(mod(fit.across.phase, size)), y: round(mod(fit.down.phase, size)) };
    console.log(`${work.id}: grid ${round(size)} px at ${origin.x}, ${origin.y} (fit at the measured size, score ${fit.score.toFixed(2)})`);
    return { cellPx: round(size), originPx: origin, ...withFeet };
  }
  // Fainter grids give the finder too little to pass its checks. The
  // measured size is known, so only where the lines fall is asked: the
  // phase of the dark-line profile at that period, kept when the grid's
  // period stands well above the profile at periods no grid has.
  // Dyson draws his grid in broad gray strokes, wider than the finder's line
  // filter reaches across, so the filter is tried wider too, and the reach
  // whose weaker axis stands out most is kept.
  const pixels = { width: info.width, height: info.height, data: px, channels: 1 } as const;
  let across = { period: cellPx, phase: 0, contrast: 0 };
  let down = across;
  for (const reach of [lineReach(info.width, info.height), 6, 10]) {
    const profiles = lineProfiles(pixels, reach, defaultStep(info.width, info.height));
    const x = phaseAt(profiles.cols.dark, cellPx);
    const y = phaseAt(profiles.rows.dark, cellPx);
    if (Math.min(x.contrast, y.contrast) > Math.min(across.contrast, down.contrast)) {
      across = x;
      down = y;
    }
  }
  if (across.contrast >= PHASE_CONTRAST && down.contrast >= PHASE_CONTRAST) {
    const size = (across.period + down.period) / 2;
    const origin = { x: round(mod(across.phase, size)), y: round(mod(down.phase, size)) };
    console.log(`${work.id}: grid ${round(size)} px at ${origin.x}, ${origin.y} (phase at the measured size, contrast ${across.contrast.toFixed(1)} and ${down.contrast.toFixed(1)})`);
    return { cellPx: round(size), originPx: origin, ...withFeet };
  }
  console.log(`${work.id}: grid ${round(cellPx)} px as measured, no origin (contrast ${across.contrast.toFixed(1)} and ${down.contrast.toFixed(1)})`);
  return { cellPx: round(cellPx), ...withFeet };
}

/**
 * Where lines `period` apart fall in a line profile, from its Fourier
 * component near that period (within 1.5%, which also refines the period),
 * and how far that component stands above the same measure at periods well
 * away from it and its harmonics.
 */
function phaseAt(profile: Float64Array, period: number): { period: number; phase: number; contrast: number } {
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= profile.length || 1;
  const magnitude = (q: number) => {
    let c = 0;
    let s = 0;
    for (let x = 0; x < profile.length; x++) {
      const v = profile[x]! - mean;
      const a = (2 * Math.PI * x) / q;
      c += v * Math.cos(a);
      s += v * Math.sin(a);
    }
    return { m: Math.hypot(c, s), c, s };
  };
  let best = { q: period, m: -1, c: 0, s: 0 };
  for (let k = -60; k <= 60; k++) {
    const q = period * (1 + k * 0.00025);
    const at = magnitude(q);
    if (at.m > best.m) best = { q, ...at };
  }
  const away = [0.62, 0.71, 0.83, 1.17, 1.29, 1.41].map((f) => magnitude(period * f).m);
  const noise = away.reduce((a, b) => a + b, 0) / away.length || 1;
  const phase = (((Math.atan2(best.s, best.c) * best.q) / (2 * Math.PI)) % best.q + best.q) % best.q;
  return { period: best.q, phase, contrast: best.m / noise };
}

async function encodeWork(pack: InputPack, work: InputWork, sources: Sources, renderer: () => Promise<Renderer>): Promise<Encoded> {
  const encoding: Encoding = pack.encoding;
  if (encoding === "stamp-render") {
    const model = work.model;
    if (!model) throw new Error(`${work.id}: no model`);
    const { gltf, files } = await sources.model(work);
    const gltfModel = { id: model.id, gltf, files: model.files };
    checkGltfNames(gltfModel, files.get(gltf) ?? Buffer.alloc(0));
    const r = await renderer();
    r.serve(new Map([...files].map(([path, data]) => [`${model.id}/${path}`, data])));
    const rendered = await renderModelStamp(r, gltfModel, model.nodes ?? null);
    console.log(`${work.id}: ${rendered.metres.width.toFixed(2)} x ${rendered.metres.depth.toFixed(2)} m, ${rendered.w} x ${rendered.h} cells`);
    return {
      data: rendered.webp,
      ext: "webp",
      width: rendered.outW,
      height: rendered.outH,
      changes: "Rendered from above and converted to WebP.",
      thumb: null,
      original: { width: rendered.outW, height: rendered.outH },
      stamp: { w: rendered.w, h: rendered.h },
    };
  }
  const input = await sources.original(work);
  switch (encoding) {
    case "line-map":
      return lineMap(input, work);
    case "painted-map":
      return paintedMap(input, work);
    case "token":
      return picture(input, work, pack.maxSide ?? STARTER_CAPS.tokenPx, null);
    case "picture":
      return picture(input, work, pack.maxSide ?? 1024, STARTER_CAPS.pictureBytes);
    case "pixel":
      return pixel(input, work);
    case "stamp-sprite":
      return spriteStamp(input, work);
    case "stamp-whole":
      return wholeStamp(input, work);
  }
}

// ---------------------------------------------------------------------------
// Building

const PACK_CHANGES: Record<Encoding, (pack: InputPack) => string> = {
  "line-map": () => "Resized to 4096 px on the long side where larger, reduced to four gray levels and saved as PNG.",
  "painted-map": () => "Converted to WebP.",
  token: (pack) => `Resized to ${pack.maxSide ?? STARTER_CAPS.tokenPx} px on the long side and converted to WebP.`,
  picture: (pack) => `Resized to ${pack.maxSide ?? 1024} px on the long side where larger and converted to WebP.`,
  pixel: () => `Upscaled ${PIXEL_SCALE} times with nearest neighbor and converted to lossless WebP.`,
  "stamp-sprite": () => "Cropped and converted to WebP.",
  "stamp-whole": () => "Converted to WebP.",
  "stamp-render": () => "Rendered from above and converted to WebP.",
};

const workSlug = (work: InputWork) => work.id.toLowerCase();

/** Runs `task` over the items, at most `size` at a time, answering in the items' order. */
async function inBatches<T, R>(items: readonly T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await task(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

function checkInput(input: Input): void {
  const packs = new Set<string>();
  const stampKeys = new Set(STAMP_ART.map((s) => s.key));
  for (const pack of input.packs) {
    if (packs.has(pack.id)) throw new Error(`two packs are ${pack.id}`);
    packs.add(pack.id);
    const ids = new Set<string>();
    const stamped = pack.encoding.startsWith("stamp-");
    for (const work of pack.works) {
      if (ids.has(work.id)) throw new Error(`${pack.id}: two works are ${work.id}`);
      ids.add(work.id);
      if (!pack.licenses.includes(work.credit.license)) throw new Error(`${work.id}: ${work.credit.license} is not among its pack's licenses`);
      if (stamped !== (work.stamp !== undefined) || stamped !== work.uses.includes("stamp")) throw new Error(`${work.id}: a stamp in a stamp pack, and only there`);
      if (work.stamp) {
        if (!STAMP_KEY.test(work.stamp.key) || stampKeys.has(work.stamp.key)) throw new Error(`${work.id}: stamp key ${work.stamp.key} is taken or not a slug`);
        stampKeys.add(work.stamp.key);
      }
      if (pack.encoding === "stamp-render" ? !work.model : !work.from) throw new Error(`${work.id}: no source`);
    }
  }
}

type Built = { pack: StarterPack; stamps: StarterStamp[]; bytes: number };

async function buildPack(pack: InputPack, sources: Sources, renderer: () => Promise<Renderer>): Promise<Built> {
  const dir = join(OUT_DIR, pack.id);
  const stamped = pack.encoding.startsWith("stamp-");
  if (!stamped) await mkdir(join(dir, "thumbs"), { recursive: true });
  const works: StarterWork[] = [];
  const stamps: StarterStamp[] = [];
  let bytes = 0;
  // Four works encode at once, in order of the pack, apart from renders: one page draws one model at a time.
  const encoded = await inBatches(pack.works, pack.encoding === "stamp-render" ? 1 : 4, (work) => encodeWork(pack, work, sources, renderer));
  for (const [i, work] of pack.works.entries()) {
    const out = encoded[i];
    if (!out) throw new Error(`${work.id}: not encoded`);
    const name = workSlug(work);
    let file: string;
    let thumb: string | undefined;
    if (out.stamp && work.stamp) {
      await writeFile(join(STAMPS_DIR, `${work.stamp.key}.webp`), out.data);
      file = `/stamps/${work.stamp.key}.webp`;
      stamps.push({ key: work.stamp.key, name: work.name, w: out.stamp.w, h: out.stamp.h, pack: pack.id });
    } else {
      await writeFile(join(dir, `${name}.${out.ext}`), out.data);
      file = `/starter/${pack.id}/${name}.${out.ext}`;
      if (out.thumb) {
        await writeFile(join(dir, "thumbs", `${name}.webp`), out.thumb);
        thumb = `/starter/${pack.id}/thumbs/${name}.webp`;
        bytes += out.thumb.length;
      } else {
        thumb = file;
      }
    }
    bytes += out.data.length;
    const original = out.original;
    works.push({
      key: `${pack.id}/${name}`,
      id: work.id,
      name: work.name,
      category: work.category,
      tags: work.tags,
      uses: work.uses as StarterUse[],
      file,
      sha256: sha256Of(out.data),
      width: out.width,
      height: out.height,
      bytes: out.data.length,
      ...(thumb ? { thumb } : {}),
      ...(out.grid ? { grid: out.grid } : {}),
      ...(pack.encoding === "line-map" ? { gridColor: PAPER_GRID } : {}),
      ...(out.stamp && work.stamp ? { stamp: { key: work.stamp.key, w: out.stamp.w, h: out.stamp.h } } : {}),
      original,
      credit: {
        title: work.credit.title,
        author: work.credit.author,
        source: work.credit.source,
        license: work.credit.license,
        changes: out.changes,
        ...(work.credit.attribution ? { attribution: work.credit.attribution } : {}),
      },
    });
    console.log(`${work.id}  ${file}  ${out.width}x${out.height}  ${out.data.length} bytes  ${out.changes}`);
  }
  const changes = new Set(works.map((w) => w.credit.changes));
  const built: StarterPack = {
    id: pack.id,
    title: pack.title,
    author: pack.author,
    ...(pack.authorUrl ? { authorUrl: pack.authorUrl } : {}),
    page: pack.page,
    wayback: pack.wayback,
    licenses: pack.licenses as LicenseId[],
    changes: changes.size === 1 ? [...changes][0]! : PACK_CHANGES[pack.encoding](pack),
    ...(pack.attribution ? { attribution: pack.attribution } : {}),
    works,
  };
  return { pack: built, stamps, bytes };
}

async function removeStale(packs: StarterPack[], stamps: StarterStamp[]): Promise<void> {
  const keep = new Set(packs.flatMap((p) => p.works.flatMap((w) => [w.file, w.thumb ?? w.file])).map((f) => join(ROOT, "public", f)));
  for (const pack of await readdir(OUT_DIR).catch(() => [] as string[])) {
    const known = packs.some((p) => p.id === pack);
    if (!known) {
      await rm(join(OUT_DIR, pack), { recursive: true, force: true });
      console.log(`removed public/starter/${pack}, no longer a pack`);
      continue;
    }
    for (const sub of ["", "thumbs"]) {
      for (const file of await readdir(join(OUT_DIR, pack, sub)).catch(() => [] as string[])) {
        const path = join(OUT_DIR, pack, sub, file);
        if ((await stat(path)).isDirectory() || keep.has(path)) continue;
        await unlink(path);
        console.log(`removed ${path.slice(ROOT.length + 1)}, no longer in the set`);
      }
    }
  }
  // The packs' stamps share public/stamps with the shipped ones, so only a key of a stamp pack that left the set is removed.
  const shipped = new Set(STAMP_ART.map((s) => s.key));
  const ours = new Set(stamps.map((s) => s.key));
  const prefixes = new Set(stamps.map((s) => s.key.split("-")[0]));
  for (const file of await readdir(STAMPS_DIR)) {
    const key = file.replace(/\.webp$/, "");
    if (shipped.has(key) || ours.has(key) || !prefixes.has(key.split("-")[0])) continue;
    await unlink(join(STAMPS_DIR, file));
    console.log(`removed public/stamps/${file}, no longer in the set`);
  }
}

// ---------------------------------------------------------------------------
// Writing the catalog and the credits

function catalogSource(packs: StarterPack[]): string {
  const body = packs
    .map((pack) => {
      const { works, ...head } = pack;
      const fields = JSON.stringify(head).slice(1, -1);
      return `  {\n    ${fields},\n    works: [\n${works.map((w) => `      ${JSON.stringify(w)},`).join("\n")}\n    ],\n  },`;
    })
    .join("\n");
  return `/**
 * The starter packs' catalog (docs/design-v1-starter-art.md). Written by
 * \`node scripts/starter-art.ts\` from scripts/starter-art.json, so change
 * those, not this file. Its shapes and the rules that read it are in
 * shared/starter.ts.
 */
import type { StarterPack } from "./starter.ts";

export const STARTER_PACKS: readonly StarterPack[] = [
${body}
];
`;
}

function stampListSource(stamps: StarterStamp[]): string {
  const rows = stamps.map(
    (s) => `  { key: ${JSON.stringify(s.key)}, name: ${JSON.stringify(s.name)}, w: ${s.w}, h: ${s.h}, pack: ${JSON.stringify(s.pack)} },`,
  );
  return `/**
 * The starter packs' stamps (docs/design-v1-starter-art.md 5), drawn from
 * \`/stamps/<key>.webp\` beside the shipped stamps of shared/stamps.ts, so
 * the board can draw one without loading the catalog. Written by
 * \`node scripts/starter-art.ts\`, so change the script, not this file.
 */
import type { StarterStamp } from "./starter.ts";

export const STARTER_STAMPS: readonly StarterStamp[] = [
${rows.join("\n")}
];
`;
}

const MD_START = "<!-- starter-packs: written by node scripts/starter-art.ts -->";
const MD_END = "<!-- end of starter-packs -->";

const md = (text: string) => text.replace(/\|/g, "\\|");

function licenseLink(id: LicenseId): string {
  const license = LICENSES[id];
  return license.url ? `[${license.name}](${license.url})` : license.name;
}

function creditsSection(packs: StarterPack[]): string {
  const out: string[] = [
    MD_START,
    "## Starter packs",
    "",
    "Art a DM can pick from the Starter tab wherever art is chosen (docs/design-v1-starter-art.md): sets from one artist or project in one style, each under its own license. `node scripts/starter-art.ts` downloads every original from where its author published it, checks it against a pinned SHA-256 in `scripts/starter-art.json`, which also records each pack's license in its page's own words, a Wayback snapshot of that page and the check for AI art, and writes the files, their catalog (`shared/starterArt.ts`) and this section. A picked image keeps its work's credit in the room's library.",
    "",
    "The files under CC BY-SA licenses (the Illustrated Bestiary and Flare Portrait Pack Number One) are adaptations, resized and re-encoded, and stay under the same CC BY-SA license as their originals. RaccoonVTT's code is a separate work and is not affected.",
    "",
  ];
  for (const pack of packs) {
    out.push(`### ${pack.title}, by ${pack.author}`, "");
    const licenses = pack.licenses.map(licenseLink).join(" and ");
    const pages = [...new Set(pack.works.map((w) => w.credit.source))];
    const where = pages.length === 1 ? `Source: ${pages[0]}.` : `Source: ${pack.page}, and each work's own page below.`;
    out.push(`${licenses}. ${where} Snapshot of the license: ${pack.wayback}.${pack.attribution ? ` Credit the author asks for: ${pack.attribution}.` : ""} Changes: ${pack.changes}`, "");
    const stamps = pack.works.some((w) => w.stamp);
    out.push(stamps ? "| File | Work | Source | License | Changes |" : "| Files | Work | Source | License | Changes |", "| --- | --- | --- | --- | --- |");
    for (const work of pack.works) {
      const files = [work.file, ...(work.thumb && work.thumb !== work.file ? [work.thumb] : [])].map((f) => `\`public${f}\``).join(", ");
      const title = work.credit.attribution ?? `${work.credit.title}, by ${work.credit.author}`;
      out.push(`| ${files} | ${md(title)} | ${work.credit.source} | ${LICENSES[work.credit.license].name} | ${md(work.credit.changes)} |`);
    }
    out.push("");
  }
  out.push(MD_END);
  return out.join("\n");
}

async function writeCredits(packs: StarterPack[]): Promise<void> {
  const text = await readFile(CREDITS_MD, "utf8");
  const section = creditsSection(packs);
  const start = text.indexOf(MD_START);
  const end = text.indexOf(MD_END);
  let next: string;
  if (start >= 0 && end > start) {
    next = text.slice(0, start) + section + text.slice(end + MD_END.length);
  } else {
    // First run: the section goes after the map stamps, before the app icon.
    const at = text.indexOf("## App icon");
    if (at < 0) throw new Error("CREDITS.md has no App icon section to place the starter packs before");
    next = `${text.slice(0, at)}${section}\n\n${text.slice(at)}`;
  }
  await writeFile(CREDITS_MD, next);
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { values } = parseArgs({ options: { cache: { type: "string" }, pin: { type: "boolean" }, only: { type: "string" } } });
  const cache = resolve(values.cache ?? join(tmpdir(), "raccoon-vtt-starter-art"));
  await mkdir(cache, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const input = inputSchema.parse(JSON.parse(await readFile(INPUT, "utf8")));
  checkInput(input);
  const only = values.only ? new Set(values.only.split(",")) : null;
  const sources = new Sources(cache, input, values.pin === true);

  // Chrome is started only when a Poly Haven model needs rendering.
  let browser: Awaited<ReturnType<typeof launchRenderer>> | null = null;
  let renderer: Promise<Renderer> | null = null;
  const getRenderer = () =>
    (renderer ??= (async () => {
      await checkThree();
      browser = await launchRenderer();
      return openRenderer(browser);
    })());

  try {
    const built: Built[] = [];
    for (const pack of input.packs) {
      if (only && !only.has(pack.id)) continue;
      built.push(await buildPack(pack, sources, getRenderer));
    }
    if (!only) {
      const packs = built.map((b) => b.pack);
      const stamps = built.flatMap((b) => b.stamps);
      await removeStale(packs, stamps);
      await writeFile(CATALOG, catalogSource(packs));
      await writeFile(STAMP_LIST, stampListSource(stamps));
      await writeCredits(packs);
    }
    const total = built.reduce((n, b) => n + b.bytes, 0);
    const works = built.reduce((n, b) => n + b.pack.works.length, 0);
    console.log(`${built.length} packs, ${works} works, ${(total / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    // Pins found before a failure are kept, so a second run need not fetch again what it already checked.
    if (sources.pinned) {
      await writeFile(INPUT, `${JSON.stringify(input, null, 2)}\n`);
      console.log("wrote the new pins into scripts/starter-art.json: check each one's license before committing");
    }
    sources.close();
    const open = browser as Awaited<ReturnType<typeof launchRenderer>> | null;
    if (open) await open.close();
  }
}
