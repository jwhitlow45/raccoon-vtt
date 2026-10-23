import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ActorTarget } from "#shared/protocol.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";

/*
 * What the roll options remember for the page, room by room
 * (docs/design-v1-roll-options.md 4.2 and 4.3): each row's newest roll by
 * its tag, an attack's critical that its next Damage tap doubles, the
 * riders toggled on, the DM's Ask switch per creature, the creature a
 * player picked, the tags already acted on, the request to scroll to the
 * options that a bar's Roll makes, and a player's open ask for saves.
 */
export type OptionState = {
  /** `${creature}|${row}` to the row's newest tag. */
  tags: Record<string, string>;
  /**
   * The room's seq when each row's newest tag was sent, so a surface that
   * stands for one moment, such as a turn's recharge card, reads only a
   * roll sent since then and not the row's roll of an earlier turn.
   */
  since: Record<string, number>;
  /** `${creature}|${roll key}`: the Critical toggle. */
  critical: Record<string, boolean>;
  /** `${creature}|${roll key}`: the optional parts toggled on, by index. */
  riders: Record<string, number[]>;
  /** `${creature}`: Ask off for a creature a player plays. Absent is on (16). */
  askOff: Record<string, boolean>;
  /** The creature a player picked, by its key. */
  picked: string | null;
  /** Tags a row already acted on, so an initiative or a critical is set once. */
  acted: Record<string, true>;
  /** A slot level picked per spell. */
  slots: Record<string, number>;
  /** A bar's Roll asked the panel to show the options. */
  focus: number;
  /** The last ask the panel scrolled for, so a later opening of the panel does not scroll again. */
  focused: number;
  /**
   * The one open block of a player's ask for saves (docs/design-v1-player-save-spell.md 3.1),
   * kept here so closing the sheet to select targets on the map keeps it. Opening it pins
   * `picked` to its creature.
   */
  cast: CastBlock | null;
  /** How many blocks this page has opened, each opening's stamp (cast.ts openedBlock). */
  openings: number;
  /**
   * The bonus typed for a creature whose numbers this viewer lacks, by its
   * key. The field stands in the creature's card and its cells in the
   * groups below, which fold, so the text lives here and not in either.
   */
  bonus: Record<string, string>;
};

/** What a player's ask for saves is for, as its block opened. */
export type CastBlock = {
  /** The creature's key (creatureKey), which `picked` is pinned to. */
  key: string;
  creature: ActorTarget;
  /** The spell's or action's name, as the row or the area shows it. */
  spell: string;
  /** The row's named roll, absent for an area, whose row is found by its spell's name. */
  roll?: string;
  /** The area it asks for. Without one, its targets are the selection less the caster. */
  area?: string;
  /** The block's own casting level, where the row has no stepper of its own. */
  slot?: number;
  /** The ask this block sent last, whose answer it shows until it waits in the view. */
  sent?: string;
  /** The opening's stamp, new each time a block opens, even on the same spell (cast.ts openedBlock). */
  opened?: number;
};

export const optionSlot = scopeSlot(() =>
  createStore<OptionState>(() => ({ tags: {}, since: {}, critical: {}, riders: {}, askOff: {}, picked: null, acted: {}, slots: {}, focus: 0, focused: 0, cast: null, openings: 0, bonus: {} })),
);

export function useOptionStore() {
  return useScoped(optionSlot);
}

export function useOption<T>(select: (s: OptionState) => T): T {
  return useStore(useScoped(optionSlot), select);
}

/** A row's newest tag, or with `after` only one sent at or after that room seq. */
export function rowTag(s: Pick<OptionState, "tags" | "since">, row: string, after?: number): string | null {
  const tag = s.tags[row] ?? null;
  return tag !== null && (after === undefined || (s.since[row] ?? -1) >= after) ? tag : null;
}

/**
 * The room's seq as this page's log has it: its newest line's. A card
 * drawn for a log line, such as a turn's start, is drawn once that line is
 * here, so a roll tapped from it reads at least the line's seq, and one
 * tapped before it less.
 */
export function logSeq(log: readonly { id: string }[] | undefined): number {
  const last = log?.at(-1);
  const seq = last ? Number(last.id.split(":")[0]) : 0;
  return Number.isFinite(seq) ? seq : 0;
}

/** The store's change that remembers a row's new tag with the room seq it went at. */
export function remembered(s: Pick<OptionState, "tags" | "since">, row: string, tag: string, seq: number): Pick<OptionState, "tags" | "since"> {
  return { tags: { ...s.tags, [row]: tag }, since: { ...s.since, [row]: seq } };
}
