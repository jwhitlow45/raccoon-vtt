import { createStore } from "zustand/vanilla";
import type { CellRect } from "#shared/model.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import { START_BLANK, type ZoneKind } from "./rules.ts";
import { isHex, type Grid } from "#shared/rules/grid.ts";

/** A zone being drawn with the Trap tool, drawn on the map until the create lands. */
export type TrapDraft = { rect: CellRect } | { wire: { a: [number, number]; b: [number, number] } };

/**
 * What the next tap or drag on the map picks for the open trap (4.1):
 * squares to add to its zone, the squares it hits, or a door, light,
 * hidden creature or hidden stamp for it to set. `fresh` squares it hits
 * replace the ones it had, and later ones in the same pick add to them.
 */
export type TrapPicking = { trapId: string; what: "squares" | "hits" | "action"; fresh?: boolean };

export type TrapToolState = {
  /** The trap whose pane is open. */
  paneId: string | null;
  /** What a new trap starts from: Blank, Alarm or an SRD preset's id. */
  start: string;
  band: LevelBand;
  kind: ZoneKind;
  draft: TrapDraft | null;
  picking: TrapPicking | null;
};

/** One Room page's Trap tool (state/scope.ts), so "view as a player" keeps its own. */
export const trapSlot = scopeSlot(() => ({
  store: createStore<TrapToolState>(() => ({ paneId: null, start: START_BLANK, band: "1-4", kind: "squares", draft: null, picking: null })),
  /** The pointer gesture in progress with the Trap tool. */
  gesture: null as { start: { x: number; y: number }; world: { x: number; y: number }; hit: string | null; moved: boolean } | null,
}));

/** The kinds of zone a new trap draws, in the row's order, which the tool's key steps through too. */
export const ZONE_KINDS: readonly { value: ZoneKind; label: string }[] = [
  { value: "squares", label: "Squares" },
  { value: "wire", label: "Trip wire" },
  { value: "door", label: "Door" },
];

/** The kinds of zone in a scene's cell word: "Hexes" on a hex scene. */
export function zoneKinds(g: Grid): readonly { value: ZoneKind; label: string }[] {
  return isHex(g) ? ZONE_KINDS.map((k) => (k.value === "squares" ? { ...k, label: "Hexes" } : k)) : ZONE_KINDS;
}

/** What a drag or a tap draws for a new trap. Start from stays as it is. */
export function pickZone(scope: RoomScope, kind: ZoneKind): void {
  scope.get(trapSlot).store.setState({ kind });
}
