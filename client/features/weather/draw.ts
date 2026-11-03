import type { Camera } from "../../lib/camera.ts";
import { toView, type View } from "../../lib/view.ts";
import type { Field } from "./sim.ts";
import { RING_MS, WRAP_MARGIN } from "./sim.ts";
import { LEAF_CELL, NOISE_SIZE, type TextureSource } from "./textures.ts";

/**
 * Draws a weather field into a 2D context (the weather design note, 5.2):
 * in CSS px from an identity transform, clipped to the scene on screen,
 * batched to one path a color. It reads the field and never steps it, so a
 * camera draw shows the same moment a tick drew.
 */

export type DrawFrame = {
  /** The weather layer's own stage as it draws: x, y and scaleX. */
  camera: Camera;
  /** The scene on screen as a polygon, x and y pairs in CSS px, or null for the whole screen. */
  clip: ArrayLike<number> | null;
};

/** The zoom at which a noise sheet draws at its own size. Sheets scale with the zoom from here, held within half and twice (5.2). */
export const SHEET_SCALE_AT = 50;

/** The scene's outline on screen: its bounds through the view's turn and squash, then the camera. */
export function sceneClip(view: View, bounds: { w: number; h: number }, camera: Camera): Float64Array {
  const out = new Float64Array(8);
  const corners = [
    [0, 0],
    [bounds.w, 0],
    [bounds.w, bounds.h],
    [0, bounds.h],
  ] as const;
  for (let k = 0; k < 4; k++) {
    const v = toView(view, { x: corners[k]![0], y: corners[k]![1] });
    out[k * 2] = v.x * camera.scale + camera.x;
    out[k * 2 + 1] = v.y * camera.scale + camera.y;
  }
  return out;
}

function wrap(v: number, size: number): number {
  return v - size * Math.floor(v / size);
}

/** A pattern per context and image, made once: a pattern belongs to the context that made it. */
const patterns = new WeakMap<object, Map<CanvasImageSource, CanvasPattern | null>>();

function patternOf(g: CanvasRenderingContext2D, image: CanvasImageSource): CanvasPattern | null {
  let mine = patterns.get(g);
  if (!mine) patterns.set(g, (mine = new Map()));
  if (!mine.has(image)) mine.set(image, g.createPattern(image, "repeat"));
  return mine.get(image) ?? null;
}

export function drawWeather(g: CanvasRenderingContext2D, field: Field, frame: DrawFrame, textures: TextureSource | null): void {
  const { look, width, height } = field;
  const { camera, clip } = frame;
  // What of the screen the scene covers: marks outside it are skipped rather than drawn into the clip.
  let x0 = 0;
  let y0 = 0;
  let x1 = width;
  let y1 = height;
  if (clip && clip.length >= 6) {
    x0 = Infinity;
    y0 = Infinity;
    x1 = -Infinity;
    y1 = -Infinity;
    for (let k = 0; k + 1 < clip.length; k += 2) {
      x0 = Math.min(x0, clip[k]!);
      x1 = Math.max(x1, clip[k]!);
      y0 = Math.min(y0, clip[k + 1]!);
      y1 = Math.max(y1, clip[k + 1]!);
    }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(width, x1);
    y1 = Math.min(height, y1);
  }
  if (x1 <= x0 || y1 <= y0) return;

  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.beginPath();
  if (clip && clip.length >= 6) {
    g.moveTo(clip[0]!, clip[1]!);
    for (let k = 2; k + 1 < clip.length; k += 2) g.lineTo(clip[k]!, clip[k + 1]!);
    g.closePath();
  } else g.rect(0, 0, width, height);
  g.clip();

  if (look.veil) {
    g.globalAlpha = look.veil.alpha;
    g.fillStyle = look.veil.color;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  if (look.sheets.length && textures) {
    const zoom = Math.min(2, Math.max(0.5, camera.scale / SHEET_SCALE_AT));
    for (let j = 0; j < look.sheets.length; j++) {
      const sheet = look.sheets[j]!;
      const scale = zoom * sheet.scale;
      const period = NOISE_SIZE * scale;
      const image = textures.noise(sheet.color);
      const pattern = image && patternOf(g, image);
      if (!pattern) continue;
      // The pattern repeats from the transform's origin, so moving the origin by the sheet's drift plus the pan moves the banks with the ground.
      const ox = wrap(field.sheets[j * 2]! + camera.x, period) - period;
      const oy = wrap(field.sheets[j * 2 + 1]! + camera.y, period) - period;
      g.setTransform(scale, 0, 0, scale, ox, oy);
      g.globalAlpha = sheet.alpha;
      g.fillStyle = pattern;
      g.fillRect((x0 - ox) / scale, (y0 - oy) / scale, (x1 - x0) / scale, (y1 - y0) / scale);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  const p = look.particles;
  if (p && field.active > 0) {
    const speed = Math.hypot(field.vx, field.vy) || 1;
    const ux = field.vx / speed;
    const uy = field.vy / speed;
    // Sway runs across the motion.
    const sx = -uy;
    const sy = ux;
    const seconds = field.t / 1000;
    const swayTurn = Math.PI * 2 * p.swayHz * seconds;
    const reach = WRAP_MARGIN;
    const left = x0 - reach;
    const right = x1 + reach;
    const top = y0 - reach;
    const bottom = y1 + reach;
    const { x, y, boxW, boxH, size, phase, shade } = field;
    const px = camera.x;
    const py = camera.y;
    g.globalAlpha = p.alpha;

    if (p.shape === "streak") {
      // A streak is as long as it travels: faster marks blur further, as a strong wind's rain does.
      const stretch = Math.max(1, speed);
      for (let c = 0; c < p.colors.length; c++) {
        g.beginPath();
        for (let i = 0; i < field.active; i++) {
          if (p.colors.length > 1 && shade[i] !== c) continue;
          const mx = wrap(x[i]! + px, boxW) - WRAP_MARGIN;
          const my = wrap(y[i]! + py, boxH) - WRAP_MARGIN;
          if (mx < left || mx > right || my < top || my > bottom) continue;
          const len = size[i]! * stretch;
          g.moveTo(mx, my);
          g.lineTo(mx - ux * len, my - uy * len);
        }
        g.lineWidth = p.width;
        g.lineCap = "butt";
        g.strokeStyle = p.colors[c]!;
        g.stroke();
      }
    } else if (p.shape === "disc" || p.shape === "flake") {
      for (let c = 0; c < p.colors.length; c++) {
        g.beginPath();
        for (let i = 0; i < field.active; i++) {
          if (p.colors.length > 1 && shade[i] !== c) continue;
          const s = p.sway * Math.sin(phase[i]! + swayTurn);
          const mx = wrap(x[i]! + px, boxW) - WRAP_MARGIN + sx * s;
          const my = wrap(y[i]! + py, boxH) - WRAP_MARGIN + sy * s;
          if (mx < left || mx > right || my < top || my > bottom) continue;
          const r = size[i]!;
          if (p.shape === "disc") {
            g.moveTo(mx + r, my);
            g.arc(mx, my, r, 0, Math.PI * 2);
          } else g.rect(mx - r / 2, my - r / 3, r, (r * 2) / 3);
        }
        g.fillStyle = p.colors[c]!;
        g.fill();
      }
    } else {
      const atlas = textures?.leaves() ?? null;
      if (atlas) {
        const { spin } = field;
        for (let i = 0; i < field.active; i++) {
          const s = p.sway * Math.sin(phase[i]! + swayTurn);
          const mx = wrap(x[i]! + px, boxW) - WRAP_MARGIN + sx * s;
          const my = wrap(y[i]! + py, boxH) - WRAP_MARGIN + sy * s;
          if (mx < left || mx > right || my < top || my > bottom) continue;
          const turn = phase[i]! + Math.PI * 2 * spin[i]! * seconds;
          // The leaf also tumbles: its width narrows and widens as it turns over, slower than it spins.
          const flip = 0.5 + 0.5 * Math.abs(Math.cos(turn * 0.6));
          // The atlas draws each leaf 20 px long in its 24 px cell, so a leaf of `size` is that long on screen.
          const k = size[i]! / (LEAF_CELL - 4);
          const cos = Math.cos(turn) * k;
          const sin = Math.sin(turn) * k;
          g.setTransform(cos * flip, sin * flip, -sin, cos, mx, my);
          g.drawImage(atlas, shade[i]! * LEAF_CELL, 0, LEAF_CELL, LEAF_CELL, -LEAF_CELL / 2, -LEAF_CELL / 2, LEAF_CELL, LEAF_CELL);
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
      }
    }

    if (field.rings.length && field.view.kind === "topDown") {
      let any = false;
      g.beginPath();
      for (let r = 0; r < field.rings.length; r += 3) {
        const age = field.rings[r + 2]!;
        if (age < 0) continue;
        const mx = wrap(field.rings[r]! + px, boxW) - WRAP_MARGIN;
        const my = wrap(field.rings[r + 1]! + py, boxH) - WRAP_MARGIN;
        const radius = 2 + 4 * (age / RING_MS);
        g.moveTo(mx + radius, my);
        g.arc(mx, my, radius, 0, Math.PI * 2);
        any = true;
      }
      if (any) {
        g.lineWidth = 1;
        g.strokeStyle = p.colors[0]!;
        g.stroke();
      }
    }
  }
  g.restore();
}
