import type Konva from "konva";
import { memo, useMemo } from "react";
import { Group, Image as KImage, Rect, Shape } from "react-konva";
import { useStore } from "zustand";
import type { FogTile, RoomState, Scene, SightTile, Token } from "#shared/model.ts";
import { sightOf } from "#shared/keys.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { useTreeShownView } from "../../canvas/relief/context.ts";
import { FogRaster } from "../../lib/fogTiles.ts";
import { boardTheme } from "../../lib/theme.ts";
import { BOARD_DISPOSITION_RING } from "../../lib/tokenView.ts";
import { useScoped } from "../../state/scope.ts";
import { useAssets } from "../../state/view.ts";
import type { LayerProps } from "../layers.ts";
import { withExplored } from "../vision/exploredFog.ts";
import { partySightSlot, sightMode, visionOn } from "../vision/sightMode.ts";
import { PARTY_PALETTE, SightRaster, VEIL_PALETTE } from "../vision/sightRaster.ts";
import { byFarFloor, farTokensIn, holeOutline, holesOn, tokenUrl, windowSlot, type HoleOutline, type HoleSpec } from "./openingView.ts";

const NO_LINKS: RoomState["floorLinks"] = {};
const NO_SCENES: RoomState["scenes"] = {};
const NO_TOKENS: RoomState["tokens"] = {};
const NO_TILES: RoomState["fogTiles"] = {};

/** The veil over the floor below, black at 35%, so it reads as further away than the floor shown (phase 4, 7.4). */
const VEIL_OPACITY = 0.35;

/**
 * The floor below in each hole of the floor shown (docs/design/design-v1-floors.md
 * phase 4, 7.4): inside the upper end of every opening whose far floor the
 * device holds, that floor's map still and build, its creatures as flat
 * images, its fog and sight, under a black veil, inert. A hole over a
 * floor the device does not hold is a black drop. The floor shown's fog
 * lies over the whole layer, as it lies over the board, so a hole the
 * party has not seen shows nothing.
 *
 * Each far floor's map and build bake into one crop a hole, at most 512 by
 * 512 pixels (openingView.ts windowPxPerCell), which OpeningCrops.tsx makes once
 * for both drawing trees: the far floor's phone-size image is decoded once
 * for every hole over it, cropped, and let go. The creatures, fog and sight
 * change with play and draw live over the crop. This layer only reads, so
 * it draws in Isometric too, flat on the ground, without running anything
 * twice (canvas/relief/controllers.test.ts).
 */
export const OpeningWindow = memo(function OpeningWindow(props: LayerProps) {
  const links = useTreeShownView((s) => s.view?.floorLinks ?? NO_LINKS);
  const scenes = useTreeShownView((s) => s.view?.scenes ?? NO_SCENES);
  const holes = useMemo(() => holesOn({ floorLinks: links, scenes }, props.scene.id), [links, scenes, props.scene.id]);
  const grid = useMemo(() => sceneGrid(props.scene), [props.scene.gridShape]);
  // One drawing a far floor, so its rasters are shared by every hole over it.
  const byFloor = useMemo(() => byFarFloor(holes), [holes]);
  if (holes.length === 0) return null;
  return (
    <Group listening={false}>
      {holes
        .filter((h) => h.far === null)
        .map((h) => (
          <Drop key={h.link.id} outline={holeOutline(grid, h.link.rect)} />
        ))}
      {byFloor.map((f) => (
        <FarFloor key={f.far.id} far={f.far} holes={f.holes} grid={grid} role={props.role} />
      ))}
    </Group>
  );
});

/** The hole's squares as a clip: its box, or on hexes the outline of its hexes. */
function clipTo(o: HoleOutline): (ctx: Konva.Context) => void {
  return (ctx) => {
    if (!o.loop) {
      ctx.rect(o.x, o.y, o.w, o.h);
      return;
    }
    ctx.moveTo(o.loop[0]!, o.loop[1]!);
    for (let i = 2; i + 1 < o.loop.length; i += 2) ctx.lineTo(o.loop[i]!, o.loop[i + 1]!);
    ctx.closePath();
  };
}

/** A hole over a floor the device does not hold: black, with nothing of that floor in it. */
function Drop(props: { outline: HoleOutline }) {
  const o = props.outline;
  return (
    <Group clipFunc={clipTo(o)} listening={false}>
      <Rect x={o.x} y={o.y} width={o.w} height={o.h} fill={boardTheme.color.stage} listening={false} />
    </Group>
  );
}

/**
 * Every hole over one far floor: the crops of its map and build, decoded
 * once for all of them, and its fog and sight as one raster each, read
 * through every hole.
 */
function FarFloor(props: { far: Scene; holes: HoleSpec[]; grid: Grid; role: "dm" | "player" }) {
  const { far, holes, role } = props;
  const outlines = useMemo(() => holes.map((h) => ({ id: h.link.id, o: holeOutline(props.grid, h.link.rect) })), [holes, props.grid]);
  const crops = useStore(useScoped(windowSlot), (s) => s.crops);
  const tokens = useTreeShownView((s) => s.view?.tokens ?? NO_TOKENS);
  const fogTiles = useTreeShownView((s) => s.view?.fogTiles ?? NO_TILES);
  const explored = useTreeShownView((s) => (role === "dm" ? s.view?.exploredTiles : undefined));
  const sight = useTreeShownView((s) => (s.view ? sightOf(s.view) : undefined));
  const partySight = useStore(useScoped(partySightSlot), (s) => s.on);
  const mode = sightMode({ role, visionOn: visionOn(far), partySight });
  // The far floor's fog as its own board draws it: a DM's with the party's explored ground revealed, at half strength.
  const drawnFog = role === "dm" ? (withExplored(fogTiles, explored) as RoomState["fogTiles"]) : fogTiles;
  const fog = useFarFog(far, far.fogEnabled !== false ? drawnFog : null);
  const seen = useFarSight(far, mode === null ? null : sight, mode);
  const farGrid = useMemo(() => sceneGrid(far), [far.gridShape]);
  return (
    <>
      {holes.map((hole) => {
        const o = outlines.find((x) => x.id === hole.link.id)!.o;
        const crop = crops.get(hole.link.id) ?? null;
        return (
          <Group key={hole.link.id} clipFunc={clipTo(o)} listening={false}>
            {crop ? <KImage image={crop} x={o.x} y={o.y} width={o.w} height={o.h} listening={false} /> : <Rect x={o.x} y={o.y} width={o.w} height={o.h} fill={boardTheme.color.stage} listening={false} />}
            {farTokensIn({ scenes: { [far.id]: far }, tokens }, far.id, hole.link.rect).map((t) => (
              <FlatToken key={t.id} token={t} grid={farGrid} />
            ))}
            {seen ? <RasterCrop canvas={seen.canvas} version={seen.version} bounds={far.bounds} o={o} smooth opacity={1} /> : null}
            {fog ? <RasterCrop canvas={fog.canvas} version={fog.version} bounds={far.bounds} o={o} smooth={false} opacity={role === "dm" ? 0.5 : 1} /> : null}
            <Rect x={o.x} y={o.y} width={o.w} height={o.h} fill={boardTheme.color.stage} opacity={VEIL_OPACITY} listening={false} />
          </Group>
        );
      })}
    </>
  );
}

/** A creature on the floor below, flat: its picture in its round, or its square for an object, ringed in its side's color. */
function FlatToken(props: { token: Token; grid: Grid }) {
  const { token } = props;
  const assets = useAssets();
  const url = tokenUrl(assets, token);
  // Loaded once for both trees by OpeningCrops.tsx.
  const image = useStore(useScoped(windowSlot), (s) => (url ? (s.images.get(url) ?? null) : null));
  const r = footprintRect(props.grid, token);
  const square = token.kind === "object";
  const ring = BOARD_DISPOSITION_RING[token.disposition] ?? boardTheme.color.neutral;
  return (
    <Group listening={false}>
      <Group
        listening={false}
        clipFunc={(ctx) => {
          if (square) ctx.rect(r.x, r.y, r.w, r.h);
          else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        }}
      >
        {image ? <KImage image={image} x={r.x} y={r.y} width={r.w} height={r.h} listening={false} /> : <Rect x={r.x} y={r.y} width={r.w} height={r.h} fill={boardTheme.color.surfaceRaised} listening={false} />}
      </Group>
      <Shape
        listening={false}
        perfectDrawEnabled={false}
        sceneFunc={(ctx, shape) => {
          const px = 1 / (shape.getAbsoluteScale().x || 1);
          ctx.beginPath();
          if (square) ctx.rect(r.x, r.y, r.w, r.h);
          else ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          ctx.lineWidth = 2 * px;
          ctx.strokeStyle = ring;
          ctx.stroke();
        }}
      />
    </Group>
  );
}

/** Part of a whole floor's raster, one pixel a sub-cell, drawn into a hole's box. */
function RasterCrop(props: { canvas: HTMLCanvasElement; version: number; bounds: { w: number; h: number }; o: HoleOutline; smooth: boolean; opacity: number }) {
  const { canvas, bounds, o } = props;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      opacity={props.opacity}
      // Not read by Konva: a changed value is what makes react-konva redraw the layer.
      rasterVersion={props.version}
      sceneFunc={(ctx) => {
        const g = ctx._context;
        const kx = canvas.width / bounds.w;
        const ky = canvas.height / bounds.h;
        g.save();
        g.imageSmoothingEnabled = props.smooth;
        // Past the floor's edge is fogged, as the board's own fog frames it.
        g.fillStyle = boardTheme.color.fog;
        if (!props.smooth) g.fillRect(o.x, o.y, o.w, o.h);
        const x0 = Math.max(0, o.x);
        const y0 = Math.max(0, o.y);
        const x1 = Math.min(bounds.w, o.x + o.w);
        const y1 = Math.min(bounds.h, o.y + o.h);
        if (x1 > x0 && y1 > y0) {
          if (!props.smooth) g.clearRect(x0, y0, x1 - x0, y1 - y0);
          g.drawImage(canvas, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, x0, y0, x1 - x0, y1 - y0);
        }
        g.restore();
      }}
    />
  );
}

/** A whole floor's raster on its own canvas, repainted where it changed, and how many times it was. */
type Drawn = { canvas: HTMLCanvasElement; version: number };

/**
 * A raster's canvas: one pixel a sub-cell, as the board's own fog and sight
 * are drawn (canvas/FogShape.tsx, vision/SightOverlay.tsx). `apply` runs
 * the raster's update and repaints the canvas where it rewrote anything.
 */
function rasterCanvas(raster: { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> }): Drawn & { apply(dirty: readonly unknown[]): number } {
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext("2d");
  const image = ctx ? new ImageData(raster.rgba, raster.width, raster.height) : null;
  if (ctx && image) ctx.putImageData(image, 0, 0);
  const out = {
    canvas,
    version: 0,
    apply(dirty: readonly unknown[]): number {
      if (dirty.length > 0 && ctx && image) {
        ctx.putImageData(image, 0, 0);
        out.version += 1;
      }
      return out.version;
    },
  };
  return out;
}

/** The far floor's committed fog, for a scene that draws fog. Null where it draws none. */
function useFarFog(far: Pick<Scene, "id" | "bounds">, tiles: RoomState["fogTiles"] | null): Drawn | null {
  const made = useMemo(() => {
    const raster = new FogRaster(far.bounds, hexRgb(boardTheme.color.fog));
    return { raster, drawn: rasterCanvas(raster) };
  }, [far.id, far.bounds.w, far.bounds.h]);
  const version = useMemo(() => (tiles ? made.drawn.apply(made.raster.update(tiles as Record<string, FogTile | undefined>, far.id)) : -1), [made, tiles, far.id]);
  return tiles ? { canvas: made.drawn.canvas, version } : null;
}

/** The far floor's sight levels, where it uses party vision, as its own board draws them. */
function useFarSight(far: Pick<Scene, "id" | "bounds">, sight: Readonly<Record<string, SightTile | undefined>> | undefined | null, mode: "party" | "veil" | null): Drawn | null {
  const made = useMemo(() => {
    const raster = new SightRaster(far.bounds, mode === "veil" ? VEIL_PALETTE : PARTY_PALETTE);
    return { raster, drawn: rasterCanvas(raster) };
  }, [far.id, far.bounds.w, far.bounds.h, mode]);
  const version = useMemo(() => (sight === null ? -1 : made.drawn.apply(made.raster.update(sight, far.id))), [made, sight, far.id]);
  return sight === null || mode === null ? null : { canvas: made.drawn.canvas, version };
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
