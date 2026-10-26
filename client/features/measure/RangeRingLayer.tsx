import { memo, useMemo } from "react";
import { Group, Shape } from "react-konva";
import type { Token } from "#shared/model.ts";
import { useDraggedIds } from "../../canvas/draggedIds.ts";
import { MarkPill } from "../../canvas/IsoParts.tsx";
import { useIsoGround, useTreeShownView } from "../../canvas/relief/context.ts";
import { theme } from "../../lib/theme.ts";
import { DISPOSITION_RING } from "../../lib/tokenView.ts";
import { useLiveTokens } from "../areas/useLiveTokens.ts";
import type { LayerProps } from "../layers.ts";
import { ringShape, type RingShape } from "./rings.ts";
import { RING_DASH, ringScene } from "./ringScene.ts";
import type { DistanceRules } from "./ruler.ts";

/**
 * Range rings around tokens (features section 4), on the overlay layer. A
 * token carries its rings, so every viewer who receives the token draws
 * them (design 7.3), and a ring is only its token's spot and a distance, so
 * it may cross the fog: a player sees how far a bow reaches into the dark,
 * and nothing of what is there. Under the fog a ring's label was cut off
 * wherever the dark began. They follow a token being dragged, here or on
 * another device, as an aura does.
 *
 * In Isometric the rings lie on the ground stage and their labels stand on
 * the overlay at the drawn height under them, since Top-down draws both
 * above the fog. A token being dragged takes its rings into the drag's
 * moving marks until the drop (canvas/DragMarks.tsx), so a drag never
 * redraws the ground (docs/design-v1-isometric-view.md 5.1).
 */

const LINE_PX = 2;
const HALO_PX = 4;

export const RangeRingLayer = memo(function RangeRingLayer(props: LayerProps) {
  const { tokens } = useLiveTokens();
  const feetPerCell = useTreeShownView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const diagonal = useTreeShownView((s) => s.view?.meta.settings.diagonal ?? "five");
  const rules = useMemo<DistanceRules>(() => ({ feetPerCell, diagonal }), [feetPerCell, diagonal]);
  const iso = useIsoGround();
  const dragged = useDraggedIds();
  const ringed = Object.values(tokens).filter((t) => t.sceneId === props.scene.id && (t.rangeRings?.length ?? 0) > 0 && !(iso && dragged.all.has(t.id)));
  if (ringed.length === 0) return null;
  const part = iso === null ? "both" : iso.place === "upright" ? "labels" : "rings";
  return (
    <Group listening={false}>
      {ringed.map((t) => (
        <TokenRings key={t.id} token={t} rules={rules} bounds={props.scene.bounds} scale={props.scale} part={part} />
      ))}
    </Group>
  );
});

/**
 * A token's rings and their labels. `part` draws one of the two: the rings
 * on the isometric ground, the labels standing on its overlay, or a dragged
 * token's moving marks (canvas/DragMarks.tsx).
 */
export function TokenRings(props: { token: Token; rules: DistanceRules; bounds: { w: number; h: number }; scale: number; part: "both" | "rings" | "labels"; z?: number }) {
  const { token, rules, bounds } = props;
  const { x, y, elevation, size, w, h, height } = token;
  const rings = token.rangeRings ?? [];
  const key = rings.join(",");
  const shapes = useMemo(
    () => rings.map((ft) => ({ ft, shape: ringShape({ x, y, elevation, size, w, h, height }, ft, rules, bounds) })),
    // The ring list is compared by its contents, so a token update that keeps it costs nothing.
    [key, x, y, elevation, size, w, h, height, rules, bounds.w, bounds.h],
  );
  const color = DISPOSITION_RING[token.disposition] ?? theme.color.neutral;
  return (
    <>
      {shapes.map(({ ft, shape }) => (
        <Ring key={ft} ft={ft} shape={shape} color={color} scale={props.scale} part={props.part} z={props.z} />
      ))}
    </>
  );
}

function Ring(props: { ft: number; shape: RingShape; color: string; scale: number; part: "both" | "rings" | "labels"; z: number | undefined }) {
  const { shape, color, part } = props;
  if (shape.segments.length === 0) return null;
  // One scene function per shape (rings.ts ringScene), so a render that keeps the shape hands Konva the same function and the layer does not redraw.
  const scene = ringScene(shape);
  return (
    <>
      {part !== "labels" ? (
        <>
          <Shape
            sceneFunc={scene}
            stroke={theme.color.textHalo}
            opacity={0.35}
            strokeWidth={HALO_PX}
            strokeScaleEnabled={false}
            lineCap="square"
            perfectDrawEnabled={false}
            listening={false}
          />
          <Shape sceneFunc={scene} stroke={color} strokeWidth={LINE_PX} strokeScaleEnabled={false} dash={RING_DASH} lineCap="square" perfectDrawEnabled={false} listening={false} />
        </>
      ) : null}
      {part !== "rings" && shape.label ? (
        <MarkPill x={shape.label.x} y={shape.label.y} z={props.z} scale={props.scale} value={`${props.ft} ft`} size="map" color={color} small above={!shape.label.below} below={shape.label.below} />
      ) : null}
    </>
  );
}
