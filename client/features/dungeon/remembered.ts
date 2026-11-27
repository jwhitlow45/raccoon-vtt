import type { PartyGroup } from "#shared/model.ts";
import { LEVEL_BANDS, type LevelBand } from "#shared/srd/traps.ts";
import { partySize } from "../encounters/budget.ts";
import { clampRooms, clampSettings, clampSide, clampStock, DEFAULT_SETTINGS, DEFAULT_STOCK, defaultRooms, maxSide, SIZE_SIDES, type DungeonSettings, type GridKind, type SizeChoice, type StockChoices } from "./settings.ts";

/**
 * The dialog's choices, and this device's memory of them per room
 * (docs/design/design-v1-dungeon-generator.md 4.2, D-261102-023). Only the
 * choices are kept, never a seed: a seed rebuilds the dungeon, and the
 * device may be shared or lost. Plain functions over a storage the caller
 * passes, so the tests run without a DOM.
 */

export type Choices = Omit<DungeonSettings, "w" | "h"> &
  StockChoices & {
    size: SizeChoice;
    /** Custom's sides. A preset's are its own. */
    across: number;
    down: number;
    /**
     * The DM's own Party level pick. `band`, the settings' band, follows the
     * party while Monsters and Traps are both above None, and comes back to
     * this pick when either goes to None (docs/design/design-v1-dungeon-stock.md
     * 4, D-261127-219).
     */
    ownBand: LevelBand;
  };

const { w: _w, h: _h, ...DEFAULT_REST } = DEFAULT_SETTINGS;
export const DEFAULT_CHOICES: Choices = { ...DEFAULT_REST, ...DEFAULT_STOCK, ownBand: DEFAULT_SETTINGS.band, size: "medium", across: SIZE_SIDES.medium, down: SIZE_SIDES.medium };

/** The Monsters choices among the dialog's. */
export function stockOf(c: StockChoices): StockChoices {
  return { monsters: c.monsters, difficulty: c.difficulty };
}

/**
 * The band of a party's mean level, each group weighted by its count and
 * the mean rounded down, or null for a party with no level to read
 * (D-261127-217, 219).
 */
export function partyBand(groups: readonly PartyGroup[]): LevelBand | null {
  const level = partyLevel(groups);
  if (level === null) return null;
  return LEVEL_BANDS.find((b) => level <= Number(b.split("-")[1])) ?? LEVEL_BANDS[LEVEL_BANDS.length - 1]!;
}

/** A party's mean level, weighted by count and rounded down, or null with no characters. */
export function partyLevel(groups: readonly PartyGroup[]): number | null {
  const size = partySize(groups);
  return size <= 0 ? null : Math.floor(groups.reduce((sum, g) => sum + g.count * g.level, 0) / size);
}

/** Monsters is held at None while the party has no level to budget for. */
export function monstersHeld(groups: readonly PartyGroup[]): boolean {
  return partySize(groups) <= 0;
}

/** Monsters as the generator stocks it: the DM's pick, or None while held. */
export function stockedShare(c: Pick<StockChoices, "monsters">, groups: readonly PartyGroup[]): number {
  return monstersHeld(groups) ? 0 : c.monsters;
}

/** Whether the Traps band follows the party: Monsters and Traps both above None, with a party that has a level. */
export function bandFollows(c: Pick<Choices, "monsters" | "traps">, groups: readonly PartyGroup[]): boolean {
  return stockedShare(c, groups) > 0 && c.traps > 0 && partyBand(groups) !== null;
}

/**
 * The band the settings should carry, worked out only at the DM's
 * transitions and Held changes (D-261127-219): the party's while it
 * follows, else the DM's own pick. A live level-up in a standing party is
 * no transition, so the band stays where the last one put it.
 */
export function followedBand(c: Pick<Choices, "monsters" | "traps" | "ownBand">, groups: readonly PartyGroup[]): LevelBand {
  return bandFollows(c, groups) ? partyBand(groups)! : c.ownBand;
}

/**
 * Whether a change of the choices or the party is a transition the band is
 * worked out at: Monsters crossing None either way, Traps crossing None
 * while Monsters is on, a party edit, or Monsters' Held state changing.
 */
export function bandTransition(before: Pick<Choices, "monsters" | "traps">, after: Pick<Choices, "monsters" | "traps">, was: readonly PartyGroup[], now: readonly PartyGroup[], partyEdit: boolean): boolean {
  if (partyEdit) return true;
  // Monsters' Held state changing moves the share across None, so it is the crossing below.
  const on = (c: Pick<Choices, "monsters">, g: readonly PartyGroup[]) => stockedShare(c, g) > 0;
  if (on(before, was) !== on(after, now)) return true;
  return on(after, now) && (before.traps > 0) !== (after.traps > 0);
}

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
  const { size: _size, across: _across, down: _down, monsters: _monsters, difficulty: _difficulty, ownBand: _ownBand, ...rest } = c;
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
  // A device that remembered no own pick, from before Monsters, kept the band it had: that was the DM's pick.
  const ownBand = LEVEL_BANDS.includes(r.ownBand as LevelBand) ? (r.ownBand as LevelBand) : rest.band;
  return { ...rest, ...clampStock({ monsters: r.monsters, difficulty: r.difficulty }), ownBand, size, across, down };
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
    monsters: c.monsters,
    difficulty: c.difficulty,
    ownBand: c.ownBand,
  };
  try {
    storage?.setItem(keyOf(roomId), JSON.stringify(kept));
  } catch {
    // Private mode or full storage: the next open starts from the defaults.
  }
}

/** What the band reads of the choices: the shares, the settings' band and the DM's own pick. */
type Banded = Pick<Choices, "monsters" | "traps" | "band" | "ownBand">;

/**
 * A change of the Monsters choices or the party, as the dialog and the
 * wing pane make it (D-261127-063, 219): the choices after it, and whether
 * it drops the room edits. It keeps them, as stocking moves nothing they
 * pin, unless it is a transition that moves the band, which shapes traps
 * and the edits' frozen layout, so it drops them as any choice does.
 */
export function restocked<T extends Banded>(c: T, next: T, was: readonly PartyGroup[], now: readonly PartyGroup[], partyEdit: boolean): { next: T; drop: boolean } {
  const band = bandTransition(c, next, was, now, partyEdit) ? followedBand(next, now) : c.band;
  return band === c.band ? { next: { ...next, band: c.band }, drop: false } : { next: { ...next, band }, drop: true };
}

/**
 * A change of a settings row, which always drops the edits: a Party level
 * pick is the DM's own, kept to come back to, and Traps crossing None while
 * Monsters is on is a transition the band follows.
 */
export function rowChanged<T extends Banded>(c: T, patch: Partial<T>, groups: readonly PartyGroup[]): T {
  const next = { ...c, ...patch };
  if (patch.band !== undefined && patch.band !== c.band) return { ...next, ownBand: patch.band };
  return bandTransition(c, next, groups, groups, false) ? { ...next, band: followedBand(next, groups) } : next;
}
