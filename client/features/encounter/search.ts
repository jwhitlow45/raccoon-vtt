import { action, inside, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";
import { SUGGEST } from "../search/index.ts";

/*
 * Initiative's DM rows in the room search (docs/design/design-v1-qol.md 5,
 * What it finds and What keeps it current): starting a fight, and in one the
 * order's setup and the turn timer. A DM's alone, so these load with the DM's
 * catalog only (catalog/dm.ts): nothing but that file imports this one. Each
 * anchor is the `search=` id on its control in panels/TrackerPanel.tsx. Its
 * Turn sound is This device's own, found there (device/search.ts), so the one
 * setting is one row.
 */

const TRACKER: Place = { panel: "tracker", where: "Initiative", icon: "combat" };
const NEW_FIGHT = inside(TRACKER, "New fight");
const SETUP = inside(TRACKER, "Initiative");
const THIS_DEVICE = inside(TRACKER, "This device");

/** A fight runs, as the panel reads it (TrackerPanel.tsx): its setup shows, and New fight does not. */
const fighting = (ctx: SearchContext) => (ctx.state.view?.encounter ?? null) !== null;
const resting = (ctx: SearchContext) => !fighting(ctx);

export const TRACKER_ENTRIES: readonly CatalogEntry[] = [
  // Three buttons start one, by who joins it, so the search goes to them and presses none.
  action(TRACKER, "tracker.new-fight", "Start a fight", { names: ["new fight", "roll initiative", "encounter"], bets: ["init", "initiative", "fight"], suggest: SUGGEST.startFight, press: false, when: resting }),
  setting(NEW_FIGHT, "tracker.new-fight.roll", "Roll monsters' Initiative", { names: ["auto initiative"], when: resting }),
  section(TRACKER, "tracker.auto", "Auto Initiative", { names: ["roll for monsters"], when: fighting }),
  action(SETUP, "tracker.initiative.values", "Type several values", { names: ["initiative values", "set initiative"], when: fighting }),
  setting(SETUP, "tracker.initiative.scores", "Monsters use Initiative scores", { when: fighting, valueNow: (ctx) => (ctx.state.view?.meta.settings.monsterInitScore ? "On" : "Off") }),
  section(TRACKER, "tracker.more", "More creatures", { names: ["add to the fight", "join the fight"], when: fighting }),
  setting(TRACKER, "tracker.timer", "Turn timer", { names: ["turn clock"], when: fighting }),
  // Its own first press arms it, "Tap again to end the fight".
  action(TRACKER, "tracker.end", "End the fight", { names: ["end combat", "stop the fight"], when: fighting }),
  setting(THIS_DEVICE, "tracker.device.follow", "Camera follows the turn", { names: ["follow the turn"] }),
];
