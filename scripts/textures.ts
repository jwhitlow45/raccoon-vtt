/**
 * Builds the map builder's terrain tiles in public/textures/ from openly
 * licensed originals. Run by hand when a texture changes:
 *
 *   node scripts/textures.ts
 *
 * Each original is fetched from where its author published it and checked
 * against a pinned SHA-256, so a changed upstream file fails loudly instead of
 * slipping different art into the app. The only changes are mechanical: a
 * downscale to 256 px and WebP encoding. shared/credits.ts and CREDITS.md
 * credit each source.
 *
 * Tiles are named by TerrainId, so the builder finds one at
 * `/textures/${terrain}.webp`. Pit, pillar and stairs have no tile: they are
 * symbols the builder draws in code over a stone floor.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type Sharp } from "sharp";
import yauzl from "yauzl";
import type { TerrainId } from "../shared/model.ts";

type TexturedTerrain = Exclude<TerrainId, "pit" | "pillar" | "stairs">;

type Original = {
  url: string;
  /** SHA-256 of the image itself, after unzipping when `zipEntry` is set. */
  sha256: string;
  zipEntry?: string;
};

const polyHaven = (id: string, file: string, sha256: string): Original => ({
  url: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${file}`,
  sha256,
});

const ORIGINALS: Record<TexturedTerrain, Original> = {
  stone: polyHaven(
    "grey_stone_path",
    "grey_stone_path_diff_1k.jpg",
    "9b98572f768a5ca2a050f060807c737e640da303eb1700383bf4d549def2835c",
  ),
  wood: polyHaven("wood_planks", "wood_planks_diff_1k.jpg", "3b0669f683e4bf10f5a55a381cfa9669a7b8dfd921901829daa3b35acc2bbdec"),
  grass: {
    url: "https://ambientcg.com/get?file=Grass001_1K-JPG.zip",
    zipEntry: "Grass001_1K-JPG_Color.jpg",
    sha256: "b9b6d61bc3b6137b868a3447eef18737896acd26d58fe2f4b83ce8c0e9d3f8ad",
  },
  dirt: polyHaven(
    "brown_mud_dry",
    "brown_mud_dry_diff_1k.jpg",
    "a56281b644de614787340f3db45e28d2f72ec32fc19a442f99002bae0ab11398",
  ),
  cave: polyHaven("rock_ground", "rock_ground_diff_1k.jpg", "bec2573bc8aa9c714b690df753730e41f2077a1f0bbca83b13e055c86b4d5626"),
  water: {
    url: "https://opengameart.org/sites/default/files/sbs_-_mini_texture_pack_3_-_liquids_256x256.zip",
    zipEntry: "256x256/Liquid_Blue_02-512x512.png",
    sha256: "81c7736378950be742eac6c2ad0da3744421c8009e25fe87eeda77ec6618803e",
  },
  difficult: polyHaven(
    "forest_leaves_02",
    "forest_leaves_02_diffuse_1k.jpg",
    "2bac85cdc76927fa7dc311037bbbc4dfa2633ea56eb0a24c9cabe163a68c9aa5",
  ),
  rubble: polyHaven("gray_rocks", "gray_rocks_diff_1k.jpg", "4c3b6fada26a9b564ca110ad47bca5921eceefc611d970159ce559c3c50728a0"),
};

const TILE_PX = 256;
const MAX_TILE_BYTES = 30 * 1024;

const OUT_DIR = join(import.meta.dirname, "..", "public", "textures");

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readZipEntry(zip: Buffer, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, file) => {
      if (err) return reject(err);
      file.on("error", reject);
      file.on("end", () => reject(new Error(`${name} is not in the zip`)));
      file.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== name) return file.readEntry();
        file.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("error", reject);
          stream.on("end", () => {
            file.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      file.readEntry();
    });
  });
}

/**
 * Downscales a seamless square tile without breaking its seams. A plain
 * resize treats the edges as a border and clamps the filter there, which
 * leaves a faint line where copies meet. Padding with wrapped copies of the
 * opposite edges first gives the filter the pixels it would see in a tiled
 * floor, and the padding is cropped off afterwards.
 */
async function toTile(image: Buffer): Promise<Sharp> {
  const { width, height } = await sharp(image).metadata();
  if (width !== height || width % TILE_PX !== 0) {
    throw new Error(`expected a square multiple of ${TILE_PX} px, got ${width} x ${height}`);
  }
  if (width === TILE_PX) return sharp(image);
  const factor = width / TILE_PX;
  const padOut = 8;
  const pad = padOut * factor;
  const padded = await sharp(image)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, extendWith: "repeat" })
    .toBuffer();
  const reduced = await sharp(padded)
    .resize(TILE_PX + 2 * padOut, TILE_PX + 2 * padOut, { kernel: "lanczos3" })
    .toBuffer();
  return sharp(reduced).extract({ left: padOut, top: padOut, width: TILE_PX, height: TILE_PX });
}

/** The highest WebP quality that fits the size budget, so busy textures are not over-compressed. */
async function encode(tile: Sharp): Promise<{ webp: Buffer; quality: number }> {
  const raw = await tile.removeAlpha().png().toBuffer();
  for (let quality = 82; quality >= 50; quality -= 4) {
    const webp = await sharp(raw).webp({ quality, effort: 6 }).toBuffer();
    if (webp.length <= MAX_TILE_BYTES) return { webp, quality };
  }
  throw new Error(`could not fit the tile in ${MAX_TILE_BYTES} bytes`);
}

async function build(terrain: TexturedTerrain, original: Original): Promise<void> {
  const fetched = await download(original.url);
  const image = original.zipEntry ? await readZipEntry(fetched, original.zipEntry) : fetched;
  const sha256 = createHash("sha256").update(image).digest("hex");
  if (sha256 !== original.sha256) {
    throw new Error(`${terrain}: ${original.url} changed upstream (sha256 ${sha256}). Re-check its license before re-pinning.`);
  }
  const { webp, quality } = await encode(await toTile(image));
  await writeFile(join(OUT_DIR, `${terrain}.webp`), webp);
  console.log(`${terrain}.webp  ${webp.length} bytes  quality ${quality}`);
}

if (import.meta.main) {
  await mkdir(OUT_DIR, { recursive: true });
  for (const [terrain, original] of Object.entries(ORIGINALS) as [TexturedTerrain, Original][]) {
    await build(terrain, original);
  }
}
