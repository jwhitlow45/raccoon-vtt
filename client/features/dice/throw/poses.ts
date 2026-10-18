import { Quaternion, Vector3 } from "three";

/**
 * A die's path through a throw (docs/design-v1-roll-animation.md 3.2 and
 * 3.4): a scripted tumble, never a physics engine. The die eases from the
 * control that rolled to its slot while a rotation about its rolling axis,
 * put in front of the solved landing, shrinks to exactly 0 at 1 s. So it
 * lands on time and on its face whatever frames the device drops: a late
 * frame draws the pose for its own time. Only the lazy stage imports this
 * module, since it needs three.
 *
 * Positions are the stage's: screen px with y upward, the tray's top left
 * at 0, 0.
 */

/** The dice land this long after the answer. */
export const LAND_MS = 1000;
/** The last frame: a dropped die has dimmed by then, and the loop stops. */
export const LAST_FRAME_MS = 1150;
/** How dim a dropped die ends, as its chip is struck through. */
export const DROPPED_OPACITY = 0.42;
const DIM_MS = 120;

export type DiePath = {
  from: Vector3;
  to: Vector3;
  axis: Vector3;
  /** Radians still to turn at the start. */
  spin: number;
  /** A later die leaves a little later, and still lands on time. */
  lag: number;
  landing: Quaternion;
};

/**
 * A die's path from `from` to `to`, both in stage px with y up. `random` is
 * the throw's own, so one tag always makes the same paths.
 */
export function pathFor(input: { from: { x: number; y: number }; to: { x: number; y: number }; landing: Quaternion; index: number }, random: () => number): DiePath {
  const from = new Vector3(input.from.x + (random() - 0.5) * 20, input.from.y + (random() - 0.5) * 20, 0);
  const to = new Vector3(input.to.x, input.to.y, 0);
  const travel = to.clone().sub(from).setZ(0);
  // It rolls about the line across its travel, as a die tumbles along a table.
  const axis = travel.lengthSq() > 1e-6 ? new Vector3(0, 0, 1).cross(travel.normalize()).normalize() : new Vector3(1, 0, 0);
  const spin = (3 + Math.floor(random() * 3)) * Math.PI + random() * 0.6;
  return { from, to, axis, spin, lag: Math.min(input.index * 25, 150), landing: input.landing.clone() };
}

export type Pose = { position: Vector3; quaternion: Quaternion; scale: number; reveal: number; opacity: number };

const clamp = (t: number) => Math.max(0, Math.min(1, t));

/**
 * Where a die is `ms` after the answer. At LAND_MS and later it is exactly
 * its landing, at its slot. `reveal` is how far the result's number has
 * darkened to full ink, and `opacity` dims a dropped die after it lands.
 */
export function poseAt(path: DiePath, ms: number, dropped: boolean): Pose {
  const t = clamp((ms - path.lag) / (LAND_MS - path.lag));
  // Travel and spin slow together, so the die still turns as it arrives.
  const k = 1 - (1 - t) ** 2;
  const position = new Vector3().lerpVectors(path.from, path.to, k);
  const hop = Math.abs(Math.sin(t * Math.PI * 2.4)) * (1 - t) ** 1.6;
  position.z = 40 + hop * 60;
  const leaving = t < 0.08 ? (0.08 - t) * -4 : 0;
  const left = path.spin * (1 - t) ** 2.2;
  const quaternion = t >= 1 ? path.landing.clone() : new Quaternion().setFromAxisAngle(path.axis, left).multiply(path.landing);
  const dim = dropped ? clamp((ms - LAND_MS) / DIM_MS) : 0;
  return { position, quaternion, scale: 1 + hop * 0.35 + leaving, reveal: clamp((t - 0.82) / 0.13), opacity: 1 - dim * (1 - DROPPED_OPACITY) };
}
