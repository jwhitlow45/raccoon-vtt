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

/*
 * A Universal VTT file's name (docs/design/design-v1-uvtt-export.md section 7,
 * D-261127-253, 293): the scene's and the floor's names as written, so a
 * name in any script or case comes back as it left. Only what a path
 * forbids becomes `_`. No size, since the file states its grid. A name
 * stays under 200 UTF-8 bytes, extension included, well inside the 255 a
 * file system allows.
 */

export const VTT_EXTENSION = ".dd2vtt";
/** The most bytes a whole name takes: under 200. */
export const MAX_NAME_BYTES = 199;

const FORBIDDEN = /[/\\:*?"<>|\p{Cc}]/gu;
const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** A name with what a path forbids as `_`, trimmed, or the fallback where nothing is left. */
function asWritten(name: string, fallback: string): string {
  return name.replace(FORBIDDEN, "_").trim() || fallback;
}

/** The longest start of `text` within `bytes`, cut between code points, and never shorter than one of them. */
function cutTo(text: string, bytes: number): string {
  let out = "";
  for (const ch of text) {
    if (out !== "" && byteLength(out + ch) > bytes) break;
    out += ch;
  }
  return out.trimEnd();
}

/**
 * The scene and floor parts that fit `MAX_NAME_BYTES` around the fixed
 * bytes each name adds: the scene part cut first, then the floor part.
 */
function fitParts(scene: string, floor: string, fixed: number): [string, string] {
  const sceneRoom = MAX_NAME_BYTES - fixed - byteLength(floor);
  const s = byteLength(scene) <= sceneRoom ? scene : cutTo(scene, Math.max(1, sceneRoom));
  const f = byteLength(floor) <= MAX_NAME_BYTES - fixed - byteLength(s) ? floor : cutTo(floor, Math.max(1, MAX_NAME_BYTES - fixed - byteLength(s)));
  return [s, f];
}

/** One floor's file: `Crypt of Doom.dd2vtt`, `Crypt of Doom (DM).dd2vtt`, `Tower - Upper floor.dd2vtt`. */
export function vttFileName(sceneName: string, view: "player" | "dm", floorName?: string): string {
  const dm = view === "dm" ? " (DM)" : "";
  const scene = asWritten(sceneName, "Map");
  if (floorName === undefined) {
    const [s] = fitParts(scene, "", byteLength(dm + VTT_EXTENSION));
    return `${s}${dm}${VTT_EXTENSION}`;
  }
  const [s, f] = fitParts(scene, asWritten(floorName, "Floor"), byteLength(` - ${dm}${VTT_EXTENSION}`));
  return `${s} - ${f}${dm}${VTT_EXTENSION}`;
}

/**
 * Every floor's zip, `Tower.zip` or `Tower (DM).zip`, and its entries,
 * `Tower - 01 - Ground floor.dd2vtt` and on, lowest first. The scene part
 * is cut once, for the longest entry, so every entry carries the same one,
 * which the several-file import reads back as the scene's name
 * (uvtt/floorsImport.ts).
 */
export function vttZipNames(sceneName: string, view: "player" | "dm", floorNames: readonly string[]): { zip: string; entries: string[] } {
  const scene = asWritten(sceneName, "Map");
  const floors = floorNames.map((f) => asWritten(f, "Floor"));
  const fixed = byteLength(` - 00 - ${VTT_EXTENSION}`);
  let s = scene;
  for (const f of floors) s = fitParts(s, f, fixed)[0];
  const entries = floors.map((f, i) => {
    const [, floor] = fitParts(s, f, fixed);
    return `${s} - ${String(i + 1).padStart(2, "0")} - ${floor}${VTT_EXTENSION}`;
  });
  const dm = view === "dm" ? " (DM)" : "";
  const [zipScene] = fitParts(s, "", byteLength(`${dm}.zip`));
  return { zip: `${zipScene}${dm}.zip`, entries };
}
