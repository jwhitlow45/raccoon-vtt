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
export const GENERATOR_VERSION = 6;

export type Density = "sparse" | "normal" | "dense";
export type CorridorStyle = "straight" | "bending" | "winding";
export type Theme = "dungeon" | "crypt" | "cave" | "mine" | "sewer";
/** Props from the shipped stamps (phase 2, 5.5): none, 1 or 2 in about 2 rooms of 3, or 2 to 4 in every room. */
export type Dressing = "none" | "some" | "full";

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
  /** Extra ways around: loop links beside the tree. */
  loops: boolean;
  theme: Theme;
  /** Rooms raised or sunk, never the entrance, in percent: 0 to HEIGHTS_MAX in steps of HEIGHTS_STEP. */
  heights: number;
  /** Rooms with a trap, in twelfths: 0 to TRAPS_MAX, so Few's one per six and Some's one per three are steps. */
  traps: number;
  band: LevelBand;
  /** Straight spurs that end in rock (phase 2, 5.2). */
  deadEnds: boolean;
  /** Secret doors, in twelfths of the kept rooms: 0 to SECRETS_MAX. Kept as the DM's pick on Cave, which has none. */
  secrets: number;
  /** Rooms lit by a light stamp and its SRD light, in percent: 0 to LIT_MAX in steps of LIT_STEP. */
  lit: number;
  dressing: Dressing;
  /** The DM key: a DM-only journal page and a DM-only numbered pin in each room. */
  key: boolean;
};

/**
 * The room settings the plan reads (phase 2, section 5): only the feet per
 * square, since the Fire-Casting Statue's reach and the Rolling Stone's roll
 * are set in feet. Nothing else of the room reaches the plan, so a seed
 * makes the same dungeon at the same scale.
 */
export type PlanContext = { feetPerCell: number };
/** The room's default scale, which the golden plans pin. */
export const DEFAULT_CONTEXT: Readonly<PlanContext> = { feetPerCell: 5 };

export const HEIGHTS_MAX = 75;
export const HEIGHTS_STEP = 5;
/** The Heights slider's named marks. Some is the quarter the generator always aimed at (D-261102-832). */
export const HEIGHT_PRESETS = { Flat: 0, Few: 10, Some: 25, Many: 50, Most: 75 } as const;
export const TRAPS_MAX = 6;
/** The Traps slider's named marks: none, one per six rooms, one per three and one per two. */
export const TRAP_PRESETS = { None: 0, Few: 2, Some: 4, Many: 6 } as const;
/** What a device remembered from before the sliders, read as the marks that replaced them. */
export const SECRETS_MAX = 6;
/** The Secret doors slider's named marks, in twelfths of the kept rooms. */
export const SECRET_PRESETS = { None: 0, Few: 1, Some: 2, Many: 4 } as const;
export const LIT_MAX = 100;
export const LIT_STEP = 5;
/** The Lit rooms slider's named marks, in percent of the kept rooms. */
export const LIT_PRESETS = { None: 0, Few: 25, Half: 50, All: 100 } as const;
const OLD_HEIGHTS: Readonly<Record<string, number>> = { flat: HEIGHT_PRESETS.Flat, some: HEIGHT_PRESETS.Some };
const OLD_TRAPS: Readonly<Record<string, number>> = { none: TRAP_PRESETS.None, few: TRAP_PRESETS.Few, some: TRAP_PRESETS.Some };

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

/** Traps of one dungeon: Many's one per two rooms up to 40 rooms. Each is one `trap.create`, so the largest dungeon stays far under the burst of 60 ops. */
export const MAX_TRAPS = 20;
/** Door edges of one dungeon. The largest Wide topology makes 198, and one `build.edge` holds 500. */
export const MAX_DOOR_EDGES = 200;
/** Secret doors of one dungeon (phase 2, 5.3). A Wide doorway's two edges are one. */
export const MAX_SECRET_DOORS = 12;
/** Dead ends of one dungeon (phase 2, 5.2). */
export const MAX_DEAD_ENDS = 10;
/** Lights of one dungeon, of the scene's 100 (phase 2, section 10). */
export const MAX_LIGHTS = 40;
/** Stamps of one dungeon, light stamps and statues included, of the scene's 500, so two `build.stamps` ops hold them. */
export const MAX_STAMPS = 160;
/** Stamps of one room, its light stamp and statue included. */
export const MAX_ROOM_STAMPS = 4;
/** Rolling stones of one dungeon. */
export const MAX_STONES = 2;
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
  heights: HEIGHT_PRESETS.Some,
  traps: TRAP_PRESETS.Few,
  band: "1-4",
  deadEnds: true,
  secrets: SECRET_PRESETS.Few,
  lit: LIT_PRESETS.Few,
  dressing: "some",
  key: true,
};

const DENSITIES: readonly Density[] = ["sparse", "normal", "dense"];
const CORRIDORS: readonly CorridorStyle[] = ["straight", "bending", "winding"];
export const THEMES: readonly Theme[] = ["dungeon", "crypt", "cave", "mine", "sewer"];
export const DRESSINGS: readonly Dressing[] = ["none", "some", "full"];

/** Each choice's name as the dialog shows it and the key's "Made with" line writes it. */
export const CHOICE_NAMES: {
  theme: Readonly<Record<Theme, string>>;
  density: Readonly<Record<Density, string>>;
  corridors: Readonly<Record<CorridorStyle, string>>;
  dressing: Readonly<Record<Dressing, string>>;
} = {
  theme: { dungeon: "Dungeon", crypt: "Crypt", cave: "Cave", mine: "Mine", sewer: "Sewer" },
  density: { sparse: "Sparse", normal: "Normal", dense: "Dense" },
  corridors: { straight: "Straight", bending: "Bending", winding: "Winding" },
  dressing: { none: "None", some: "Some", full: "Full" },
};

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

/** A slider's value from anything: a number to the nearest step within 0 to `max`, an old choice's word as its mark, else the fallback. */
function onSlider(value: unknown, max: number, step: number, old: Readonly<Record<string, number>>, fallback: number): number {
  if (typeof value === "string") return Object.hasOwn(old, value) ? old[value]! : fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(Math.round(value / step) * step, 0, max);
}

/**
 * Rooms a Heights share raises or sinks among `rooms`, never the entrance:
 * the share of the others, rounded, and at least one for any share above
 * none, so Few always shows on a small map.
 */
export function raisedCount(share: number, rooms: number): number {
  const others = Math.max(0, rooms - 1);
  if (share <= 0 || others === 0) return 0;
  return clamp(Math.floor((2 * share * others + 100) / 200), 1, others);
}

/** Traps a Traps share places among `rooms` kept rooms: its twelfths of them, rounded down, at least one and at most MAX_TRAPS. */
export function trapCount(twelfths: number, rooms: number): number {
  if (twelfths <= 0) return 0;
  return clamp(Math.floor((rooms * twelfths) / 12), 1, MAX_TRAPS);
}

/**
 * Secret doors a Secret doors share places among `rooms` kept rooms: its
 * twelfths of them, rounded down, at least one above None and at most
 * MAX_SECRET_DOORS. The generator places none on Cave whatever this says.
 */
export function secretCount(twelfths: number, rooms: number): number {
  if (twelfths <= 0 || rooms <= 0) return 0;
  return clamp(Math.floor((rooms * twelfths) / 12), 1, MAX_SECRET_DOORS);
}

/**
 * Rooms a Lit rooms share lights among `rooms` kept rooms, the entrance
 * among them: the share rounded half up, at least one above None and at
 * most every room, within MAX_LIGHTS.
 */
export function litCount(share: number, rooms: number): number {
  if (share <= 0 || rooms <= 0) return 0;
  return clamp(Math.floor((2 * share * rooms + 100) / 200), 1, Math.min(rooms, MAX_LIGHTS));
}

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
    heights: onSlider(s.heights, HEIGHTS_MAX, HEIGHTS_STEP, OLD_HEIGHTS, DEFAULT_SETTINGS.heights),
    traps: onSlider(s.traps, TRAPS_MAX, 1, OLD_TRAPS, DEFAULT_SETTINGS.traps),
    band: oneOf(s.band, LEVEL_BANDS, DEFAULT_SETTINGS.band),
    deadEnds: typeof s.deadEnds === "boolean" ? s.deadEnds : DEFAULT_SETTINGS.deadEnds,
    secrets: onSlider(s.secrets, SECRETS_MAX, 1, {}, DEFAULT_SETTINGS.secrets),
    lit: onSlider(s.lit, LIT_MAX, LIT_STEP, {}, DEFAULT_SETTINGS.lit),
    dressing: oneOf(s.dressing, DRESSINGS, DEFAULT_SETTINGS.dressing),
    key: typeof s.key === "boolean" ? s.key : DEFAULT_SETTINGS.key,
  };
}

/** A plan context from anything: the feet per square as the room settings hold it, 1 to 100, else the default. */
export function clampContext(c: Partial<Record<keyof PlanContext, unknown>> | undefined): PlanContext {
  const ft = c?.feetPerCell;
  return { feetPerCell: typeof ft === "number" && Number.isFinite(ft) ? clamp(Math.round(ft), 1, 100) : DEFAULT_CONTEXT.feetPerCell };
}
