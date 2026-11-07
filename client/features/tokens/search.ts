import type { ProjectedActor } from "#shared/project.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { STATUSES } from "#shared/srd/statuses.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import type { FieldDef, FieldHolder } from "../search/catalog/types.ts";
import { ownsCharacter } from "./access.ts";

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

/**
 * Whether the token panel draws a Stat block for the selection, by the
 * panel's own rule (statBlockLink.ts). A character's page draws it for
 * whoever reaches the page, and only its players find it here.
 */
function statBlockDrawn(h: FieldHolder): boolean {
  const { token, character } = h;
  if (h.surface === "page" || !token) return true;
  return statBlockShown({
    dm: h.role === "dm",
    owner: true,
    kind: token.kind,
    actor: "inline" in token.actor ? token.actor.inline : character?.actor,
    companion: token.companion !== undefined,
    character: "ref" in token.actor,
    ownsCharacter: character ? ownsCharacter(h.memberId, character) : undefined,
  });
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
  // Position holds Elevation, Facing and Shares sight, which stay folded in the sweep and so take their group's anchor. A viewer who finds a creature's fields may change all three.
  { key: "position", kind: "section", title: "Position", names: ["elevation", "facing", "shares sight", "rotation"], icon: "position", token: { section: "position", anchor: "token.position" } },
  { key: "image", kind: "section", title: "Image", names: ["picture", "portrait"], icon: "image", token: { section: "image", anchor: "token.image" }, page: { section: "page.image", anchor: "character.image" } },
  // The one fold a page shares with the panel, so both name it `statBlock`.
  { key: "stat-block", kind: "section", title: "Stat block", names: ["statblock"], icon: "statBlock", token: { section: "statBlock", anchor: "token.stat-block" }, page: { section: "statBlock", anchor: "character.stat-block" }, shown: statBlockDrawn },
  { key: "companions", kind: "section", title: "Companions", icon: "companion", page: { section: "page.companions", anchor: "character.companions" } },
];
