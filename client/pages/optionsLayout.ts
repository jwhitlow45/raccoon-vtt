import type { Rect } from "../components/popoverPlace.ts";
import { SHORT_LANDSCAPE_MAX } from "../features/encounter/band.ts";
import { SETUP_TOOLS } from "../features/toolbarOrder.ts";
import { theme } from "../lib/theme.ts";

/*
 * Where a tool's options stand and what their one row shows
 * (docs/design-v1-tool-options.md 4, 5.2, 5.4, 6.3, 6.4 and 7.3), as plain
 * functions of the layout and of measured widths, so every rule runs under
 * node --test. Every size is in layout px, the chrome's own
 * (features/device/layout.ts).
 */

// ------------------------------------------------------------ the arrangement (4)

/** Where the options row stands: on the toolbar of a phone, floating above a computer's, or in the toolbar's own row on a short sideways screen. */
export type Arrangement = "stacked" | "floating" | "merged" | "pair";

/**
 * The least room the merged and pair arrangements give the options: the
 * widest player tool's priority-1 controls in their compact forms with ⋯
 * beside them, which is Draw's (its tool chip keeping its words, the
 * color, the stroke's bar, their gaps and ⋯: 255).
 */
export const MERGE_MIN = 256;

/** A toolbar button in the merged and pair arrangements: its short name under its icon, or the icon alone for a mouse from 900 px up. */
export const TOOL_BUTTON_NAMED = 56;
export const TOOL_BUTTON_ICON = theme.touch;
/** Between two toolbar buttons in the merged and pair arrangements. */
export const TOOL_GAP = theme.space(1);
/** A divider among the buttons: its 1 px line and its 4 px gap. */
export const TOOL_DIVIDER = theme.line.border + theme.space(1);
/** From the last tool to the row's first control in the merged and pair arrangements: a 6 px gap, the row's 1 px divider and its 8 px padding. */
export const ROW_LEAD = theme.space(1.5) + theme.line.border + theme.space(2);
/** The toolbar's 4 px padding at each side, the row's 15 px lead and 8 px before Panels. */
export const MERGED_LEAD = 2 * theme.space(1) + ROW_LEAD + theme.space(2);
/** Panels beside the merged row: its 4 px gap, 4 px padding and 1 px separator, past its own width. */
export const PANELS_EXTRA = 2 * theme.space(1) + theme.line.border;
/** The stacked row's 8 px padding at each side. */
export const STACKED_PADDING = 2 * theme.space(2);
/** The floating row at its widest, its box included, and its padding and border, which its controls do not use. */
export const FLOAT_MAX = 640;
export const FLOAT_PADDING = 2 * theme.space(2) + 2 * theme.line.border;

/** The toolbar's buttons as a layout draws them: how many, and whether a divider stands among them. */
export type ToolbarShape = { buttons: number; divider: boolean };

/**
 * The role's whole toolbar on a layout (5.1): a computer keeps every tool
 * with the divider before the setup tools, and the phone layout puts the
 * setup tools behind one Setup button after the divider. A player has no
 * setup tools.
 */
export function toolbarShape(tools: readonly { id: string }[], wide: boolean): ToolbarShape {
  const setup = tools.filter((t) => SETUP_TOOLS.has(t.id)).length;
  const play = tools.length - setup;
  if (setup === 0 || play === 0) return { buttons: tools.length, divider: false };
  return wide ? { buttons: tools.length, divider: true } : { buttons: play + 1, divider: true };
}

/** The pair: Select and the last tool. */
export const PAIR: ToolbarShape = { buttons: 2, divider: false };

export type ArrangementInput = {
  /** The layout: the window in the chrome's own px. */
  width: number;
  height: number;
  /** The side panel shows beside the map, which takes its width (wide layouts only). */
  sidePanel: boolean;
  safeLeft: number;
  safeRight: number;
  /** The role's whole toolbar as this layout draws it (toolbarShape). */
  toolbar: ToolbarShape;
  /** Each tool's short name under its icon: every touch screen and the phone layout. A mouse from 900 px up shows icons alone. */
  named: boolean;
};

export type OptionsPlace = {
  arrangement: Arrangement;
  /** The width the row may use for its controls. */
  room: number;
};

/** Whether the layout is short and held sideways, where the options share the toolbar's row when they can. */
export function shortSideways(width: number, height: number): boolean {
  return width > height && height < SHORT_LANDSCAPE_MAX;
}

/** The map's width: the layout less the side panel while it shows. */
export function mapWidthOf(input: Pick<ArrangementInput, "width" | "sidePanel">): number {
  return input.sidePanel ? input.width - theme.layout.sidePanelWidth : input.width;
}

/** Whether Panels stands at the toolbar's right end: always on the phone layout, and from 900 px up while the side panel is hidden. */
export function panelsShown(input: Pick<ArrangementInput, "width" | "sidePanel">): boolean {
  return input.width < theme.layout.wideMinWidth || !input.sidePanel;
}

/**
 * The room the options get in the toolbar's row beside `toolbar`: the
 * map less its safe areas, the buttons with their gaps and divider, the
 * toolbar's padding, the row's lead and Panels where it shows. Worked
 * out, not measured, so the arrangement is known before paint.
 */
export function mergedRoom(input: ArrangementInput, toolbar: ToolbarShape): number {
  const button = input.named ? TOOL_BUTTON_NAMED : TOOL_BUTTON_ICON;
  const right = input.sidePanel ? 0 : input.safeRight;
  const buttons = toolbar.buttons * button + Math.max(0, toolbar.buttons - 1) * TOOL_GAP + (toolbar.divider ? TOOL_DIVIDER : 0);
  const panels = panelsShown(input) ? button + PANELS_EXTRA : 0;
  return mapWidthOf(input) - input.safeLeft - right - buttons - MERGED_LEAD - panels;
}

/**
 * Where the options stand (4.1), from the layout alone, never from a
 * measurement. On a short sideways layout the row stands in the toolbar's
 * row beside the whole toolbar, else beside Select and the last tool, the
 * first whose room is at least MERGE_MIN. Otherwise, and where neither
 * leaves that much, it floats above a wide layout's toolbar or stacks on a
 * phone's. Decided by the screen and the role's toolbar, never by the
 * tool, so picking a tool never moves a button under the finger.
 */
export function optionsArrangement(input: ArrangementInput): OptionsPlace {
  if (shortSideways(input.width, input.height)) {
    const merged = mergedRoom(input, input.toolbar);
    if (merged >= MERGE_MIN) return { arrangement: "merged", room: merged };
    const pair = mergedRoom(input, PAIR);
    if (pair >= MERGE_MIN) return { arrangement: "pair", room: pair };
  }
  const across = mapWidthOf(input) - input.safeLeft - (input.sidePanel ? 0 : input.safeRight);
  if (input.width >= theme.layout.wideMinWidth) return { arrangement: "floating", room: Math.min(FLOAT_MAX, across - STACKED_PADDING) - FLOAT_PADDING };
  return { arrangement: "stacked", room: across - STACKED_PADDING };
}

/** Whether the toolbar shows only Select and the last tool. */
export function isPair(arrangement: Arrangement): boolean {
  return arrangement === "pair";
}

/** Whether the row stands in the toolbar's own row and takes no height from the map. */
export function inToolbarRow(arrangement: Arrangement): boolean {
  return arrangement === "merged" || arrangement === "pair";
}

// ------------------------------------------------------------ the fit (6.3, 6.4)

/** Between two controls in the row. */
export const SLOT_GAP = theme.space(1);
/** ⋯ and the gap before it. */
export const MORE_ROOM = theme.touch + SLOT_GAP;
/** A 1 px line and its gap before the first inline control of another part, such as a selected stamp's (9.9). */
export const PART_DIVIDER = theme.line.border + SLOT_GAP;

/** How a slot draws in the row: its full form, its compact form, a chip's glyph with its words, or its words with the value of a slot it hosts, with or without its glyph. */
export type SlotForm = "full" | "compact" | "glyph" | "hosts" | "hostsGlyph";

/** A slot as the fit reads it: its widths as measured, in layout px, and its rules (6.1). */
export type FitSlot = {
  id: string;
  /** 1, the highest, to 9. */
  priority: number;
  /** Its full form, or a flexible slot's least width. */
  full: number;
  /** Its compact form, where it has one. */
  compact?: number;
  /** A chip's glyph with its words, where its options all have glyphs. */
  glyph?: number;
  /** A chip that shows the value of a slot it hosts while that slot waits: its words with the value, and with its glyph too. */
  hosts?: { id: string; words: number; glyph?: number };
  /** The chip whose popover holds it when it waits. Left out, ⋯. */
  home?: string;
  /** A flexible field or text: it fits at `full` and grows into the room left, up to this. */
  max?: number;
  /** A part of the row, such as a selected stamp's: a line stands before its first inline slot where another part's slot is inline before it. */
  part?: string;
};

export type FitInput = {
  room: number;
  /** The slots that show, in display order, without the content always in ⋯. */
  slots: readonly FitSlot[];
  /** The tool has content always in ⋯, so ⋯ always shows. */
  alwaysMore: boolean;
  /** Slots the fit never moves out of the row: the one holding focus and the anchor of an open popover. */
  pins: readonly string[];
};

export type PlacedSlot = { id: string; form: SlotForm; width: number };

export type RowFit = {
  /** The inline slots in display order, each with its form and width. */
  row: PlacedSlot[];
  /** The slots waiting in ⋯, in display order. */
  more: string[];
  /** The slots waiting in a chip's popover, by the chip's id. */
  homes: Record<string, string[]>;
  /** Whether ⋯ shows. */
  hasMore: boolean;
  /** Pins the room could not hold beside ⋯: an open popover there closes, and focus moves on. */
  broken: string[];
};

function formWidth(slot: FitSlot, form: SlotForm): number {
  switch (form) {
    case "compact":
      return slot.compact ?? slot.full;
    case "glyph":
      return slot.glyph ?? slot.full;
    case "hosts":
      return slot.hosts?.words ?? slot.full;
    case "hostsGlyph":
      return slot.hosts?.glyph ?? slot.hosts?.words ?? slot.full;
    case "full":
      return slot.full;
  }
}

/** The width of inline slots, in display order, with their gaps and any line between parts. */
function rowWidth(slots: readonly FitSlot[], placed: ReadonlyMap<string, SlotForm>, widths?: ReadonlyMap<string, number>): number {
  let total = 0;
  let previous: FitSlot | null = null;
  for (const slot of slots) {
    const form = placed.get(slot.id);
    if (form === undefined) continue;
    if (previous) total += (previous.part ?? "") !== (slot.part ?? "") ? PART_DIVIDER + SLOT_GAP : SLOT_GAP;
    total += widths?.get(slot.id) ?? formWidth(slot, form);
    previous = slot;
  }
  return total;
}

/** The order compact forms are taken in: the lowest priority first and, among equal priorities, the last in display order. */
function compactionOrder(slots: readonly FitSlot[]): FitSlot[] {
  return slots
    .map((slot, order) => ({ slot, order }))
    .filter(({ slot }) => slot.compact !== undefined)
    .sort((a, b) => b.slot.priority - a.slot.priority || b.order - a.order)
    .map(({ slot }) => slot);
}

/** Highest priority first, in display order among equal priorities. */
function byPriority(slots: readonly FitSlot[]): FitSlot[] {
  return slots
    .map((slot, order) => ({ slot, order }))
    .sort((a, b) => a.slot.priority - b.slot.priority || a.order - b.order)
    .map(({ slot }) => slot);
}

/**
 * The row and ⋯ (6.3), a pure function of the room, the slots that show
 * and the pins, so the same inputs give the same row and a refit that
 * changes nothing draws nothing.
 *
 * 1. With no content always in ⋯, every slot inline in its full form, or
 *    with compact forms taken one at a time until they all fit: no ⋯.
 * 2. Otherwise, 48 px kept for ⋯: pins first, then the others by priority
 *    and display order, each inline if it fits what is left.
 * 3. While a priority-1 slot waits, compact forms are taken one at a time
 *    and step 2 runs again.
 * 4. Whatever still waits goes to its home: ⋯, or a chip's popover.
 * 5. From the room left: a chip shows a waiting slot's value, a waiting
 *    slot comes back in its compact form, chips gain their glyphs, and a
 *    flexible slot grows.
 */
export function fitRow(input: FitInput): RowFit {
  const { room, slots } = input;
  const ids = new Set(slots.map((s) => s.id));
  const placed = new Map<string, SlotForm>();
  const order = compactionOrder(slots);

  // 1. Without ⋯.
  if (!input.alwaysMore) {
    for (const slot of slots) placed.set(slot.id, "full");
    let fits = rowWidth(slots, placed) <= room;
    for (const slot of order) {
      if (fits) break;
      placed.set(slot.id, "compact");
      fits = rowWidth(slots, placed) <= room;
    }
    if (fits) return finish({ input, placed, waiting: [], limit: room, broken: [] });
  }

  // 2 and 3. With ⋯.
  const limit = room - MORE_ROOM;
  const forms = new Map<string, SlotForm>(slots.map((s) => [s.id, "full"]));
  const queue = [...order];
  const pins = input.pins.filter((id) => ids.has(id));
  for (;;) {
    placed.clear();
    const broken: string[] = [];
    const pinned = slots.filter((s) => pins.includes(s.id));
    const rest = byPriority(slots.filter((s) => !pins.includes(s.id)));
    const waiting: FitSlot[] = [];
    for (const slot of [...pinned, ...rest]) {
      placed.set(slot.id, forms.get(slot.id) ?? "full");
      if (rowWidth(slots, placed) <= limit) continue;
      placed.delete(slot.id);
      waiting.push(slot);
      if (pins.includes(slot.id)) broken.push(slot.id);
    }
    const next = waiting.some((s) => s.priority === 1) ? queue.shift() : undefined;
    if (next) {
      forms.set(next.id, "compact");
      continue;
    }
    return finish({ input, placed, waiting, limit, broken });
  }
}

/** Steps 4 and 5: homes, then what the room left gives back. */
function finish(state: { input: FitInput; placed: Map<string, SlotForm>; waiting: FitSlot[]; limit: number; broken: string[] }): RowFit {
  const { input, placed, limit } = state;
  const { slots } = input;
  const waiting = new Set(state.waiting.map((s) => s.id));
  const fits = (widths?: ReadonlyMap<string, number>) => rowWidth(slots, placed, widths) <= limit;
  const tryForm = (slot: FitSlot, form: SlotForm): boolean => {
    const before = placed.get(slot.id);
    placed.set(slot.id, form);
    if (fits()) return true;
    if (before === undefined) placed.delete(slot.id);
    else placed.set(slot.id, before);
    return false;
  };

  // A chip shows the value of a slot it hosts while that slot waits (Area's shape chip reads "Sphere 20 ft").
  for (const slot of slots) {
    if (placed.get(slot.id) === "full" && slot.hosts && waiting.has(slot.hosts.id)) tryForm(slot, "hosts");
  }
  // A waiting slot whose compact form fits comes back in it, so a chip shows its glyph rather than wait behind ⋯.
  for (const slot of byPriority(state.waiting)) {
    if (slot.compact !== undefined && tryForm(slot, "compact")) waiting.delete(slot.id);
  }
  // Chips in their words form gain their glyph, while it fits.
  for (const slot of byPriority(slots)) {
    const form = placed.get(slot.id);
    if (form === "full" && slot.glyph !== undefined) tryForm(slot, "glyph");
    else if (form === "hosts" && slot.hosts?.glyph !== undefined) tryForm(slot, "hostsGlyph");
  }
  // A flexible slot grows into the rest, in display order.
  const widths = new Map<string, number>();
  for (const slot of slots) {
    if (slot.max === undefined || placed.get(slot.id) !== "full") continue;
    const left = limit - rowWidth(slots, placed, widths);
    widths.set(slot.id, Math.max(slot.full, Math.min(slot.max, slot.full + Math.max(0, left))));
  }

  const homes: Record<string, string[]> = {};
  const more: string[] = [];
  for (const slot of slots) {
    if (!waiting.has(slot.id)) continue;
    const home = slot.home !== undefined && placedOrWaiting(slot.home, placed, waiting) ? slot.home : null;
    if (home) (homes[home] ??= []).push(slot.id);
    else more.push(slot.id);
  }
  const row = slots.flatMap((slot) => {
    const form = placed.get(slot.id);
    return form === undefined ? [] : [{ id: slot.id, form, width: widths.get(slot.id) ?? formWidth(slot, form) }];
  });
  return { row, more, homes, hasMore: input.alwaysMore || more.length > 0, broken: state.broken };
}

function placedOrWaiting(id: string, placed: ReadonlyMap<string, SlotForm>, waiting: ReadonlySet<string>): boolean {
  return placed.has(id) || waiting.has(id);
}

/**
 * The split while it holds (6.4): while ⋯'s popover is open (`moreOpen`),
 * and while a press that began on the row is down. No slot crosses
 * between the row and ⋯. A slot that goes leaves from wherever it is, and
 * a slot that appears joins its home. While ⋯ is open it stays, even with
 * nothing left in it, until the popover closes, and then the row refits
 * once. Where the held row no longer fits the room (a rotation to a
 * narrower one), the hold gives way to a refit, which keeps an open ⋯.
 */
export function heldFit(previous: RowFit, input: FitInput, moreOpen = true): RowFit {
  const ids = new Set(input.slots.map((s) => s.id));
  const was = new Map(previous.row.map((p) => [p.id, p.form]));
  const placed = new Map<string, SlotForm>();
  for (const slot of input.slots) {
    const form = was.get(slot.id);
    if (form !== undefined) placed.set(slot.id, form);
  }
  if (rowWidth(input.slots, placed) > input.room - (moreOpen || previous.hasMore ? MORE_ROOM : 0)) {
    const fit = fitRow(input);
    return moreOpen ? { ...fit, hasMore: true } : fit;
  }
  const homeOf = new Map(Object.entries(previous.homes).flatMap(([chip, held]) => held.map((id) => [id, chip] as const)));
  const homes: Record<string, string[]> = {};
  const more: string[] = [];
  for (const slot of input.slots) {
    if (placed.has(slot.id)) continue;
    const before = previous.more.includes(slot.id) ? null : (homeOf.get(slot.id) ?? null);
    const fresh = !previous.more.includes(slot.id) && !homeOf.has(slot.id);
    const home = before ?? (fresh && slot.home !== undefined && ids.has(slot.home) ? slot.home : null);
    if (home) (homes[home] ??= []).push(slot.id);
    else more.push(slot.id);
  }
  const row = input.slots.flatMap((slot) => {
    const form = placed.get(slot.id);
    if (form === undefined) return [];
    const kept = previous.row.find((p) => p.id === slot.id);
    // A flexible slot keeps the width it had, so nothing beside it moves.
    return [{ id: slot.id, form, width: slot.max !== undefined && kept ? kept.width : formWidth(slot, form) }];
  });
  return { row, more, homes, hasMore: moreOpen || previous.hasMore || input.alwaysMore || more.length > 0, broken: [] };
}

// ------------------------------------------------------------ the toolbar (5.2, 5.4)

/** The pair's second button before any tool but Select was made active: the most used tool after Select for both roles. */
export const FIRST_LAST_TOOL = "ruler";

/** The last tool other than Select that this page made active, by any way: a button, a tile, a key or a panel. */
export function lastToolAfter(last: string, active: string): string {
  return active === "select" ? last : active;
}

/** The last tool as the pair shows it: the Ruler once its own tool has left the role's list, as Draw taken from a player. */
export function lastToolIn(last: string, tools: readonly { id: string }[]): string {
  return tools.some((t) => t.id === last) ? last : FIRST_LAST_TOOL;
}

/**
 * What tucks or shows a tool's options (5.4, 5.5), as the tool whose
 * options are tucked, or null.
 *
 * - "press": a press on the active tool's own button, or a pick of its
 *   tile in Setup or Tools, tucks its options, and the next brings them
 *   back. Select has no options to tuck.
 * - "show": the active tool's key, or a press on the "options hidden"
 *   pill, brings them back and never tucks, so a held or repeated key
 *   never hides them.
 * - "tool": another tool became active, which ends the tuck.
 */
export type TuckEvent = { kind: "press" | "show" | "tool"; tool: string };

export function tuckAfter(tucked: string | null, active: string, e: TuckEvent): string | null {
  if (e.kind === "tool") return e.tool === tucked ? tucked : null;
  if (e.tool !== active) return null;
  if (e.kind === "show") return null;
  if (active === "select") return null;
  return tucked === active ? null : active;
}

// ------------------------------------------------------------ the popovers' frame (7.3)

/** A tool popover's least height before it rises over the top bars: its padding, border and title, and one 44 px row. */
export const POPOVER_MIN = 2 * theme.space(3) + 2 * theme.line.border + 16 + theme.space(2) + theme.touch;

/**
 * Where a tool popover, Setup and Tools keep (7.3): the map's area less
 * the safe areas, from under the top bars and the last lasting notice,
 * with the base's 8 px margin, and a rise region up to the top safe area,
 * over the bars and the notices, for a short screen in a fight. All in
 * the chrome's own px.
 */
export function toolPopoverFrame(input: {
  mapWidth: number;
  height: number;
  safe: { top: number; right: number; bottom: number; left: number };
  /** The top bars with the turn band and the top safe area. */
  top: number;
  /** The foot of the last lasting notice, or null. */
  lasting: number | null;
}): { bound: Rect; rise: Rect } {
  const left = input.safe.left;
  const right = input.mapWidth - input.safe.right;
  const bottom = input.height - input.safe.bottom;
  return {
    bound: { left, right, bottom, top: Math.max(input.top, input.lasting ?? input.top) },
    rise: { left, right, bottom, top: input.safe.top },
  };
}
