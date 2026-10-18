import type { ComponentType } from "react";
import type { Scene } from "#shared/model.ts";
import type { IconName } from "../components/Icon.tsx";
import type { Camera, Point } from "../lib/camera.ts";
import type { RoomScope } from "../state/scope.ts";
import type { RoomUi } from "../state/store.ts";
import type { RoomActions, RoomView } from "../state/types.ts";
import { areaTool } from "./areas/AreaTool.tsx";
import { drawTool } from "./drawings/DrawTool.tsx";
import { rulerTool } from "./measure/RulerTool.tsx";
import { pingTool } from "./pings/PingTool.tsx";
import { pinTool } from "./pins/PinTool.tsx";
import { builderTool } from "./builder/tool.tsx";
import { fogTool } from "./fog/tool.tsx";
import { gridTool } from "./grid/tool.tsx";
import { placeTool } from "./tokens/placeTool.tsx";
import { SelectOptions } from "./select/SelectOptions.tsx";
import { TOOL_ORDER } from "./toolbarOrder.ts";

/**
 * The toolbar's tools (design sections 14.2 to 14.4).
 *
 * Why a registry: each feature (rulers, areas, fog, the builder, drawing,
 * pings) owns its tool in its own files, and the Room page and the canvas
 * render whatever is listed here. Adding a tool is one import and one line
 * in TOOLS, with no edit to Room.tsx or Stage.tsx.
 *
 * Input rules, which every tool gets for free:
 * - Two fingers always pan and pinch the camera, whatever the tool. When a
 *   second finger lands mid-gesture, the tool's `cancel` runs instead of `up`.
 * - One finger, or the left mouse button, goes to the active tool's
 *   `pointer` handlers in world coordinates (cells). A tool without
 *   handlers gets the select tool's behavior: tap selects, a drag on a token
 *   moves it, a drag on empty map pans.
 * - The mouse wheel always zooms. A drag with the middle or right button,
 *   or the left with Space held, always moves the map.
 *
 * A minimal tool, in client/features/ping/tool.ts:
 *
 *   export const pingTool: ToolDef = {
 *     id: "ping",
 *     label: "Ping",
 *     icon: { glyph: "!" },
 *     roles: ["dm", "player"],
 *     order: 60,
 *     pointer: {
 *       up(p, ctx) {
 *         ctx.actions.sendEph({ k: "ping", x: p.world.x, y: p.world.y });
 *       },
 *     },
 *   };
 *
 * and here: `import { pingTool } from "./ping/tool.ts";` plus `pingTool,` in TOOLS.
 */

export type ToolPointer = {
  /** The pointer in world cells. */
  world: Point;
  /** The pointer in CSS pixels from the canvas's top-left corner. */
  screen: Point;
  pointerId: number;
  pointerType: string;
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** The token under the pointer, if any. A ruler snaps to it, for example. */
  tokenId: string | null;
};

/** What a tool's handlers may use. Read state through `getState()` at call time: handlers outlive renders. */
export type ToolContext = {
  actions: RoomActions;
  ui: RoomUi;
  getState(): RoomView;
  scene: Scene;
  role: "dm" | "player";
  camera(): Camera;
  /**
   * The Room page's own state (client/state/scope.ts). A tool keeps its
   * choices and its gesture in progress here, never in module variables,
   * because "view as a player" runs a second Room page with the same tools.
   */
  scope: RoomScope;
};

export type ToolPointerHandlers = {
  down?(p: ToolPointer, ctx: ToolContext): void;
  move?(p: ToolPointer, ctx: ToolContext): void;
  up?(p: ToolPointer, ctx: ToolContext): void;
  /** The one-finger gesture ended without an `up`: a second finger landed, the pointer was cancelled, or the tool changed. */
  cancel?(ctx: ToolContext): void;
  /** A mouse moving with no button pressed, for desktop hover previews. */
  hover?(p: ToolPointer, ctx: ToolContext): void;
};

/** An SVG path in a 24 x 24 box, filled with the current text color, an interface icon by its meaning, or a short text glyph. */
export type ToolIcon = { path: string } | { icon: IconName } | { glyph: string };

export type ToolDef = {
  id: string;
  label: string;
  /** One short word under the icon on a phone's toolbar, when `label` is longer. Left out, the label. */
  shortLabel?: string;
  icon: ToolIcon;
  roles: readonly ("dm" | "player")[];
  /** Position in the toolbar, lowest first. Leave gaps of 10 so later tools fit between. */
  order: number;
  pointer?: ToolPointerHandlers;
  /** Runs when the tool becomes active. */
  activate?(ctx: ToolContext): void;
  /** Runs when another tool takes over, or the scene changes. End any preview the tool sent here. */
  deactivate?(ctx: ToolContext): void;
  /**
   * The tool's options (color, shape, size), as one row of slots on the
   * options strip (features/measure/controls.tsx OptionsStrip), which Room
   * stands on a phone's toolbar, floats above a computer's, or puts in the
   * toolbar's own row on a short sideways screen
   * (docs/design-v1-tool-options.md 4). It renders inside RoomProvider, so
   * it may use the room hooks.
   */
  Options?: ComponentType<{ role: "dm" | "player" }>;
  /** Whether the options show right now. Left out, they show whenever the tool is active. */
  optionsShown?(state: RoomView): boolean;
  /** A CSS cursor for the canvas while the tool is active. */
  cursor?: string;
  /**
   * Whether the toolbar leaves the tool out for this viewer right now, for a
   * rule that is more than a role, such as Draw for a player the DM has not
   * let draw (features/drawings/gate.ts). It runs on every store update, so
   * it must be cheap.
   */
  hidden?(state: RoomView): boolean;
};

/**
 * Tap to select, drag a token to move it, drag the map to pan. Its behavior
 * lives in the canvas itself. Its bar shows only while "Multi-select" is
 * on, so the most used tool keeps the whole map otherwise.
 */
export const selectTool: ToolDef = {
  id: "select",
  label: "Select",
  icon: { path: "M5 2.5v17.2l4.6-4.4 3 6.9 3.1-1.3-3-6.8h6.3z" },
  roles: ["dm", "player"],
  order: TOOL_ORDER.select,
  Options: SelectOptions,
  optionsShown: (s) => s.local.multi,
};

/** Every tool, one per line. */
export const TOOLS: readonly ToolDef[] = [
  selectTool,
  fogTool,
  builderTool,
  gridTool,
  placeTool,
  rulerTool,
  areaTool,
  drawTool,
  pingTool,
  pinTool,
];

/** The role's tools in toolbar order. With the room's state, those a tool's own rule hides are left out too. */
export function toolsFor(role: "dm" | "player", state?: RoomView): ToolDef[] {
  return TOOLS.filter((t) => t.roles.includes(role) && !(state && t.hidden?.(state))).sort((a, b) => a.order - b.order);
}

/** The tool with this id that the role may use, or the select tool. */
export function activeTool(id: string, role: "dm" | "player"): ToolDef {
  return TOOLS.find((t) => t.id === id && t.roles.includes(role)) ?? selectTool;
}
