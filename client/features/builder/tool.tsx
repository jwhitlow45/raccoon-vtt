import { Suspense } from "react";
import type { EdgeFeature } from "#shared/model.ts";
import { MAX_POLY_VERTICES } from "#shared/protocol.ts";
import { Loading } from "../../components/Loading.tsx";
import { worldToScreen } from "../../lib/camera.ts";
import { distance, TAP_SLOP_PX } from "../../lib/gestures.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import {
  edgeOps,
  edgeRun,
  isHiddenDoor,
  nearestEdge,
  nextDoor,
  paintOps,
  polyOps,
  rectBetween,
  rectOps,
  runFeature,
  secretDoor,
  snapToCorner,
  strokeCells,
  strokeMaySend,
  type Point,
} from "./cells.ts";
import { tapFreeWall } from "./freeWallTap.ts";
import { edgeAt, erasable, terrainAt } from "./query.ts";
import { labelUnder, tapMapLabel } from "./labelTap.ts";
import { builderSlot, resetGesture } from "./store.ts";
import { withStampMode } from "./stamps/pointer.ts";
import { withHeightMode } from "./heights/pointer.ts";
import { withLightMode } from "../lights/pointer.ts";
import { builderCycle } from "../toolChoices.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/** Brush strokes send what they painted this often (design 12): a few ops a second, never one per cell. */
export const PAINT_FLUSH_MS = 150;
/** A tap this close to the first corner closes a polygon: half a 44 px target. */
const CLOSE_PX = 22;

function isTap(ctx: ToolContext, p: ToolPointer): boolean {
  const downAt = ctx.scope.get(builderSlot).gesture.downAt;
  return !!downAt && distance(downAt.screen, p.screen) <= TAP_SLOP_PX;
}

/**
 * Sends the stroke's unsent cells, skipping any that already look right in
 * the view. The cells go to the scene the stroke started on, never to one
 * the DM switched to since. A finger's stroke holds them a moment first,
 * unless it has ended (`done`), in case a second finger is on its way.
 */
function flushStroke(ctx: ToolContext, done: boolean): void {
  const { store: builderState, gesture } = ctx.scope.get(builderSlot);
  const { unsent, mode, terrain } = builderState.getState();
  if (unsent.length === 0 || !gesture.stroke) return;
  if (!done && !strokeMaySend(gesture.stroke.touch, gesture.stroke.startedAt, performance.now())) return;
  builderState.setState({ unsent: [] });
  const sceneId = gesture.stroke.sceneId;
  if (ctx.scene.id !== sceneId) return;
  const view = ctx.getState().view;
  const ops = paintOps(sceneId, unsent, mode === "erase" ? null : terrain, (key) => terrainAt(view, sceneId, key), erasable(view, sceneId));
  for (const op of ops) ctx.actions.dispatch(op, { group: gesture.stroke.group });
}

function endStroke(ctx: ToolContext, send: boolean): void {
  const { store: builderState, gesture } = ctx.scope.get(builderSlot);
  if (!gesture.stroke) return;
  clearInterval(gesture.stroke.timer);
  if (send) flushStroke(ctx, true);
  else builderState.setState({ unsent: [] });
  gesture.stroke = null;
}

function tapEdge(p: ToolPointer, ctx: ToolContext): void {
  if (tapFreeWall(p, ctx)) return;
  const builderState = ctx.scope.get(builderSlot).store;
  const { edge, secretFound } = builderState.getState();
  const sceneId = ctx.scene.id;
  const key = nearestEdge(p.world, ctx.scene.bounds);
  if (!key) {
    builderState.setState({ note: "Tap an edge inside the scene." });
    return;
  }
  const current = edgeAt(ctx.getState().view, sceneId, key);
  let feature: EdgeFeature | null;
  if (edge === "door") {
    if (isHiddenDoor(current)) {
      builderState.setState({ note: "That is a hidden secret door. Pick Secret door to change it." });
      return;
    }
    feature = nextDoor(current);
  } else if (edge === "secret") feature = secretDoor(current, secretFound);
  else if (edge === "clear") feature = null;
  // Tapping an edge that already has this feature takes it off again.
  else feature = current?.kind === edge ? null : { kind: edge };
  if (feature === null && current === undefined) return;
  dispatchGesture(ctx.actions, edgeOps(sceneId, [{ key, feature }]));
}

/** Sends a dragged run, leaving alone the edges that already have what it puts down. */
function sendRun(ctx: ToolContext, run: readonly string[]): void {
  const { edge, secretFound } = ctx.scope.get(builderSlot).store.getState();
  const view = ctx.getState().view;
  const edges: { key: string; feature: EdgeFeature | null }[] = [];
  for (const key of run) {
    const feature = runFeature(edge, edgeAt(view, ctx.scene.id, key), secretFound);
    if (feature !== undefined) edges.push({ key, feature });
  }
  dispatchGesture(ctx.actions, edgeOps(ctx.scene.id, edges));
}

function tapPoly(p: ToolPointer, ctx: ToolContext): void {
  const builderState = ctx.scope.get(builderSlot).store;
  const { poly } = builderState.getState();
  const first = poly[0];
  if (first && poly.length >= 3 && distance(worldToScreen(ctx.camera(), first), p.screen) <= CLOSE_PX) {
    closePolygon(ctx);
    return;
  }
  const corner = snapToCorner(p.world);
  const last = poly[poly.length - 1];
  if (last && last.x === corner.x && last.y === corner.y) return;
  if (poly.length >= MAX_POLY_VERTICES) {
    builderState.setState({ note: `A room has at most ${MAX_POLY_VERTICES} corners. Close it to finish.` });
    return;
  }
  builderState.setState({ poly: [...poly, corner], note: null });
}

/** Sends the polygon room tapped so far. Exported for the option bar's Close button. */
export function closePolygon(ctx: Pick<ToolContext, "scene" | "actions" | "scope">): void {
  const builderState = ctx.scope.get(builderSlot).store;
  const { poly, terrain } = builderState.getState();
  if (poly.length < 3) return;
  const ops = polyOps(
    ctx.scene.id,
    poly.flatMap((p) => [p.x, p.y]),
    terrain,
    ctx.scene.bounds,
  );
  builderState.setState({ poly: [], note: ops.length === 0 ? "That shape holds no whole square." : null });
  dispatchGesture(ctx.actions, ops);
}

/** A tap on a label opens its edit pane (LabelPane.tsx), and a tap elsewhere places a new one. */
function tapLabel(p: ToolPointer, ctx: ToolContext): void {
  if (tapMapLabel(ctx, builderTool.id, p.world)) return;
  const builderState = ctx.scope.get(builderSlot).store;
  const { labelText, labelSize } = builderState.getState();
  const text = labelText.trim();
  if (!text) {
    builderState.setState({ note: "Type the label's text first." });
    return;
  }
  ctx.actions.dispatch({
    t: "build.label",
    sceneId: ctx.scene.id,
    labelId: ctx.actions.newId(),
    label: { x: Math.round(p.world.x * 100) / 100, y: Math.round(p.world.y * 100) / 100, text, size: labelSize },
  });
}

const Options = retryableLazy(() => import("./Options.tsx"), { roles: ["dm"] });

/**
 * The map builder (design section 12): paint floor with a 1 to 3 cell
 * brush, drag rectangle rooms, tap polygon rooms, erase with the brush or a
 * rectangle, set walls, doors and windows on cell edges, and place and move
 * labels. Walls around floor come on their own, so a room is just cells.
 * Height mode (heights/pointer.ts) paints raised areas and stairs, and Stamp
 * mode (stamps/pointer.ts) places stamps, each in front of these handlers.
 */
export const builderTool: ToolDef = {
  id: "build",
  label: "Map builder",
  shortLabel: "Builder",
  icon: { path: "M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm12 0h2v4h4v2h-4v4h-2v-4h-4v-2h4z" },
  roles: ["dm"],
  order: TOOL_ORDER.build,
  cursor: "crosshair",
  activate(ctx) {
    resetGesture(ctx.scope.get(builderSlot).store);
  },
  deactivate(ctx) {
    const { store, gesture } = ctx.scope.get(builderSlot);
    endStroke(ctx, false);
    gesture.downAt = null;
    gesture.labelGrab = null;
    resetGesture(store);
  },
  pointer: withLightMode(withStampMode(withHeightMode({
    down(p, ctx) {
      const { store: builderState, gesture } = ctx.scope.get(builderSlot);
      gesture.downAt = { screen: p.screen, world: p.world };
      const { mode, brush } = builderState.getState();
      builderState.setState({ note: null });
      if (mode === "paint" || mode === "erase") {
        endStroke(ctx, true);
        const seen = new Set<string>();
        const cells = strokeCells(null, p.world, brush, ctx.scene.bounds, seen);
        gesture.stroke = {
          sceneId: ctx.scene.id,
          seen,
          last: p.world,
          group: ctx.actions.newId(),
          timer: setInterval(() => flushStroke(ctx, false), PAINT_FLUSH_MS),
          touch: p.pointerType === "touch",
          startedAt: performance.now(),
        };
        builderState.setState({ unsent: cells });
      } else if (mode === "rect" || mode === "eraseRect") {
        builderState.setState({ rect: { a: p.world, b: p.world } });
      } else if (mode === "label") {
        const hit = labelUnder(ctx, p.world);
        gesture.labelGrab = hit ? { id: hit.id, dx: p.world.x - hit.x, dy: p.world.y - hit.y } : null;
      }
    },
    move(p, ctx) {
      const { store: builderState, gesture } = ctx.scope.get(builderSlot);
      const { stroke, downAt } = gesture;
      const s = builderState.getState();
      if ((s.mode === "paint" || s.mode === "erase") && stroke) {
        const added = strokeCells(stroke.last, p.world, s.brush, ctx.scene.bounds, stroke.seen);
        stroke.last = p.world;
        if (added.length > 0) builderState.setState({ unsent: [...s.unsent, ...added] });
      } else if ((s.mode === "rect" || s.mode === "eraseRect") && s.rect) {
        builderState.setState({ rect: { a: s.rect.a, b: p.world } });
      } else if (s.mode === "edge" && downAt && !isTap(ctx, p)) {
        builderState.setState({ run: edgeRun(downAt.world, p.world, ctx.scene.bounds) });
      } else if (s.mode === "label" && gesture.labelGrab && (s.labelMove || !isTap(ctx, p))) {
        const grab = gesture.labelGrab;
        const label = ctx.getState().view?.labels[grab.id];
        if (!label) return;
        builderState.setState({ labelMove: { id: label.id, x: p.world.x - grab.dx, y: p.world.y - grab.dy } });
      }
    },
    up(p, ctx) {
      const { store: builderState, gesture } = ctx.scope.get(builderSlot);
      const s = builderState.getState();
      const tap = isTap(ctx, p);
      if (s.mode === "paint" || s.mode === "erase") {
        endStroke(ctx, true);
      } else if ((s.mode === "rect" || s.mode === "eraseRect") && s.rect) {
        builderState.setState({ rect: null });
        const terrain = s.mode === "eraseRect" ? null : s.terrain;
        dispatchGesture(ctx.actions, rectOps(ctx.scene.id, rectBetween(s.rect.a, p.world), terrain, ctx.scene.bounds));
      } else if (s.mode === "poly" && tap) {
        tapPoly(p, ctx);
      } else if (s.mode === "edge") {
        // A drag too short to cover a whole edge was a tap that slid.
        if (tap || s.run.length === 0) tapEdge(p, ctx);
        else sendRun(ctx, s.run);
        builderState.setState({ run: [] });
      } else if (s.mode === "label") {
        const moved = s.labelMove;
        if (moved) {
          builderState.setState({ labelMove: null });
          // Gone mid-drag (undone, or erased by another DM): nothing left to move.
          const label = ctx.getState().view?.labels[moved.id];
          if (label) {
            ctx.actions.dispatch({
              t: "build.label",
              sceneId: label.sceneId,
              labelId: label.id,
              label: { x: Math.round(moved.x * 100) / 100, y: Math.round(moved.y * 100) / 100, text: label.text, size: label.size },
            });
          }
        } else if (tap) tapLabel(p, ctx);
        gesture.labelGrab = null;
      }
      gesture.downAt = null;
    },
    cancel(ctx) {
      // A second finger landed: the DM is zooming, not building. A finger's
      // stroke has sent nothing yet unless it went on for a while
      // (SECOND_FINGER_MS). Cells already sent stay (undo takes them back),
      // the rest is dropped.
      const { store, gesture } = ctx.scope.get(builderSlot);
      endStroke(ctx, false);
      gesture.downAt = null;
      gesture.labelGrab = null;
      store.setState({ rect: null, run: [], labelMove: null });
    },
  }))),
  Options: () => (
    <Suspense fallback={<Loading text="Loading the options…" />}>
      <Options />
    </Suspense>
  ),
  cycle: builderCycle,
};
