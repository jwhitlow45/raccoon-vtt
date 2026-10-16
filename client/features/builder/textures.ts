import { useEffect, useState } from "react";
import type { TerrainId } from "#shared/model.ts";
import type { TexturedTerrain } from "./geometry.ts";

/**
 * The builder's floor textures: 256 px tiles in public/textures, openly
 * licensed and credited in CREDITS.md. Eight small images in all, so each is
 * decoded once and kept for the page's life.
 */
const cache = new Map<TexturedTerrain, Promise<HTMLImageElement>>();

/** One texture, decoded. The map export awaits these before it draws. */
export function loadTexture(terrain: TexturedTerrain): Promise<HTMLImageElement> {
  let pending = cache.get(terrain);
  if (!pending) {
    const img = new Image();
    img.decoding = "async";
    img.src = `/textures/${terrain}.webp`;
    pending = img.decode().then(() => img);
    // Forget a failure so a later render can try again.
    pending.catch(() => cache.delete(terrain));
    cache.set(terrain, pending);
  }
  return pending;
}

/** Plain colors close to each texture, drawn until it loads or if it never does. */
export const TERRAIN_COLORS: Record<TexturedTerrain, string> = {
  stone: "#6d6c6a",
  wood: "#8a6440",
  grass: "#55753a",
  dirt: "#7a5c40",
  cave: "#5b544c",
  water: "#2f5f80",
  difficult: "#5a6a34",
  rubble: "#76726b",
};

/**
 * A terrain's swatch in the builder's terrain chip and tiles
 * (docs/design-v1-tool-options.md 9.9): the texture's plain color, and for
 * the marks drawn over a floor the mark's own: a pit's dark, a pillar's
 * stone, a stair's slab.
 */
export const TERRAIN_SWATCHES: Record<TerrainId, string> = { ...TERRAIN_COLORS, pit: "#0b0b0e", pillar: "#8f897e", stairs: "#bdb4a6" };

/** One texture tile spans this many cells, so planks and stones read at a sensible size. */
export const TEXTURE_CELLS = 2;

/** The textures for the terrains in use, filled in as they decode. */
export function useTextures(terrains: readonly TexturedTerrain[]): Partial<Record<TexturedTerrain, HTMLImageElement>> {
  const [loaded, setLoaded] = useState<Partial<Record<TexturedTerrain, HTMLImageElement>>>({});
  const wanted = [...terrains].sort().join(",");
  useEffect(() => {
    let cancelled = false;
    for (const terrain of wanted ? (wanted.split(",") as TexturedTerrain[]) : []) {
      loadTexture(terrain).then(
        (img) => {
          if (!cancelled) setLoaded((prev) => (prev[terrain] === img ? prev : { ...prev, [terrain]: img }));
        },
        () => {},
      );
    }
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  return loaded;
}
