import { DEFAULT_SETTINGS, type BuildChunk, type RoomState, type Scene } from "#shared/model.ts";
import { occupiedRange, type FootprintToken } from "#shared/rules/footprint.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { screenToView, viewToScreen, type Camera, type GroundMap, type Insets, type Point, type Size } from "../lib/camera.ts";
import { footprint, type ViewToken } from "../lib/scene.ts";
import { arrowStep, drawnBase, drawnFootprintGround, drawnHeights, flatHeights, heightsStand, pickWalk, TOP_DOWN, toView, toWorld, type DrawnHeights, type DrawnSource, type PickSource, type View } from "../lib/view.ts";
import { scopeSlot, type RoomScope } from "../state/scope.ts";
import { FogView } from "./relief/fogView.ts";
import { creatureStands } from "./relief/stand.ts";
import { cappedBase } from "./relief/standee.ts";

/**
 * What a press on the board means (docs/design-v1-isometric-view.md 6.1):
 * the view on screen, its camera, the scene's grid and the drawn heights
 * this viewer may see. A press becomes a world point once, through
 * `pickGround`, and every slop and grab radius compares screen distances
 * through the same view, so the rules after it run as in Top-down.
 */
export type BoardPick = PickSource & {
  /** What the drawn heights read, in feet, for a standee's base (view.ts drawnBase). Null on flat ground. */
  src: DrawnSource | null;
  feetPerCell: number;
  /** The canvas's height in px, which caps how far a standee's lift draws (relief/standee.ts cappedBase). */
  canvasHeight: number;
};

/**
 * The board's pick, per Room page (client/state/scope.ts), for the tools
 * and the tap handlers that run outside the canvas's own code. The canvas
 * sets `read` (canvas/Stage.tsx), and it reads the camera a gesture asked
 * for, so a press right after a pan means what is about to show.
 */
export const boardPickSlot = scopeSlot(() => ({ read: null as (() => BoardPick | null) | null }));

/** Top-down's pick, with no heights: what a tool reads before the canvas has measured itself, and in tests. */
export function flatPick(camera: Camera, bounds: { w: number; h: number } = { w: 0, h: 0 }, grid: Grid = sceneGrid({})): BoardPick {
  return { camera, view: TOP_DOWN, grid, heights: flatHeights(bounds), src: null, feetPerCell: 5, canvasHeight: Infinity };
}

/** The board's pick in this Room, or Top-down's at the tool's camera. */
export function boardPickOf(ctx: { scope: RoomScope; camera(): Camera }): BoardPick {
  return ctx.scope.get(boardPickSlot).read?.() ?? flatPick(ctx.camera());
}

/** The world point a press at `screen` means: the first drawn ground its ray meets (view.ts pickGround). */
export function pressAt(pick: BoardPick, screen: Point): Point {
  return pickWalk(pick, screen).point;
}

/** A cell's drawn ground in cells of height, under a world point: 0 in Top-down, off the scene and below the stand threshold. */
export function drawnAt(pick: Pick<BoardPick, "view" | "heights">, p: Point): number {
  if (pick.view.kind === "topDown") return 0;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const { w, h } = pick.heights.bounds;
  return x < 0 || y < 0 || x >= w || y >= h ? 0 : pick.heights.at(x, y);
}

/** The view shown with its drawn ground at a world point, in cells: what a mark standing on the ground reads, such as a pin's tip (pins/rules.ts PinView). */
export function viewGround(pick: Pick<BoardPick, "view" | "heights">): { view: View; ground: (x: number, y: number) => number } {
  return { view: pick.view, ground: (x, y) => drawnAt(pick, { x, y }) };
}

/** Where a world point at height `z` cells shows on screen. */
export function screenAt(pick: Pick<BoardPick, "view" | "camera">, p: Point, z = 0): Point {
  return viewToScreen(pick.camera, toView(pick.view, p, z));
}

/**
 * How far a world point stands from a press, in screen pixels: what every
 * slop and grab radius compares (6.1). In Top-down it is the world distance
 * times the scale, as it always was. In Isometric it is the point at its
 * drawn ground, or at `z` cells, through the view, against the press's own
 * screen point, so a handle on a raised top is reached where it draws.
 */
export function pressGap(pick: Pick<BoardPick, "view" | "camera" | "heights">, press: { world: Point; screen: Point }): (p: Point, z?: number) => number {
  if (pick.view.kind === "topDown") {
    const scale = pick.camera.scale;
    return (p) => Math.hypot(p.x - press.world.x, p.y - press.world.y) * scale;
  }
  return (p, z) => {
    const at = screenAt(pick, p, z ?? drawnAt(pick, p));
    return Math.hypot(at.x - press.screen.x, at.y - press.screen.y);
  };
}

/**
 * Where a token's ring draws, in cells of height: a standee's base as its
 * standee draws it (view.ts drawnBase, its lift capped by
 * relief/standee.ts cappedBase), or for a creature that lies flat under
 * the fog (`stands` false, 5.2) the drawn ground under it, where the ground
 * stage lays its picture. What stands by a ring reads this one: box select,
 * the chrome over a token, a switch's held point and a drag's grab. The
 * rules keep the logical base. 0 in Top-down.
 */
export function tokenBase(pick: Pick<BoardPick, "view" | "src" | "feetPerCell" | "camera" | "canvasHeight">, token: FootprintToken, stands = true): number {
  if (pick.view.kind === "topDown" || !pick.src) return 0;
  const range = occupiedRange(token);
  const ground = drawnFootprintGround(pick.src, range) / pick.feetPerCell;
  if (!stands) return ground;
  return cappedBase(drawnBase(pick.src, range, token.elevation) / pick.feetPerCell, ground, pick.camera.scale, pick.canvasHeight);
}

/** Which tokens stand as standees for this pick's viewer, by the stand rule (relief/stand.ts creatureStands) with one read of the fog for them all. */
export function standsFor(pick: Pick<BoardPick, "src">, aboveFog: (t: ViewToken) => boolean): (t: ViewToken) => boolean {
  const src = pick.src;
  if (!src?.fog) return () => true;
  const fog = new FogView(src.fog, src.sceneId, src.bounds);
  return (t) => creatureStands(fog, t, aboveFog(t));
}

/** The highest drawn ground under a footprint, in cells (view.ts drawnFootprintGround): where a ghost of it stands. 0 in Top-down. */
export function groundUnder(pick: Pick<BoardPick, "view" | "src" | "feetPerCell">, token: Omit<FootprintToken, "elevation">): number {
  if (pick.view.kind === "topDown" || !pick.src) return 0;
  return drawnFootprintGround(pick.src, occupiedRange(token)) / pick.feetPerCell;
}

/** Where a token's ring's center shows on screen: its footprint's middle where its ring draws (`tokenBase`). */
export function ringCenter(pick: Pick<BoardPick, "view" | "camera" | "src" | "feetPerCell" | "canvasHeight">, token: FootprintToken, stands = true): Point {
  const fp = footprint(token);
  return screenAt(pick, { x: token.x + fp.w / 2, y: token.y + fp.h / 2 }, tokenBase(pick, token, stands));
}

/** The highest drawn ground inside a world rectangle, in cells, at least 0: how far a fit raises its box's top (docs/design-v1-isometric-view.md 4.2). */
export function liftIn(heights: DrawnHeights, rect: { x: number; y: number; width: number; height: number }): number {
  if (heights.high <= 0) return 0;
  const { w, h } = heights.bounds;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(w, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(h, Math.ceil(rect.y + rect.height));
  if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return heights.high;
  let top = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) top = Math.max(top, heights.at(x, y));
  return top;
}

/** How a view meets the ground at 0, for the camera's keep in view (lib/camera.ts keepInView): none in Top-down, whose rule reads the scene's box. */
export function groundMapOf(view: View): GroundMap | undefined {
  if (view.kind === "topDown") return undefined;
  return { toGround: (v) => toWorld(view, v), toView: (p) => toView(view, p) };
}

const ARROW_OF: Readonly<Record<string, string>> = { "0,-1": "ArrowUp", "1,0": "ArrowRight", "0,1": "ArrowDown", "-1,0": "ArrowLeft" };

/**
 * An arrow key's square step, which the keys give as Top-down's (state/shortcuts.ts),
 * as the view shows the map (ISO-D11, view.ts arrowStep): in Isometric Up
 * moves toward the map edge facing up and to the right, and so round.
 */
export function nudgeStep(view: View, dx: number, dy: number): readonly [number, number] {
  const key = ARROW_OF[`${dx},${dy}`];
  return (key ? arrowStep(view, key) : null) ?? [dx, dy];
}

/** The press's point in view space, for a test against a box that stands up, such as a label's (builder/labelShape.ts). */
export function pressView(pick: Pick<BoardPick, "camera">, screen: Point) {
  return screenToView(pick.camera, screen);
}

/**
 * The board's pick for a viewer (canvas/Stage.tsx): Top-down's identity, or
 * in Isometric the drawn heights of the ground this viewer may see. A
 * player on a scene with fog is held to their fog, so terrain they have not
 * seen never moves a press.
 */
export function boardPickFor(
  input: {
    room: Pick<RoomState, "buildChunks" | "fogTiles" | "meta"> | null;
    scene: Pick<Scene, "id" | "bounds" | "gridShape">;
    role: "dm" | "player";
    /** Whether the scene draws fog for this viewer. */
    fog: boolean;
    view: View;
    camera: Camera;
    lowPower: boolean;
    /** The canvas's height in px, for the lift's cap: none when absent. */
    canvasHeight?: number;
  },
  memo: DrawnHeightsMemo,
): BoardPick {
  const { scene, room, camera, view } = input;
  const grid = sceneGrid(scene);
  if (view.kind === "topDown") return { ...flatPick(camera, scene.bounds, grid), canvasHeight: input.canvasHeight ?? Infinity };
  const feetPerCell = room?.meta.settings.feetPerCell ?? DEFAULT_SETTINGS.feetPerCell;
  const fog = input.role === "player" && input.fog ? (room?.fogTiles ?? NO_FOG) : null;
  const { src, heights } = memo.get({ chunks: room?.buildChunks ?? NO_CHUNKS, sceneId: scene.id, bounds: scene.bounds, fog, feetPerCell, scale: camera.scale, lowPower: input.lowPower });
  return { camera, view, grid, heights, src, feetPerCell, canvasHeight: input.canvasHeight ?? Infinity };
}

const NO_FOG: RoomState["fogTiles"] = {};
const NO_CHUNKS: RoomState["buildChunks"] = {};

/** What the drawn heights of a board read: the room's build, the scene, and the fog a player is held to. */
export type DrawnInput = {
  chunks: Readonly<Record<string, BuildChunk>>;
  sceneId: string;
  bounds: { w: number; h: number };
  /** A player's fog on a scene with fog on, else null: the DM and a scene without fog see all the ground. */
  fog: RoomState["fogTiles"] | null;
  feetPerCell: number;
  scale: number;
  lowPower: boolean;
};

/**
 * Drawn heights made again only when what they read changes: the store
 * replaces the build and the fog on every change, so the same objects mean
 * the same heights. A pick, a box select and each drag frame read these.
 */
export class DrawnHeightsMemo {
  #last: { input: DrawnInput; stand: boolean; src: DrawnSource; heights: DrawnHeights } | null = null;

  get(input: DrawnInput): { src: DrawnSource; heights: DrawnHeights } {
    const stand = heightsStand(input.scale, input.lowPower);
    const last = this.#last;
    if (
      last &&
      last.stand === stand &&
      last.input.chunks === input.chunks &&
      last.input.fog === input.fog &&
      last.input.sceneId === input.sceneId &&
      last.input.bounds.w === input.bounds.w &&
      last.input.bounds.h === input.bounds.h &&
      last.input.feetPerCell === input.feetPerCell
    ) {
      return last;
    }
    const src: DrawnSource = { chunks: input.chunks, sceneId: input.sceneId, bounds: { w: input.bounds.w, h: input.bounds.h }, fog: input.fog, stand };
    const next = { input, stand, src, heights: drawnHeights(src, input.feetPerCell) };
    this.#last = next;
    return next;
  }
}

/**
 * The world point a turn or a switch keeps still (4.2), with its drawn
 * height in the view before and after: the selected token's ring while it
 * shows in the clear part of the canvas, else where a press at that part's
 * middle meets the drawn ground.
 */
export function heldPoint(was: BoardPick, now: BoardPick, selected: FootprintToken | undefined, viewport: Size, insets: Insets, stands = true): { at: Point; before: number; after: number } {
  const clear = { x0: insets.left, y0: insets.top, x1: viewport.width - insets.right, y1: viewport.height - insets.bottom };
  if (selected) {
    const ring = ringCenter(was, selected, stands);
    if (ring.x >= clear.x0 && ring.x <= clear.x1 && ring.y >= clear.y0 && ring.y <= clear.y1) {
      const fp = footprint(selected);
      return { at: { x: selected.x + fp.w / 2, y: selected.y + fp.h / 2 }, before: tokenBase(was, selected, stands), after: tokenBase(now, selected, stands) };
    }
  }
  const press = pickWalk(was, { x: (clear.x0 + clear.x1) / 2, y: (clear.y0 + clear.y1) / 2 });
  return { at: press.point, before: press.z, after: drawnAt(now, press.point) };
}
