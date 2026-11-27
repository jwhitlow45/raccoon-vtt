import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";
import { action, page, type Place } from "../search/catalog/write.ts";
import { hiddenModules, showLabel } from "./gate.ts";
import { modulesFor, type ModuleId, type Role } from "./registry.ts";
import { featureChoices, type FeatureChoices } from "./store.ts";

/*
 * The Features page in the room search (docs/design/design-v1-features.md 6,
 * Search): the page itself, and one "Show Spell slots" result for each part
 * hidden on this device, valued "Hidden", whose Enter presses the part's
 * switch, so it shows with what it needs, and whose Shift+Enter only goes
 * there. A hidden part's other entries leave the index (search/index.ts).
 * A part a player also has is everyone's (catalog/everyone.ts). A DM's own
 * part is the DM's catalog's (catalog/dm.ts), so a player's search never
 * lists one.
 */

export const FEATURES_PAGE: Place = { panel: "menu", page: "features", where: "Menu · This device", icon: "hidden" };

/** Where a part's switch stands: the page, at its group's fold. */
const FEATURES_WHERE = "Menu · This device · Features";

export const FEATURES_ENTRIES: readonly CatalogEntry[] = [page(FEATURES_PAGE, "menu.this-device.features", "Features", { names: ["hide parts", "simple", "modules", "hidden parts"] })];

/**
 * A part's switch on the page, by its anchor: "menu.this-device.features."
 * and the part's id in words, "spell-slots". FeaturesPage.tsx writes each
 * whole (SWITCH_ANCHORS), as the catalog's scan reads anchors from the
 * components alone, and its test holds the two alike.
 */
export function switchAnchor(id: ModuleId): string {
  return `menu.this-device.features.${id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Whose catalog a part's result lives in: everyone's for a part both roles have, the DM's for one only a DM has. */
export type ShowCatalog = "everyone" | "dm";

function catalogOf(roles: readonly Role[]): ShowCatalog {
  return roles.includes("player") ? "everyone" : "dm";
}

/**
 * The "Show" results for the parts hidden for the searching role, in the
 * registry's order, each in the catalog `which` names. Made as the index is
 * built (catalog/types.ts `items`), so the title names a hidden need too:
 * "Show Dungeon generator and Map builder".
 */
export function showEntries(ctx: Pick<SearchContext, "role">, which: ShowCatalog, choices: FeatureChoices = featureChoices()): CatalogEntry[] {
  const role = ctx.role;
  const hidden = hiddenModules(role, choices);
  return modulesFor(role)
    .filter((m) => hidden.has(m.id) && catalogOf(Object.keys(m.roles) as Role[]) === which)
    .map((m) =>
      action({ panel: "menu", page: "features", section: m.group, where: FEATURES_WHERE, icon: "hidden" }, switchAnchor(m.id), showLabel(m.id, role, choices), {
        names: [m.name, ...(m.names ?? [])],
        value: "Hidden",
      }),
    );
}
