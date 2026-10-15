import { memo, useMemo } from "react";
import { Shape } from "react-konva";
import { FOG_SUBCELLS, type FogTile, type RoomState } from "#shared/model.ts";
import { FogRaster } from "../lib/fogTiles.ts";
import { theme } from "../lib/theme.ts";
import { useRoomView } from "../state/view.ts";

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const FOG_RGB = hexToRgb(theme.color.fog);
/** How far past the scene's edge the fog frame reaches, in cells. Far enough for any zoom. */
const FRAME_CELLS = 10_000;

/** Past this many changed places, one copy of the region around them is cheaper than one copy each. */
const COPY_ONCE_FROM = 8;

/**
 * The fog image and the offscreen canvas it is copied into. A change of
 * fog copies only the tiles that changed (lib/fogTiles.ts FogRaster), which
 * matters on vision scenes, where the party's exploration changes the fog
 * on most moves.
 */
class FogCanvas {
  readonly raster: FogRaster;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly image: ImageData | null;
  private version = 0;

  constructor(bounds: { w: number; h: number }) {
    this.raster = new FogRaster(bounds, FOG_RGB);
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.raster.width;
    this.canvas.height = this.raster.height;
    this.ctx = this.canvas.getContext("2d");
    this.image = this.ctx ? new ImageData(this.raster.rgba, this.raster.width, this.raster.height) : null;
    if (this.ctx && this.image) this.ctx.putImageData(this.image, 0, 0);
  }

  get ok(): boolean {
    return this.ctx !== null;
  }

  update(tiles: Record<string, FogTile | undefined>, sceneId: string): number {
    const dirty = this.raster.update(tiles, sceneId);
    if (dirty.length === 0) return this.version;
    if (this.ctx && this.image) {
      if (dirty.length < COPY_ONCE_FROM) {
        for (const r of dirty) this.ctx.putImageData(this.image, 0, 0, r.x, r.y, r.w, r.h);
      } else {
        const x0 = Math.min(...dirty.map((r) => r.x));
        const y0 = Math.min(...dirty.map((r) => r.y));
        const x1 = Math.max(...dirty.map((r) => r.x + r.w));
        const y1 = Math.max(...dirty.map((r) => r.y + r.h));
        this.ctx.putImageData(this.image, 0, 0, x0, y0, x1 - x0, y1 - y0);
      }
    }
    return ++this.version;
  }
}

/**
 * The committed fog as one image node (design section 13.3).
 *
 * The bitmap is drawn into an offscreen canvas at one pixel per sub-cell (4
 * per cell), rewritten only where tiles changed, then stretched over the
 * scene with smoothing off, so every pixel of a fogged sub-cell stays
 * fully opaque at any zoom. Everything
 * outside the scene's bounds is fogged too: a map's margin past the first
 * grid line has no tiles, and fail-closed means no tile, no view.
 *
 * Players see it opaque. The DM sees the same fog at half opacity, and
 * fainter still while lining up the grid, which needs the map's own lines
 * in view. `translucent` is only ever set for a DM, so nothing here can
 * thin a player's fog.
 */
export const FogShape = memo(function FogShape(props: {
  sceneId: string;
  bounds: { w: number; h: number };
  tiles: RoomState["fogTiles"];
  translucent: boolean;
}) {
  const { sceneId, bounds, tiles, translucent } = props;
  const aligning = useRoomView((s) => s.local.tool === "grid");
  const canvas = useMemo(() => new FogCanvas(bounds), [sceneId, bounds.w, bounds.h]);
  const version = useMemo(() => canvas.update(tiles as Record<string, FogTile | undefined>, sceneId), [canvas, tiles, sceneId]);

  const w = canvas.canvas.width / FOG_SUBCELLS;
  const h = canvas.canvas.height / FOG_SUBCELLS;
  return (
    <Shape
      listening={false}
      opacity={translucent ? (aligning ? 0.2 : 0.5) : 1}
      perfectDrawEnabled={false}
      // Not read by Konva: a changed value is what makes react-konva redraw the layer.
      fogVersion={version}
      sceneFunc={(ctx) => {
        const native = ctx._context;
        native.save();
        native.fillStyle = theme.color.fog;
        native.beginPath();
        native.rect(-FRAME_CELLS, -FRAME_CELLS, w + FRAME_CELLS * 2, h + FRAME_CELLS * 2);
        native.rect(0, 0, w, h);
        native.fill("evenodd");
        if (canvas.ok) {
          native.imageSmoothingEnabled = false;
          native.drawImage(canvas.canvas, 0, 0, w, h);
        } else {
          // No 2D context (out of memory): fog everything rather than show the map.
          native.fillRect(0, 0, w, h);
        }
        native.restore();
      }}
    />
  );
});
