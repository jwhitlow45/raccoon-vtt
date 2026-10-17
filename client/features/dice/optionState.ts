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
  createStore<OptionState>(() => ({ tags: {}, critical: {}, riders: {}, askOff: {}, picked: null, acted: {}, slots: {}, focus: 0, focused: 0 })),
);

export function useOptionStore() {
  return useScoped(optionSlot);
}

export function useOption<T>(select: (s: OptionState) => T): T {
  return useStore(useScoped(optionSlot), select);
}
