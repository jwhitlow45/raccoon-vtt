import { memo, useMemo } from "react";
import { Circle, Line, Rect, Shape } from "react-konva";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { BuildChunk, Label, Light, Scene } from "#shared/model.ts";
import { theme } from "../../lib/theme.ts";
import { useAccent } from "../../state/accent.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { parseCellKey, polygonCells, rectBetween, type Point } from "./cells.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { hexesInRect, hexOutline } from "./hexBuild.ts";
import { heightSlot } from "./heights/store.ts";
import { buildPaths, CAPTION_PX, drawBuild, drawLabel, drawLightReach, drawSuns, measureLabel, pillarPaths } from "./draw.ts";
import { useIsoGround, useTreeShownView } from "../../canvas/relief/context.ts";
import { boxStands } from "../../canvas/relief/stand.ts";
import { isSymbolTerrain, type TexturedTerrain } from "./geometry.ts";
import { labelBox } from "#shared/rules/labels.ts";
import { lightCaption, lightCaptionSpot, lightReach, lightSlot, tokenBodies } from "./lightTap.ts";
import { labelPaneSlot, useBuilderStore } from "./store.ts";
import { useStampDrawing } from "./stamps/useStampDrawing.ts";
import { TERRAIN_COLORS, useTextures } from "./textures.ts";

/**
 * The build on the board layer (design section 12): one path per floor
 * texture, symbols for pits, pillars and stairs, the walls as one thick
 * path, free walls with them, doors and windows as symbols, and labels.
 * Paths are built once per change to the build, so a camera move only
 * replays them. Never bitmap-cached, for the same canvas size reason as the
 * map (section 14.2). The drawing itself is in draw.ts, shared with the map
 * export. The DM also sees the scene's lights as small suns, which players
 * never receive.
 */
export function BuilderLayer(props: LayerProps) {
  return (
    <>
      <BuildBoard sceneId={props.scene.id} grid={props.scene.grid} autoWalls={props.scene.autoWalls} bounds={props.scene.bounds} gridShape={props.scene.gridShape} role={props.role} scale={props.scale} />
      {props.role === "dm" ? <LightMarks sceneId={props.scene.id} scale={props.scale} /> : null}
      {props.role === "dm" ? <BuildPreview scene={props.scene} scale={props.scale} /> : null}
      {props.role === "dm" ? <LabelMarks /> : null}
    </>
  );
}

const EMPTY_CHUNKS: Record<string, BuildChunk> = {};
const ERASE_FILL = "rgba(229, 72, 77, 0.45)";
const EMPTY_LABELS: Record<string, Label> = {};
const EMPTY_LIGHTS: Record<string, Light> = {};

const BuildBoard = memo(function BuildBoard(props: {
  sceneId: string;
  grid: Scene["grid"];
  autoWalls: Scene["autoWalls"];
  bounds: Scene["bounds"];
  gridShape: Scene["gridShape"];
  role: "dm" | "player";
  scale: number;
}) {
  const { sceneId, grid, autoWalls, role, scale, gridShape } = props;
  const { w, h } = props.bounds;
  // The build's paths are the costliest part of a build edit, so the tree not on screen keeps its last read.
  const allChunks = useTreeShownView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const allLabels = useTreeShownView((s) => s.view?.labels ?? EMPTY_LABELS);
  const chunks = useMemo(() => Object.values(allChunks).filter((c): c is BuildChunk => !!c && c.sceneId === sceneId), [allChunks, sceneId]);
  const labels = useMemo(() => Object.values(allLabels).filter((l): l is Label => !!l && l.sceneId === sceneId), [allLabels, sceneId]);
  const paths = useMemo(() => buildPaths(chunks, role, { autoWalls, bounds: { w, h }, gridShape }), [chunks, role, autoWalls, w, h, gridShape]);
  const textures = useTextures(paths.floors.map(([t]) => t));
  const stamps = useStampDrawing(sceneId, role);
  // On the isometric view's ground stage, what stands up there is left out here (docs/design-v1-isometric-view.md 5.3).
  const iso = useIsoGround();
  const flatLabels = useMemo(() => (iso ? labels.filter((l) => !iso.uprightLabels.has(l.id)) : labels), [iso, labels]);
  const standing = useMemo(() => {
    if (!iso?.heights) return undefined;
    const flat = paths.drawing.symbols.pillar.filter((c) => !boxStands(iso.fog, { x0: c.x, y0: c.y, x1: c.x + 1, y1: c.y + 1 }));
    return pillarPaths(flat, () => new Path2D());
  }, [iso, paths]);

  if (chunks.length === 0 && labels.length === 0 && !stamps) return null;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => drawBuild(ctx._context, paths, { role, scale, grid, textures, labels: flatLabels, underWalls: stamps ?? undefined, standing })}
    />
  );
});

/** The scene's lights, as suns for the DM (docs/design-v1-maps-vision.md section 3.6). */
function LightMarks(props: { sceneId: string; scale: number }) {
  const { sceneId, scale } = props;
  const lights = useSceneLights(sceneId);
  if (lights.length === 0) return null;
  return <Shape listening={false} perfectDrawEnabled={false} sceneFunc={(ctx) => drawSuns(ctx._context, lights, scale)} />;
}

function useSceneLights(sceneId: string): Light[] {
  const allLights = useRoomView((s) => s.view?.lights ?? EMPTY_LIGHTS);
  return useMemo(() => Object.values(allLights).filter((l): l is Light => !!l && l.sceneId === sceneId), [allLights, sceneId]);
}

/**
 * The reach of the light picked in the builder's Lights mode, while that
 * mode is open. On the overlay layer, so tokens never cover its rings or
 * the radii written beside it. While it is dragged, its sun and rings follow
 * the finger and the stored sun stays where it was until the move is sent.
 * It draws only for the DM: a player's view never holds a light, and the
 * role is checked as well.
 */
export function LightReachLayer(props: LayerProps) {
  const { scene, role, scale, labelBoxes } = props;
  const lights = useSceneLights(scene.id);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const building = useRoomView((s) => s.local.tool === "build");
  const lightMode = useStore(useBuilderStore(), (b) => b.mode === "light");
  const { lightId, dragTo } = useStore(useScoped(lightSlot), useShallow((l) => ({ lightId: l.lightId, dragTo: l.dragTo })));
  const { accent } = useAccent();
  const tokens = useRoomView((s) => s.view?.tokens);
  const stored = role === "dm" && building && lightMode && lightId ? lights.find((l) => l.id === lightId) : undefined;
  if (!stored) return null;
  const picked = dragTo ? { ...stored, ...dragTo } : stored;
  const reach = lightReach(picked, feetPerCell);
  const text = lightCaption(picked, feetPerCell);
  // The halo drawLabel strokes reaches about a pixel past the letters, and a line of text stands 1.4 times its size.
  const size = { width: measureLabel(text) * CAPTION_PX + 2, height: CAPTION_PX * 1.4 };
  // Clear of the names, as the height pills keep, and of the tokens too, since the caption draws over them (LPD-REGRESS-3).
  const spot = lightCaptionSpot(picked, size, scale, [...labelBoxes, ...tokenBodies(tokens ?? {}, scene.id, scale)]);
  const caption = spot ? { text, ...spot } : null;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        drawLightReach(ctx._context, picked, reach, caption, scale, accent);
        if (dragTo) drawSuns(ctx._context, [picked], scale);
      }}
    />
  );
}

/** The DM's gesture in progress: cells not sent yet, the rectangle or polygon being drawn, a wall run. A hex scene's go to HexPreview. */
function BuildPreview(props: { scene: Scene; scale: number }) {
  const g = sceneGrid(props.scene);
  return isHex(g) ? <HexPreview scene={props.scene} scale={props.scale} g={g} /> : <SquarePreview scene={props.scene} scale={props.scale} />;
}

/**
 * A hex scene's gesture in progress (HX-D7, HX-D9): the hexes a stroke has
 * not sent yet, the hexes inside a dragged area, and a Wall line's points
 * with the run to where the next one would land, or a straight one being
 * dragged.
 */
function HexPreview(props: { scene: Scene; scale: number; g: HexGrid }) {
  const { scene, scale, g } = props;
  const active = useRoomView((s) => s.local.tool === "build");
  const { unsent, rect, mode, line, lineScene, lineAt, lineDrag } = useStore(
    useBuilderStore(),
    useShallow((b) => ({ unsent: b.unsent, rect: b.rect, mode: b.mode, line: b.line, lineScene: b.lineScene, lineAt: b.lineAt, lineDrag: b.lineDrag })),
  );
  const clearing = useStore(useScoped(heightSlot).store, (h) => h.rough === "clear");
  const inRect = useMemo(() => (rect ? hexesInRect(g, rect.a, rect.b, scene.bounds) : []), [g, rect, scene.bounds]);
  const { accent } = useAccent();
  if (!active) return null;
  const fill = mode === "rough" && !clearing ? TERRAIN_COLORS.difficult : ERASE_FILL;
  const hexes = unsent.length > 0 ? unsent : inRect;
  const points = lineScene === scene.id ? line : [];
  const last = points[points.length - 1];
  const r = rect ? rectBetween(rect.a, rect.b) : null;
  const dot = (p: Point, i: number, big: boolean) => (
    <Circle key={i} x={p.x} y={p.y} radius={(big ? 11 : 5) / scale} fill={big ? theme.color.accentSoft : accent} stroke="#000000" strokeWidth={1} strokeScaleEnabled={false} listening={false} />
  );
  return (
    <>
      {hexes.length > 0 ? (
        <Shape
          listening={false}
          perfectDrawEnabled={false}
          sceneFunc={(ctx) => {
            const c = ctx._context;
            c.save();
            c.globalAlpha = 0.7;
            c.fillStyle = fill;
            c.beginPath();
            for (const key of hexes) {
              const corners = hexOutline(g, key);
              corners.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
              c.closePath();
            }
            c.fill();
            c.restore();
          }}
        />
      ) : null}
      {r && rect ? (
        <Rect
          x={Math.min(rect.a.x, rect.b.x)}
          y={Math.min(rect.a.y, rect.b.y)}
          width={Math.abs(rect.b.x - rect.a.x)}
          height={Math.abs(rect.b.y - rect.a.y)}
          stroke={mode === "rough" && !clearing ? accent : theme.color.danger}
          strokeWidth={2}
          strokeScaleEnabled={false}
          dash={[6, 4]}
          listening={false}
        />
      ) : null}
      {points.length > 0 ? (
        <>
          <Line points={points.flatMap((p) => [p.x, p.y])} stroke={accent} strokeWidth={4} strokeScaleEnabled={false} lineCap="round" lineJoin="round" listening={false} />
          {last && lineAt ? <Line points={[last.x, last.y, lineAt.x, lineAt.y]} stroke={accent} strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} listening={false} /> : null}
          {points.map((p, i) => dot(p, i, i === 0 && points.length >= 3))}
        </>
      ) : null}
      {lineDrag ? (
        <>
          <Line points={[lineDrag.a.x, lineDrag.a.y, lineDrag.b.x, lineDrag.b.y]} stroke={accent} strokeWidth={4} strokeScaleEnabled={false} lineCap="round" listening={false} />
          {dot(lineDrag.a, 0, false)}
          {dot(lineDrag.b, 1, false)}
        </>
      ) : null}
    </>
  );
}

function SquarePreview(props: { scene: Scene; scale: number }) {
  const { scene, scale } = props;
  const active = useRoomView((s) => s.local.tool === "build");
  const { unsent, rect, poly, run, mode, terrain } = useStore(
    useBuilderStore(),
    useShallow((b) => ({
      unsent: b.unsent,
      rect: b.rect,
      poly: b.poly,
      run: b.run,
      mode: b.mode,
      terrain: b.terrain,
    })),
  );
  const floor: TexturedTerrain = isSymbolTerrain(terrain) ? "stone" : terrain;
  const erasing = mode === "erase" || mode === "eraseRect";
  const color = erasing ? ERASE_FILL : TERRAIN_COLORS[floor];
  const polyFill = useMemo(
    () => (poly.length >= 3 ? polygonCells(poly.flatMap((p) => [p.x, p.y]), scene.bounds) : []),
    [poly, scene.bounds],
  );
  const { accent } = useAccent();
  if (!active) return null;

  const r = rect ? rectBetween(rect.a, rect.b) : null;
  return (
    <>
      {unsent.length > 0 || polyFill.length > 0 ? (
        <Shape
          listening={false}
          perfectDrawEnabled={false}
          sceneFunc={(ctx) => {
            const g = ctx._context;
            g.save();
            g.globalAlpha = 0.7;
            g.fillStyle = color;
            g.beginPath();
            for (const key of unsent.length > 0 ? unsent : polyFill) {
              const c = parseCellKey(key);
              g.rect(c.x, c.y, 1, 1);
            }
            g.fill();
            g.restore();
          }}
        />
      ) : null}
      {r ? (
        <Rect
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill={erasing ? ERASE_FILL : TERRAIN_COLORS[floor]}
          opacity={0.6}
          stroke={erasing ? theme.color.danger : accent}
          strokeWidth={2}
          strokeScaleEnabled={false}
          listening={false}
        />
      ) : null}
      {poly.length > 0 ? (
        <>
          <Line points={poly.flatMap((p) => [p.x, p.y])} stroke={accent} strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} listening={false} />
          {poly.map((p, i) => (
            <Circle
              key={i}
              x={p.x}
              y={p.y}
              radius={(i === 0 && poly.length >= 3 ? 11 : 5) / scale}
              fill={i === 0 ? theme.color.accentSoft : accent}
              stroke="#000000"
              strokeWidth={1}
              strokeScaleEnabled={false}
              listening={false}
            />
          ))}
        </>
      ) : null}
      {run.length > 0 ? (
        <Shape
          listening={false}
          stroke={accent}
          strokeWidth={6}
          strokeScaleEnabled={false}
          lineCap="round"
          sceneFunc={(ctx, shape) => {
            ctx.beginPath();
            for (const key of run) {
              const [xs, ys, side] = key.split(",");
              const x = Number(xs);
              const y = Number(ys);
              ctx.moveTo(x, y);
              ctx.lineTo(side === "n" ? x + 1 : x, side === "n" ? y : y + 1);
            }
            ctx.strokeShape(shape);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The label being dragged, drawn where it would land, and an outline
 * around it and around the label whose edit pane is open (LabelPane.tsx).
 * The pane opens with the Select tool too, so this draws whatever the tool.
 */
function LabelMarks() {
  const paneId = useStore(useScoped(labelPaneSlot), (p) => p.labelId);
  const moving = useStore(useBuilderStore(), (b) => b.labelMove);
  const building = useRoomView((s) => s.local.tool === "build");
  const paneLabel = useRoomView((s) => (paneId ? s.view?.labels[paneId] : undefined));
  const movingLabel = useRoomView((s) => (moving ? s.view?.labels[moving.id] : undefined));
  const { accent } = useAccent();
  const dragged = building && moving && movingLabel ? { ...movingLabel, x: moving.x, y: moving.y } : null;
  const outlined = [dragged, paneLabel && paneLabel.id !== dragged?.id ? paneLabel : null].filter((l): l is Label => !!l);
  return (
    <>
      {dragged ? <Shape listening={false} perfectDrawEnabled={false} opacity={0.85} sceneFunc={(ctx) => drawLabel(ctx._context, dragged)} /> : null}
      {outlined.map((label) => {
        const box = labelBox(label, measureLabel);
        return (
          <Rect
            key={label.id}
            x={box.x0}
            y={box.y0}
            width={box.x1 - box.x0}
            height={box.y1 - box.y0}
            stroke={accent}
            strokeWidth={2}
            strokeScaleEnabled={false}
            dash={[6, 4]}
            cornerRadius={0.1}
            listening={false}
          />
        );
      })}
    </>
  );
}
