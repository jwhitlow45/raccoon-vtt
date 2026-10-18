import type { Scene } from "#shared/model.ts";
import { assetUrl } from "../../lib/api.ts";
import { mapWorldRect } from "../../lib/scene.ts";
import type { AssetSource } from "../../state/view.ts";
import { buildPaths, drawBuild, labelFontReady } from "../builder/draw.ts";
import { drawStamps, loadStampImages, stampUrl } from "../builder/stamps/draw.ts";
import type { TexturedTerrain } from "../builder/geometry.ts";
import { loadTexture } from "../builder/textures.ts";
import type { ExportContent } from "./content.ts";
import type { ExportSize } from "./size.ts";

/**
 * Draws a scene's map on an offscreen canvas and encodes it as a PNG: the
 * background color, the map image, the grid when asked for, then the build
 * through the same drawing as the board layer. Tokens, areas, drawings,
 * pings, fog and selection live on other layers and never get here.
 */

export class ExportError extends Error {}

export type RenderInput = {
  scene: Pick<Scene, "bounds" | "background" | "grid" | "map" | "autoWalls">;
  size: ExportSize;
  content: ExportContent;
  grid: boolean;
  /** The map art, decoded, or null to leave it out. */
  map: HTMLImageElement | null;
  /** How the canvas becomes a file: PNG unless the caller says otherwise, as a scene thumbnail does (scenes/thumbnail.ts). */
  encode?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
  /** Where stamps from the room's library are fetched. Left out, the server's own asset URLs. */
  assets?: AssetSource;
};

const encodePng = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  return img;
}

/** The map art from the preferred copy, then the other one, or null when neither loads. */
export async function loadMapImage(urls: readonly string[]): Promise<HTMLImageElement | null> {
  for (const url of urls) {
    try {
      return await loadImage(url);
    } catch {
      // Try the next copy.
    }
  }
  return null;
}

/** The floor textures the build uses. A texture that fails draws as its plain color, as on the board. */
async function loadTextures(terrains: readonly TexturedTerrain[]): Promise<Partial<Record<TexturedTerrain, HTMLImageElement>>> {
  const out: Partial<Record<TexturedTerrain, HTMLImageElement>> = {};
  await Promise.all(
    terrains.map((t) =>
      loadTexture(t).then(
        (img) => void (out[t] = img),
        () => {},
      ),
    ),
  );
  return out;
}

function drawGrid(g: CanvasRenderingContext2D, scene: RenderInput["scene"], pxPerCell: number): void {
  const { w, h } = scene.bounds;
  const { color, opacity, lineWidth } = scene.grid;
  g.save();
  g.globalAlpha = Number.isFinite(opacity) ? opacity : 0.25;
  g.strokeStyle = color || "#ffffff";
  g.lineWidth = (lineWidth > 0 ? lineWidth : 1) / pxPerCell;
  g.beginPath();
  for (let x = 0; x <= w; x++) {
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  for (let y = 0; y <= h; y++) {
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.stroke();
  g.restore();
}

export async function renderMapPng(input: RenderInput): Promise<Blob> {
  const { scene, size, content, grid, map } = input;
  const paths = buildPaths(content.chunks, content.role, { autoWalls: scene.autoWalls, bounds: scene.bounds });
  const textures = await loadTextures(paths.floors.map(([t]) => t));
  const assets = input.assets ?? { url: assetUrl };
  const stampUrlOf = (art: Parameters<typeof stampUrl>[0]) => stampUrl(art, assets);
  // The drawing cannot wait for a redraw, so every stamp's image is in first. One that fails draws as a dashed box.
  await loadStampImages(content.stamps.map((s) => stampUrlOf(s.art)));
  // And the labels' font, or a page that never drew Inter yet would write them in the fallback.
  if (content.labels.length > 0) await labelFontReady();
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    const g = canvas.getContext("2d");
    if (!g) throw new ExportError("This device could not make a canvas that large.");
    const px = size.pxPerCell;
    g.scale(px, px);
    g.fillStyle = scene.background || "#2b2b31";
    g.fillRect(0, 0, scene.bounds.w, scene.bounds.h);
    const rect = scene.map ? mapWorldRect(scene.map) : null;
    if (map && rect) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(map, rect.x, rect.y, rect.width, rect.height);
    }
    if (grid) drawGrid(g, scene, px);
    drawBuild(g, paths, {
      role: content.role,
      scale: px,
      grid: { ...scene.grid, show: grid },
      textures,
      labels: content.labels,
      underWalls: (stampsG) => drawStamps(stampsG, content.stamps, { urlOf: stampUrlOf, onLoad: () => {} }),
    });
    const blob = await (input.encode ?? encodePng)(canvas);
    if (!blob) throw new ExportError("This device could not encode an image that large.");
    return blob;
  } finally {
    // iOS keeps a canvas's memory until it is resized, and counts it against
    // a small total for the page, so the next export or the map itself
    // could fail if this one were left to the garbage collector.
    canvas.width = 0;
    canvas.height = 0;
  }
}
