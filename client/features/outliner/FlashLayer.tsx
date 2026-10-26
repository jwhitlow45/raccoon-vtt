import { Line, Rect } from "react-konva";
import { convexHull } from "#shared/rules/aoe.ts";
import { Lift, Upright } from "../../canvas/IsoParts.tsx";
import { boxGround } from "../../canvas/isoPlace.ts";
import { useIsoGround, useTreeShownStore, useTreeShownView, type IsoGround } from "../../canvas/relief/context.ts";
import { accentFor } from "../../lib/accent.ts";
import { isometric, toView } from "../../lib/view.ts";
import { useScoped } from "../../state/scope.ts";
import type { LayerProps } from "../layers.ts";
import { flashSlot, type Flash } from "./flash.ts";

/**
 * The outliner's flash on the map (flash.ts): a door's line, or a dashed box
 * round a drawing, in the viewer's accent, for 1.5 s. It draws once
 * and goes, with no animation loop. In Isometric it draws in the drag layer
 * (docs/design-v1-isometric-view.md 5.3), bounding what it flashes as the
 * ground stage draws it, each cell at its own drawn height (`flashShape`).
 */
export function FlashLayer(props: LayerProps) {
  const current = useTreeShownStore(useScoped(flashSlot).store, (s) => s.flash);
  const color = useTreeShownView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined));
  const iso = useIsoGround();
  if (props.role !== "dm" || !current || current.sceneId !== props.scene.id) return null;
  const { accent } = accentFor(color);
  const px = 1 / props.scale;
  const shape = flashShape(iso, current, props.scale);
  if (shape.kind === "line") {
    return (
      <Lift z={shape.z}>
        <Line points={shape.points} stroke={accent} strokeWidth={8 * px} lineCap="round" opacity={0.9} listening={false} />
      </Lift>
    );
  }
  const dashed = { stroke: accent, strokeWidth: 3 * px, dash: [8 * px, 5 * px], listening: false };
  if (shape.kind === "hull") {
    return (
      <Upright>
        <Line points={shape.points} closed lineJoin="round" {...dashed} />
      </Upright>
    );
  }
  return (
    <Lift z={shape.z}>
      <Rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} cornerRadius={4 * px} {...dashed} />
    </Lift>
  );
}

/** How a flash draws: a line or a box in cells on the ground plane at `z`, or, round cells at several heights, an outline in view units. */
export type FlashShape =
  | { kind: "line"; points: number[]; z: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; z: number }
  | { kind: "hull"; points: number[] };

/**
 * Where a flash draws. A door's line lies at the highest drawn ground of
 * the cells either side of it (`boxGround`), where relief/runs.ts stands
 * its piece. A box lies round its cells, padded 6 px, at their drawn
 * ground when they share one, and otherwise becomes the outline round the
 * box seen at both the lowest and the highest drawn ground under it, so
 * every fragment the ground stage draws of a drawing across a ledge lies
 * inside it.
 */
export function flashShape(iso: Pick<IsoGround, "turn" | "ground"> | null, flash: Pick<Flash, "rect" | "segment">, scale: number): FlashShape {
  if (flash.segment) {
    const { a, b } = flash.segment;
    // A quarter cell either side takes in the cells the line divides, and no more.
    const side = { x0: Math.min(a.x, b.x) - 0.25, y0: Math.min(a.y, b.y) - 0.25, x1: Math.max(a.x, b.x) + 0.25, y1: Math.max(a.y, b.y) + 0.25 };
    return { kind: "line", points: [a.x, a.y, b.x, b.y], z: iso ? boxGround(iso, side) : 0 };
  }
  const pad = 6 / scale;
  const { x, y, width, height } = flash.rect;
  const box = { kind: "rect" as const, x: x - pad, y: y - pad, width: width + pad * 2, height: height + pad * 2 };
  if (!iso) return { ...box, z: 0 };
  const cells = { x0: x, y0: y, x1: x + width, y1: y + height };
  const high = boxGround(iso, cells);
  // The lowest, by the same walk over the cells with the ground turned over.
  const low = -boxGround({ ground: (cx, cy) => -iso.ground(cx, cy) }, cells);
  if (low === high) return { ...box, z: high };
  const view = isometric(iso.turn);
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x, y: box.y + box.height },
    { x: box.x + box.width, y: box.y + box.height },
  ];
  const seen = convexHull([low, high].flatMap((z) => corners.map((c) => toView(view, c, z))));
  return { kind: "hull", points: seen.flatMap((p) => [p.x, p.y]) };
}
