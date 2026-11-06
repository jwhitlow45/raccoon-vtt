import { createStore } from "zustand/vanilla";
import { scopeSlot } from "../../state/scope.ts";

/*
 * Which sections a player's Ambiance shows (docs/design/design-v1-panel-groups.md 5,
 * D-261102-755, D-261102-762): Time while their view holds the clock, Sound
 * while something plays that they receive, and either one, once it has
 * shown, for as long as Ambiance stays open, saying it has stopped. So a
 * player reading the date never has it vanish under their eyes when the DM
 * stops sharing. Closing Ambiance lets every kept section go. Pure, so a
 * test runs it through any order of events.
 */

export type AmbianceSections = { readonly time: boolean; readonly sound: boolean };

export const NO_SECTIONS: AmbianceSections = { time: false, sound: false };

/** What a player's Ambiance holds now: whether it is open, and whether the view holds a clock and something playing. */
export type AmbianceNow = { readonly open: boolean; readonly clock: boolean; readonly sound: boolean };

/** The sections kept after this change: while open, every section that shows now or was kept, and nothing once closed. The same object back when nothing changes. */
export function keptSections(prev: AmbianceSections, now: AmbianceNow): AmbianceSections {
  const next = now.open ? { time: prev.time || now.clock, sound: prev.sound || now.sound } : NO_SECTIONS;
  return next.time === prev.time && next.sound === prev.sound ? prev : next;
}

/** The sections an open Ambiance draws: kept ones and those whose condition holds now. Neither means its empty line. */
export function shownSections(kept: AmbianceSections, now: Pick<AmbianceNow, "clock" | "sound">): AmbianceSections {
  return { time: kept.time || now.clock, sound: kept.sound || now.sound };
}

/**
 * The kept sections, per Room page, set by Room from keptSections as the
 * player's view and panels change. In Room's scope rather than the panel,
 * since a turn across 900 px remounts the panel in the other tree while it
 * stays open, and a kept Time must survive that.
 */
export const ambianceKeptSlot = scopeSlot(() => createStore<AmbianceSections>(() => NO_SECTIONS));
