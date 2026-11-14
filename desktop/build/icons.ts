/**
 * Draws the desktop app's icons from the app's own icon, public/icon.svg.
 * Run by hand when the icon changes, then commit the files it writes:
 *
 *   node desktop/build/icons.ts
 *
 * - icon.png: 1024 px, the icon as it is, for Windows and Linux.
 *   electron-builder makes the .ico and the Linux sizes from it.
 * - icon-macos.png: the same shape inside Apple's 1024 px icon grid, 824 px
 *   with a margin all round, so it sits the size of other apps' icons in
 *   the Dock. electron-builder makes the .icns from it.
 * - tray.png and tray@2x.png: 16 and 32 px, in color, for the Windows
 *   notification area and Linux's AppIndicator.
 * - trayTemplate.png and trayTemplate@2x.png: the macOS menu bar's black
 *   template, which the system tints for light and dark bars. The icon's
 *   white square is the black, and its orange face is cut out of it.
 *
 * These are conversions of the existing art, nothing drawn anew.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type Sharp } from "sharp";

const ROOT = join(import.meta.dirname, "..", "..");
const ICON_SVG = join(ROOT, "public", "icon.svg");
const OUT = join(import.meta.dirname, "icons");

/** Apple's macOS icon grid: the body of an app icon is 824 of its 1024 px. */
const MAC_BODY = 824;

async function draw(svg: Buffer, size: number): Promise<Sharp> {
  // Density scales from the SVG's 512 viewBox, 72 dpi being 1:1.
  return sharp(svg, { density: (72 * size) / 512 }).resize(size, size);
}

async function png(svg: Buffer, size: number): Promise<Buffer> {
  return (await draw(svg, size)).png({ compressionLevel: 9 }).toBuffer();
}

async function macIcon(svg: Buffer): Promise<Buffer> {
  const margin = (1024 - MAC_BODY) / 2;
  const body = await png(svg, MAC_BODY);
  return sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: margin, top: margin }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * The template keeps each pixel's coverage times its whiteness: the white
 * square stays, the orange and yellow face (no blue in either) drops out,
 * and edges keep their antialiasing.
 */
async function template(svg: Buffer, size: number): Promise<Buffer> {
  const { data, info } = await (await draw(svg, size)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    const a = data[i * 4 + 3]!;
    out[i * 4 + 3] = Math.round((a * Math.min(r, g, b)) / 255);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

if (import.meta.main) {
  const svg = await readFile(ICON_SVG);
  await mkdir(OUT, { recursive: true });
  const files: [string, Buffer][] = [
    ["icon.png", await png(svg, 1024)],
    ["icon-macos.png", await macIcon(svg)],
    ["tray.png", await png(svg, 16)],
    ["tray@2x.png", await png(svg, 32)],
    ["trayTemplate.png", await template(svg, 16)],
    ["trayTemplate@2x.png", await template(svg, 32)],
  ];
  for (const [name, data] of files) {
    await writeFile(join(OUT, name), data);
    console.log(`${name}  ${data.length} bytes`);
  }
}
