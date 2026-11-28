import type { ModelRef } from "#shared/model.ts";
import { modelArtBox, modelDrawnBox } from "../../features/models/frames.ts";
import { isometric, K, toView, turnAxes, type Turn } from "../../lib/view.ts";
import type { VBox } from "./pieces.ts";

/**
 * Where a standee draws (docs/design/design-v1-isometric-view.md 5.4), in view
 * units. A picture's art box is the footprint's w by h, its bottom middle on
 * the footprint's center at the base, so every decor layout keeps its
 * numbers. A creature standing as its 3D model (features/models/shown.ts,
 * docs/design/design-v1-token-models.md 4.4) draws its frame's square from
 * its anchor instead, and only the frame's drawn box paints: its decor sits
 * over the drawn top, and its silhouette, a rider's seat and culling read
 * the drawn box (D-261127-183). The ring is the footprint's ellipse at the
 * base, and a base above the drawn ground under the footprint casts a
 * shadow ellipse on that ground with a stem up to the ring.
 */

/** How far a standee's decor reaches past its art box, in screen pixels: chips above, a label of a few lines below, wide names to the sides. */
export const DECOR_REACH_PX = { top: 44, bottom: 72, side: 96 } as const;

/** How far the outlines round a ring reach past it on screen, in pixels: the active turn's, a remote drag's and a caught area's rings with their gaps. */
export const RING_REACH_PX = 16;

/** How far a facing tick reaches past the ring, in view units (TokenNode.tsx Standee). */
const TICK_REACH = 0.18;

/** How far a lift may raise a standee on screen, in canvas heights (5.4): past it the stem is capped and draws a break mark. */
export const LIFT_CAP_CANVAS = 1;

export type StandeeShape = {
  /** The footprint's center on the ground, in view units. */
  ground: { x: number; y: number };
  /** The footprint's center at the base. */
  base: { x: number; y: number };
  /** The art as it draws, raised up its holder and inset where it rides one: the picture, or a model's whole frame. */
  art: VBox;
  /** The part of the art that paints: the picture, or the model frame's drawn box. What a later piece covers to give it a silhouette. */
  drawnBox: VBox;
  /**
   * The footprint-sized box the decor lays out on: bottom-aligned with a
   * picture, as Top-down's decor lays out on the token's box around its
   * inset face, and hung from a model's drawn top, or for a model lower than
   * its footprint standing on its foot as a picture's does, so the decor
   * never hangs below the foot (D-261127-716).
   */
  frame: VBox;
  ring: VBox;
  /** The shadow on the drawn ground, when the base is above it. */
  shadow: VBox | null;
  /** Everything it draws, its decor included. */
  bounds: VBox;
  /**
   * Everything it draws among the relief's pieces: its art, ring, outlines,
   * stem and shadow. Its decor draws in the overlay over every piece, so a
   * later standee covers an earlier one only with these.
   */
  paints: VBox;
  /** Whether the lift was capped, so the stem draws a break mark. */
  capped: boolean;
  /** The base as drawn, in cells: the logical base, or lower where the lift is capped. Drawing and layout both read this one. */
  drawnBase: number;
};

/** The view box of a footprint's ellipse, w by h cells on the ground, at a view point: the same at every turn, since the ground turns by 45 degrees plus right angles. */
export function ellipseBox(turn: Turn, w: number, h: number, at: { x: number; y: number }): VBox {
  const { c, s } = turnAxes(turn);
  // A world ellipse with semi-axes a and b, turned: its half-width along u, and half its half-height along v.
  const a = w / 2;
  const b = h / 2;
  const hu = Math.sqrt(a * a * c * c + b * b * s * s);
  const hv = Math.sqrt(a * a * s * s + b * b * c * c) / 2;
  return { x0: at.x - hu, x1: at.x + hu, y0: at.y - hv, y1: at.y + hv };
}

/** How a rider sits on its holder: `rise` view units up it, its art drawn at `inset` of its size when it covers the holder. */
export type Seat = { rise: number; inset: number };

export const ON_GROUND: Seat = { rise: 0, inset: 1 };

/** A model a standee stands as: its frame's side and anchor (ModelRef), and the drawn box of the frame its turn and facing pick, in hundredths. */
export type StandeeModel = { side: number; anchorY: number; box: readonly [number, number, number, number] };

/** The standee shape of a model at a frame (features/models/frames.ts frameFor). */
export function standeeModel(ref: Pick<ModelRef, "side" | "anchorY" | "boxes">, frame: number): StandeeModel {
  return { side: ref.side, anchorY: ref.anchorY, box: ref.boxes[frame] ?? [0, 0, 100, 100] };
}

/** A footprint's longer side: a model draws at it, centered on a custom w by h footprint (D-261127-383). */
function longer(size: { w: number; h: number }): number {
  return Math.max(size.w, size.h);
}

/**
 * How far up its holder a rider sits, in view units: half the holder's art
 * up its picture, or the middle of the drawn box of the frame a holder
 * standing as its model shows (docs/design/design-v1-token-models.md 6),
 * never below the holder's ring.
 */
export function seatRise(holder: { w: number; h: number }, model: StandeeModel | null): number {
  if (!model) return holder.h / 2;
  const size = model.side * longer(holder);
  const top = model.anchorY - model.box[1] / 100;
  const bottom = model.anchorY - model.box[3] / 100;
  return Math.max(0, ((top + bottom) / 2) * size);
}

/**
 * A standee's shape, the one box its drawing, decor, silhouette and culling
 * all read. `box` is its footprint as drawn, in cells, `base` its drawn
 * base and `ground` the drawn ground under it, both in cells, `scale` the
 * camera's px per view unit, for the decor's reach and the lift's cap
 * (`canvasHeight` in px), `seat` where it rides a holder, and `model` the
 * model it stands as, by modelShown, or null for its picture.
 */
export function standeeShape(
  turn: Turn,
  box: { x: number; y: number; w: number; h: number },
  base: number,
  ground: number,
  scale: number,
  canvasHeight: number,
  seat: Seat = ON_GROUND,
  model: StandeeModel | null = null,
): StandeeShape {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const g = toView(isometric(turn), center, ground);
  const drawn = cappedBase(base, ground, scale, canvasHeight);
  const capped = drawn !== base;
  const lift = K * (drawn - ground);
  const at = { x: g.x, y: g.y - lift };
  const foot = at.y - seat.rise;
  let art: VBox;
  let drawnBox: VBox;
  let frame: VBox;
  if (model) {
    art = modelArtBox(model, longer(box) * seat.inset, { x: at.x, y: foot });
    drawnBox = modelDrawnBox(art, model.box);
    const top = modelDecorTop(drawnBox.y0, foot, box.h);
    frame = { x0: at.x - box.w / 2, x1: at.x + box.w / 2, y0: top, y1: top + box.h };
  } else {
    art = { x0: at.x - (box.w * seat.inset) / 2, x1: at.x + (box.w * seat.inset) / 2, y0: foot - box.h * seat.inset, y1: foot };
    drawnBox = art;
    frame = { x0: at.x - box.w / 2, x1: at.x + box.w / 2, y0: foot - box.h, y1: foot };
  }
  const ring = ellipseBox(turn, box.w, box.h, at);
  const shadow = base > ground ? ellipseBox(turn, box.w, box.h, g) : null;
  const k = 1 / Math.max(scale, 1e-9);
  const reach = TICK_REACH + RING_REACH_PX * k;
  const paints = {
    x0: Math.min(drawnBox.x0, ring.x0 - reach, shadow?.x0 ?? Infinity),
    x1: Math.max(drawnBox.x1, ring.x1 + reach, shadow?.x1 ?? -Infinity),
    y0: Math.min(drawnBox.y0, ring.y0 - reach),
    y1: Math.max(drawnBox.y1, ring.y1 + reach, shadow?.y1 ?? -Infinity),
  };
  /*
   * The decor's reach round the frame it lays out on and the ring under it,
   * with everything the standee paints: a flat or low model's drawn top lies
   * below its ring's top, and at a close zoom the outlines and facing tick
   * reach past the decor's reach of a few pixels.
   */
  const bounds = {
    x0: Math.min(Math.min(frame.x0, ring.x0, drawnBox.x0) - DECOR_REACH_PX.side * k, paints.x0),
    x1: Math.max(Math.max(frame.x1, ring.x1, drawnBox.x1) + DECOR_REACH_PX.side * k, paints.x1),
    y0: Math.min(Math.min(frame.y0, drawnBox.y0) - DECOR_REACH_PX.top * k, paints.y0),
    y1: Math.max(Math.max(ring.y1, shadow?.y1 ?? -Infinity, frame.y1, drawnBox.y1) + DECOR_REACH_PX.bottom * k, paints.y1),
  };
  return { ground: g, base: at, art, drawnBox, frame, ring, shadow, bounds, paints, capped, drawnBase: drawn };
}

/**
 * The base a standee draws at, in cells: its base, or lower where its lift
 * over the drawn ground would rise past LIFT_CAP_CANVAS canvas heights on
 * screen (5.4). Everything that stands by a ring reads this one: the
 * drawing, box select, the chrome over it and a drag's grab
 * (canvas/boardPick.ts tokenBase), while the rules keep the logical base.
 */
export function cappedBase(base: number, ground: number, scale: number, canvasHeight: number): number {
  const cap = (LIFT_CAP_CANVAS * canvasHeight) / Math.max(scale, 1e-9);
  return K * (base - ground) > cap ? ground + cap / K : base;
}

/**
 * The top of a model's decor frame, `h` tall, from its drawn top and its
 * foot in one frame of reference: hung from the drawn top, or for a model
 * lower than its footprint standing on its foot as a picture's does, so the
 * decor never hangs below the foot (D-261127-716). The still layout
 * (standeeShape) and a dragged model's own decor (standeeParts) both read
 * it, so starting a drag never moves the decor.
 */
export function modelDecorTop(drawnTop: number, foot: number, h: number): number {
  return Math.min(drawnTop, foot - h);
}

/**
 * Where a model draws in the art's group, before the art's scale: its
 * frame's drawn box alone, the only part of the frame that paints, so the
 * image takes a press there and nowhere else in its frame (D-261127-379).
 */
export type ModelParts = { drawn: { x: number; y: number; w: number; h: number } };

/**
 * Where a standee's parts draw inside the ground group, in world cells
 * from the footprint's corner, for TokenNode.tsx's Standee: the shadow's
 * and the ring's offsets, and the stem's length in view units, all from the
 * drawn base, so what draws is the box the layout culls and decorates. A
 * lift of K z view units up the screen is a shift of (-2K z s, -2K z c) in
 * the ground group, which squashes and turns it. The art's corner and the
 * decor's, in the upright group at the ring's middle, are the layout's art
 * box and frame (standeeShape), a model's included.
 */
export function standeeParts(
  turn: Turn,
  drawnBase: number,
  ground: number,
  size: { w: number; h: number },
  seat: Seat = ON_GROUND,
  model: StandeeModel | null = null,
): { shadow: { x: number; y: number } | null; base: { x: number; y: number }; stem: number; art: { x: number; y: number; scale: number }; decor: { x: number; y: number }; model: ModelParts | null } {
  const { c, s } = turnAxes(turn);
  const lift = (z: number) => ({ x: -2 * K * z * s, y: -2 * K * z * c });
  const raised = drawnBase > ground;
  const parts = { shadow: raised ? lift(ground) : null, base: lift(drawnBase), stem: raised ? K * (drawnBase - ground) : 0 };
  if (!model) {
    // The art's corner in the upright group, which stands at the ring's middle in view units: up its holder, and inset where it rides one.
    const art = { x: (-size.w * seat.inset) / 2, y: -size.h * seat.inset - seat.rise, scale: seat.inset };
    return { ...parts, art, decor: { x: -size.w / 2, y: -size.h - seat.rise }, model: null };
  }
  const side = model.side * longer(size);
  const k = side / 100;
  const [x0, y0, x1, y1] = model.box;
  const art = { x: (-side * seat.inset) / 2, y: -seat.rise - model.anchorY * side * seat.inset, scale: seat.inset };
  // The upright group stands at the ring's middle, so the foot is the seat's rise up it.
  return { ...parts, art, decor: { x: -size.w / 2, y: modelDecorTop(art.y + y0 * k * seat.inset, -seat.rise, size.h) }, model: { drawn: { x: x0 * k, y: y0 * k, w: (x1 - x0) * k, h: (y1 - y0) * k } } };
}
