import { LEVEL_BANDS, type LevelBand } from "#shared/srd/traps.ts";

/*
 * The dungeon generator's choices and caps (docs/design/design-v1-dungeon-generator.md
 * 4.2 and 8). The dialog keeps the choices, the generator reads them, and
 * every number a dungeon can reach is bounded here, so the ops it lands
 * stay inside the server's burst and the scene's caps.
 */

/**
 * The generator's version, the first character of every seed it makes.
 * The golden fixture pins plans by hash, so a change that moves any plan
 * bumps this and the fixture together. Replay never reads it: the stored
 * ops hold the dungeon.
 */
export const GENERATOR_VERSION = 1;

export type Density = "sparse" | "normal" | "dense";
export type CorridorStyle = "straight" | "bending" | "winding";
export type Theme = "dungeon" | "crypt";
export type HeightsChoice = "flat" | "some";
export type TrapsChoice = "none" | "few" | "some";

export type DungeonSettings = {
  /** Squares across and down, MIN_SIDE to MAX_SIDE. */
  w: number;
  h: number;
  /** Rooms asked for, MIN_ROOMS to roomCap(w, h). */
  rooms: number;
  density: Density;
  corridors: CorridorStyle;
  /** Corridors and doorways 2 squares across, with double doors. */
  wide: boolean;
  /** Extra ways round: loop links beside the tree. */
  loops: boolean;
  theme: Theme;
  heights: HeightsChoice;
  traps: TrapsChoice;
  band: LevelBand;
};

/** The Size choices. Custom takes Across and Down. */
export type SizeChoice = "small" | "medium" | "large" | "custom";
export const SIZE_SIDES: Readonly<Record<Exclude<SizeChoice, "custom">, number>> = { small: 30, medium: 50, large: 80 };

export const MIN_SIDE = 20;
export const MAX_SIDE = 100;
export const MIN_ROOMS = 2;
export const MAX_ROOMS = 40;
/** Rooms reach one per this many squares of the map, so they always have rock between them. */
const SQUARES_PER_ROOM_CAP = 90;
/** Custom's starting Rooms: one per this many squares. */
const SQUARES_PER_ROOM_CUSTOM = 200;
/** The presets' starting Rooms. */
const PRESET_ROOMS: Readonly<Record<Exclude<SizeChoice, "custom">, number>> = { small: 6, medium: 12, large: 20 };

export const MAX_TRAPS = 12;
/** Door edges of one dungeon. The largest Wide topology makes 198, and one `build.edge` holds 500. */
export const MAX_DOOR_EDGES = 200;
/** Search expansions for the whole dungeon's corridors (5.4). */
export const SEARCH_BUDGET = 400_000;

export const DEFAULT_SETTINGS: Readonly<DungeonSettings> = {
  w: SIZE_SIDES.medium,
  h: SIZE_SIDES.medium,
  rooms: PRESET_ROOMS.medium,
  density: "normal",
  corridors: "bending",
  wide: false,
  loops: true,
  theme: "dungeon",
  heights: "some",
  traps: "few",
  band: "1-4",
};

const DENSITIES: readonly Density[] = ["sparse", "normal", "dense"];
const CORRIDORS: readonly CorridorStyle[] = ["straight", "bending", "winding"];
const THEMES: readonly Theme[] = ["dungeon", "crypt"];
const HEIGHTS: readonly HeightsChoice[] = ["flat", "some"];
const TRAPS: readonly TrapsChoice[] = ["none", "few", "some"];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A side as the generator takes it: a whole number of squares, 20 to 100. Anything else reads as the nearest. */
export function clampSide(n: number): number {
  return Number.isFinite(n) ? clamp(Math.round(n), MIN_SIDE, MAX_SIDE) : MIN_SIDE;
}

/** The most rooms a map of this size takes: one per 90 squares, 2 to 40. */
export function roomCap(w: number, h: number): number {
  return clamp(Math.floor((clampSide(w) * clampSide(h)) / SQUARES_PER_ROOM_CAP), MIN_ROOMS, MAX_ROOMS);
}

/** Rooms clamped to what the size takes. */
export function clampRooms(n: number, w: number, h: number): number {
  return Number.isFinite(n) ? clamp(Math.round(n), MIN_ROOMS, roomCap(w, h)) : MIN_ROOMS;
}

/** Rooms a size starts on: 6, 12 and 20 for the presets, and one per 200 squares on Custom, within the cap. */
export function defaultRooms(size: SizeChoice, w: number, h: number): number {
  const n = size === "custom" ? Math.floor((clampSide(w) * clampSide(h)) / SQUARES_PER_ROOM_CUSTOM) : PRESET_ROOMS[size];
  return clampRooms(n, w, h);
}

const oneOf = <T>(value: unknown, choices: readonly T[], fallback: T): T => (choices.includes(value as T) ? (value as T) : fallback);

/**
 * Settings the generator can take from anything shaped like them, such as
 * choices a device remembered under an older build: each field read or
 * replaced by its default, sides and Rooms clamped.
 */
export function clampSettings(s: Partial<Record<keyof DungeonSettings, unknown>>): DungeonSettings {
  const w = typeof s.w === "number" ? clampSide(s.w) : DEFAULT_SETTINGS.w;
  const h = typeof s.h === "number" ? clampSide(s.h) : DEFAULT_SETTINGS.h;
  return {
    w,
    h,
    rooms: typeof s.rooms === "number" ? clampRooms(s.rooms, w, h) : clampRooms(DEFAULT_SETTINGS.rooms, w, h),
    density: oneOf(s.density, DENSITIES, DEFAULT_SETTINGS.density),
    corridors: oneOf(s.corridors, CORRIDORS, DEFAULT_SETTINGS.corridors),
    wide: typeof s.wide === "boolean" ? s.wide : DEFAULT_SETTINGS.wide,
    loops: typeof s.loops === "boolean" ? s.loops : DEFAULT_SETTINGS.loops,
    theme: oneOf(s.theme, THEMES, DEFAULT_SETTINGS.theme),
    heights: oneOf(s.heights, HEIGHTS, DEFAULT_SETTINGS.heights),
    traps: oneOf(s.traps, TRAPS, DEFAULT_SETTINGS.traps),
    band: oneOf(s.band, LEVEL_BANDS, DEFAULT_SETTINGS.band),
  };
}
