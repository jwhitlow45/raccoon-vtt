import type { RingShape } from "./rings.ts";

/** A ring's dash, in screen pixels: one array for every ring, so a render hands Konva the same one. Never changed in place. */
export const RING_DASH: number[] = [8, 5];

type Trace = { beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; strokeShape(shape: unknown): void };

const scenes = new WeakMap<RingShape, (ctx: Trace, shape: unknown) => void>();

/**
 * The Konva scene function that strokes a ring's edge (rings.ts ringShape),
 * one per shape object for the shape's life. Konva redraws a layer when a
 * node's attribute changes, and a new function is a change, so a ring layer
 * that renders again for another token's drag would redraw every ring on
 * its layer, the isometric ground stage included (ISO2-RANGERING). A shape
 * is made again only when its token or its range changes.
 */
export function ringScene(shape: RingShape): (ctx: Trace, shape: unknown) => void {
  let scene = scenes.get(shape);
  if (!scene) {
    const s = shape.segments;
    scene = (ctx, node) => {
      ctx.beginPath();
      for (let i = 0; i + 3 < s.length; i += 4) {
        ctx.moveTo(s[i]!, s[i + 1]!);
        ctx.lineTo(s[i + 2]!, s[i + 3]!);
      }
      ctx.strokeShape(node);
    };
    scenes.set(shape, scene);
  }
  return scene;
}
