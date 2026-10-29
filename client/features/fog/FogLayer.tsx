import { memo, useMemo } from "react";
import { Circle, Line, Rect, Shape } from "react-konva";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { FogDraft, FogOp, GridShape } from "#shared/model.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { draftOutlines, rectShape } from "./shapes.ts";
import { useFogStore } from "./store.ts";

/** Reveals outline in the crest yellow, hides in red. */
const REVEAL = theme.color.crest;
const HIDE = "#ff7a7a";

/**
 * The DM's fog draft, outlined over the committed fog (design 13.3), and the
 * fog gesture in progress. Drafts exist only in a DM's projection, so a
 * player's view never has one to draw, and this returns nothing for players
 * either way.
 */
export function FogLayer(props: LayerProps) {
  const { scene, role, scale } = props;
  const draft = useRoomView((s) => s.view?.fogDrafts[scene.id]);
  const active = useRoomView((s) => s.local.tool === "fog");
  if (role !== "dm") return null;
  return (
    <>
      {draft && draft.ops.length > 0 ? <DraftOutline draft={draft} bounds={scene.bounds} shape={scene.gridShape} /> : null}
      {active ? <FogPreview scale={scale} /> : null}
    </>
  );
}

const DraftOutline = memo(function DraftOutline(props: { draft: FogDraft; bounds: { w: number; h: number }; shape: GridShape | undefined }) {
  const { draft, bounds, shape } = props;
  // "Cells" ops are outlined along their edit's edge, computed once per draft change.
  const outlines = useMemo(() => draftOutlines(draft.ops, gridOfShape(shape)), [draft, shape]);
  return <>{draft.ops.map((op) => <OpOutline key={op.id} op={op} bounds={bounds} cells={outlines.get(op.id)} />)}</>;
});

/** Outlines stay 2 px wide with a 6 px dash at any zoom: with strokeScaleEnabled off, Konva strokes in screen pixels. */
const DASH = [6, 4];

function OpOutline(props: { op: FogOp; bounds: { w: number; h: number }; cells?: number[] }) {
  const { op, bounds } = props;
  const color = op.mode === "reveal" ? REVEAL : HIDE;
  const fill = op.mode === "reveal" ? "rgba(247, 223, 0, 0.10)" : "rgba(255, 122, 122, 0.12)";
  const brush = op.mode === "reveal" ? "rgba(247, 223, 0, 0.30)" : "rgba(255, 122, 122, 0.30)";
  const common = { stroke: color, strokeWidth: 2, strokeScaleEnabled: false, dash: DASH, listening: false, perfectDrawEnabled: false } as const;
  const shape = op.shape;
  switch (shape.kind) {
    case "all":
      return <Rect x={0} y={0} width={bounds.w} height={bounds.h} fill={fill} {...common} />;
    case "rect":
      return <Rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill={fill} {...common} />;
    case "poly":
      return <Line points={shape.points} closed fill={fill} {...common} />;
    case "stroke":
      return shape.points.length === 2 ? (
        <Circle x={shape.points[0]} y={shape.points[1]} radius={shape.width / 2} fill={fill} {...common} />
      ) : (
        <Line points={shape.points} stroke={brush} strokeWidth={shape.width} lineCap="round" lineJoin="round" listening={false} perfectDrawEnabled={false} />
      );
    case "cells": {
      const segments = props.cells ?? [];
      return (
        <Shape
          {...common}
          sceneFunc={(ctx, s) => {
            ctx.beginPath();
            for (let i = 0; i < segments.length; i += 4) {
              ctx.moveTo(segments[i]!, segments[i + 1]!);
              ctx.lineTo(segments[i + 2]!, segments[i + 3]!);
            }
            ctx.strokeShape(s);
          }}
        />
      );
    }
  }
}

function FogPreview(props: { scale: number }) {
  const { scale } = props;
  const { mode, rect, poly, stroke, width } = useStore(
    useFogStore(),
    useShallow((f) => ({ mode: f.mode, rect: f.rect, poly: f.poly, stroke: f.stroke, width: f.width })),
  );
  const color = mode === "reveal" ? REVEAL : HIDE;
  const box = rect ? rectShape(rect.a, rect.b) : null;
  return (
    <>
      {box ? <Rect x={box.x} y={box.y} width={box.w} height={box.h} stroke={color} strokeWidth={2} strokeScaleEnabled={false} fill="rgba(255, 255, 255, 0.08)" listening={false} /> : null}
      {stroke.length > 0 ? (
        <Line
          points={stroke.flatMap((p) => [p.x, p.y])}
          stroke={color}
          opacity={0.45}
          strokeWidth={width}
          lineCap="round"
          lineJoin="round"
          listening={false}
          perfectDrawEnabled={false}
        />
      ) : null}
      {poly.length > 0 ? (
        <>
          <Line points={poly.flatMap((p) => [p.x, p.y])} stroke={color} strokeWidth={2} strokeScaleEnabled={false} listening={false} />
          {poly.map((p, i) => (
            <Circle
              key={i}
              x={p.x}
              y={p.y}
              radius={(i === 0 && poly.length >= 3 ? 11 : 5) / scale}
              fill={color}
              stroke="#000000"
              strokeWidth={1}
              strokeScaleEnabled={false}
              listening={false}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
