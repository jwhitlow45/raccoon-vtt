import { SIZE_CELLS, type Character, type Member, type RoomState, type Scene, type SceneMap, type Token } from "#shared/model.ts";
import { occupiedHexes, sizeCategory, type PlacedToken } from "#shared/rules/footprint.ts";
import type { Grid } from "#shared/rules/grid.ts";
import { HEX_R, hexAt, hexCenter, hexDistance, hexKey, hexNeighbors, snapAnchor, type Hex, type HexGrid } from "#shared/rules/hex.ts";
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
 * The outline round a creature's hexes on a hex scene, the selected token's
 * outline (docs/design-v1-hex-grids.md 3, "a hex outline when selected"):
 * one closed loop of points in cells, `[x0, y0, x1, y1, ...]`, clockwise on
 * screen, along the sides no two of its hexes share. A footprint's 1, 3, 7
 * or 12 hexes are joined without holes, so its outline is one loop.
 */
export function hexFootprintOutline(g: HexGrid, token: PlacedToken): number[] {
  return hexOutline(g, occupiedHexes(g, token));
}

/**
 * The outer outline of a set of joined hexes without holes, as one closed
 * loop. Corners are worked out from centers for drawing only: no rule
 * reads them.
 */
export function hexOutline(g: HexGrid, hexes: readonly Hex[]): number[] {
  const held = new Set(hexes.map(hexKey));
  return outerLoop(g, hexes, (h) => held.has(hexKey(h)));
}

/**
 * The outline round every hex within `steps` of a set of hexes, as one
 * closed loop: an emanation's on a hex scene (docs/design-v1-hex-grids.md
 * HX-D11). Only the ring of hexes exactly `steps` out is walked, so a
 * 1,000 ft emanation costs the hexes round its edge, not the thousands
 * inside it.
 */
export function hexBallOutline(g: HexGrid, from: readonly Hex[], steps: number): number[] {
  const away = (h: Hex) => from.reduce((d, f) => Math.min(d, hexDistance(g, f, h)), Infinity);
  const ring = new Map<string, Hex>();
  for (const f of from) for (const h of hexRing(g, f, steps)) if (away(h) === steps) ring.set(hexKey(h), h);
  return outerLoop(g, [...ring.values()], (h) => away(h) <= steps);
}

/** The hexes exactly `k` steps from one, round the ring from its north-west corner, clockwise on hex rows. */
export function hexRing(g: HexGrid, center: Hex, k: number): Hex[] {
  if (k <= 0) return [center];
  let h = center;
  for (let i = 0; i < k; i++) h = hexNeighbors(g, h)[4]!;
  const out: Hex[] = [];
  for (let side = 0; side < 6; side++) {
    for (let i = 0; i < k; i++) {
      out.push(h);
      h = hexNeighbors(g, h)[side]!;
    }
  }
  return out;
}

/**
 * The loop along the sides of `edge`'s hexes whose hex across is not
 * `inside`, each run in its hex's own clockwise turning and chained end to
 * start, its straight runs merged.
 */
function outerLoop(g: HexGrid, edge: readonly Hex[], inside: (h: Hex) => boolean): number[] {
  const key = (p: { x: number; y: number }) => `${Math.round(p.x * 4096)},${Math.round(p.y * 4096)}`;
  const next = new Map<string, { x: number; y: number }>();
  let first: { x: number; y: number } | undefined;
  for (const h of edge) {
    const c = hexCenter(g, h);
    const pts = hexPoints(g, h);
    for (let i = 0; i < 6; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % 6]!;
      // The hex across a side has its center mirrored through the side's middle.
      if (inside(hexAt(g, { x: a.x + b.x - c.x, y: a.y + b.y - c.y }))) continue;
      next.set(key(a), b);
      first ??= a;
    }
  }
  const loop: { x: number; y: number }[] = [];
  let at = first;
  for (let guard = 0; at && guard <= next.size; guard++) {
    loop.push(at);
    at = next.get(key(at));
    if (at && key(at) === key(loop[0]!)) break;
  }
  return dropStraight(loop).flatMap((p) => [p.x, p.y]);
}

/** A hex's six points from its center, clockwise on screen for both orientations. */
function hexPoints(g: HexGrid, h: Hex): { x: number; y: number }[] {
  const c = hexCenter(g, h);
  const half = HEX_R / 2;
  const rows = [
    { x: 0, y: -HEX_R },
    { x: 0.5, y: -half },
    { x: 0.5, y: half },
    { x: 0, y: HEX_R },
    { x: -0.5, y: half },
    { x: -0.5, y: -half },
  ];
  // Swapping x and y mirrors the turning, so columns run the rows' points backward to stay clockwise.
  const pts = g.orient === "rows" ? rows : rows.map((p) => ({ x: p.y, y: p.x })).reverse();
  return pts.map((p) => ({ x: c.x + p.x, y: c.y + p.y }));
}

/** The loop without points that lie on a straight run, so a dashed outline's corners fall where the shape turns. */
function dropStraight(loop: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  return loop.filter((p, i) => {
    const a = loop[(i + loop.length - 1) % loop.length]!;
    const b = loop[(i + 1) % loop.length]!;
    return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-9;
  });
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
