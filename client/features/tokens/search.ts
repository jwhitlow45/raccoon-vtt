import type { ProjectedActor } from "#shared/project.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { STATUSES } from "#shared/srd/statuses.ts";
import type { FieldDef } from "../search/catalog/types.ts";

/*
 * A creature's fields in the room search (designs/qol/search.md 4 and
 * 5.10), for both roles, so they ship in the room's chunk through
 * catalog/everyone.ts: the token panel's for the selection, and a
 * character's page's for each character the viewer may search. Each place
 * names the fold on the way and the `search=` id on its control in
 * TokenPanel.tsx and CharacterCard.tsx, which StatsFields, HpSection,
 * EffectsSection and RestSection draw. A value reads only the actor this
 * device holds, a player's projection, so a row never says more than the
 * panel would.
 */

const EFFECT_NAMES: ReadonlyMap<string, string> = new Map([...Object.values(CONDITIONS).map((c) => [c.key, c.name] as const), ...Object.values(STATUSES).map((s) => [s.key, s.label] as const)]);

/** The conditions on a creature, by name, as its Conditions lists them. */
function conditionsOf(actor: ProjectedActor): string | undefined {
  const names = (actor.effects ?? []).flatMap((e) => {
    const name = EFFECT_NAMES.get(e.key);
    return name ? [name] : [];
  });
  return names.length > 0 ? names.join(", ") : undefined;
}

export const CREATURE_FIELDS: readonly FieldDef[] = [
  {
    key: "hp",
    title: "Hit Points",
    icon: "combat",
    token: { section: "combat", anchor: "token.hp" },
    page: { section: "page.combat", anchor: "character.hp" },
    everyCharacter: true,
    value: (a) => (a.hp ? `${a.hp.cur} of ${a.hp.max}` : undefined),
  },
  {
    key: "conditions",
    title: "Conditions",
    names: ["effects", "status"],
    icon: "combat",
    token: { section: "combat", anchor: "token.conditions" },
    page: { section: "page.combat", anchor: "character.conditions" },
    everyCharacter: true,
    value: conditionsOf,
  },
  {
    key: "ac",
    title: "Armor Class",
    icon: "stats",
    token: { section: "stats", anchor: "token.ac" },
    page: { section: "page.stats", anchor: "character.ac" },
    everyCharacter: true,
    value: (a) => (a.ac === undefined ? undefined : String(a.ac)),
  },
  {
    key: "pp",
    title: "Passive Perception",
    icon: "stats",
    token: { section: "stats", anchor: "token.pp" },
    page: { section: "page.stats", anchor: "character.pp" },
    everyCharacter: true,
    value: (a) => (a.passivePerception === undefined ? undefined : String(a.passivePerception)),
  },
  {
    key: "senses",
    title: "Senses",
    icon: "stats",
    token: { section: "stats", anchor: "token.senses" },
    page: { section: "page.stats", anchor: "character.senses" },
    everyCharacter: true,
    value: (a) => a.senses || undefined,
  },
  {
    key: "walk",
    title: "Walk Speed",
    icon: "speed",
    token: { section: "stats", anchor: "token.walk" },
    page: { section: "page.stats", anchor: "character.walk" },
    value: (a) => (a.speeds ? `${a.speeds.walk} ft.` : undefined),
  },
  // A character's rests, each its own choice on the page, so "long rest" lands on Long Rest itself. The token panel's rest is the same one step further.
  { key: "long-rest", title: "Long Rest", icon: "time", page: { section: "page.combat", anchor: "character.rest.long" }, everyCharacter: true },
  { key: "short-rest", title: "Short Rest", icon: "time", page: { section: "page.combat", anchor: "character.rest.short" }, everyCharacter: true },
  // The groups each creature's panel and page hold, landing on the group's header.
  { key: "combat", kind: "section", title: "Combat", icon: "combat", token: { section: "combat", anchor: "token.combat" }, page: { section: "page.combat", anchor: "character.combat" } },
  { key: "stats", kind: "section", title: "Stats", icon: "stats", token: { section: "stats", anchor: "token.stats" }, page: { section: "page.stats", anchor: "character.stats" } },
  { key: "notes", kind: "section", title: "Notes", icon: "notes", token: { section: "notes", anchor: "token.notes" }, page: { section: "page.notes", anchor: "character.notes" } },
];
