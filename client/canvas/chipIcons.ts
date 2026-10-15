import { useEffect, useState } from "react";
import { CONDITION_KEYS, STATUS_KEYS } from "#shared/model.ts";

/**
 * Condition and status icons for token chips (features section 7, credits
 * in CREDITS.md). The SVGs in public/icons are filled with `currentColor`
 * so the app can tint them, but an SVG drawn as an image has no CSS color
 * to inherit, so the color is written into the file's text before it loads.
 *
 * Each tinted icon is decoded once and shared by every chip that shows it.
 * Until it is ready, and if it fails, the chip shows its letter glyph.
 */

const CONDITIONS = new Set<string>(CONDITION_KEYS);
const STATUSES = new Set<string>(STATUS_KEYS);

/** Raster size the SVG is decoded at: chips are 18 CSS pixels, at up to 2x pixel ratio, with room to spare. */
const ICON_PX = 64;

export function chipIconUrl(key: string): string | null {
  if (CONDITIONS.has(key)) return `/icons/conditions/${key}.svg`;
  if (STATUSES.has(key)) return `/icons/statuses/${key}.svg`;
  return null;
}

/**
 * The SVG text with every `currentColor` replaced by a concrete color, and
 * an explicit size on the root element, since an SVG with only a viewBox
 * has no intrinsic size and some browsers then decode it at 0 x 0.
 */
export function tintSvg(svg: string, color: string): string {
  let out = svg.replace(/currentColor/g, color);
  if (!/<svg[^>]*\swidth=/.test(out)) out = out.replace(/<svg\b/, `<svg width="${ICON_PX}" height="${ICON_PX}"`);
  return out;
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const loading = new Map<string, Promise<HTMLImageElement | null>>();
const ready = new Map<string, HTMLImageElement>();
const sources = new Map<string, Promise<string | null>>();

function source(url: string): Promise<string | null> {
  let pending = sources.get(url);
  if (!pending) {
    pending = fetch(url, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.text() : null))
      .catch(() => null);
    sources.set(url, pending);
  }
  return pending;
}

function load(key: string, color: string): Promise<HTMLImageElement | null> {
  const id = `${key}|${color}`;
  let pending = loading.get(id);
  if (pending) return pending;
  const url = chipIconUrl(key);
  pending = (async () => {
    if (!url) return null;
    const svg = await source(url);
    if (!svg) return null;
    const img = new Image(ICON_PX, ICON_PX);
    img.src = svgDataUrl(tintSvg(svg, color));
    try {
      await img.decode();
    } catch {
      return null;
    }
    ready.set(id, img);
    return img;
  })();
  loading.set(id, pending);
  return pending;
}

/** The tinted icon for an effect key, or null while it loads, when it fails, or for keys with no icon. */
export function useChipIcon(key: string, color: string): HTMLImageElement | null {
  const id = `${key}|${color}`;
  const [image, setImage] = useState<{ id: string; img: HTMLImageElement } | null>(() => {
    const img = ready.get(id);
    return img ? { id, img } : null;
  });
  useEffect(() => {
    if (ready.has(id) || !chipIconUrl(key)) return;
    let cancelled = false;
    void load(key, color).then((img) => {
      if (!cancelled && img) setImage({ id, img });
    });
    return () => {
      cancelled = true;
    };
  }, [id, key, color]);
  if (image?.id === id) return image.img;
  return ready.get(id) ?? null;
}
