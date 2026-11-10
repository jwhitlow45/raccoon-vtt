import { clampRooms, clampSettings, clampSide, DEFAULT_SETTINGS, defaultRooms, maxSide, SIZE_SIDES, type DungeonSettings, type GridKind, type SizeChoice } from "./settings.ts";

/**
 * The dialog's choices, and this device's memory of them per room
 * (docs/design/design-v1-dungeon-generator.md 4.2, D-261102-023). Only the
 * choices are kept, never a seed: a seed rebuilds the dungeon, and the
 * device may be shared or lost. Plain functions over a storage the caller
 * passes, so the tests run without a DOM.
 */

export type Choices = Omit<DungeonSettings, "w" | "h"> & {
  size: SizeChoice;
  /** Custom's sides. A preset's are its own. */
  across: number;
  down: number;
};

const { w: _w, h: _h, ...DEFAULT_REST } = DEFAULT_SETTINGS;
export const DEFAULT_CHOICES: Choices = { ...DEFAULT_REST, size: "medium", across: SIZE_SIDES.medium, down: SIZE_SIDES.medium };

/** The longest a side may be on a grid (settings.ts `maxSide`): 87 across a hex scene's rows, else 100. The presets' 80 is within it. */
export function sideCap(grid: GridKind, axis: "w" | "h"): number {
  return maxSide(grid, axis);
}

/** The scene's sides for the choices, Custom's within the grid's caps. */
export function sidesOf(c: Pick<Choices, "size" | "across" | "down">, grid: GridKind = "squares"): { w: number; h: number } {
  if (c.size === "custom") return { w: Math.min(clampSide(c.across), sideCap(grid, "w")), h: Math.min(clampSide(c.down), sideCap(grid, "h")) };
  const side = SIZE_SIDES[c.size];
  return { w: side, h: side };
}

/** Rooms for the choices' size picked fresh (settings.ts `defaultRooms`). */
export function roomsDefault(c: Pick<Choices, "size" | "across" | "down">, grid: GridKind = "squares"): number {
  const { w, h } = sidesOf(c, grid);
  return clampRooms(defaultRooms(c.size, w, h), w, h, grid);
}

/**
 * The choices after a size change. Rooms the DM left at the old size's
 * default move to the new size's, and any other count is kept within the
 * new size's limits, so a typed count survives a size change.
 */
export function withSize(c: Choices, next: Partial<Pick<Choices, "size" | "across" | "down">>, grid: GridKind = "squares"): Choices {
  const moved = { ...c, ...next };
  const { w, h } = sidesOf(moved, grid);
  const rooms = c.rooms === roomsDefault(c, grid) ? roomsDefault(moved, grid) : clampRooms(c.rooms, w, h);
  return { ...moved, rooms };
}

/**
 * The generator's settings for the choices, as `clampSettings` orders and
 * bounds them, so the JSON a room edit freezes is the JSON the planner
 * compares (edits.ts `editsHold`).
 */
export function settingsOf(c: Choices, grid: GridKind = "squares"): DungeonSettings {
  const { w, h } = sidesOf(c, grid);
  const { size: _size, across: _across, down: _down, ...rest } = c;
  return clampSettings({ ...rest, w, h, rooms: clampRooms(c.rooms, w, h, grid) }, grid);
}

/**
 * Where the dialog opens: this device's last choices for the room, or the
 * defaults. Custom starts at the New scene form's size, clamped, until the
 * DM has kept a Custom size of their own. Aimed at a floor
 * (docs/design/design-v1-floors.md phase 3, 3.7), it opens on Custom at the
 * floor beside's size, each side clamped, so a floor 140 squares wide gives
 * one 100 wide, with the remembered theme, rooms and the rest.
 */
export function startChoices(saved: Choices | null, form: { w: number; h: number }, floor?: { w: number; h: number }): Choices {
  if (floor) return withSize(saved ?? DEFAULT_CHOICES, { size: "custom", across: clampSide(floor.w), down: clampSide(floor.h) });
  if (saved) return saved;
  return { ...DEFAULT_CHOICES, across: clampSide(form.w), down: clampSide(form.h) };
}

/**
 * The size choices, which a dialog aimed at a floor leaves as they were
 * remembered when it opened (D-261110-185), with the rooms remembered then
 * and the count the dialog opened with, which the floor's size may have
 * moved or clamped.
 */
export type KeptSize = Pick<Choices, "size" | "across" | "down" | "rooms"> & { opened: number };

/** The size a floor's dialog keeps: the remembered one, or the defaults' when nothing was remembered. */
export function keptSize(saved: Choices | null, opened: number): KeptSize {
  const c = saved ?? DEFAULT_CHOICES;
  return { size: c.size, across: c.across, down: c.down, rooms: c.rooms, opened };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const keyOf = (roomId: string) => `rvtt.dungeon.${roomId}`;
const SIZES: readonly SizeChoice[] = ["small", "medium", "large", "custom"];

/** What storage held, each field checked on its own (settings.ts `clampSettings`): anything could have written there. */
export function parseChoices(raw: string | null): Choices | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const size = SIZES.includes(r.size as SizeChoice) ? (r.size as SizeChoice) : DEFAULT_CHOICES.size;
  const across = typeof r.across === "number" ? clampSide(r.across) : DEFAULT_CHOICES.across;
  const down = typeof r.down === "number" ? clampSide(r.down) : DEFAULT_CHOICES.down;
  const { w, h } = sidesOf({ size, across, down });
  const { w: _sw, h: _sh, ...rest } = clampSettings({ ...r, w, h, rooms: typeof r.rooms === "number" ? r.rooms : defaultRooms(size, w, h) });
  return { ...rest, size, across, down };
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadChoices(roomId: string, storage: Storage | null = browserStorage()): Choices | null {
  try {
    return parseChoices(storage?.getItem(keyOf(roomId)) ?? null);
  } catch {
    return null;
  }
}

/**
 * Kept field by field, so no seed or anything else rides along. A storage
 * that refuses loses only the convenience. `size` is a floor's kept size,
 * written in place of the choices' own, so neither Make nor Cancel on a
 * floor changes the size the next New scene dungeon opens on. Rooms the DM
 * left as the dialog opened them, or at the floor's default, keep the count
 * remembered with that size for the same reason: the dialog saves as it
 * opens, and a count the floor moved or clamped would read as typed beside
 * the other size (reviews FL3-OPUS-1 and 7).
 */
export function saveChoices(roomId: string, c: Choices, storage: Storage | null = browserStorage(), size?: KeptSize): void {
  const kept: Choices = {
    theme: c.theme,
    size: size?.size ?? c.size,
    across: size?.across ?? c.across,
    down: size?.down ?? c.down,
    rooms: size && (c.rooms === size.opened || c.rooms === roomsDefault(c)) ? size.rooms : c.rooms,
    density: c.density,
    corridors: c.corridors,
    wide: c.wide,
    loops: c.loops,
    heights: c.heights,
    traps: c.traps,
    band: c.band,
    deadEnds: c.deadEnds,
    secrets: c.secrets,
    lit: c.lit,
    dressing: c.dressing,
    key: c.key,
  };
  try {
    storage?.setItem(keyOf(roomId), JSON.stringify(kept));
  } catch {
    // Private mode or full storage: the next open starts from the defaults.
  }
}
