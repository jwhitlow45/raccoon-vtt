import { useEffect, useRef } from "react";
import type { MapPhase } from "#shared/model.ts";
import type { AssetVariant } from "../../lib/api.ts";

/**
 * A DM device fetches every other phase's image when it opens a scene
 * (docs/design-v1-maps-vision.md section 3.4), so the DM's own switches
 * need only a decode. The bytes go to the browser's HTTP cache, where map
 * variants live for a year (server/assets/serve.ts), and nothing decoded is
 * held: a decoded map can take 256 MiB. Players never preload, since their
 * projection names no other phase, which is the point.
 *
 * It fetches the variant this device draws, with the full one as the
 * fallback the map layer also uses, one image at a time and only after the
 * map on screen has drawn, so it never slows the map the DM is looking at.
 */

export type PreloadTarget = { url: string; fallback: string | null };

/** Every phase image but the one showing, once each, in the list's order. */
export function phasePreloads(
  phases: readonly MapPhase[] | undefined,
  activeAssetId: string,
  variant: AssetVariant,
  urlOf: (assetId: string, variant: AssetVariant) => string,
): PreloadTarget[] {
  const seen = new Set([activeAssetId]);
  const out: PreloadTarget[] = [];
  for (const phase of phases ?? []) {
    if (seen.has(phase.assetId)) continue;
    seen.add(phase.assetId);
    out.push({ url: urlOf(phase.assetId, variant), fallback: variant === "full" ? null : urlOf(phase.assetId, "full") });
  }
  return out;
}

/** True once the image is in the cache. */
async function warm(target: PreloadTarget, signal: AbortSignal): Promise<boolean> {
  for (const url of target.fallback ? [target.url, target.fallback] : [target.url]) {
    try {
      const res = await fetch(url, { signal, credentials: "same-origin" });
      // Reading the body to its end is what leaves the whole file in the cache.
      if (res.ok) {
        await res.blob();
        return true;
      }
    } catch {
      if (signal.aborted) return false;
    }
  }
  return false;
}

/** Starts the preloads while `enabled`, and stops them when the targets change or the scene goes. */
export function usePhasePreload(targets: readonly PreloadTarget[], enabled: boolean): void {
  // Renaming or reordering phases makes a new list of the same images, which must not start over.
  const key = targets.map((t) => t.url).join("\n");
  // Adding a phase changes the list, and the images already fetched need no second read from the cache.
  const warmed = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || key === "") return;
    const controller = new AbortController();
    const list = targets.filter((t) => !warmed.current.has(t.url));
    void (async () => {
      for (const target of list) {
        if (controller.signal.aborted) return;
        // A phase that will not preload simply loads when the DM switches to it.
        if (await warm(target, controller.signal)) warmed.current.add(target.url);
      }
    })();
    return () => controller.abort();
    // `targets` is read through `key`, which names every url it holds.
  }, [key, enabled]);
}
