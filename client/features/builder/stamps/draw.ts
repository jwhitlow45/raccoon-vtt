import type { Stamp, StampArt } from "#shared/model.ts";
import type { AssetSource } from "../../../state/view.ts";
import { shippedStamp, sizeBucket } from "./rules.ts";

/**
 * Draws a scene's stamps onto the board (docs/design-v1-maps-vision.md
 * section 3.5), for the DM and players alike, below walls, doors, labels
 * and tokens: the build calls `drawStamps` between its floor and its walls.
 *
 * Each distinct art, tint and size bucket is drawn once into a small
 * offscreen canvas and reused, so 500 stamps cost 500 image draws on a
 * redraw, and tinting, which needs two composite passes, runs once per
 * copy rather than once per frame. The images and their copies are kept
 * for the page's life: the shipped set is about 300 KB in all, and copies
 * past COPY_LIMIT are dropped oldest first.
 */

/**
 * The floor behind a stamp's tile in the picker: a dark stone brown, so
 * art made to lie on a floor reads as it will on the map, and its
 * transparent edges do not vanish into the dialog.
 */
export const STAMP_TILE_FLOOR = "#4d463f";

/** Where an art's image is, or null for a key this client does not ship, which draws as a dashed box. */
export function stampUrl(art: StampArt, assets: AssetSource): string | null {
  if ("key" in art) return shippedStamp(art.key) ? `/stamps/${art.key}.webp` : null;
  return assets.url(art.assetId, "full");
}

type Loaded = { status: "loading" } | { status: "ready"; img: HTMLImageElement } | { status: "failed" };

const images = new Map<string, Loaded>();
/** Callbacks waiting on an image, so each board that drew it while it loaded draws again once it is in. */
const waiting = new Map<string, Set<() => void>>();

function image(url: string, onLoad: () => void): Loaded {
  const known = images.get(url);
  if (known && known.status !== "loading") return known;
  let callbacks = waiting.get(url);
  if (!callbacks) waiting.set(url, (callbacks = new Set()));
  callbacks.add(onLoad);
  if (known) return known;
  const loading: Loaded = { status: "loading" };
  images.set(url, loading);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  img.decode().then(
    () => settle(url, { status: "ready", img }),
    () => settle(url, { status: "failed" }),
  );
  return loading;
}

function settle(url: string, result: Loaded): void {
  images.set(url, result);
  const callbacks = waiting.get(url);
  waiting.delete(url);
  for (const callback of callbacks ?? []) callback();
}

const COPY_LIMIT = 300;
const copies = new Map<string, HTMLCanvasElement>();

/** The art at `bucket` pixels on its long side, with its tint multiplied in, drawn once and kept. */
function copyOf(url: string, img: HTMLImageElement, tint: string | undefined, bucket: number): HTMLCanvasElement | HTMLImageElement {
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  if (!tint && bucket >= long) return img;
  const key = `${url}|${tint ?? ""}|${bucket}`;
  const cached = copies.get(key);
  if (cached) {
    // Most recently used goes last, so the oldest go first when the cache is full.
    copies.delete(key);
    copies.set(key, cached);
    return cached;
  }
  const k = bucket / long;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = canvas.getContext("2d");
  if (!g) return img;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (tint) {
    // Multiply the color in, then keep only the art's own pixels, so the tint never fills its transparent margin.
    g.globalCompositeOperation = "multiply";
    g.fillStyle = tint;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  copies.set(key, canvas);
  if (copies.size > COPY_LIMIT) {
    const oldest = copies.keys().next().value;
    if (oldest !== undefined) copies.delete(oldest);
  }
  return canvas;
}

/** Loads every image these stamps draw, for a drawing that cannot wait for a redraw: the map export. */
export async function loadStampImages(urls: readonly (string | null)[]): Promise<void> {
  await Promise.all(
    urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          if (url === null || image(url, resolve).status !== "loading") resolve();
        }),
    ),
  );
}

export type StampDrawOptions = {
  urlOf(art: StampArt): string | null;
  /** Called once an image that was still loading is in, so the board draws again. */
  onLoad(): void;
  /**
   * Draws DM-only stamps at half opacity inside a dashed outline, as the
   * DM's board shows every DM-only thing (a hidden token at half opacity),
   * so a hidden chest does not look like one players see. The board turns
   * it on for a DM. The map export and thumbnails leave it off: they show
   * the scene as it is.
   */
  dimHidden?: boolean;
};

/** A stamp whose art cannot be drawn: a dashed box the size of its footprint. */
function dashedBox(g: CanvasRenderingContext2D, w: number, h: number, pxPerCell: number): void {
  g.lineWidth = 2 / pxPerCell;
  g.setLineDash([8 / pxPerCell, 6 / pxPerCell]);
  g.strokeStyle = "rgba(241, 239, 233, 0.75)";
  g.strokeRect(-w / 2, -h / 2, w, h);
  g.setLineDash([]);
}

/**
 * Draws stamps, bottom first, onto `g`, whose transform maps world cells to
 * device pixels. A stamp whose image is still loading is left out until it
 * is in, and one whose image failed draws as a dashed box.
 */
export function drawStamps(g: CanvasRenderingContext2D, stamps: readonly Stamp[], opts: StampDrawOptions): void {
  const t = g.getTransform();
  const pxPerCell = Math.hypot(t.a, t.b) || 1;
  const alpha = g.globalAlpha;
  g.save();
  for (const stamp of stamps) {
    const dim = opts.dimHidden === true && stamp.visibility === "dm";
    g.save();
    g.translate(stamp.x, stamp.y);
    g.rotate((stamp.rotation * Math.PI) / 180);
    if (stamp.flip) g.scale(-1, 1);
    if (dim) g.globalAlpha = alpha * 0.5;
    const url = opts.urlOf(stamp.art);
    const loaded = url ? image(url, opts.onLoad) : ({ status: "failed" } as const);
    if (loaded.status === "ready") {
      const long = Math.max(loaded.img.naturalWidth, loaded.img.naturalHeight);
      const art = copyOf(url ?? "", loaded.img, stamp.tint, sizeBucket(Math.max(stamp.w, stamp.h) * pxPerCell, long));
      g.drawImage(art, -stamp.w / 2, -stamp.h / 2, stamp.w, stamp.h);
    }
    // A failed image draws as the dashed box already, so it gets no second outline.
    if (loaded.status === "failed" || dim) {
      g.globalAlpha = alpha;
      dashedBox(g, stamp.w, stamp.h, pxPerCell);
    }
    g.restore();
  }
  g.restore();
}
