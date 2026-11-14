import { chunkOf, fogRoom, paint } from "./discoveryTestutil.ts";
import type { AreaTemplate, RoomState, Stamp, Token } from "./model.ts";
import { seqTwins, type SeqTwinOptions } from "./seqTestutil.ts";
import { chance, character, drawing, int, rng, template, token } from "./testutil.ts";

/**
 * Helpers for the twin tests of what a player's device receives
 * (server/rooms/priv.twin.test.ts, priv.random.test.ts, priv.itest.ts):
 * two rooms whose copies for P1 and the table display match, while the
 * rest of each room differs, and checks on the frames each device got.
 * Nothing here runs in the app.
 */

/** Twin names, as seqTwins names its two rooms. */
export type TwinName = "door" | "rock";

/** The side room's corridor runs south from room R's west end and turns east, so nothing in room R sees into it. */
export const SIDE_CORRIDOR = { x: 2, y: 10, w: 1, h: 2 } as const;
/** The side room, 2, 12 to 9, 13. */
export const SIDE_ROOM = { x: 2, y: 12, w: 8, h: 2 } as const;
/** Where Ayla stands to see the whole side room. */
export const IN_SIDE = { x: 5, y: 12 } as const;
/** Where Ayla stands in room R, out of sight of the side room. */
export const IN_R = { x: 4, y: 4 } as const;

/** A stamp of a shipped picture, at a cell's middle. */
export function stampAt(id: string, x: number, y: number, z: number, visibility: Stamp["visibility"] = "all"): Stamp {
  return { id, rev: 0, sceneId: "s1", art: { key: "chest" }, x: x + 0.5, y: y + 0.5, w: 1, h: 1, rotation: 0, z, visibility };
}

/** An id of the production shape, from a seeded source, so two twins pair their ids by drawing alike. */
export function idFrom(r: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => int(r, 0, 15).toString(16)).join("");
  return `0199f0a0-${hex(4)}-7${hex(3)}-8${hex(3)}-${hex(12)}`;
}

/** What one twin holds that neither P1 nor the display may ever be sent: ids and names. */
export type Hidden = { ids: string[]; names: string[] };

export type PrivTwins = {
  door: RoomState;
  rock: RoomState;
  /** Per twin, what no copy of P1's or the display's may hold. */
  hidden: Record<TwinName, Hidden>;
  /** Per twin, the hidden creatures on the players' scene, in room R. */
  creatures: Record<TwinName, string[]>;
  /** Per twin, the hidden stamps, in room R and the side room. */
  hiddenStamps: Record<TwinName, string[]>;
  /** The stamps both twins hold alike for players: room R's, then the side room's. */
  stampsR: string[];
  stampsSide: string[];
  /** The visible area in room R, cast by a hidden creature (a different one in each twin). */
  area: string;
};

/**
 * The room count's twins (seqTwins, the door twin and the twin of rock),
 * each with a side room off room R, and with more drawn apart per twin
 * that P1 and the display never get: hidden stamps between the public
 * ones in room R and in the side room, so the stored orders differ, hidden
 * creatures with names no visible creature has, a visible area whose
 * caster is one of them, and areas only the DM sees. The public stamps
 * are alike in both twins in every field but their stored order.
 */
export function privTwins(seed: number, opts: SeqTwinOptions = {}): PrivTwins {
  const w = seqTwins(opts);
  const shared = rng(seed);
  const stampsR = [idFrom(shared), idFrom(shared), idFrom(shared)];
  const stampsSide = [idFrom(shared), idFrom(shared)];
  const area = idFrom(shared);
  const out: PrivTwins = {
    door: w.door,
    rock: w.rock,
    hidden: { door: { ids: [], names: [] }, rock: { ids: [], names: [] } },
    creatures: { door: [], rock: [] },
    hiddenStamps: { door: [], rock: [] },
    stampsR,
    stampsSide,
    area,
  };
  for (const name of ["door", "rock"] as const) {
    const state = w[name];
    // Each twin draws apart from its own source.
    const r = rng(seed * 2 + (name === "door" ? 1 : 2));
    const hidden = out.hidden[name];
    paint(state, SIDE_CORRIDOR);
    paint(state, SIDE_ROOM);
    const creatures: Token[] = [];
    for (let i = int(r, 1, 3); i > 0; i--) {
      const id = idFrom(r);
      const label = `Shade ${id.slice(-6)}`;
      creatures.push(token(id, { name: label, visibility: "dm", disposition: "hostile", x: int(r, 6, 9), y: int(r, 2, 3) }));
      hidden.ids.push(id);
      hidden.names.push(label);
    }
    for (const c of creatures) state.tokens[c.id] = c;
    out.creatures[name] = creatures.map((c) => c.id);
    // Public stamps keep one order. Hidden ones sit between them, a different number in each twin, and the gaps
    // leave room to move a stamp among the hidden ones without passing a public one.
    const stamps: Stamp[] = [];
    let z = 0;
    const next = () => (z += int(r, 2, 10));
    const between = (x0: number, x1: number, y: number) => {
      for (let i = int(r, 0, 2); i > 0; i--) {
        const id = idFrom(r);
        stamps.push(stampAt(id, int(r, x0, x1), y, next(), "dm"));
        hidden.ids.push(id);
        out.hiddenStamps[name].push(id);
      }
    };
    for (const [i, id] of stampsR.entries()) {
      between(3, 8, 8);
      stamps.push(stampAt(id, 3 + 2 * i, 7, next()));
    }
    between(3, 8, 8);
    for (const [i, id] of stampsSide.entries()) {
      between(4, 9, 13);
      stamps.push(stampAt(id, 6 + 2 * i, 12, next()));
    }
    between(4, 9, 13);
    state.stamps = Object.fromEntries(stamps.map((s) => [s.id, s]));
    const caster = creatures[0]!.id;
    const templates: AreaTemplate[] = [template(area, { origin: { x: 5.5, y: 3.5, z: 0 }, size: 5, ownerId: "dm1", casterId: caster })];
    for (let i = chance(r, 0.5) ? 1 : int(r, 0, 2); i > 0; i--) {
      const id = idFrom(r);
      templates.push(template(id, { origin: { x: int(r, 3, 8) + 0.5, y: int(r, 3, 8) + 0.5, z: 0 }, size: 5, ownerId: "dm1", visibility: "dm" }));
      hidden.ids.push(id);
    }
    state.templates = Object.fromEntries(templates.map((t) => [t.id, t]));
  }
  return out;
}

/** The kinds of frame that carry a copy of the room. */
function copyValues(frame: unknown): Array<[string, unknown]> {
  if (frame === null || typeof frame !== "object") return [];
  const f = frame as { t?: unknown; changes?: unknown; state?: unknown };
  if (f.t === "snapshot") return [["state", f.state]];
  if (f.t === "ev" && Array.isArray(f.changes)) return (f.changes as Array<{ key: string; value?: unknown }>).filter((c) => "value" in c).map((c) => [c.key, c.value]);
  return [];
}

/**
 * Every `rev` other than 0 in the copies the frames carry, as
 * `"<where> rev <n>"`: a snapshot's state and every value an `ev` sends. A
 * player's copy holds none.
 */
export function revsIn(frames: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) walk(item, `${where}[${i}]`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "rev" && typeof v === "number" && v !== 0) out.push(`${where} rev ${v}`);
      else walk(v, `${where}.${k}`);
    }
  };
  for (const frame of frames) for (const [where, value] of copyValues(frame)) walk(value, where);
  return out;
}

/** Each frame, raw, that names any of the hidden ids or names, as `"<needle> in <frame>"`. Read before any frame is normalized. */
export function hiddenIn(frames: readonly unknown[], hidden: Hidden): string[] {
  const needles = [...hidden.ids, ...hidden.names];
  const out: string[] = [];
  for (const frame of frames) {
    const raw = JSON.stringify(frame);
    for (const needle of needles) if (raw.includes(needle)) out.push(`${needle} in ${raw.slice(0, 300)}`);
  }
  return out;
}

/**
 * The stamps one connection's copy holds, followed frame by frame: a
 * snapshot replaces them, and each `ev` puts or removes the ones it names.
 */
export class StampCopy {
  readonly stamps = new Map<string, Stamp>();

  read(frames: readonly unknown[]): this {
    for (const frame of frames) {
      if (frame === null || typeof frame !== "object") continue;
      const f = frame as { t?: unknown; changes?: Array<{ key: string; value?: unknown }>; state?: { stamps?: Record<string, Stamp> } };
      if (f.t === "snapshot") {
        this.stamps.clear();
        for (const s of Object.values(f.state?.stamps ?? {})) this.stamps.set(s.id, s);
      } else if (f.t === "ev" && Array.isArray(f.changes)) {
        for (const c of f.changes) {
          if (!c.key.startsWith("stamp:")) continue;
          const id = c.key.slice("stamp:".length);
          if ("value" in c && c.value !== null && c.value !== undefined) this.stamps.set(id, c.value as Stamp);
          else this.stamps.delete(id);
        }
      }
    }
    return this;
  }

  /** Each held stamp's `z` by id, per scene. */
  orders(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const s of [...this.stamps.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) (out[s.sceneId] ??= {})[s.id] = s.z;
    return out;
  }

  /** The scenes whose held stamps' `z` are not exactly 0 to n-1, each once, as `"<scene>: <z, in order>"`. */
  notRanks(): string[] {
    const out: string[] = [];
    for (const [scene, zs] of Object.entries(this.orders())) {
      const sorted = Object.values(zs).sort((a, b) => a - b);
      if (sorted.some((z, i) => z !== i)) out.push(`${scene}: ${sorted.join(", ")}`);
    }
    return out;
  }
}

/**
 * A version 7 id dated `ms`, its other bits drawn from `r`, so two twins
 * that mint at the same clock time from sources seeded alike get the same
 * id, as a device minting at send does.
 */
export function idAt(r: () => number, ms: number): string {
  const hex = (n: number) => Array.from({ length: n }, () => int(r, 0, 15).toString(16)).join("");
  const time = Math.floor(ms).toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(3)}-${"89ab"[int(r, 0, 3)]}${hex(3)}-${hex(12)}`;
}

/** Ids and names only one twin of the player limits tests holds carry this, which no frame's text holds by chance. */
export const APART = "zq";

/** The party's room R, where Ayla (P1's) and Bree (P2's) stand with a goblin, and room F, apart from it behind rock. */
export const ROOM_R = { x: 2, y: 2, w: 10, h: 8 } as const;
export const ROOM_F = { x: 24, y: 2, w: 10, h: 8 } as const;

/** A cell in room R or F by column and row inside it. */
export const inRoomR = (i: number, j = 0) => ({ x: 7 + i, y: 3 + j });
export const inRoomF = (i: number, j = 0) => ({ x: 26 + i, y: 3 + j });

/** P1's character Ayla and P2's Bree, each with a token of the same id in room R. */
export const AYLA = "ayla";
export const BREE = "bree";
/** An ogre in room R that every player sees, alone of its name, so it carries no number. */
export const OGRE = "ogre";

/**
 * The room of the player limits twins: party sight on the players' scene
 * s1, rooms R and F painted apart so sight in R never reaches F, P1's
 * Ayla and P2's Bree as characters with tokens in R, and an ogre in R.
 * Each twin adds what P1 never sees.
 */
export function limitsRoom(): RoomState {
  const state = fogRoom({ vision: true });
  paint(state, ROOM_R);
  paint(state, ROOM_F);
  state.characters[AYLA] = character(AYLA, { name: "Ayla", ownerIds: ["p1"] });
  state.characters[BREE] = character(BREE, { name: "Bree", ownerIds: ["p2"] });
  state.tokens[AYLA] = token(AYLA, { kind: "pc", name: "Ayla", disposition: "ally", x: 3, y: 3, actor: { ref: AYLA } });
  state.tokens[BREE] = token(BREE, { kind: "pc", name: "Bree", disposition: "ally", x: 3, y: 7, actor: { ref: BREE } });
  state.tokens[OGRE] = token(OGRE, { name: "Ogre", x: 8, y: 4 });
  return { ...state, playedScenes: { s1: { sceneId: "s1", rev: 0 } } };
}

/** An id only one twin holds, `zq` and a number, padded so no two share a prefix the scan could mistake. */
export const apartId = (what: string, i: number) => `${APART}${what}${String(i).padStart(5, "0")}`;

/** `n` areas only the DM sees on a scene, on its first floor. */
export function dmAreas(state: RoomState, n: number, sceneId = "s1"): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("area", i));
  for (const id of ids) state.templates[id] = template(id, { sceneId, ownerId: "dm1", visibility: "dm", origin: { x: 28.5, y: 5.5, z: 0 }, size: 5 });
  return ids;
}

/** `n` creatures only the DM sees, in room F. */
export function dmTokens(state: RoomState, n: number, sceneId = "s1"): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("tok", i));
  for (const [i, id] of ids.entries()) state.tokens[id] = token(id, { sceneId, name: `${APART}shade`, visibility: "dm", x: 26 + (i % 6), y: 3 + (Math.floor(i / 6) % 6) });
  return ids;
}

/** `n` drawings only the DM sees, of `points` point values each. */
export function dmDrawings(state: RoomState, n: number, points = 4, sceneId = "s1"): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("drw", i));
  const values = Array.from({ length: points }, (_, i) => 26 + (i % 6));
  for (const id of ids) state.drawings[id] = drawing(id, { sceneId, ownerId: "dm1", visibility: "dm", points: values });
  return ids;
}

/** Stairs from Ayla's square on s1 up to the Upper floor of s1's scene, and back down. */
export const STAIRS_UP = "l1";
export const STAIRS_DOWN = "l2";

/** Gives the limits room an Upper floor above s1, with room R painted there too, and stairs under Ayla. */
export function withUpper(state: RoomState): RoomState {
  const ground = state.scenes.s1!;
  state.scenes.s1 = { ...ground, floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } };
  state.scenes.up = { ...ground, id: "up", floor: { of: "s1", level: 1, name: "Upper floor", height: 10 } };
  for (let y = ROOM_R.y; y < ROOM_R.y + ROOM_R.h; y++) for (let x = ROOM_R.x; x < ROOM_R.x + ROOM_R.w; x++) chunkOf(state, "up", x, y).cells[`${x},${y}`] = "stone";
  const rect = { x: 3, y: 3, w: 1, h: 1 };
  state.floorLinks = {
    [STAIRS_UP]: { id: STAIRS_UP, rev: 0, sceneId: "s1", to: "up", pair: STAIRS_DOWN, rect, kind: "stairs", ground: 0, made: 1 },
    [STAIRS_DOWN]: { id: STAIRS_DOWN, rev: 0, sceneId: "up", to: "s1", pair: STAIRS_UP, rect, kind: "stairs", ground: 0, made: 1 },
  };
  return state;
}
