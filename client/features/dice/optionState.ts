import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopeSlot, useScoped } from "../../state/scope.ts";

/*
 * What the roll options remember for the page, room by room
 * (docs/design-v1-roll-options.md 4.2 and 4.3): each row's newest roll by
 * its tag, an attack's critical that its next Damage tap doubles, the
 * riders toggled on, the DM's Ask switch per creature, the creature a
 * player picked, the tags already acted on, and the request to scroll to
 * the options that a bar's Roll makes.
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
};

export const optionSlot = scopeSlot(() =>
  createStore<OptionState>(() => ({ tags: {}, since: {}, critical: {}, riders: {}, askOff: {}, picked: null, acted: {}, slots: {}, focus: 0, focused: 0 })),
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
