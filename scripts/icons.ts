/**
 * Builds the app's icons. Run by hand when a source changes:
 *
 *   node scripts/icons.ts          PWA and Home Screen PNGs from public/icon.svg
 *   node scripts/icons.ts effects  condition and status SVGs from game-icons.net
 *
 * Both only convert existing art. The PNGs are rasterized from the raccoon
 * icon (design section 14.5). The effect icons are game-icons.net files
 * reduced to one tintable path (design section 20). Their sources and credits
 * live in shared/credits.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  CONDITION_ICONS,
  GAME_ICON_CHANGES,
  GAME_ICONS_COMMIT,
  LICENSES,
  STATUS_ICONS,
  type GameIcon,
} from "../shared/credits.ts";

const PUBLIC = join(import.meta.dirname, "..", "public");
const ICON_SVG = join(PUBLIC, "icon.svg");
const ICONS_DIR = join(PUBLIC, "icons");

/** The app's background, so maskable and Apple icons blend into the splash screen. */
const BACKGROUND = "#16161a";

/**
 * The icon's white disc has a radius of 248 in its 512 viewBox. A maskable
 * icon must keep everything that matters inside the central circle of 80%
 * of its width, because launchers crop to anything from a circle to a
 * squircle. Drawing the icon at 80% of the canvas puts the disc's diameter at
 * about 77.5%, just inside that zone.
 */
const MASKABLE_SCALE = 0.8;

/**
 * iOS fills transparency with black and rounds the corners itself, so the
 * Home Screen icon gets a solid background and a little room around the
 * disc. The rounded corners never reach a centered circle this size.
 */
const APPLE_SCALE = 0.9;

type AppIcon = { file: string; size: number; scale: number; background: string | null };

const APP_ICONS: AppIcon[] = [
  { file: "app-192.png", size: 192, scale: 1, background: null },
  { file: "app-512.png", size: 512, scale: 1, background: null },
  { file: "app-maskable-512.png", size: 512, scale: MASKABLE_SCALE, background: BACKGROUND },
  { file: "apple-touch-icon-180.png", size: 180, scale: APPLE_SCALE, background: BACKGROUND },
];

/** The SVG's own size, from its viewBox. Density scales from there, 72 dpi being 1:1. */
const SVG_SIZE = 512;

async function rasterize(svg: Buffer, icon: AppIcon): Promise<Buffer> {
  const inner = Math.round(icon.size * icon.scale);
  const art = await sharp(svg, { density: (72 * inner) / SVG_SIZE })
    .resize(inner, inner)
    .png()
    .toBuffer();
  if (!icon.background) return sharp(art).png({ compressionLevel: 9 }).toBuffer();
  const offset = Math.round((icon.size - inner) / 2);
  return sharp({ create: { width: icon.size, height: icon.size, channels: 3, background: icon.background } })
    .composite([{ input: art, left: offset, top: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function buildAppIcons(): Promise<void> {
  const svg = await readFile(ICON_SVG);
  await mkdir(ICONS_DIR, { recursive: true });
  for (const icon of APP_ICONS) {
    const png = await rasterize(svg, icon);
    await writeFile(join(ICONS_DIR, icon.file), png);
    console.log(`${icon.file}  ${png.length} bytes`);
  }
}

/**
 * Every game-icons.net file is a black 512 x 512 square with one white path
 * on top. Keeping only that path, filled with currentColor, lets the app tint
 * the icon with CSS or swap the color in before drawing it on the canvas.
 * Anything else in the file means upstream changed shape, so it fails rather
 * than guessing. The path data is checked against the path grammar's
 * characters because these files may be inlined into the page.
 */
export const GAME_ICON_SHAPE =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"\/><path fill="#fff" d="([^"]+)"\/><\/svg>\s*$/;
export const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\se-]+$/;

export function simplifyGameIcon(svg: string, attribution: string): string {
  const match = GAME_ICON_SHAPE.exec(svg);
  const d = match?.[1];
  if (!d) throw new Error("unexpected game-icons.net SVG shape");
  if (!PATH_DATA.test(d)) throw new Error("unexpected characters in path data");
  if (attribution.includes("--")) throw new Error("attribution cannot contain -- inside an XML comment");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
    `<!-- ${attribution} -->` +
    `<path fill="currentColor" d="${d}"/></svg>\n`
  );
}

function gameIconAttribution(icon: GameIcon): string {
  const license = LICENSES["CC-BY-3.0"];
  return `"${icon.title}" by ${icon.author}, https://game-icons.net/1x1/${icon.slug}.html, ${license.name} ${license.url}. ${GAME_ICON_CHANGES}`;
}

async function buildEffectIcons(): Promise<void> {
  const groups: [string, Record<string, GameIcon>][] = [
    ["conditions", CONDITION_ICONS],
    ["statuses", STATUS_ICONS],
  ];
  for (const [dir, icons] of groups) {
    await mkdir(join(ICONS_DIR, dir), { recursive: true });
    for (const [key, icon] of Object.entries(icons)) {
      // Pinned to a commit, so the same command always fetches the same art.
      const url = `https://raw.githubusercontent.com/game-icons/icons/${GAME_ICONS_COMMIT}/${icon.slug}.svg`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const svg = simplifyGameIcon(await res.text(), gameIconAttribution(icon));
      await writeFile(join(ICONS_DIR, dir, `${key}.svg`), svg);
      console.log(`${dir}/${key}.svg  from ${icon.slug}`);
    }
  }
}

if (import.meta.main) {
  const command = process.argv[2] ?? "app";
  if (command === "app") await buildAppIcons();
  else if (command === "effects") await buildEffectIcons();
  else throw new Error(`unknown command ${command}. Use "app" or "effects".`);
}
