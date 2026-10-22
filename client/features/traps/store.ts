import { createStore } from "zustand/vanilla";
import type { CellRect } from "#shared/model.ts";
import type { LevelBand } from "#shared/srd/traps.ts";
import { scopeSlot } from "../../state/scope.ts";
import { START_BLANK, type ZoneKind } from "./rules.ts";

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
