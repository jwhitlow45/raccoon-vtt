import { youMenuSections } from "../../../pages/chipMenus.ts";
import { CHIP_WORDS } from "../../../pages/chipWords.ts";
import { DEVICE_ENTRIES } from "../../device/search.ts";
import { DICE_ENTRIES } from "../../dice/search.ts";
import { LOG_ENTRIES } from "../../log/search.ts";
import { CREATURE_FIELDS } from "../../tokens/search.ts";
import { SUGGEST } from "../index.ts";
import type { Catalog, CatalogEntry, SearchContext } from "./types.ts";
import { action, page, type Place } from "./write.ts";

/**
 * What both roles' searches find beyond the panels, keys and the room's own
 * things (designs/qol/search.md 5.10): Menu's pages and This device, your
 * own color in Members, the Dice panel, the Log's Chat, the fields and
 * groups of a creature's panel and page, and a player's You menu items.
 * Initiative's rows are a DM's: a player's Initiative holds their own
 * creatures to add and This device's Turn sound, found in This device. It
 * ships in the room's chunk, so it holds nothing only a DM may know: the
 * DM's entries live in catalog/dm.ts.
 */

const MENU = (pageId: string, icon: Place["icon"]): Place => ({ panel: "menu", page: pageId, where: "Menu", icon });
const MEMBERS: Place = { panel: "menu", page: "members", where: "Menu · Members", icon: "group" };

/**
 * A player's You menu as rows (chips.md C7, plan.md 3): the X-card, whose
 * twin is the Menu panel's own. Their characters' sheets are the index's
 * character rows already, one row each. Never a DM's: a DM has no You menu,
 * and the DM menu's items come from the DM's catalog alone (QD-OPUS-18).
 */
function youItems(ctx: SearchContext): CatalogEntry[] {
  const view = ctx.state.view;
  if (ctx.role !== "player" || !view || ctx.memberId === null) return [];
  const sections = youMenuSections({ memberId: ctx.memberId, member: view.members[ctx.memberId], characters: view.characters, preview: false });
  return sections.flatMap((s) =>
    s.items
      .filter((item) => item.kind === "xcard")
      .map(
        (item): CatalogEntry => ({
          id: `item:${item.id}`,
          kind: "action",
          title: item.title,
          names: ["safety tool"],
          where: `${CHIP_WORDS.youMenuName} menu`,
          icon: "about",
          suggest: SUGGEST.xCard,
          act: { t: "item", itemId: item.id, twin: { panel: "menu", anchor: "menu.xcard" } },
        }),
      ),
  );
}

export const EVERYONE: Catalog = {
  entries: [
    page(MENU("device", "device"), "menu.this-device", "This device", { names: ["device settings", "preferences"] }),
    ...DEVICE_ENTRIES,
    page(MENU("members", "group"), "menu.members", "Members", { names: ["who is here"] }),
    action(MEMBERS, "menu.members.color", "Change your color", { names: ["your color"] }),
    ...DICE_ENTRIES,
    ...LOG_ENTRIES,
  ],
  fields: CREATURE_FIELDS,
  panels: {
    menu: { names: ["settings", "options"] },
    tracker: { names: ["turn order"], bets: ["init", "initiative"] },
    log: { names: ["chat"] },
    characters: { names: ["character sheets"] },
  },
  items: youItems,
};
