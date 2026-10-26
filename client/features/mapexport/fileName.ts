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
 * `crypt-hex-70px.png` (docs/design-v1-hex-grids.md HX-D13): other VTTs
 * read `30x20` as squares, and the upload's size hint passes over it.
 *
 * The DM view adds `-dm`, so the copy that shows secret doors is never
 * mistaken for the one to hand to players.
 */
export function exportFileName(g: Grid, sceneName: string, bounds: { w: number; h: number }, pxPerCell: number, view: "player" | "dm"): string {
  const slug = sceneName
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(\d)x(?=\d)/g, "$1-x-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  const cells = g.shape === "hex" ? "hex" : `${bounds.w}x${bounds.h}`;
  return `${slug || "map"}-${cells}-${pxPerCell}px${view === "dm" ? "-dm" : ""}.png`;
}
