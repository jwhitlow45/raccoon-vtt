import { memo, useEffect, useMemo, useState } from "react";
import { Shape } from "react-konva";
import { theme } from "../../lib/theme.ts";
import { isometric, toView, type Turn } from "../../lib/view.ts";
import type { BandPart } from "../../features/areas/volume.ts";
import type { VolumePiece } from "./buckets.ts";
import { cameraOfStage } from "../../lib/camera.ts";
import { drawVolume, viewSpaceOf, type VolumeLook } from "./drawRelief.ts";
import { sideOf, wholeVolume, type VolumeWorld, type WholeRequest } from "./volumes.ts";

/**
 * An area's bands drawn as one run outside the depth list
 * (docs/design-v1-iso-area-shapes.md 4.5): in the drag layer while it is
 * aimed or moves with its token, or on the overlay for another member's
 * drag or preview. It draws in view units from its stage's camera,
 * whatever group holds it, and takes no presses.
 */
export const VolumeShape = memo(function VolumeShape(props: { pieces: readonly VolumePiece[]; turn: Turn }) {
  const { pieces, turn } = props;
  if (pieces.length === 0) return null;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        const stage = shape.getStage();
        const layer = shape.getLayer();
        if (!stage || !layer) return;
        const camera = cameraOfStage(stage);
        const g = ctx._context;
        viewSpaceOf(g, camera, layer.getCanvas().getPixelRatio());
        const high: BandPart[] = [];
        const low: BandPart[] = [];
        for (const p of pieces) {
          for (const d of p.draws) {
            high.push(d.high);
            low.push(d.low);
          }
        }
        drawVolume(g, high, low, pieces[0]!.pits, pieces[0]!.look, turn, 1 / camera.scale);
      }}
    />
  );
});

/** Time a render gives a volume drawn whole before it shows flat and carries on in the next frame. */
const SLICE_MS = 4;

/**
 * A coarse volume drawn whole outside the depth list (relief/volumes.ts
 * wholeVolume), built in slices across frames while it has more to do,
 * nothing meanwhile, so the flat mark drawn with it shows. `side` draws
 * only the bands behind a key or only those at or in front of it: an aura
 * dragged here draws around its own standee in two passes (design 4.5).
 */
export function WholeVolume(props: { req: WholeRequest; id: string; look: VolumeLook; turn: Turn; world: VolumeWorld; side?: { key: number; part: "behind" | "front" } }) {
  const { req, id, look, turn, world, side } = props;
  const [, setTick] = useState(0);
  const got = wholeVolume(req, id, look, turn, world, performance.now() + SLICE_MS);
  const more = got.more;
  useEffect(() => {
    if (!more) return;
    const frame = requestAnimationFrame(() => setTick((t) => t + 1));
    return () => cancelAnimationFrame(frame);
  });
  const pieces = got.pieces;
  const shown = useMemo(() => (pieces && side ? sideOf(pieces, side.key, side.part) : pieces), [pieces, side?.key, side?.part]);
  return shown ? <VolumeShape pieces={shown} turn={turn} /> : null;
}

/** A dashed 1 px line straight up from a point on the drawn ground to a height, in view units: from an area's origin grip to its raised origin (design 4.5). */
export function UprightDash(props: { x: number; y: number; z0: number; z1: number; turn: Turn; color: string }) {
  const { x, y, z0, z1, turn, color } = props;
  if (!(z1 > z0 + 1e-6)) return null;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx, shape) => {
        const stage = shape.getStage();
        const layer = shape.getLayer();
        if (!stage || !layer) return;
        const camera = cameraOfStage(stage);
        const g = ctx._context;
        viewSpaceOf(g, camera, layer.getCanvas().getPixelRatio());
        const view = isometric(turn);
        const a = toView(view, { x, y }, z0);
        const b = toView(view, { x, y }, z1);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.strokeStyle = color;
        g.lineWidth = theme.area.thinWidthPx / camera.scale;
        g.setLineDash(theme.area.hiddenDash.map((d) => d / camera.scale));
        g.stroke();
      }}
    />
  );
}
