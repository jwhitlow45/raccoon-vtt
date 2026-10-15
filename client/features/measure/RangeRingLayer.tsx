import { memo, useMemo } from "react";
import { Group, Shape } from "react-konva";
import type { Token } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { useLiveTokens } from "../areas/useLiveTokens.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "./Pill.tsx";
import { ringShape, type RingShape } from "./rings.ts";
import type { DistanceRules } from "./ruler.ts";

/**
 * Range rings around tokens (features section 4), on the overlay layer. A
 * token carries its rings, so every viewer who receives the token draws
 * them (design 7.3), and a ring is only its token's spot and a distance, so
 * it may cross the fog: a player sees how far a bow reaches into the dark,
 * and nothing of what is there. Under the fog a ring's label was cut off
 * wherever the dark began. They follow a token being dragged, here or on
 * another device, as an aura does.
 */

const DISPOSITION: Record<Token["disposition"], string> = { ally: theme.color.ally, neutral: theme.color.neutral, hostile: theme.color.hostile };
const LINE_PX = 2;
const HALO_PX = 4;

export const RangeRingLayer = memo(function RangeRingLayer(props: LayerProps) {
  const { tokens } = useLiveTokens();
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const diagonal = useRoomView((s) => s.view?.meta.settings.diagonal ?? "five");
  const rules = useMemo<DistanceRules>(() => ({ feetPerCell, diagonal }), [feetPerCell, diagonal]);
  const ringed = Object.values(tokens).filter((t) => t.sceneId === props.scene.id && (t.rangeRings?.length ?? 0) > 0);
  if (ringed.length === 0) return null;
  return (
    <Group listening={false}>
      {ringed.map((t) => (
        <TokenRings key={t.id} token={t} rules={rules} bounds={props.scene.bounds} scale={props.scale} />
      ))}
    </Group>
  );
});

function TokenRings(props: { token: Token; rules: DistanceRules; bounds: { w: number; h: number }; scale: number }) {
  const { token, rules, bounds } = props;
  const { x, y, elevation, size, w, h, height } = token;
  const rings = token.rangeRings ?? [];
  const key = rings.join(",");
  const shapes = useMemo(
    () => rings.map((ft) => ({ ft, shape: ringShape({ x, y, elevation, size, w, h, height }, ft, rules, bounds) })),
    // The ring list is compared by its contents, so a token update that keeps it costs nothing.
    [key, x, y, elevation, size, w, h, height, rules, bounds.w, bounds.h],
  );
  const color = DISPOSITION[token.disposition] ?? theme.color.neutral;
  return (
    <>
      {shapes.map(({ ft, shape }) => (
        <Ring key={ft} ft={ft} shape={shape} color={color} scale={props.scale} />
      ))}
    </>
  );
}

function Ring(props: { ft: number; shape: RingShape; color: string; scale: number }) {
  const { shape, color } = props;
  if (shape.segments.length === 0) return null;
  const trace = (ctx: { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void }) => {
    const s = shape.segments;
    ctx.beginPath();
    for (let i = 0; i + 3 < s.length; i += 4) {
      ctx.moveTo(s[i]!, s[i + 1]!);
      ctx.lineTo(s[i + 2]!, s[i + 3]!);
    }
  };
  return (
    <>
      <Shape
        sceneFunc={(ctx, node) => {
          trace(ctx);
          ctx.strokeShape(node);
        }}
        stroke={theme.color.textHalo}
        opacity={0.35}
        strokeWidth={HALO_PX}
        strokeScaleEnabled={false}
        lineCap="square"
        perfectDrawEnabled={false}
        listening={false}
      />
      <Shape
        sceneFunc={(ctx, node) => {
          trace(ctx);
          ctx.strokeShape(node);
        }}
        stroke={color}
        strokeWidth={LINE_PX}
        strokeScaleEnabled={false}
        dash={[8, 5]}
        lineCap="square"
        perfectDrawEnabled={false}
        listening={false}
      />
      {shape.label ? (
        <Pill x={shape.label.x} y={shape.label.y} scale={props.scale} value={`${props.ft} ft`} size="map" color={color} small above={!shape.label.below} below={shape.label.below} />
      ) : null}
    </>
  );
}
