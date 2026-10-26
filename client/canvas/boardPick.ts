import { DEFAULT_SETTINGS, type BuildChunk, type RoomState, type Scene } from "#shared/model.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { cameraOfStage, screenToView, viewToScreen, type Camera, type Point } from "../lib/camera.ts";
import { drawnHeights, flatHeights, heightsStand, pickGround, pickWalk, TOP_DOWN, toView, type DrawnHeights, type DrawnSource, type PickSource, type View } from "../lib/view.ts";
import { scopeSlot, type RoomScope } from "../state/scope.ts";

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
  return { camera, view: TOP_DOWN, grid, heights: flatHeights(bounds), src: null, feetPerCell: 5 };
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
  },
  memo: DrawnHeightsMemo,
): BoardPick {
  const { scene, room, camera, view } = input;
  const grid = sceneGrid(scene);
  if (view.kind === "topDown") return flatPick(camera, scene.bounds, grid);
  const feetPerCell = room?.meta.settings.feetPerCell ?? DEFAULT_SETTINGS.feetPerCell;
  const fog = input.role === "player" && input.fog ? (room?.fogTiles ?? NO_FOG) : null;
  const { src, heights } = memo.get({ chunks: room?.buildChunks ?? NO_CHUNKS, sceneId: scene.id, bounds: scene.bounds, fog, feetPerCell, scale: camera.scale, lowPower: input.lowPower });
  return { camera, view, grid, heights, src, feetPerCell };
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
 * The map point a press on the board means, from what the board itself
 * reads (docs/design-v1-isometric-view.md 4.3 and 6.2): in Top-down the
 * point under it, and in Isometric the first ground its ray meets, on the
 * drawn heights this viewer may see, so a press never reads terrain the
 * fog hides. For what answers a press outside the board's own gestures,
 * such as the hold-to-ping.
 */

export type BoardGround = {
  room: Pick<RoomState, "buildChunks" | "fogTiles" | "meta"> | null;
  scene: Pick<Scene, "id" | "bounds" | "gridShape">;
  role: "dm" | "player";
  /** Whether the scene draws fog (features/layers.ts LayerProps). */
  fog: boolean;
  lowPower: boolean;
};

/** The drawn heights' source as the isometric board reads it (relief/IsoBoard.tsx): a player's own fog on a scene with fog, else all the ground. */
export function drawnSourceOf(input: BoardGround, scale: number): DrawnSource {
  const { room, scene } = input;
  return {
    chunks: room?.buildChunks ?? {},
    sceneId: scene.id,
    bounds: scene.bounds,
    fog: input.role === "player" && input.fog ? (room?.fogTiles ?? {}) : null,
    stand: heightsStand(scale, input.lowPower),
  };
}

export function pickAt(camera: Camera, view: View, input: BoardGround, screen: Point): Point {
  // Top-down reads no heights, so it builds none.
  if (view.kind === "topDown") return pickGround({ camera, view, grid: sceneGrid(input.scene), heights: flatHeights(input.scene.bounds) }, screen);
  const feet = input.room?.meta.settings.feetPerCell ?? DEFAULT_SETTINGS.feetPerCell;
  return pickGround({ camera, view, grid: sceneGrid(input.scene), heights: drawnHeights(drawnSourceOf(input, camera.scale), feet) }, screen);
}

/** `pickAt` with the camera of the stage pressed. */
export function pickOnBoard(stage: { x(): number; y(): number; scaleX(): number }, view: View, input: BoardGround, screen: Point): Point {
  return pickAt(cameraOfStage(stage), view, input, screen);
}
