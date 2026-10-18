import { Suspense } from "react";
import { Loading } from "../../components/Loading.tsx";
import { worldToScreen } from "../../lib/camera.ts";
import { distance } from "../../lib/gestures.ts";
import { retryableLazy } from "../../lib/retryableLazy.ts";
import { currentStageCamera } from "../scenes/stageCamera.ts";
import type { ToolContext, ToolDef } from "../tools.ts";
import { boxAtCell, boxCorner, boxFromDrag, canonicalToWorld, resizeBox, worldToCanonical, type CalBox, type Corner } from "./calibrate.ts";
import { gridSlot, HANDLE_HIT_PX } from "./store.ts";
import { TOOL_ORDER } from "../toolbarOrder.ts";

/** A drag shorter than this, in screen pixels, is a tap. */
const TAP_PX = 8;

const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

/** The box over the 3 x 3 squares at the middle of the screen, under the current calibration. */
export function centeredBox(ctx: ToolContext): CalBox | null {
  const map = ctx.scene.map;
  if (!map) return null;
  const cam = ctx.camera();
  const live = currentStageCamera(ctx.scope);
  const center = live
    ? { x: (live.viewport.width / 2 - cam.x) / cam.scale, y: (live.viewport.height / 2 - cam.y) / cam.scale }
    : { x: ctx.scene.bounds.w / 2, y: ctx.scene.bounds.h / 2 };
  return boxAtCell(map, Math.floor(center.x) - 1, Math.floor(center.y) - 1);
}

function cornerAt(ctx: ToolContext, box: CalBox, screen: { x: number; y: number }): Corner | null {
  const map = ctx.scene.map;
  if (!map) return null;
  const cam = ctx.camera();
  let best: Corner | null = null;
  let bestDist = HANDLE_HIT_PX;
  for (const corner of CORNERS) {
    const d = distance(worldToScreen(cam, canonicalToWorld(map, boxCorner(box, corner))), screen);
    if (d <= bestDist) {
      best = corner;
      bestDist = d;
    }
  }
  return best;
}

function inside(box: CalBox, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.size && p.y >= box.y && p.y <= box.y + box.size;
}

const Options = retryableLazy(() => import("./Options.tsx"), { roles: ["dm"] });

/**
 * Lining up the app's grid with a map (design section 5). The DM drags a
 * box over three by three squares of the art, adjusts it with its corners
 * or the nudge buttons, and applies it. Only `cellPx` and `originPx` change.
 *
 * - Drag on the map outside the box: draw a new box from that point.
 * - Drag inside the box: move it. Drag a corner: resize it about the
 *   opposite corner.
 * - Tap outside the box: move the box to the squares there.
 */
export const gridTool: ToolDef = {
  id: "grid",
  label: "Line up grid",
  shortLabel: "Grid",
  icon: { path: "M3 3h18v18H3zm2 2v4h4V5zm6 0v4h4V5zm6 0v4h2V5zM5 11v4h4v-4zm6 0v4h4v-4zm6 0v4h2v-4zM5 17v2h4v-2zm6 0v2h4v-2zm6 0v2h2v-2z" },
  roles: ["dm"],
  order: TOOL_ORDER.grid,
  cursor: "crosshair",
  activate(ctx) {
    // A grid just found for this scene (outcome.ts) brings its own box.
    const { found } = ctx.scope.get(gridSlot).getState();
    const box = found?.sceneId === ctx.scene.id && found.box ? found.box : centeredBox(ctx);
    ctx.scope.get(gridSlot).setState({ box, drag: null, sceneId: ctx.scene.id });
  },
  deactivate(ctx) {
    // A note or a search for the scene being left ends with it. One for
    // another scene stays: an import makes its scene, then switches to it.
    const { found, finding, sceneId } = ctx.scope.get(gridSlot).getState();
    if (finding && finding.sceneId === sceneId) finding.cancel();
    ctx.scope.get(gridSlot).setState({
      box: null,
      drag: null,
      sceneId: null,
      ...(found && found.sceneId === sceneId ? { found: null } : {}),
      ...(finding && finding.sceneId === sceneId ? { finding: null } : {}),
    });
  },
  pointer: {
    down(p, ctx) {
      const gridState = ctx.scope.get(gridSlot);
      const map = ctx.scene.map;
      if (!map) return;
      const { box } = gridState.getState();
      const corner = box ? cornerAt(ctx, box, p.screen) : null;
      if (box && corner) {
        gridState.setState({ drag: { kind: "corner", corner, start: box } });
      } else if (box && inside(box, worldToCanonical(map, p.world))) {
        gridState.setState({ drag: { kind: "move", from: p.world, start: box } });
      } else {
        gridState.setState({ drag: { kind: "new", from: p.world, start: box, moved: false } });
      }
    },
    move(p, ctx) {
      const gridState = ctx.scope.get(gridSlot);
      const map = ctx.scene.map;
      const { drag } = gridState.getState();
      if (!map || !drag) return;
      if (drag.kind === "corner") {
        gridState.setState({ box: resizeBox(map, drag.start, drag.corner, p.world) });
      } else if (drag.kind === "move") {
        const a = worldToCanonical(map, drag.from);
        const b = worldToCanonical(map, p.world);
        gridState.setState({ box: { ...drag.start, x: drag.start.x + b.x - a.x, y: drag.start.y + b.y - a.y } });
      } else {
        const cam = ctx.camera();
        const moved = drag.moved || distance(worldToScreen(cam, drag.from), p.screen) > TAP_PX;
        if (!moved) return;
        gridState.setState({ drag: { ...drag, moved }, box: boxFromDrag(map, drag.from, p.world) });
      }
    },
    up(p, ctx) {
      const gridState = ctx.scope.get(gridSlot);
      const map = ctx.scene.map;
      const { drag, box } = gridState.getState();
      if (!map || !drag) return;
      if (drag.kind === "new" && !drag.moved) {
        // A tap: the same box size, moved to the squares under the finger.
        const size = drag.start?.size ?? 3 * map.cellPx;
        const at = boxAtCell(map, Math.floor(p.world.x) - 1, Math.floor(p.world.y) - 1);
        gridState.setState({ drag: null, box: { ...at, size } });
        return;
      }
      // A box dragged to nothing keeps the one before it.
      if (box && box.size < 3) gridState.setState({ drag: null, box: drag.start });
      else gridState.setState({ drag: null });
    },
    cancel(ctx) {
      const gridState = ctx.scope.get(gridSlot);
      const { drag } = gridState.getState();
      if (drag) gridState.setState({ drag: null, box: drag.start });
    },
  },
  Options: () => (
    <Suspense fallback={<Loading text="Loading the options…" />}>
      <Options />
    </Suspense>
  ),
};
