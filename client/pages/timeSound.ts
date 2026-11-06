import { SOUND_PANEL, TIME_PANEL, type PanelsForOptions } from "../features/panels.ts";

/*
 * Room's two rules for the Time and Sound panels
 * (docs/design/design-v1-sound-layout.md 3.2 and 3.3), here rather than in
 * Room.tsx, which cannot load under node (Konva wants a window), so a test
 * can run them.
 */

/** What Room reads of the room for a player's list: whether their view holds the clock, and whether something plays that they receive. */
export type TableNow = { readonly clock: boolean; readonly sound: boolean };

/**
 * What a player's list waits for (features/panels.ts panelsFor): Time
 * while their view holds the clock, Sound while the room plays music or a
 * background sound they receive (effects show nowhere), and each while it
 * is open after its reason ends, until it is closed. So a player reading
 * the date never has the panel vanish under them: the open panel says the
 * reason ended itself. `open` counts a hidden sheet or side panel
 * (lib/folds.ts panelIsOpen). The DM's list ignores this.
 */
export function playerWaits(now: TableNow, open: (id: string) => boolean): PanelsForOptions {
  return { clock: now.clock || open(TIME_PANEL), sound: now.sound || open(SOUND_PANEL) };
}

/**
 * Whether a clock line needs no toast: the Log or the Time panel is on
 * screen, either of which shows the change itself
 * (docs/design/design-v1-calendar.md 4.7). `onScreen` is the side panel's
 * tabs and the pane below from 900 px up, else the phone's sheet while it
 * shows.
 */
export function clockLinesShown(onScreen: (id: string) => boolean): boolean {
  return onScreen("log") || onScreen(TIME_PANEL);
}
