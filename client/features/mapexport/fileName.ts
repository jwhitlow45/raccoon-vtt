import type { Grid } from "#shared/rules/grid.ts";

/**
 * The exported image's file name, such as `crypt-30x20-70px.png`.
 *
 * The `30x20` is the scene's size in squares. This app's map upload reads
 * that from a file name to set the map's scale (server/assets/kinds.ts,
 * Owlbear's trick), and other VTTs read it too, so the image comes back in
 * lined up with no grid alignment. The upload takes the first `NxM` in the
 * name, so one inside the scene's own name is broken up to keep it from
 * winning.
 *
 * A hex scene's name says `hex` where a square one's has its size, as in
 * `crypt-hex-70px.png` (docs/design/design-v1-hex-grids.md HX-D13): other VTTs
 * read `30x20` as squares, and the upload's size hint passes over it.
 *
 * A floor of a scene with floors adds its name after the scene's, as in
 * `tower-upper-floor-30x20-70px.png`.
 *
 * The DM view adds `-dm`, so the copy that shows secret doors is never
 * mistaken for the one to hand to players.
 */
export function exportFileName(g: Grid, sceneName: string, bounds: { w: number; h: number }, pxPerCell: number, view: "player" | "dm", floorName?: string): string {
  const slug = slugOf(sceneName);
  // A floor's image says which floor it is, after the scene's name (docs/design/design-v1-floors.md 7.8).
  const floor = floorName === undefined ? "" : slugOf(floorName);
  const cells = g.shape === "hex" ? "hex" : `${bounds.w}x${bounds.h}`;
  return `${slug || "map"}${floor ? `-${floor}` : ""}-${cells}-${pxPerCell}px${view === "dm" ? "-dm" : ""}.png`;
}

/**
 * Export every floor's file (docs/design/design-v1-floors.md phase 4, 9.3),
 * such as `tower-30x20-70px.zip`: the scene's name, its size where every
 * floor in the file shares one, and the scale, as one floor's image is
 * named. The pictures inside are named by `floorEntryName`.
 */
export function everyFloorFileName(g: Grid, sceneName: string, bounds: { w: number; h: number } | null, pxPerCell: number, view: "player" | "dm"): string {
  // Floors made from files keep each file's size, and a size that holds for one floor only would set the wrong scale on the others.
  const cells = g.shape === "hex" ? "hex-" : bounds ? `${bounds.w}x${bounds.h}-` : "";
  return `${slugOf(sceneName) || "map"}-${cells}${pxPerCell}px${view === "dm" ? "-dm" : ""}.zip`;
}

/**
 * A floor's picture in Export every floor's zip, such as
 * `01-ground-floor.png`: its number among the floors in the file, lowest
 * first, then its name's slug, or `floor` where nothing of the name is left
 * (D-261119-095, D-261119-116). The number alone keeps names apart, where
 * "Café" and "Cafe", or two names in another script, share a slug. It
 * counts only the floors in the file, so a player view's file shows no gap
 * where a floor players have not reached sits, as their own floors are
 * numbered.
 */
export function floorEntryName(ordinal: number, floorName: string): string {
  return `${String(ordinal).padStart(2, "0")}-${slugOf(floorName) || "floor"}.png`;
}

function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(\d)x(?=\d)/g, "$1-x-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}
