import type { AutoWalls, DoorCover, EdgeFeature, RoomState } from "./model.ts";
import { edge, fogRoom, paint } from "./discoveryTestutil.ts";
import { groundOf } from "./rules/held.ts";
import { token } from "./testutil.ts";

/**
 * The twins of the secret door twin test (docs/design/design-v1-maps-vision.md
 * 2.1, SB6): a dead end with a secret door in it and a hidden passage past
 * it, and the same scene with the passage left as rock and the door gone,
 * or for a door with a drawn cover a plain drawn wall in its place. Nothing
 * here runs in the app.
 *
 * Room R is painted from 2, 2 to 9, 9, and a corridor runs east from it on
 * row 5 (rows 5 and 6 when wide) to x 15, so the doors stand on x 16's west
 * edges, across the chunk border at 16. Past them the passage runs to x 18
 * and opens into room Q, 19, 3 to 25, 9. With a drawn cover a wall the DM
 * drew runs down the whole of x 16, as a drawn line the door stands in.
 */

export type TwinOptions = {
  /** One door, or the two of a Wide doorway. */
  wide?: boolean;
  /** The doors' cover: what the twin of rock has in their place follows it. `null` is a door from before covers. */
  cover: DoorCover | null;
  rule?: AutoWalls;
  /** Explore (party vision with fog), or Reveal by hand. */
  explore: boolean;
  perPlayer?: boolean;
};

export type Twins = {
  door: RoomState;
  rock: RoomState;
  doors: string[];
  /** The squares the passage paints, `"x,y"`. */
  passage: ReadonlySet<string>;
  /** The squares no class of the audience may ever have held: the passage and every square beside it but the near doorway squares. */
  banned: ReadonlySet<string>;
};

export const TWIN_W = 32;
export const TWIN_H = 14;
export const HIDDEN_DOOR = { kind: "door", state: "closed", secret: true, discovered: false } as const;

export function twins(opts: TwinOptions): Twins {
  const rows = opts.wide ? [5, 6] : [5];
  const doors = rows.map((y) => `16,${y},w`);
  const passage = new Set<string>();
  for (const y of rows) for (let x = 16; x <= 18; x++) passage.add(`${x},${y}`);
  for (let y = 3; y <= 9; y++) for (let x = 19; x <= 25; x++) passage.add(`${x},${y}`);
  const near = new Set(rows.map((y) => `15,${y}`));
  const banned = new Set(passage);
  for (const key of passage) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const at = `${x + dx},${y + dy}`;
      if (!near.has(at)) banned.add(at);
    }
  }
  const base = (): RoomState => {
    const state = fogRoom({
      vision: opts.explore,
      perPlayer: opts.perPlayer === true,
      bounds: { w: TWIN_W, h: TWIN_H },
      scene: opts.rule === undefined ? {} : { autoWalls: opts.rule },
    });
    paint(state, { x: 2, y: 2, w: 8, h: 8 });
    paint(state, { x: 10, y: 5, w: 6, h: rows.length });
    if (opts.cover === "drawn") for (let y = 0; y < TWIN_H; y++) if (!rows.includes(y)) edge(state, `16,${y},w`, { kind: "wall" });
    state.tokens.a = token("a", { kind: "pc", name: "Ayla", ownerIds: ["p1"], disposition: "ally", x: 4, y: 4 });
    state.tokens.b = token("b", { kind: "pc", name: "Bree", ownerIds: ["p2"], disposition: "ally", x: 6, y: 7 });
    if (opts.perPlayer) state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }] } };
    return { ...state, memory: {}, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
  };
  const door = base();
  for (const key of passage) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    paint(door, { x, y, w: 1, h: 1 });
  }
  const hidden: EdgeFeature = opts.cover === null ? { ...HIDDEN_DOOR } : { ...HIDDEN_DOOR, cover: opts.cover };
  for (const key of doors) edge(door, key, hidden);
  const rock = base();
  if (opts.cover === "drawn") for (const key of doors) edge(rock, key, { kind: "wall" });
  return { door, rock, doors, passage, banned };
}

/** The fog classes of the scene now: the party's, and each sight holder turned on. */
export function classesOf(state: RoomState): (string | null)[] {
  const scene = state.scenes.s1!;
  if (scene.vision?.perPlayer !== true) return [null];
  return [null, ...(state.holders?.s1?.entries ?? []).filter((e) => e.on).map((e) => e.memberId)];
}

/** The fog class a player's device belongs to now. */
export function classOfMember(state: RoomState, memberId: string): string | null {
  return classesOf(state).includes(memberId) ? memberId : null;
}

/** Whether a class holds any of the squares, in either twin: once it has, it leaves the audience for good. */
export function holdsAny(states: readonly RoomState[], layer: string | null, squares: ReadonlySet<string>): boolean {
  for (const state of states) {
    const ground = groundOf(state, "s1", layer);
    if (!ground) continue;
    for (const key of squares) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (ground.held(x, y)) return true;
    }
  }
  return false;
}

/** A value with every `rev` left out, as the twin test compares projected state. */
export function withoutRevs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRevs);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) if (key !== "rev") out[key] = withoutRevs((value as Record<string, unknown>)[key]);
  return out;
}
