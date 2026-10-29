/**
 * Builds the app's icons. Run by hand when a source changes:
 *
 *   node scripts/icons.ts          PWA and Home Screen PNGs from public/icon.svg
 *   node scripts/icons.ts effects  condition and status SVGs from game-icons.net
 *   node scripts/icons.ts damage   damage SVGs from the pinned local game-icons copy
 *
 * These commands only convert existing art. The PNGs are rasterized from the raccoon
 * icon (design section 14.5). The effect icons are game-icons.net files
 * reduced to one tintable path (design section 20). Their sources and credits
 * live in shared/credits.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  CONDITION_ICONS,
  DAMAGE_ICONS,
  GAME_ICON_CHANGES,
  GAME_ICONS_COMMIT,
  LICENSES,
  STATUS_ICONS,
  type GameIcon,
} from "../shared/credits.ts";

const PUBLIC = join(import.meta.dirname, "..", "public");
const ICON_SVG = join(PUBLIC, "icon.svg");
const ICONS_DIR = join(PUBLIC, "icons");

/** The white of the icon's shape, which fills the icons a system cuts to its own shape. */
const SHAPE_WHITE = "#ffffff";

/** The icon's white rounded square in its 512 viewBox, 8 in from each edge. */
const SHAPE = { x: 8, y: 8, size: 496 };

/** The SVG's own size, from its viewBox. */
const SVG_SIZE = 512;

/**
 * A maskable icon must keep everything that matters inside the central
 * circle of 80% of its width, because launchers crop to anything from a
 * circle to a squircle.
 */
const MASKABLE_SAFE = 0.8;

/**
 * How each icon shows the SVG:
 * - "icon": as it is, the shape with transparent corners, for a page or
 *   launcher that shows the icon unmasked.
 * - "shape": the shape's square filled to its edges, for iOS, which cuts its
 *   own rounded square from the Home Screen icon and fills transparency with
 *   black. The face sits on it as on the icon.
 * - "maskable": widened until the face fits the maskable safe circle, and
 *   filled to the edges.
 * Corners or a rim drawn into the last two would show inside the system's
 * own shape, so they are full squares of the shape's white with no rim.
 */
type View = "icon" | "shape" | "maskable";

type AppIcon = { file: string; size: number; view: View };

const APP_ICONS: AppIcon[] = [
  { file: "app-192.png", size: 192, view: "icon" },
  { file: "app-512.png", size: 512, view: "icon" },
  { file: "app-maskable-512.png", size: 512, view: "maskable" },
  { file: "apple-touch-icon-180.png", size: 180, view: "shape" },
];

const RIM = /\s*<use id="rim"[^>]*\/>/;
const VIEW_BOX = /viewBox="0 0 512 512"/;

/** The SVG with its rim taken out and its viewBox set to the square at (x, y) of side `side`. */
function filled(svg: string, x: number, y: number, side: number): string {
  if (!RIM.test(svg) || !VIEW_BOX.test(svg)) throw new Error("public/icon.svg has no rim or no 512 viewBox to replace");
  return svg.replace(RIM, "").replace(VIEW_BOX, `viewBox="${x} ${y} ${side} ${side}"`);
}

/** Draws `svg` whose viewBox is `side` wide at `size` px, flattened onto `background` unless it is null. */
async function draw(svg: string, side: number, size: number, background: string | null): Promise<Buffer> {
  // Density scales from the viewBox's size, 72 dpi being 1:1.
  const art = sharp(Buffer.from(svg), { density: (72 * size) / side }).resize(size, size);
  return (background ? art.flatten({ background }) : art).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * How far the face reaches from the icon's middle, in viewBox units: the
 * farthest pixel that is not the shape's white, drawn 1:1 with the rim out.
 * Measured rather than written down, so the maskable icon follows the art.
 */
async function faceReach(svg: string): Promise<number> {
  const { data, info } = await sharp(Buffer.from(filled(svg, 0, 0, SVG_SIZE)), { density: 72 })
    .resize(SVG_SIZE, SVG_SIZE)
    .flatten({ background: SHAPE_WHITE })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const middle = SVG_SIZE / 2;
  let reach = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue;
      // The pixel's far corner, so the face's edge is inside the circle, not only its pixel centers.
      reach = Math.max(reach, Math.hypot(Math.abs(x + 0.5 - middle) + 0.5, Math.abs(y + 0.5 - middle) + 0.5));
    }
  }
  return reach;
}

async function rasterize(svg: string, icon: AppIcon): Promise<Buffer> {
  if (icon.view === "icon") return draw(svg, SVG_SIZE, icon.size, null);
  if (icon.view === "shape") return draw(filled(svg, SHAPE.x, SHAPE.y, SHAPE.size), SHAPE.size, icon.size, SHAPE_WHITE);
  const side = (2 * (await faceReach(svg))) / MASKABLE_SAFE;
  const corner = SVG_SIZE / 2 - side / 2;
  return draw(filled(svg, corner, corner, side), side, icon.size, SHAPE_WHITE);
}

async function buildAppIcons(): Promise<void> {
  const svg = await readFile(ICON_SVG, "utf8");
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
  return tintGameIcon(d, attribution);
}

function tintGameIcon(d: string, attribution: string): string {
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

/** The local copy already has its background removed by scripts/game-icons.ts. */
async function buildDamageIcons(): Promise<void> {
  const dir = join(ICONS_DIR, "damage");
  await mkdir(dir, { recursive: true });
  for (const [key, icon] of Object.entries(DAMAGE_ICONS)) {
    const source = await readFile(join(PUBLIC, "game-icons", GAME_ICONS_COMMIT.slice(0, 8), `${icon.slug}.svg`), "utf8");
    const d = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512" width="512" height="512"><path d="([^"]+)"\/><\/svg>\s*$/.exec(source)?.[1];
    if (!d) throw new Error(`unexpected local game-icons.net SVG shape: ${icon.slug}`);
    await writeFile(join(dir, `${key}.svg`), tintGameIcon(d, gameIconAttribution(icon)));
    console.log(`damage/${key}.svg  from ${icon.slug}`);
  }
}

if (import.meta.main) {
  const command = process.argv[2] ?? "app";
  if (command === "app") await buildAppIcons();
  else if (command === "effects") await buildEffectIcons();
  else if (command === "damage") await buildDamageIcons();
  else throw new Error(`unknown command ${command}. Use "app", "effects" or "damage".`);
}
