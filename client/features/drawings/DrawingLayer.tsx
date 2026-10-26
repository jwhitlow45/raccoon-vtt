import { memo } from "react";
import { Arrow, Circle, Ellipse, Group, Line, Rect, Text } from "react-konva";
import type { Drawing, DrawingKind, RoomState } from "#shared/model.ts";
import { drawsHere, viewPointOf } from "../../canvas/isoPlace.ts";
import { groundPieces, markStands, type GroundPiece } from "../../canvas/markStand.ts";
import { measurePill } from "../../canvas/measureText.ts";
import { useIsoGround, useTreeShownStore, useTreeShownView, type IsoGround } from "../../canvas/relief/context.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { Clipped } from "../areas/TemplateLayer.tsx";
import type { LayerProps } from "../layers.ts";
import { drawSlot, type DrawToolState } from "./store.ts";
import { bounds, fillFor, strokeCells, textCells } from "./geometry.ts";
import { textDrawingBox, type MeasureEm } from "./textBox.ts";

/**
 * Drawings on the board layer (design section 14.2), under the tokens and
 * under the fog, and the stroke this device is drawing right now.
 *
 * Sizes are in cells (geometry.ts), so a drawing grows and shrinks with
 * the map. A DM-only drawing shows faded on the DM's own screen, so the DM
 * can tell it apart. Players never receive one.
 *
 * In Isometric drawings lie on the ground stage, and a text drawing stands
 * on the overlay by the stand rule, else lies flat under the fog. The stroke
 * being drawn moves in the drag layer, so drawing never redraws the ground,
 * each part on its own cell's drawn ground and, for a player, cut to the
 * revealed sub-cells that Top-down's fog would show it over
 * (docs/design-v1-isometric-view.md 5.2 and 5.3).
 */

const EMPTY: RoomState["drawings"] = {};

/** A line's width in ems of the bold board font that text drawings use. */
const measureEm: MeasureEm = (line) => measurePill(line, 100, theme.font.body) / 100;

export const DrawingLayer = memo(function DrawingLayer(props: LayerProps) {
  const drawings = useTreeShownView((s) => s.view?.drawings ?? EMPTY);
  const tool$ = useScoped(drawSlot).store;
  const draft = useTreeShownStore(tool$, (s) => s.draft);
  const textAt = useTreeShownStore(tool$, (s) => s.textAt);
  const color = useTreeShownStore(tool$, (s) => s.color);
  const width = useTreeShownStore(tool$, (s) => s.width);
  const opacity = useTreeShownStore(tool$, (s) => s.opacity);
  const fill = useTreeShownStore(tool$, (s) => s.fill);
  const tool = useTreeShownView((s) => s.local.tool);
  const memberColor = useTreeShownView((s) => (s.you ? s.view?.members[s.you.memberId]?.color : undefined)) ?? theme.color.crest;
  const iso = useIsoGround();
  // Kept rulers are drawings in the state, drawn and measured by the ruler layer (features/measure).
  const list = Object.values(drawings).filter((d): d is Drawing => !!d && d.sceneId === props.scene.id && d.kind !== "ruler");
  const drawing = tool === "draw";
  if (list.length === 0 && !(drawing && (draft || textAt))) return null;
  const stroke = color ?? memberColor;
  // The stored drawings lie on the ground, a standing text on the overlay, and the stroke being drawn moves in the drag layer.
  const stored = iso === null || iso.place !== "moving";
  const live = iso === null || iso.place === "moving";
  return (
    <Group listening={false}>
      {stored
        ? list.map((d) =>
            d.kind === "text" && iso ? (
              <IsoText key={d.id} drawing={d} iso={iso} />
            ) : iso?.place === "upright" ? null : (
              <DrawingShape key={d.id} kind={d.kind} points={d.points} style={d.style} text={d.text} faded={d.visibility === "dm"} />
            ),
          )
        : null}
      {live && drawing ? <Draft iso={iso} draft={draft} textAt={textAt} stroke={stroke} width={width} opacity={opacity} fill={fill} scale={props.scale} /> : null}
    </Group>
  );
});

/**
 * A text drawing in Isometric: upright on the overlay, standing on the
 * middle of its Top-down box at the drawn ground there, when every sub-cell
 * that box touches is revealed to this viewer, and otherwise flat on the
 * ground stage under the fog, as Top-down draws it (5.2).
 */
function IsoText(props: { drawing: Drawing; iso: IsoGround }) {
  const { drawing: d, iso } = props;
  const stands = markStands(iso.fog, textDrawingBox(d, measureEm));
  if (!drawsHere(iso, stands)) return null;
  if (iso.place === "ground") return <DrawingShape kind={d.kind} points={d.points} style={d.style} text={d.text} faded={d.visibility === "dm"} />;
  const size = textCells(d.style.width);
  const lines = (d.text ?? "").split("\n");
  const w = Math.max(0, ...lines.map((l) => measureEm(l))) * size;
  const h = lines.length * size;
  const x = d.points[0] ?? 0;
  const y = d.points[1] ?? 0;
  const v = viewPointOf(iso, { x: x + w / 2, y: y + h / 2 });
  return <DrawingShape kind={d.kind} points={[v.x - w / 2, v.y - h]} style={d.style} text={d.text} faded={d.visibility === "dm"} />;
}

type Point = { x: number; y: number };

/** How the stroke being drawn draws: its shape's points, a polygon's corner handles and the dot where a text will go, all in cells, and the pieces of the ground it lies on. */
export type DraftDrawn = {
  kind: DrawingKind;
  points: number[];
  handles: number[];
  dot: Point | null;
  pieces: GroundPiece[];
};

const FLAT: GroundPiece[] = [{ lift: { x: 0, y: 0 }, clip: null }];

/**
 * The stroke this device is drawing, as it draws: in Top-down as it is. In
 * Isometric's drag layer it lies as the ground stage will lay it once
 * stored, each part on its own cell's drawn ground (canvas/markStand.ts
 * groundPieces), so it stays under the finger across heights and does not
 * jump at the drop. Top-down draws a draft on the board layer, under the
 * fog, so for a player each part is cut to the revealed sub-cells of the
 * box it paints before it is lifted: its fill, stroke, arrowhead and
 * handles show nothing over a fogged sub-cell, and nothing drawn over fog
 * lands on a revealed top.
 */
export function draftDrawn(
  iso: Pick<IsoGround, "fog" | "turn" | "ground"> | null,
  draft: DrawToolState["draft"],
  textAt: Point | null,
  width: number,
  scale: number,
): DraftDrawn {
  const kind: DrawingKind = !draft ? "line" : draft.kind === "polygon" ? "line" : draft.kind;
  const points = draft?.points ?? [];
  const drawn = { kind, points, handles: draft?.kind === "polygon" ? points : [], dot: textAt };
  if (!iso) return { ...drawn, pieces: FLAT };
  return { ...drawn, pieces: groundPieces(iso, paintBox(draft?.kind ?? "line", textAt ? [...points, textAt.x, textAt.y] : points, width, scale)) };
}

/**
 * The box a draft paints in cells: its points grown by an arrowhead's
 * reach (it is four strokes long and wide), the round caps' half stroke,
 * the handles' 7 px and their 1 px rim, and a free stroke's curve, whose
 * control points stay within 0.3 of the neighboring segments.
 */
function paintBox(kind: DrawingKind, pts: readonly number[], width: number, scale: number) {
  const b = bounds(pts);
  let curve = 0;
  if (kind === "free") for (let i = 2; i + 1 < pts.length; i += 2) curve = Math.max(curve, Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!));
  const pad = 3 * strokeCells(width) + 8 / scale + 0.6 * curve;
  return { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
}

/** The stroke this device is drawing now, and the dot where a text will go, as draftDrawn places them. */
function Draft(props: {
  iso: IsoGround | null;
  draft: DrawToolState["draft"];
  textAt: Point | null;
  stroke: string;
  width: number;
  opacity: number;
  fill: boolean;
  scale: number;
}) {
  const { draft, stroke, width, opacity, fill, scale } = props;
  const at = draftDrawn(props.iso, draft, props.textAt, width, scale);
  const marks = (
    <>
      {draft ? <DrawingShape kind={at.kind} points={at.points} style={{ stroke, width, opacity, fill: fill ? fillFor(stroke) : undefined }} /> : null}
      {Array.from({ length: at.handles.length / 2 }, (_, i) => (
        <Circle key={i} x={at.handles[2 * i]} y={at.handles[2 * i + 1]} radius={(i === 0 ? 7 : 4) / scale} fill={stroke} stroke={theme.color.textHalo} strokeWidth={1} strokeScaleEnabled={false} />
      ))}
      {at.dot ? <Circle x={at.dot.x} y={at.dot.y} radius={5 / scale} fill={stroke} stroke={theme.color.textHalo} strokeWidth={1} strokeScaleEnabled={false} /> : null}
    </>
  );
  return (
    <>
      {at.pieces.map((piece, i) => (
        <Group key={i} x={piece.lift.x} y={piece.lift.y} listening={false}>
          {piece.clip ? <Clipped rects={piece.clip}>{marks}</Clipped> : marks}
        </Group>
      ))}
    </>
  );
}

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
