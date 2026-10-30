import { memo, useEffect, useMemo, useState } from "react";
import { Group, Shape } from "react-konva";
import { sightOf } from "#shared/keys.ts";
import type { Scene } from "#shared/model.ts";
import { fogSeam } from "../../canvas/fogSeam.ts";
import { useIsoGround } from "../../canvas/relief/context.ts";
import { useRoomView } from "../../state/view.ts";
import { NOT_SEEN, PARTY_PALETTE, SightRaster, VEIL_PALETTE, type Palette, type Rgba } from "./sightRaster.ts";
import type { SightMode } from "./sightMode.ts";

/** How far past the scene's edge the overlay reaches, in cells, as the fog's frame does. */
const FRAME_CELLS = 10_000;

/**
 * The most tiles written in one frame. A move changes a handful and a door
 * a few dozen, but a snapshot, a light level or vision turned on can change
 * every one of a 200 x 200 scene's 169. Writing those at once measured
 * about 4 ms with Chrome's CPU slowed four times, the phone budget of
 * docs/design-v1-maps-vision.md 4.3.6, so the rest wait for the next
 * frames, a few dozen at a time. Those tiles show their old levels for a
 * frame or two, which only shades the map: the server has already decided
 * which creatures players get.
 */
const TILES_PER_FRAME = 48;

/** Past this many changed tiles, one copy of the region around them is cheaper than one copy each. */
const COPY_ONCE_FROM = 8;

/**
 * The raster and the offscreen canvas it is copied into. Only the regions
 * the raster rewrote are copied, with putImageData, so a move that changes
 * a few sight tiles touches a few tiles of the canvas.
 */
class SightCanvas {
  readonly raster: SightRaster;
  readonly canvas: HTMLCanvasElement;
  readonly palette: Palette;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly image: ImageData | null;
  /** Counts the updates that changed something, so the Konva node redraws exactly then. */
  version = 0;

  constructor(bounds: { w: number; h: number }, palette: Palette) {
    this.raster = new SightRaster(bounds, palette);
    this.palette = palette;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.raster.width;
    this.canvas.height = this.raster.height;
    this.ctx = this.canvas.getContext("2d");
    this.image = this.ctx ? new ImageData(this.raster.rgba, this.raster.width, this.raster.height) : null;
    this.ctx?.putImageData(this.image!, 0, 0);
  }

  /** Whether the canvas could be made. Without it the scene draws as not seen. */
  get ok(): boolean {
    return this.ctx !== null;
  }

  /** Whether changed tiles are still waiting for a later frame. */
  get behind(): boolean {
    return this.raster.behind;
  }

  update(sight: Parameters<SightRaster["update"]>[0], sceneId: string): number {
    const dirty = this.raster.update(sight, sceneId, TILES_PER_FRAME);
    if (dirty.length === 0) return this.version;
    if (this.ctx && this.image) {
      if (dirty.length < COPY_ONCE_FROM) {
        for (const r of dirty) this.ctx.putImageData(this.image, 0, 0, r.x, r.y, r.w, r.h);
      } else {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = 0;
        let y1 = 0;
        for (const r of dirty) {
          x0 = Math.min(x0, r.x);
          y0 = Math.min(y0, r.y);
          x1 = Math.max(x1, r.x + r.w);
          y1 = Math.max(y1, r.y + r.h);
        }
        this.ctx.putImageData(this.image, 0, 0, x0, y0, x1 - x0, y1 - y0);
      }
    }
    return ++this.version;
  }
}

function css(rgba: readonly number[]): string {
  return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${(rgba[3] ?? 0) / 255})`;
}

/** Opaque unseen pixels can overlap the frame in an isolated surface, then receive their tint once. */
export function sightPaint(mode: SightMode, isometric: boolean): { palette: Palette; opacity: number } {
  const palette = mode === "party" ? PARTY_PALETTE : VEIL_PALETTE;
  if (!isometric) return { palette, opacity: 1 };
  const opacity = palette[NOT_SEEN][3] / 255;
  const normalize = (c: Rgba): Rgba => [c[0], c[1], c[2], Math.round(c[3] / opacity)];
  return { palette: [normalize(palette[0]), normalize(palette[1]), normalize(palette[2]), normalize(palette[3])], opacity };
}

/**
 * The party's sight on the overlay layer, below the fog image (section
 * 4.3.7): one image of the scene at one pixel per sub-cell, drawn with
 * smoothing on so its edges are soft. Smoothing is safe here, as it is not
 * for the fog: the server has already withheld every creature out of
 * sight, and the opaque, unsmoothed fog still guards unexplored ground.
 *
 * It redraws when the sight tiles in the view change and when the camera
 * moves. Its only animation frames are the few that finish a change too
 * large for one (TILES_PER_FRAME), and then it stops.
 */
export const SightOverlay = memo(function SightOverlay(props: { scene: Pick<Scene, "id" | "bounds">; mode: SightMode }) {
  const { scene, mode } = props;
  const sight = useRoomView((s) => (s.view ? sightOf(s.view) : undefined));
  const isometric = useIsoGround() !== null;
  const paint = useMemo(() => sightPaint(mode, isometric), [mode, isometric]);
  const drawn = useMemo(() => new SightCanvas(scene.bounds, paint.palette), [scene.id, scene.bounds.w, scene.bounds.h, paint]);
  // Counts the frames spent finishing a large change, each one an update that writes the next tiles.
  const [frame, setFrame] = useState(0);
  const version = useMemo(() => drawn.update(sight, scene.id), [drawn, sight, scene.id, frame]);
  useEffect(() => {
    if (!drawn.behind) return;
    const id = requestAnimationFrame(() => setFrame((f) => f + 1));
    return () => cancelAnimationFrame(id);
  }, [drawn, version]);

  const w = scene.bounds.w;
  const h = scene.bounds.h;
  return <SightSurface drawn={drawn} w={w} h={h} version={version} isometric={isometric} opacity={paint.opacity} />;
});

/** The frame and raster share one drawing surface. */
export function SightSurface({ drawn, w, h, version, isometric, opacity }: { drawn: Pick<SightCanvas, "canvas" | "ok" | "palette">; w: number; h: number; version: number; isometric: boolean; opacity: number }) {
  const unseen = css(drawn.palette[NOT_SEEN]);
  return (
    <Group listening={false} isolated={isometric} opacity={opacity}>
      <Shape
        listening={false}
        perfectDrawEnabled={false}
        // Not read by Konva: a changed value is what makes react-konva redraw the layer.
        sightVersion={version}
        selfRectFunc={() => ({ x: -FRAME_CELLS, y: -FRAME_CELLS, width: w + FRAME_CELLS * 2, height: h + FRAME_CELLS * 2 })}
        sceneFunc={(ctx) => {
          const g = ctx._context;
          g.save();
          // Slanted edges overlap inside the opaque unseen frame. The isolated group applies translucency once, as FogShape does.
          const { hole, clip } = fogSeam(g.getTransform(), w, h);
          // Past the scene's edge nothing is in sight, as fail-closed fog treats it.
          g.fillStyle = unseen;
          g.beginPath();
          g.rect(-FRAME_CELLS, -FRAME_CELLS, w + FRAME_CELLS * 2, h + FRAME_CELLS * 2);
          g.rect(hole.x, hole.y, hole.w, hole.h);
          g.fill("evenodd");
          if (clip) {
            g.beginPath();
            g.rect(clip.x, clip.y, clip.w, clip.h);
            g.clip();
          }
          if (drawn.ok) {
            g.imageSmoothingEnabled = true;
            g.drawImage(drawn.canvas, 0, 0, w, h);
          } else {
            g.fillRect(0, 0, w, h);
          }
          g.restore();
        }}
      />
    </Group>
  );
}
