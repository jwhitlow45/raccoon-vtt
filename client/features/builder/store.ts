import { createStore, type StoreApi } from "zustand/vanilla";
import type { TerrainId } from "#shared/model.ts";
import type { IconName } from "../../components/Icon.tsx";
import { scopeSlot, useScoped, type RoomScope } from "../../state/scope.ts";
import type { BrushSize, Point } from "./cells.ts";

/**
 * The map builder's choices and its gesture in progress. Local to this
 * device: the build itself only changes through ops, and the canvas draws
 * the unsent part of a gesture from here so it shows under the finger
 * before its op goes out.
 */
export type BuildMode = "paint" | "rect" | "poly" | "erase" | "eraseRect" | "edge" | "label" | "light" | "stamp" | "height" | "rough";
export type EdgeKind = "wall" | "none" | "door" | "secret" | "window" | "clear";

export type BuilderState = {
  mode: BuildMode;
  terrain: TerrainId;
  brush: BrushSize;
  edge: EdgeKind;
  /** Whether a secret door tap marks it found (players see a door) or hidden (players see a wall). */
  secretFound: boolean;
  labelText: string;
  /** Label size in cells. */
  labelSize: number;

  /** Cells a brush stroke has touched and not yet sent, drawn as a preview. */
  unsent: readonly string[];
  /** The rectangle being dragged, in world cells: a room, or an area to erase. */
  rect: { a: Point; b: Point } | null;
  /** Corners tapped so far for a polygon room, on grid intersections. */
  poly: readonly Point[];
  /** The wall run being dragged, as edge keys. */
  run: readonly string[];
  /** The label being dragged, and where to, in world cells. */
  labelMove: { id: string; x: number; y: number } | null;
  /** A short note for the option bar, such as why a tap did nothing. */
  note: string | null;
  /** The party's sight met a cell of the gesture since the last press, so the option bar says they see it as it is built (inSight.ts). */
  inSight: boolean;
};

export const TERRAINS: readonly { value: TerrainId; label: string }[] = [
  { value: "stone", label: "Stone" },
  { value: "wood", label: "Wood" },
  { value: "grass", label: "Grass" },
  { value: "dirt", label: "Dirt" },
  { value: "cave", label: "Cave" },
  { value: "water", label: "Water" },
  { value: "difficult", label: "Difficult" },
  { value: "rubble", label: "Rubble" },
  { value: "pit", label: "Pit" },
  { value: "pillar", label: "Pillar" },
  { value: "stairs", label: "Stairs" },
];

/**
 * Each mode's whole name, which its tile shows, the short word the chip
 * shows (docs/design-v1-tool-options.md 6.2), and its icon, on its tile and
 * as the chip's glyph (D-261026-3), in the row's order, which the tool's
 * key steps through too. `spoken` is the name a screen reader says where
 * the shown one has a slash, which it would read as "slash": its tile's
 * name, the chip's name and what the key's press says (FU32-SR-NAMES).
 */
export const BUILD_MODES: readonly { value: BuildMode; label: string; spoken?: string; short: string; icon: IconName }[] = [
  { value: "paint", label: "Brush", short: "Brush", icon: "paint" },
  { value: "rect", label: "Rectangle room", short: "Rect room", icon: "shapeBox" },
  { value: "poly", label: "Shape room", short: "Shape room", icon: "shapePolygon" },
  { value: "erase", label: "Erase", short: "Erase", icon: "eraser" },
  { value: "eraseRect", label: "Erase area", short: "Erase area", icon: "eraseArea" },
  { value: "edge", label: "Walls/doors", spoken: "Walls and doors", short: "Walls", icon: "walls" },
  { value: "height", label: "Heights/stairs", spoken: "Heights and stairs", short: "Heights", icon: "heights" },
  { value: "rough", label: "Difficult ground", short: "Difficult", icon: "difficultGround" },
  { value: "label", label: "Label", short: "Label", icon: "mapLabel" },
  { value: "light", label: "Lights", short: "Lights", icon: "light" },
  { value: "stamp", label: "Stamp", short: "Stamp", icon: "stamp" },
];

/** A new mode, which drops a shape room's corners, a rectangle's start, a wall run and the note. A selected stamp stays selected. */
export function pickBuildMode(scope: RoomScope, mode: BuildMode): void {
  scope.get(builderSlot).store.setState({ mode, poly: [], rect: null, run: [], note: null });
}

/** A gesture's bookkeeping that the canvas never draws. */
export type BuilderGesture = {
  /** `group` is the stroke's undo group: its flushes undo as one step. */
  stroke: {
    sceneId: string;
    seen: Set<string>;
    last: Point;
    group: string;
    timer: ReturnType<typeof setInterval>;
    /** Whether a finger draws it, and when it began (cells.ts strokeMaySend). */
    touch: boolean;
    startedAt: number;
  } | null;
  downAt: { screen: Point; world: Point } | null;
  /** The label a press landed on, and where on it, so a drag moves it without a jump. */
  labelGrab: { id: string; dx: number; dy: number } | null;
};

/** One Room page's builder (client/state/scope.ts): its choices and gesture. */
export const builderSlot = scopeSlot(
  () => ({
    store: createStore<BuilderState>(() => ({
      mode: "paint",
      terrain: "stone",
      brush: 1,
      edge: "wall",
      secretFound: false,
      labelText: "",
      labelSize: 0.7,
      unsent: [],
      rect: null,
      poly: [],
      run: [],
      labelMove: null,
      note: null,
      inSight: false,
    })),
    gesture: { stroke: null, downAt: null, labelGrab: null } as BuilderGesture,
  }),
  (b) => {
    if (b.gesture.stroke) clearInterval(b.gesture.stroke.timer);
    b.gesture.stroke = null;
  },
);

/**
 * The label whose edit pane is open (LabelPane.tsx), if any. A slot of its
 * own rather than part of the builder's state, since the Select tool opens
 * the pane too.
 */
export const labelPaneSlot = scopeSlot(() => createStore<{ labelId: string | null }>(() => ({ labelId: null })));

/** This Room's builder store, for the option bar and the canvas preview. */
export function useBuilderStore(): StoreApi<BuilderState> {
  return useScoped(builderSlot).store;
}

/** Ends whatever gesture was in progress, keeping the DM's choices. */
export function resetGesture(store: StoreApi<BuilderState>): void {
  store.setState({ unsent: [], rect: null, poly: [], run: [], labelMove: null, note: null, inSight: false });
}
