import { memo } from "react";
import { Arrow, Circle, Ellipse, Group, Line, Rect, Text } from "react-konva";
import type { Drawing, DrawingKind, RoomState } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { useDrawTool } from "./DrawTool.tsx";
import { bounds, fillFor, strokeCells, textCells } from "./geometry.ts";

/**
 * Drawings on the board layer (design section 14.2), under the tokens and
 * under the fog, and the stroke this device is drawing right now.
 *
 * Sizes are in cells (geometry.ts), so a drawing grows and shrinks with
 * the map. A DM-only drawing shows faded on the DM's own screen, so the DM
 * can tell it apart. Players never receive one.
 */

const EMPTY: RoomState["drawings"] = {};

export const DrawingLayer = memo(function DrawingLayer(props: LayerProps) {
  const drawings = useRoomView((s) => s.view?.drawings ?? EMPTY);
  const draft = useDrawTool((s) => s.draft);
  const textAt = useDrawTool((s) => s.textAt);
  const color = useDrawTool((s) => s.color);
  const width = useDrawTool((s) => s.width);
  const opacity = useDrawTool((s) => s.opacity);
  const fill = useDrawTool((s) => s.fill);
  const tool = useRoomView((s) => s.local.tool);
  const memberColor = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined)) ?? theme.color.crest;
  // Kept rulers are drawings in the state, drawn and measured by the ruler layer (features/measure).
  const list = Object.values(drawings).filter((d): d is Drawing => !!d && d.sceneId === props.scene.id && d.kind !== "ruler");
  const drawing = tool === "draw";
  if (list.length === 0 && !(drawing && (draft || textAt))) return null;
  const stroke = color ?? memberColor;
  return (
    <Group listening={false}>
      {list.map((d) => (
        <DrawingShape key={d.id} kind={d.kind} points={d.points} style={d.style} text={d.text} faded={d.visibility === "dm"} />
      ))}
      {drawing && draft ? (
        <>
          <DrawingShape kind={draft.kind === "polygon" ? "line" : draft.kind} points={draft.points} style={{ stroke, width, opacity, fill: fill ? fillFor(stroke) : undefined }} />
          {draft.kind === "polygon"
            ? Array.from({ length: draft.points.length / 2 }, (_, i) => (
                <Circle key={i} x={draft.points[2 * i]} y={draft.points[2 * i + 1]} radius={(i === 0 ? 7 : 4) / props.scale} fill={stroke} stroke={theme.color.textHalo} strokeWidth={1} strokeScaleEnabled={false} />
              ))
            : null}
        </>
      ) : null}
      {drawing && textAt ? <Circle x={textAt.x} y={textAt.y} radius={5 / props.scale} fill={stroke} stroke={theme.color.textHalo} strokeWidth={1} strokeScaleEnabled={false} /> : null}
    </Group>
  );
});

function DrawingShape(props: { kind: DrawingKind; points: number[]; style: Drawing["style"]; text?: string; faded?: boolean }) {
  const { kind, points, style } = props;
  const sw = strokeCells(style.width);
  const common = {
    stroke: style.stroke,
    strokeWidth: sw,
    opacity: Math.max(0, Math.min(1, style.opacity)) * (props.faded ? 0.55 : 1),
    dash: style.dash?.map((v) => v / 20),
    listening: false,
    perfectDrawEnabled: false,
  };
  switch (kind) {
    case "free":
      return <Line points={points} tension={0.3} lineCap="round" lineJoin="round" {...common} />;
    case "line":
      return <Line points={points} lineCap="round" {...common} />;
    case "arrow":
      return <Arrow points={points} pointerLength={sw * 4} pointerWidth={sw * 4} fill={style.stroke} lineCap="round" {...common} />;
    case "polygon":
      return <Line points={points} closed lineJoin="round" fill={style.fill} {...common} />;
    case "rect": {
      const b = bounds(points);
      return <Rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} fill={style.fill} {...common} />;
    }
    case "ellipse": {
      const b = bounds(points);
      return <Ellipse x={(b.x0 + b.x1) / 2} y={(b.y0 + b.y1) / 2} radiusX={(b.x1 - b.x0) / 2} radiusY={(b.y1 - b.y0) / 2} fill={style.fill} {...common} />;
    }
    case "text":
      return (
        <Text
          x={points[0]}
          y={points[1]}
          text={props.text ?? ""}
          fontSize={textCells(style.width)}
          fontFamily={theme.font.body}
          fontStyle="bold"
          fill={style.stroke}
          stroke={theme.color.textHalo}
          strokeWidth={textCells(style.width) / 14}
          fillAfterStrokeEnabled
          opacity={common.opacity}
          listening={false}
        />
      );
  }
}
