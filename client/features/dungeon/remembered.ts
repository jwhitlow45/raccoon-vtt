import { clampRooms, clampSettings, clampSide, DEFAULT_SETTINGS, defaultRooms, SIZE_SIDES, type DungeonSettings, type SizeChoice } from "./settings.ts";

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

/** The scene's sides for the choices. */
export function sidesOf(c: Pick<Choices, "size" | "across" | "down">): { w: number; h: number } {
  if (c.size === "custom") return { w: clampSide(c.across), h: clampSide(c.down) };
  const side = SIZE_SIDES[c.size];
  return { w: side, h: side };
}

/** Rooms for the choices' size picked fresh (settings.ts `defaultRooms`). */
export function roomsDefault(c: Pick<Choices, "size" | "across" | "down">): number {
  const { w, h } = sidesOf(c);
  return defaultRooms(c.size, w, h);
}

/**
 * The choices after a size change. Rooms the DM left at the old size's
 * default move to the new size's, and any other count is kept within the
 * new size's limits, so a typed count survives a size change.
 */
export function withSize(c: Choices, next: Partial<Pick<Choices, "size" | "across" | "down">>): Choices {
  const moved = { ...c, ...next };
  const { w, h } = sidesOf(moved);
  const rooms = c.rooms === roomsDefault(c) ? roomsDefault(moved) : clampRooms(c.rooms, w, h);
  return { ...moved, rooms };
}

/** The generator's settings for the choices. */
export function settingsOf(c: Choices): DungeonSettings {
  const { w, h } = sidesOf(c);
  const { size: _size, across: _across, down: _down, ...rest } = c;
  return { ...rest, w, h, rooms: clampRooms(c.rooms, w, h) };
}

/**
 * Where the dialog opens: this device's last choices for the room, or the
 * defaults. Custom starts at the New scene form's size, clamped, until the
 * DM has kept a Custom size of their own.
 */
export function startChoices(saved: Choices | null, form: { w: number; h: number }): Choices {
  if (saved) return saved;
  return { ...DEFAULT_CHOICES, across: clampSide(form.w), down: clampSide(form.h) };
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

/** Kept field by field, so no seed or anything else rides along. A storage that refuses loses only the convenience. */
export function saveChoices(roomId: string, c: Choices, storage: Storage | null = browserStorage()): void {
  const kept: Choices = {
    theme: c.theme,
    size: c.size,
    across: c.across,
    down: c.down,
    rooms: c.rooms,
    density: c.density,
    corridors: c.corridors,
    wide: c.wide,
    loops: c.loops,
    heights: c.heights,
    traps: c.traps,
    band: c.band,
  };
  try {
    storage?.setItem(keyOf(roomId), JSON.stringify(kept));
  } catch {
    // Private mode or full storage: the next open starts from the defaults.
  }
}
