import { MAX_POLY_VERTICES } from "#shared/protocol.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { viewToScreen } from "../../lib/camera.ts";
import { distance, TAP_SLOP_PX } from "../../lib/gestures.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import type { ToolContext, ToolPointer, ToolPointerHandlers } from "../tools.ts";
import { buildContext, dispatchBuild } from "./ask.ts";
import { strokeMaySend, type Point } from "./cells.ts";
import { tapFreeWall } from "./freeWallTap.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { stairChoiceOn } from "./heights/facings.ts";
import { paintCells } from "./heights/ops.ts";
import { heightSlot, type HeightState } from "./heights/store.ts";
import { hexEraseOps, hexesInRect, hexRoughOps, hexSightCells, hexStroke, lineFeature, wallLineOps, wallPoint } from "./hexBuild.ts";
import { partySeesAny } from "./inSight.ts";
import { builderSlot, type BuildMode } from "./store.ts";

/** Strokes send what they painted this often, as the square brush does (tool.tsx PAINT_FLUSH_MS). */
const FLUSH_MS = 150;
/** A tap this close to a Wall line's first point closes it, as a shape room's corner does: half a 44 px target. */
const CLOSE_PX = 22;

/** The builder's modes a hex scene works by hexes (HX-D9), Height mode from H3. Lights, stamps and labels keep their own handlers, and the rest only show the limit. */
const HEX_MODES: ReadonlySet<BuildMode> = new Set<BuildMode>(["edge", "erase", "eraseRect", "rough", "height"]);

function hexMode(ctx: ToolContext): { g: HexGrid; mode: BuildMode } | null {
  const g = sceneGrid(ctx.scene);
  if (!isHex(g)) return null;
  const mode = ctx.scope.get(builderSlot).store.getState().mode;
  return HEX_MODES.has(mode) ? { g, mode } : null;
}

/** Difficult ground mode's brush and choice, kept with Height mode's as on squares (heights/store.ts). */
function roughChoice(ctx: ToolContext): { size: number | "area"; on: boolean } {
  const h = ctx.scope.get(heightSlot).store.getState();
  return { size: h.shape, on: h.rough !== "clear" };
}

/** Height mode's brush and what it paints, its stairs choice kept to the scene's facings (heights/HeightOptions.tsx stairChoiceOn). */
function heightChoice(ctx: ToolContext, g: HexGrid): Pick<HeightState, "paint" | "height" | "stairs" | "shape"> {
  const h = ctx.scope.get(heightSlot).store.getState();
  return { paint: h.paint, height: h.height, stairs: stairChoiceOn(g, h.stairs), shape: h.shape };
}

/** The ops for a gesture's hexes in the mode it was made in. */
function hexOps(ctx: ToolContext, g: HexGrid, mode: BuildMode, sceneId: string, keys: readonly string[]): ClientOp[] {
  const view = ctx.getState().view;
  if (mode === "rough") return hexRoughOps(view, sceneId, keys, roughChoice(ctx).on);
  if (mode === "height") return paintCells(view, sceneId, keys, heightChoice(ctx, g));
  return hexEraseOps(view, g, sceneId, keys);
}

/** Sends a stroke's unsent hexes to the scene it began on, a finger's after a moment unless it has ended. */
function flush(ctx: ToolContext, g: HexGrid, done: boolean): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const stroke = gesture.hex;
  const s = store.getState();
  if (stroke?.kind !== "stroke" || s.unsent.length === 0) return;
  if (!done && !strokeMaySend(stroke.touch, stroke.startedAt, performance.now())) return;
  store.setState({ unsent: [] });
  if (ctx.scene.id !== stroke.sceneId) return;
  for (const op of hexOps(ctx, g, s.mode, stroke.sceneId, s.unsent)) ctx.actions.dispatch(op, { group: stroke.group });
}

function endStroke(ctx: ToolContext, g: HexGrid | null, send: boolean): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const stroke = gesture.hex;
  if (stroke?.kind !== "stroke") return;
  clearInterval(stroke.timer);
  if (send && g) flush(ctx, g, true);
  else store.setState({ unsent: [] });
  gesture.hex = null;
}

/** Sends the Wall line tapped so far, as free walls of the Walls and doors choice. Exported for the option bar's Done. */
export function finishWallLine(ctx: Pick<ToolContext, "scene" | "actions" | "ui" | "scope">): void {
  const store = ctx.scope.get(builderSlot).store;
  const { line, lineScene, edge, secretFound } = store.getState();
  store.setState({ line: [], lineScene: null, lineAt: null, note: null });
  const feature = lineFeature(edge, secretFound);
  if (line.length < 2 || lineScene !== ctx.scene.id || feature === null) return;
  dispatchBuild(buildContext(ctx), wallLineOps(ctx.scene.id, line, feature));
}

/**
 * A tap in Walls and doors on a hex scene (HX-D7). Remove takes the free
 * wall under it off. With no line begun, Door steps the free door under it
 * through its states, as on squares (freeWallTap.ts). Otherwise the tap
 * adds a point to the Wall line, snapped as Snap to hex corners says: a
 * tap on the first point closes the line and one on the last ends it, and
 * Done sends it.
 */
function tapLine(p: ToolPointer, ctx: ToolContext, g: HexGrid): void {
  const store = ctx.scope.get(builderSlot).store;
  const s = store.getState();
  const line = s.lineScene === ctx.scene.id ? s.line : [];
  if (s.edge === "clear" || (s.edge === "door" && line.length === 0)) {
    if (tapFreeWall(p, ctx)) return;
    if (s.edge === "clear") {
      store.setState({ note: "Tap a wall, door or window to remove it." });
      return;
    }
  }
  const point = wallPoint(g, p.world, s.snapCorners, ctx.scene.bounds);
  const first = line[0];
  const last = line[line.length - 1];
  const near = (q: Point) => distance(viewToScreen(ctx.camera(), toView(TOP_DOWN, q)), p.screen) <= CLOSE_PX;
  if (first && line.length >= 3 && near(first)) {
    store.setState({ line: [...line, first] });
    finishWallLine(ctx);
    return;
  }
  if (last && line.length >= 2 && last.x === point.x && last.y === point.y) {
    finishWallLine(ctx);
    return;
  }
  if (last && last.x === point.x && last.y === point.y) return;
  if (line.length >= MAX_POLY_VERTICES) {
    store.setState({ note: `A wall line has at most ${MAX_POLY_VERTICES} points. Tap Done to finish.` });
    return;
  }
  store.setState({ line: [...line, point], lineScene: ctx.scene.id, lineAt: null, note: null });
}

function down(p: ToolPointer, ctx: ToolContext, g: HexGrid, mode: BuildMode): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  store.setState({ note: null, inSight: false });
  endStroke(ctx, g, true);
  const sceneId = ctx.scene.id;
  const brush = mode === "rough" ? roughChoice(ctx).size : mode === "height" ? heightChoice(ctx, g).shape : mode === "erase" ? store.getState().brush : "area";
  if (mode === "edge" || brush === "area") {
    gesture.hex = { kind: "drag", sceneId, down: { screen: p.screen, world: p.world } };
    if (brush === "area" && mode !== "edge") store.setState({ rect: { a: p.world, b: p.world } });
    return;
  }
  const seen = new Set<string>();
  const unsent = hexStroke(g, null, p.world, brush, ctx.scene.bounds, seen);
  gesture.hex = {
    kind: "stroke",
    sceneId,
    seen,
    last: p.world,
    group: ctx.actions.newId(),
    timer: setInterval(() => flush(ctx, g, false), FLUSH_MS),
    touch: p.pointerType === "touch",
    startedAt: performance.now(),
  };
  store.setState({ unsent });
  markSight(ctx, g, unsent);
}

function move(p: ToolPointer, ctx: ToolContext, g: HexGrid): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const hex = gesture.hex;
  const s = store.getState();
  if (hex?.kind === "stroke") {
    const brush = s.mode === "rough" ? roughChoice(ctx).size : s.mode === "height" ? heightChoice(ctx, g).shape : s.brush;
    if (brush === "area") return;
    const added = hexStroke(g, hex.last, p.world, brush, ctx.scene.bounds, hex.seen);
    hex.last = p.world;
    if (added.length > 0) store.setState({ unsent: [...s.unsent, ...added] });
    markSight(ctx, g, added);
  } else if (hex?.kind === "drag") {
    if (s.rect) store.setState({ rect: { a: s.rect.a, b: p.world } });
    else if (s.edge !== "clear" && distance(hex.down.screen, p.screen) > TAP_SLOP_PX) {
      store.setState({ lineDrag: { a: wallPoint(g, hex.down.world, s.snapCorners, ctx.scene.bounds), b: wallPoint(g, p.world, s.snapCorners, ctx.scene.bounds) } });
    }
  }
}

function up(p: ToolPointer, ctx: ToolContext, g: HexGrid): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  const hex = gesture.hex;
  if (hex?.kind === "stroke") {
    endStroke(ctx, g, true);
    return;
  }
  gesture.hex = null;
  if (hex?.kind !== "drag" || hex.sceneId !== ctx.scene.id) {
    store.setState({ rect: null, lineDrag: null });
    return;
  }
  const s = store.getState();
  if (s.rect) {
    store.setState({ rect: null });
    const keys = hexesInRect(g, s.rect.a, p.world, ctx.scene.bounds);
    markSight(ctx, g, keys);
    dispatchBuild(buildContext(ctx), hexOps(ctx, g, s.mode, ctx.scene.id, keys));
    return;
  }
  store.setState({ lineDrag: null });
  if (distance(hex.down.screen, p.screen) <= TAP_SLOP_PX) {
    tapLine(p, ctx, g);
    return;
  }
  // A drag is a straight run of its own, sent at once, beside any line being tapped.
  const feature = lineFeature(s.edge, s.secretFound);
  if (feature === null) return;
  const a = wallPoint(g, hex.down.world, s.snapCorners, ctx.scene.bounds);
  const b = wallPoint(g, p.world, s.snapCorners, ctx.scene.bounds);
  dispatchBuild(buildContext(ctx), wallLineOps(ctx.scene.id, [a, b], feature));
}

/**
 * The builder's handlers with the hex scene's own gestures in front of
 * them (HX-D7, HX-D9): in Walls and doors, Erase, Erase area and
 * Difficult ground, a hex scene builds by hexes and Wall lines. A gesture
 * that began here ends here, whatever the mode is by then.
 */
export function withHexBuild(handlers: ToolPointerHandlers): ToolPointerHandlers {
  const busy = (ctx: ToolContext) => ctx.scope.get(builderSlot).gesture.hex !== null;
  const grid = (ctx: ToolContext) => {
    const g = sceneGrid(ctx.scene);
    return isHex(g) ? g : null;
  };
  return {
    ...handlers,
    down: (p, ctx) => {
      const m = hexMode(ctx);
      if (m) down(p, ctx, m.g, m.mode);
      else handlers.down?.(p, ctx);
    },
    move: (p, ctx) => {
      const g = grid(ctx);
      if (busy(ctx) && g) move(p, ctx, g);
      else handlers.move?.(p, ctx);
    },
    up: (p, ctx) => {
      const g = grid(ctx);
      if (busy(ctx) && g) up(p, ctx, g);
      else if (busy(ctx)) cancel(ctx);
      else handlers.up?.(p, ctx);
    },
    hover: (p, ctx) => {
      const m = hexMode(ctx);
      const store = ctx.scope.get(builderSlot).store;
      const s = store.getState();
      // A mouse shows where the next run of the line goes.
      if (m?.mode === "edge" && s.line.length > 0 && s.lineScene === ctx.scene.id) store.setState({ lineAt: wallPoint(m.g, p.world, s.snapCorners, ctx.scene.bounds) });
      else handlers.hover?.(p, ctx);
    },
    cancel: (ctx) => {
      cancel(ctx);
      handlers.cancel?.(ctx);
    },
  };
}

/**
 * Marks the option bar's note while the party's sight meets a hex of the
 * gesture, as the square builder's markSight does (tool.tsx), read by the
 * fog's cells under the hexes' centers.
 */
function markSight(ctx: ToolContext, g: HexGrid, keys: readonly string[]): void {
  const store = ctx.scope.get(builderSlot).store;
  if (store.getState().inSight || keys.length === 0) return;
  const view = ctx.getState().view;
  if (view && partySeesAny(view, ctx.scene, hexSightCells(g, keys, ctx.scene.bounds))) store.setState({ inSight: true });
}

/** A second finger landed or the tool changed: a stroke's sent hexes stay, as on squares, and a drag is dropped. A tapped line stays. */
export function cancelHexGesture(ctx: ToolContext): void {
  cancel(ctx);
}

function cancel(ctx: ToolContext): void {
  const { store, gesture } = ctx.scope.get(builderSlot);
  endStroke(ctx, null, false);
  gesture.hex = null;
  store.setState({ rect: null, lineDrag: null });
}
