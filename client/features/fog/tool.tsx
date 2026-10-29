import { Suspense } from "react";
import type { BuildChunk, FogShape } from "#shared/model.ts";
import { MAX_FOG_DRAFT_OPS, MAX_POLY_VERTICES } from "#shared/protocol.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { indexBuild, sceneWalls } from "#shared/rules/walls.ts";
import { Loading } from "../../components/Loading.tsx";
import { viewToScreen } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import { distance, TAP_SLOP_PX } from "../../lib/gestures.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import type { ToolContext, ToolDef, ToolPointer } from "../tools.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { fogMessages, fogOps, hexRoomShapes, polyShape, rectShape, roomShapes, snapPoint, strokeShapes, type Point } from "./shapes.ts";
import { fogSlot, resetFogGesture } from "./store.ts";
import { fogCycle } from "../toolChoices.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/** A tap this close to the first corner closes a polygon: half a 44 px target. */
const CLOSE_PX = 22;
/** Brush samples closer than this, in cells, add nothing a stroke can show. */
const STROKE_MIN_STEP = 0.05;

function isTap(ctx: ToolContext, p: ToolPointer): boolean {
  const downAt = ctx.scope.get(fogSlot).downAt;
  return !!downAt && distance(downAt, p.screen) <= TAP_SLOP_PX;
}

/**
 * Sends shapes as fog ops: into the scene's draft, or to the players at once
 * in live mode. A draft holds at most 500 ops, so an edit that would
 * overflow it is refused here with a note instead of by the server. A
 * gesture too big for one socket frame goes as several messages under one
 * undo step (fogMessages).
 */
export function submitFog(ctx: Pick<ToolContext, "scene" | "actions" | "getState" | "scope">, shapes: readonly FogShape[]): void {
  if (shapes.length === 0) return;
  const fogState = ctx.scope.get(fogSlot).store;
  const { mode, live } = fogState.getState();
  const sceneId = ctx.scene.id;
  const ops = fogOps(shapes, mode, ctx.actions.newId);
  if (!live) {
    const drafted = ctx.getState().view?.fogDrafts[sceneId]?.ops.length ?? 0;
    if (drafted + ops.length > MAX_FOG_DRAFT_OPS) {
      fogState.setState({ note: "The draft is full. Reveal it to the players or discard it first." });
      return;
    }
  }
  dispatchGesture(ctx.actions, fogMessages(sceneId, ops, live));
}

export function closeFogPolygon(ctx: Pick<ToolContext, "scene" | "actions" | "getState" | "scope">): void {
  const fogState = ctx.scope.get(fogSlot).store;
  const shape = polyShape(fogState.getState().poly);
  fogState.setState({ poly: [] });
  if (shape) submitFog(ctx, [shape]);
}

function tapPoly(p: ToolPointer, ctx: ToolContext): void {
  const fogState = ctx.scope.get(fogSlot).store;
  const { poly } = fogState.getState();
  const first = poly[0];
  if (first && poly.length >= 3 && distance(viewToScreen(ctx.camera(), toView(TOP_DOWN, first)), p.screen) <= CLOSE_PX) {
    closeFogPolygon(ctx);
    return;
  }
  if (poly.length >= MAX_POLY_VERTICES) {
    fogState.setState({ note: `A shape has at most ${MAX_POLY_VERTICES} corners. Close it to finish.` });
    return;
  }
  fogState.setState({ poly: [...poly, snapPoint(p.world)], note: null });
}

/** What a Builder room tap that finds nothing says, by the scene's grid: a hex scene floods any whole hex of it. */
export const ROOM_MISSED = {
  squares: "Tap inside a room made with the map builder.",
  hex: "Tap a whole hex inside the map.",
} as const;

function tapRoom(p: ToolPointer, ctx: ToolContext): void {
  const view = ctx.getState().view;
  const g = sceneGrid(ctx.scene);
  if (isHex(g)) {
    const shapes = hexRoomShapes(sceneWalls(ctx.scene, view?.buildChunks ?? {}), g, p.world, ctx.scene.bounds);
    if (shapes.length === 0) ctx.scope.get(fogSlot).store.setState({ note: ROOM_MISSED.hex });
    else submitFog(ctx, shapes);
    return;
  }
  const chunks = Object.values(view?.buildChunks ?? {}).filter((c): c is BuildChunk => !!c && c.sceneId === ctx.scene.id);
  const { shapes } = roomShapes(indexBuild(chunks), p.world, ctx.scene.bounds);
  if (shapes.length === 0) {
    ctx.scope.get(fogSlot).store.setState({ note: ROOM_MISSED.squares });
    return;
  }
  submitFog(ctx, shapes);
}

const Options = retryableLazy(() => import("./Options.tsx"), { roles: ["dm"] });

/**
 * The fog tool (design sections 13.1 and 13.2): reveal or hide with a
 * rectangle, a polygon or a brush, or reveal a builder room with one tap,
 * on a hex scene the hexes its wall lines close in (docs/design-v1-hex-grids.md HX-D10).
 * Edits go to the draft, which only the DM sees, until "Reveal to players"
 * publishes it. Live mode sends each edit to the players at once.
 */
export const fogTool: ToolDef = {
  id: "fog",
  label: "Fog",
  icon: { path: "M6.5 18A4.5 4.5 0 0 1 6 9.03 6 6 0 0 1 17.6 8.5 4.75 4.75 0 0 1 17.25 18zM3 21h18v-1.5H3z" },
  roles: ["dm"],
  order: TOOL_ORDER.fog,
  cursor: "crosshair",
  activate(ctx) {
    resetFogGesture(ctx.scope.get(fogSlot).store);
  },
  deactivate(ctx) {
    const tool = ctx.scope.get(fogSlot);
    tool.downAt = null;
    resetFogGesture(tool.store);
  },
  pointer: {
    down(p, ctx) {
      const tool = ctx.scope.get(fogSlot);
      const fogState = tool.store;
      tool.downAt = p.screen;
      const { shape } = fogState.getState();
      fogState.setState({ note: null });
      if (shape === "rect") fogState.setState({ rect: { a: p.world, b: p.world } });
      else if (shape === "brush") fogState.setState({ stroke: [p.world] });
    },
    move(p, ctx) {
      const fogState = ctx.scope.get(fogSlot).store;
      const s = fogState.getState();
      if (s.shape === "rect" && s.rect) {
        fogState.setState({ rect: { a: s.rect.a, b: p.world } });
      } else if (s.shape === "brush" && s.stroke.length > 0) {
        const last = s.stroke[s.stroke.length - 1]!;
        if (Math.hypot(p.world.x - last.x, p.world.y - last.y) >= STROKE_MIN_STEP) fogState.setState({ stroke: [...s.stroke, p.world] });
      }
    },
    up(p, ctx) {
      const tool = ctx.scope.get(fogSlot);
      const fogState = tool.store;
      const s = fogState.getState();
      const tap = isTap(ctx, p);
      tool.downAt = null;
      if (s.shape === "rect" && s.rect) {
        fogState.setState({ rect: null });
        const shape = rectShape(s.rect.a, p.world);
        if (shape) submitFog(ctx, [shape]);
      } else if (s.shape === "brush" && s.stroke.length > 0) {
        fogState.setState({ stroke: [] });
        submitFog(ctx, strokeShapes(s.stroke, s.width));
      } else if (s.shape === "poly" && tap) {
        tapPoly(p, ctx);
      } else if (s.shape === "room" && tap) {
        tapRoom(p, ctx);
      }
    },
    cancel(ctx) {
      const tool = ctx.scope.get(fogSlot);
      tool.downAt = null;
      tool.store.setState({ rect: null, stroke: [] });
    },
  },
  Options: () => (
    <Suspense fallback={<Loading text="Loading the options…" />}>
      <Options />
    </Suspense>
  ),
  cycle: fogCycle,
};
