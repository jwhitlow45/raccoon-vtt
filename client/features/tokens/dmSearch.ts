import { action, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, FieldDef } from "../search/catalog/types.ts";
import { SUGGEST } from "../search/index.ts";
import { drawn, panelHolds } from "./panelDraws.ts";

/*
 * The token panel's and Characters' DM rows in the room search
 * (docs/design/design-v1-qol.md 5, What it finds and What keeps it current).
 * A DM's alone, so these load with the DM's catalog only (catalog/dm.ts):
 * nothing but that file imports this one. Each anchor is the `search=` id on
 * its control in TokenPanel.tsx and CharactersPanel.tsx.
 */

/** The selected token's settings a DM looks for, in Token settings. */
export const DM_TOKEN_FIELDS: readonly FieldDef[] = [
  { key: "hidden", title: "Hidden from players", names: ["hide the token", "invisible"], icon: "hidden", token: { section: "settings", anchor: "token.hidden" }, shown: drawn((d) => panelHolds(d.parts, "settings"), () => false) },
  // A token's owners and a character's players are the DM's to choose. The page's group is found for every character, as the DM has no other way to its page's fields.
  { key: "owners", kind: "section", title: "Owners", names: ["who controls"], icon: "group", token: { section: "owners", anchor: "token.owners" }, shown: drawn((d) => panelHolds(d.parts, "owners"), () => false) },
  { key: "players", kind: "section", title: "Players", names: ["owners", "who plays"], icon: "group", page: { section: "page.owners", anchor: "character.owners" }, everyCharacter: true, shown: drawn(() => false, (d) => d.parts.includes("owners")) },
  { key: "settings", kind: "section", title: "Token settings", names: ["token name", "disposition", "layer"], icon: "settings", token: { section: "settings", anchor: "token.settings" }, shown: drawn((d) => panelHolds(d.parts, "settings"), () => false) },
];

const CHARACTERS: Place = { panel: "characters", where: "Characters", icon: "characters" };

export const DM_CHARACTERS_ENTRIES: readonly CatalogEntry[] = [
  // Its card asks before anyone rests, so Enter presses it and lands on Finish (CharactersPanel.tsx PartyLongRest).
  action(CHARACTERS, "characters.party-long-rest", "Long Rest for the party", {
    names: ["party rest"],
    bets: ["rest", "long rest", "lr"],
    suggest: SUGGEST.longRest,
    when: (ctx) => Object.keys(ctx.state.view?.characters ?? {}).length > 0,
  }),
];
