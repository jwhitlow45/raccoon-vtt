import { useMemo } from "react";
import { Shape } from "react-konva";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BuildChunk } from "#shared/model.ts";
import { deriveWalls, indexBuild } from "#shared/rules/walls.ts";
import { useBoardView } from "../../../canvas/boardView.ts";
import { measurePill } from "../../../canvas/measureText.ts";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import type { LayerProps } from "../../layers.ts";
import { clipRect, parseCellKey, rectBetween } from "../cells.ts";
import { useBuilderStore } from "../store.ts";
import { drawMark, drawPills, heightTextSizes, placeHeightPills } from "./boardText.ts";
import { stairCells } from "./relief.ts";
import { heightRegions } from "./regions.ts";
import { useHeightStore, type HeightState } from "./store.ts";

const EMPTY: Record<string, BuildChunk> = {};
/** At most this many numbers, the largest regions first, so a scene painted cell by cell stays quick to draw. */
const MAX_NUMBERS = 300;
/** Below this many screen pixels per cell a "?" would cover its neighbors, so the DM zooms in to see them. */
const MARK_MIN_SCALE = 8;

/** A pill's text measured in the font drawPills draws it in, and cached, as the board's other pills are. */
const measureBoardPill = (text: string, px: number) => measurePill(text, px, theme.font.body);

/**
 * Height mode's marks on the overlay, for the DM while the mode is open
 * (docs/design-v1-maps-vision.md section 4.2): each raised or lowered
 * region's height, a "?" on each stair the rule cannot point, and the
 * stroke or area being painted. It draws in the slot under the token decor
 * (features/layers.ts `underDecor`): over the tokens, so a creature on a
 * platform never hides its number, and under their names, chips and plates,
 * so a name always reads. Each pill also keeps off the placed names,
 * plates, chips, elevation badges and HP bars, so none hides under one
 * (docs/design-v1-visual.md 3.4).
 */
export function HeightLayer(props: LayerProps) {
  const building = useRoomView((s) => s.local.tool === "build");
  const heightMode = useStore(useBuilderStore(), (b) => b.mode === "height");
  if (props.role !== "dm" || !building || !heightMode) return null;
  return <HeightMarks {...props} />;
}

function HeightMarks(props: LayerProps) {
  const { scene, scale, labelBoxes } = props;
  const view = useBoardView();
  const allChunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY);
  const chunks = useMemo(() => Object.values(allChunks).filter((c): c is BuildChunk => !!c && c.sceneId === scene.id), [allChunks, scene.id]);
  const { w, h } = scene.bounds;
  // The largest regions get numbers, and the smallest of those place theirs first, since they have the fewest spots to choose from.
  const regions = useMemo(() => heightRegions(chunks, { w, h }).slice(0, MAX_NUMBERS).reverse(), [chunks, w, h]);
  const unsettled = useMemo(() => {
    const walls = deriveWalls(indexBuild(chunks), "heights", { rule: scene.autoWalls ?? "all", bounds: { w, h } });
    return stairCells(chunks, walls).filter((c) => c.dir === null && c.x < w && c.y < h);
  }, [chunks, scene.autoWalls, w, h]);
  const { pill, markPx } = heightTextSizes(scale);
  // Placed once per zoom, interface size and set of names, not on every draw, since a pan changes none of them (LayerProps `labelBoxes`).
  const pills = useMemo(() => placeHeightPills(regions, labelBoxes, scale, pill, measureBoardPill), [regions, labelBoxes, scale, pill.fontPx]);
  const gesture = useStore(
    useHeightStore(),
    useShallow((s) => ({ unsent: s.unsent, area: s.area, paint: s.paint, height: s.height, stairs: s.stairs })),
  );

  return (
    <>
      <Preview {...gesture} bounds={scene.bounds} scale={scale} />
      {pills.length > 0 || unsettled.length > 0 ? (
        <Shape
          listening={false}
          perfectDrawEnabled={false}
          sceneFunc={(ctx) => {
            const g = ctx._context;
            if (scale >= MARK_MIN_SCALE) for (const c of unsettled) drawMark(g, "?", c.x + 0.5, c.y + 0.5, scale, markPx, theme.color.accentSoft);
            drawPills(g, pills, scale, view);
          }}
        />
      ) : null}
    </>
  );
}

/** The stroke or area being painted, in a wash that says what it does: lighter to raise, darker to lower, red to clear, the accent for stairs. */
function Preview(props: Pick<HeightState, "unsent" | "area" | "paint" | "height" | "stairs"> & { bounds: { w: number; h: number }; scale: number }) {
  const { unsent, area, bounds } = props;
  const area2 = area ? clipRect(rectBetween(area.a, area.b), bounds) : null;
  if (unsent.length === 0 && !area2) return null;
  const clearing = props.paint === "height" ? props.height === 0 : props.stairs === "remove";
  const fill = clearing
    ? "rgba(229, 72, 77, 0.4)"
    : props.paint === "stairs"
      ? "rgba(247, 223, 0, 0.35)"
      : props.height > 0
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(0, 0, 0, 0.45)";
  const edge = clearing ? theme.color.danger : theme.color.accent;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const g = ctx._context;
        g.save();
        g.fillStyle = fill;
        g.beginPath();
        if (area2) g.rect(area2.x, area2.y, area2.w, area2.h);
        for (const key of unsent) {
          const c = parseCellKey(key);
          g.rect(c.x, c.y, 1, 1);
        }
        g.fill();
        if (area2) {
          g.strokeStyle = edge;
          g.lineWidth = 2 / props.scale;
          g.strokeRect(area2.x, area2.y, area2.w, area2.h);
        }
        g.restore();
      }}
    />
  );
}
