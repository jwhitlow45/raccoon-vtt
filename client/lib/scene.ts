import { SIZE_CELLS, type Character, type Member, type RoomState, type Scene, type SceneMap, type Token } from "#shared/model.ts";
import { sizeCategory } from "#shared/rules/footprint.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { snapAnchor } from "#shared/rules/hex.ts";
import type { Rect } from "./camera.ts";

/**
 * Scene geometry and the fail-closed gate for drawing a scene. Local helpers
 * until shared/rules (footprints) lands. They follow design sections 5, 9.1
 * and 13.3.
 */

export const MAX_SCENE_CELLS = 200;

/** Footprint in cells. `custom` uses the token's own w and h, bounded to 0.5 to 20. */
export function footprint(token: Pick<Token, "size" | "w" | "h">): { w: number; h: number } {
  if (token.size === "custom") {
    const clamp = (v: number | undefined) => Math.min(20, Math.max(0.5, Number.isFinite(v) ? v! : 1));
    return { w: clamp(token.w), h: clamp(token.h) };
  }
  const side = SIZE_CELLS[token.size] ?? 1;
  return { w: side, h: side };
}

/**
 * Snaps a token's top-left corner: half cells for footprints under one cell
 * (Tiny), whole cells otherwise. A whole-cell corner puts odd-size tokens on
 * square centers and even-size tokens on grid intersections, as the feature
 * list asks, with no special case.
 *
 * On hexes (docs/design-v1-hex-grids.md 4.2) the box's middle goes to the
 * nearest anchor of its size, a hex's center or for Large and Gargantuan
 * the corner their top three hexes share, ties as the rules break them.
 * The size is read from the box alone, as the rules read a custom size by
 * its longer side: Small and Medium share a box and one hex, so nothing is
 * lost. The answer is the rules' own spot (footprint.ts placedOnHex), so a
 * drop the board sends is one the server reads on the same hexes.
 */
export function snapPosition(g: Grid, x: number, y: number, size: { w: number; h: number }): { x: number; y: number } {
  if (g.shape === "hex") {
    const a = snapAnchor(g, sizeCategory({ size: "custom", w: size.w, h: size.h }), { x: x + size.w / 2, y: y + size.h / 2 });
    return { x: a.x - size.w / 2 + 0, y: a.y - size.h / 2 + 0 };
  }
  const step = Math.min(size.w, size.h) < 1 ? 0.5 : 1;
  return { x: Math.round(x / step) * step, y: Math.round(y / step) * step };
}

/**
 * Where the map image goes, in world cells (design section 5). Every
 * variant, the phone one included, is stretched to this rectangle, so all
 * devices agree with the grid printed on the art. Null when the calibration
 * cannot be drawn.
 */
export function mapWorldRect(map: SceneMap): Rect | null {
  const { widthPx, heightPx, cellPx, originPx } = map;
  const finite = [widthPx, heightPx, cellPx, originPx?.x, originPx?.y].every((v) => Number.isFinite(v));
  if (!finite || cellPx <= 0 || widthPx <= 0 || heightPx <= 0) return null;
  return { x: -originPx.x / cellPx, y: -originPx.y / cellPx, width: widthPx / cellPx, height: heightPx / cellPx };
}

export function validBounds(bounds: unknown): bounds is { w: number; h: number } {
  if (!bounds || typeof bounds !== "object") return false;
  const { w, h } = bounds as { w: unknown; h: unknown };
  const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SCENE_CELLS;
  return ok(w) && ok(h);
}

/**
 * What the canvas may draw (design section 13.3). It fails closed:
 *
 * - `wait`: no snapshot has been applied (or the scene is unreadable), so
 *   nothing from any scene is drawn: no map, no build, no tokens.
 * - `blackout`: a player during a blackout sees black before anything else.
 * - `noScene`: the snapshot is in, but there is no scene to show yet.
 * - `ready`: draw it. `fog` is true unless the scene says `fogEnabled: false`
 *   in so many words, so a missing or malformed field means fog.
 */
export type SceneGate =
  | { kind: "wait" }
  | { kind: "blackout" }
  | { kind: "noScene" }
  | { kind: "ready"; scene: Scene; fog: boolean };

export function sceneGate(input: { view: RoomState | null; sceneId: string | null; role: "dm" | "player" }): SceneGate {
  const { view, sceneId, role } = input;
  if (!view) return { kind: "wait" };
  if (role === "player" && view.meta?.view?.blackout === true) return { kind: "blackout" };
  if (!sceneId) return { kind: "noScene" };
  const scene = view.scenes?.[sceneId];
  if (!scene) return { kind: "noScene" };
  if (!validBounds(scene.bounds)) return { kind: "wait" };
  return { kind: "ready", scene, fog: scene.fogEnabled !== false };
}

/**
 * The scene a selection belongs to after the gate changes, and whether
 * the change lets go of the selection: a new scene does, and so does
 * losing the scene, since the tokens selected stand on the one before. A
 * player's blackout does neither (LPD-PLAYER-7). It is a pause with the
 * same scene behind it, and letting go there took each player's selection,
 * and the token bar with it, whenever the DM paused the game.
 */
export function selectionScene(before: string | null, gate: SceneGate): { scene: string | null; letGo: boolean } {
  if (gate.kind === "blackout") return { scene: before, letGo: false };
  const scene = gate.kind === "ready" ? gate.scene.id : null;
  return { scene, letGo: scene !== before };
}

/**
 * A token as the client's view holds it. Player projections add `aboveFog`
 * (design section 7.3): true when a player owns the token or the DM exempted
 * it from the fog, the tokens drawn above the fog so the party always sees
 * itself. A creature revealed on its turn is not among them (design 13.4).
 */
export type ViewToken = Token & { aboveFog?: boolean };

export function drawsAboveFog(
  token: ViewToken,
  role: "dm" | "player",
  members: Record<string, Member | undefined>,
  characters?: Readonly<Record<string, Pick<Character, "ownerIds"> | undefined>>,
): boolean {
  if (typeof token.aboveFog === "boolean") return token.aboveFog;
  // A DM's view carries the raw fields instead, so apply the same rule,
  // party membership included (docs/design-v1-maps-vision.md 4.3.2).
  // A player's token without the derived field stays below the fog.
  if (role !== "dm") return false;
  if (token.fogExempt || token.partyVision === true) return true;
  const byPlayer = (ids: readonly string[] | undefined) => (ids ?? []).some((id) => members[id]?.kind === "player");
  // A player character's token is usually owned through its character, which
  // players' projections count too (shared/project.ts playerOwned).
  const character = token.actor && "ref" in token.actor ? characters?.[token.actor.ref] : undefined;
  return byPlayer(token.ownerIds) || byPlayer(character?.ownerIds);
}

/** "Goblin 3" for numbered duplicates. Players' projections already carry the public name. */
export function displayName(token: Pick<Token, "name" | "number">): string {
  return token.number === undefined ? token.name : `${token.name} ${token.number}`;
}
