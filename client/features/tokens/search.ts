import type { ProjectedActor } from "#shared/project.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { STATUSES } from "#shared/srd/statuses.ts";
import type { FieldDef } from "../search/catalog/types.ts";
import { drawn, panelGroupDrawn, panelHolds, type StatRows } from "./panelDraws.ts";

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

// Each field is offered where its surface draws its control (panelDraws.ts drawn).
const combatShown = drawn((d) => panelGroupDrawn(d.parts, "combat"), (d) => d.parts.includes("combat"));
// A player lent only a character's token holds none of its card, so its panel has no Armor Class, Passive Perception, Senses or Walk Speed to land on.
const statRow = (row: keyof StatRows) => drawn((d) => panelHolds(d.parts, "stats") && d.stats !== null && d.stats[row], (d) => d.parts.includes("stats") && d.stats[row]);

export const CREATURE_FIELDS: readonly FieldDef[] = [
  {
    key: "hp",
    title: "Hit Points",
    icon: "combat",
    token: { section: "combat", anchor: "token.hp" },
    page: { section: "page.combat", anchor: "character.hp" },
    everyCharacter: true,
    shown: combatShown,
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
    shown: combatShown,
    value: conditionsOf,
  },
  {
    key: "ac",
    title: "Armor Class",
    icon: "stats",
    token: { section: "stats", anchor: "token.ac" },
    page: { section: "page.stats", anchor: "character.ac" },
    everyCharacter: true,
    shown: statRow("ac"),
    value: (a) => (a.ac === undefined ? undefined : String(a.ac)),
  },
  {
    key: "pp",
    title: "Passive Perception",
    icon: "stats",
    token: { section: "stats", anchor: "token.pp" },
    page: { section: "page.stats", anchor: "character.pp" },
    everyCharacter: true,
    shown: statRow("pp"),
    value: (a) => (a.passivePerception === undefined ? undefined : String(a.passivePerception)),
  },
  {
    key: "senses",
    title: "Senses",
    icon: "stats",
    token: { section: "stats", anchor: "token.senses" },
    page: { section: "page.stats", anchor: "character.senses" },
    everyCharacter: true,
    shown: statRow("senses"),
    value: (a) => a.senses || undefined,
  },
  {
    key: "walk",
    title: "Walk Speed",
    icon: "speed",
    token: { section: "stats", anchor: "token.walk" },
    page: { section: "page.stats", anchor: "character.walk" },
    shown: statRow("walk"),
    value: (a) => (a.speeds ? `${a.speeds.walk} ft.` : undefined),
  },
  // A character's rests, each its own choice on the page, so "long rest" lands on Long Rest itself. The token panel's rest is the same one step further.
  { key: "long-rest", title: "Long Rest", icon: "time", page: { section: "page.combat", anchor: "character.rest.long" }, everyCharacter: true, shown: combatShown },
  { key: "short-rest", title: "Short Rest", icon: "time", page: { section: "page.combat", anchor: "character.rest.short" }, everyCharacter: true, shown: combatShown },
  // The groups each creature's panel and page hold, landing on the group's header.
  { key: "combat", kind: "section", title: "Combat", icon: "combat", token: { section: "combat", anchor: "token.combat" }, page: { section: "page.combat", anchor: "character.combat" }, shown: combatShown },
  { key: "stats", kind: "section", title: "Stats", icon: "stats", token: { section: "stats", anchor: "token.stats" }, page: { section: "page.stats", anchor: "character.stats" }, shown: drawn((d) => panelHolds(d.parts, "stats"), (d) => d.parts.includes("stats")) },
  { key: "notes", kind: "section", title: "Notes", icon: "notes", token: { section: "notes", anchor: "token.notes" }, page: { section: "page.notes", anchor: "character.notes" }, shown: drawn((d) => panelGroupDrawn(d.parts, "notes"), (d) => d.parts.includes("notes")) },
  // Position holds Elevation, Facing and Shares sight, which stay folded in the sweep and so take their group's anchor. A viewer who finds a creature's fields may change all three.
  { key: "position", kind: "section", title: "Position", names: ["elevation", "facing", "shares sight", "rotation"], icon: "position", token: { section: "position", anchor: "token.position" }, shown: drawn((d) => panelGroupDrawn(d.parts, "position"), () => false) },
  { key: "image", kind: "section", title: "Image", names: ["picture", "portrait"], icon: "image", token: { section: "image", anchor: "token.image" }, page: { section: "page.image", anchor: "character.image" }, shown: drawn((d) => panelGroupDrawn(d.parts, "image"), (d) => d.parts.includes("image")) },
  // The one fold a page shares with the panel, so both name it `statBlock`.
  { key: "stat-block", kind: "section", title: "Stat block", names: ["statblock"], icon: "statBlock", token: { section: "statBlock", anchor: "token.stat-block" }, page: { section: "statBlock", anchor: "character.stat-block" }, shown: drawn((d) => panelHolds(d.parts, "statBlock"), (d) => d.parts.includes("statBlock")) },
  { key: "companions", kind: "section", title: "Companions", icon: "companion", page: { section: "page.companions", anchor: "character.companions" }, shown: drawn(() => false, (d) => d.parts.includes("companions")) },
];
