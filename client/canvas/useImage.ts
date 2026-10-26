import { useEffect, useState } from "react";

async function loadDecoded(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  // decode() finishes the work off the main thread before the first draw.
  // Without it, the first drawImage of a large map stalls the frame (WebKit
  // bug 241402), and Konva would draw a half-loaded image.
  await img.decode();
  return img;
}

/** What a canvas can draw a map from: a bitmap where the browser makes them, an image element elsewhere. */
export type MapSource = ImageBitmap | HTMLImageElement;

/*
 * A map is decoded into an ImageBitmap, off the main thread, rather than
 * into an <img> that decode() has finished. Chrome decodes such an <img>
 * again, on the main thread, the first time a canvas draws it, and the page
 * froze meanwhile: 470 ms for an 8000 by 6000 map on a laptop, and 490 ms
 * for the 4096 px phone copy at a phone's speed. A bitmap's first draw took
 * 55 to 115 ms in the same runs, and panning never decodes it again, where
 * an <img> the browser had dropped from its image cache stalled a pan frame
 * for the whole decode. A browser without createImageBitmap keeps the <img>.
 */
async function loadMap(src: string, signal: AbortSignal): Promise<MapSource> {
  if (typeof createImageBitmap !== "function") return loadDecoded(src);
  const res = await fetch(src, { signal, credentials: "same-origin" });
  if (!res.ok) throw new Error(`The map image answered ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** The bitmaps freed so far, so a reader still holding one can tell before it draws it. */
const freed = new WeakSet<MapSource>();

/** Frees a bitmap's pixels now, instead of at the next garbage collection. An image element has nothing to free. */
export function release(image: MapSource | null | undefined): void {
  if (!image || !("close" in image)) return;
  freed.add(image);
  image.close();
}

export type MapImageState = { image: MapSource | null; status: "loading" | "ready" | "failed" };

/**
 * The map image, decoded, or null until it is ready. A map is large (up to
 * 256 MiB decoded at 8192 px), so it is never kept in a cache: when the URL
 * changes, the old image is dropped and freed. If the preferred variant
 * fails, `fallbackUrl` is tried once.
 */
export function useMapImage(url: string | null, fallbackUrl: string | null): MapImageState {
  const [loaded, setLoaded] = useState<{ url: string; image: MapSource | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const controller = new AbortController();
    loadMap(url, controller.signal)
      .catch((err: unknown) => {
        if (fallbackUrl && fallbackUrl !== url && !cancelled) return loadMap(fallbackUrl, controller.signal);
        throw err;
      })
      .then(
        (image) => {
          if (cancelled) release(image);
          else setLoaded({ url, image });
        },
        () => {
          // A map that will not load leaves the background and grid, which
          // still work for play. The fog never depends on the image.
          if (!cancelled) setLoaded({ url, image: null });
        },
      );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, fallbackUrl]);
  // The cleanup runs after the commit that stopped drawing this image, so a
  // closed bitmap is never handed to Konva.
  useEffect(() => () => release(loaded?.image), [loaded]);
  if (!loaded || loaded.url !== url) return { image: null, status: "loading" };
  return loaded.image ? { image: loaded.image, status: "ready" } : { image: null, status: "failed" };
}

/**
 * Whether a map image a tree drew can still be read, as the isometric
 * view's side tints read it (relief/looks.ts), given what the loader that
 * made it answers now. A drawImage of a freed bitmap throws. The loader
 * frees an image in the commit after another settles in its place, so a
 * reader lets go in that commit's render, before the free: once the loader
 * answers ready or failed with another image, or none. While it loads,
 * it still holds the last image it made. `loader` is null for an image a
 * reader's own hook loaded.
 */
export function mapReadable(image: MapSource, loader: MapImageState | null): boolean {
  if (freed.has(image)) return false;
  return loader === null || loader.status === "loading" || loader.image === image;
}

/**
 * Token images are small (at most 512 px) and repeat (ten goblins share one
 * image), so they share one decoded element per URL. The cache is bounded,
 * oldest first, and forgets failures so a later render can try again.
 */
const tokenImages = new Map<string, Promise<HTMLImageElement>>();
const TOKEN_IMAGE_CACHE = 300;

function tokenImage(url: string): Promise<HTMLImageElement> {
  let pending = tokenImages.get(url);
  if (!pending) {
    pending = loadDecoded(url);
    pending.catch(() => tokenImages.delete(url));
    tokenImages.set(url, pending);
    if (tokenImages.size > TOKEN_IMAGE_CACHE) {
      const oldest = tokenImages.keys().next().value;
      if (oldest !== undefined) tokenImages.delete(oldest);
    }
  }
  return pending;
}

export function useTokenImage(url: string | null): HTMLImageElement | null {
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    tokenImage(url).then(
      (image) => {
        if (!cancelled) setLoaded({ url, image });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [url]);
  return loaded && loaded.url === url ? loaded.image : null;
}
