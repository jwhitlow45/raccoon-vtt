import { action, inside, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";

/*
 * The Dice panel in the room search (docs/design/design-v1-qol.md 5, What it
 * finds and What keeps it current), for both roles, so it ships in the room's
 * chunk through catalog/everyone.ts: the formula field, the next roll's
 * choices, Recent rolls, and the shown creature's Saves and checks and
 * Skills. Each anchor is the `search=` id on its control in Roller.tsx,
 * RecentRolls.tsx and RollOptions.tsx. A creature's other groups, its actions
 * and spells, hang on what its stat block holds, so they stay its own rows
 * there.
 */

const DICE: Place = { panel: "dice", where: "Dice", icon: "dice" };
const NEXT = inside(DICE, "Next roll");

/**
 * Whether the panel shows one creature's options (RollOptions.tsx): the
 * DM's one selected token, or a creature a player may pick, which is one
 * of their characters or a token of theirs on the scene (options.ts
 * playerCreatures, read here without its weight). Several selected show
 * the group's options instead.
 */
function creatureShown(ctx: SearchContext): boolean {
  const view = ctx.state.view;
  if (!view) return false;
  if (ctx.role === "dm") {
    const ids = ctx.state.local.selectedIds;
    return ids.length === 1 && view.tokens[ids[0]!] !== undefined;
  }
  const me = ctx.memberId;
  if (me === null) return false;
  const mine = (owners: readonly string[] | undefined) => (owners ?? []).includes(me);
  return Object.values(view.characters).some((c) => mine(c.ownerIds)) || Object.values(view.tokens).some((t) => t.sceneId === ctx.state.sceneId && t.kind !== "object" && mine(t.ownerIds));
}

export const DICE_ENTRIES: readonly CatalogEntry[] = [
  // The field to type in: Enter goes there, as a typed formula's own row rolls it.
  action(DICE, "dice.formula", "Roll dice", { names: ["dice formula", "type a roll"], press: false }),
  setting(NEXT, "dice.next.adv", "Advantage", { names: ["roll with advantage"] }),
  setting(NEXT, "dice.next.dis", "Disadvantage", { names: ["roll with disadvantage"] }),
  setting(NEXT, "dice.next.secret", "Secret roll", { names: ["hidden roll", "hide the roll"] }),
  section({ ...DICE, section: "recent" }, "dice.recent", "Recent rolls", { names: ["roll history", "roll log"] }),
  section({ ...DICE, section: "saves" }, "dice.saves", "Saves and checks", { names: ["saving throws", "ability checks"], when: creatureShown }),
  section({ ...DICE, section: "skills" }, "dice.skills", "Skills", { names: ["skill checks"], when: creatureShown }),
];
