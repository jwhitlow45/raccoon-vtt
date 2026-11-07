import { TIME_PANEL } from "../panels.ts";
import { action, onOff, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";

/*
 * Time in the room search (docs/design/design-v1-qol.md 5, What it finds and
 * What keeps it current): starting the clock, and a running clock's steps,
 * date, sharing, calendar and stop. A DM's alone, so these load with the DM's
 * catalog only (catalog/dm.ts): nothing but that file imports this one. A
 * player's Time panel only shows the date, so it is the panel's row alone.
 * Each anchor is the `search=` id on its control in TimePanel.tsx,
 * StepButtons.tsx and StartClock.tsx.
 */

const TIME: Place = { panel: TIME_PANEL, where: "Time", icon: "time" };

const running = (ctx: SearchContext) => (ctx.state.view?.clock ?? null) !== null;

export const TIME_ENTRIES: readonly CatalogEntry[] = [
  // The form above it sets the calendar and the date first, so the search goes to it and starts nothing.
  action(TIME, "time.start", "Start the clock", { names: ["start time", "date and time"], press: false, when: (ctx) => !running(ctx) }),
  section(TIME, "time.steps", "Move the clock on", { names: ["advance time", "pass time", "skip ahead"], when: running }),
  action(TIME, "time.set", "Set the date and time…", { names: ["change the date"], when: running }),
  setting(TIME, "time.shown", "Players see the date and time", { names: ["share the date"], when: running, valueNow: (ctx) => onOff(ctx.state.view?.clock?.shown === true) }),
  action(TIME, "time.calendar", "Calendar…", { names: ["months", "change the calendar"], when: running }),
  // Its own first press arms it, "Tap again to stop the clock".
  action(TIME, "time.stop", "Stop the clock", { names: ["remove the clock"], when: running }),
];
