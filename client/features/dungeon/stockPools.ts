import type { ImageRef, RoomState } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { monsterImage } from "../monsters/images.ts";
import type { Theme } from "./settings.ts";

/*
 * The SRD monsters each theme stocks its rooms from (docs/design/design-v1-dungeon-stock.md
 * 4, D-261127-065 and 216 amended). SRD 5.2.1 blocks name no habitat, so a
 * theme takes whole creature types, its families, and leaves out what has
 * no place underground: the huge, the aquatic, the harmless, the farm and
 * the open sky. The worker draws from the pool the page sends, so the
 * 0.5 MB SRD chunk loads on the page once and never in the worker.
 */

/** A pool block: an SRD monster without its stat block text, which the worker never reads, and the room's image for it. */
export type StockMonster = Omit<SrdMonster, "statBlock"> & { image?: ImageRef };

/**
 * Each theme's families, first the one it draws most. A family is a base
 * type ("Humanoid" takes every Humanoid tag) or a type with its tag ("Fey
 * (Goblinoid)" takes only the goblinoids). Swarms count as the type they
 * are a swarm of.
 */
export const THEME_FAMILIES: Readonly<Record<Theme, readonly string[]>> = {
  dungeon: ["Humanoid", "Fey (Goblinoid)", "Monstrosity", "Aberration", "Ooze", "Construct", "Giant"],
  crypt: ["Undead", "Construct"],
  cave: ["Beast", "Monstrosity", "Ooze", "Aberration", "Plant", "Giant", "Dragon"],
  mine: ["Elemental", "Construct", "Monstrosity", "Ooze", "Fey (Goblinoid)", "Dragon"],
  sewer: ["Beast", "Ooze", "Aberration", "Monstrosity (Lycanthrope)", "Humanoid"],
};

/** A theme's first family weighs this much in a room's draw, the rest 1. */
export const FIRST_FAMILY_WEIGHT = 3;

/** Left out of every pool: livestock, mounts and pets, the open sky's birds, and blocks that are no fight of their own. */
const NOWHERE: ReadonlySet<string> = new Set([
  "Camel",
  "Deer",
  "Draft Horse",
  "Elk",
  "Giant Elk",
  "Goat",
  "Mule",
  "Pony",
  "Riding Horse",
  "Warhorse",
  "Elephant",
  "Mammoth",
  "Hippopotamus",
  "Rhinoceros",
  "Cat",
  "Mastiff",
  "Eagle",
  "Hawk",
  "Owl",
  "Raven",
  "Vulture",
  "Commoner",
  "Noble",
  "Troll Limb",
  "Homunculus",
]);

/** Wilderness animals and flying mounts, which only Cave keeps some of. */
const WILDS: readonly string[] = [
  "Lion",
  "Tiger",
  "Saber-Toothed Tiger",
  "Panther",
  "Polar Bear",
  "Giant Goat",
  "Blood Hawk",
  "Swarm of Ravens",
  "Hyena",
  "Giant Hyena",
  "Jackal",
  "Axe Beak",
  "Hippogriff",
  "Griffon",
  "Giant Vulture",
];

/** What each theme leaves out besides NOWHERE. Cave keeps its Polar Bear and loses the Pteranodon. */
const THEME_OUT: Readonly<Record<Theme, ReadonlySet<string>>> = {
  dungeon: new Set(WILDS),
  crypt: new Set(WILDS),
  cave: new Set([...WILDS.filter((n) => n !== "Polar Bear"), "Pteranodon"]),
  mine: new Set(WILDS),
  sewer: new Set(WILDS),
};

/** The only beasts a Sewer takes, by SRD id (D-261127-223): its vermin, Giant Wasp and Giant Fire Beetle counted as insects. */
export const SEWER_BEASTS: ReadonlySet<string> = new Set([
  "bat",
  "giant-bat",
  "swarm-of-bats",
  "rat",
  "giant-rat",
  "swarm-of-rats",
  "giant-centipede",
  "spider",
  "giant-spider",
  "giant-wolf-spider",
  "venomous-snake",
  "giant-venomous-snake",
  "constrictor-snake",
  "giant-constrictor-snake",
  "swarm-of-venomous-snakes",
  "crocodile",
  "giant-crocodile",
  "frog",
  "giant-frog",
  "giant-toad",
  "giant-fire-beetle",
  "giant-wasp",
  "swarm-of-insects",
]);

/** A type's base: "Dragon (Chromatic)" is Dragon, and "Swarm of Tiny Beasts" is Beast. */
export function baseType(type: string): string {
  const swarm = /^Swarm of \w+ (\w+?)s?$/.exec(type);
  if (swarm) return swarm[1]!;
  return type.replace(/\s*\(.*\)$/, "");
}

/** The index of the theme's family a block belongs to, or -1 for none. */
export function familyOf(theme: Theme, m: Pick<SrdMonster, "type">): number {
  const base = baseType(m.type);
  return THEME_FAMILIES[theme].findIndex((f) => (f.includes("(") ? f === m.type : f === base));
}

/** Whether a block lives in the water: a walk of 10 ft or less with a swim speed. */
function aquatic(m: Pick<SrdMonster, "speeds">): boolean {
  return (m.speeds.swim ?? 0) > 0 && (m.speeds.walk ?? 0) <= 10;
}

/** Whether a theme stocks a block at all. */
export function inPool(theme: Theme, m: Pick<SrdMonster, "srdId" | "name" | "type" | "size" | "speeds" | "xp">): boolean {
  if (m.size === "gargantuan" || m.xp <= 0 || aquatic(m) || m.type === "Beast (Dinosaur)") return false;
  if (NOWHERE.has(m.name) || THEME_OUT[theme].has(m.name)) return false;
  if (familyOf(theme, m) < 0) return false;
  if (theme === "mine" && /^(Adult|Ancient) /.test(m.name)) return false;
  if (theme === "sewer" && baseType(m.type) === "Beast" && !SEWER_BEASTS.has(m.srdId)) return false;
  return true;
}

/**
 * A theme's pool from the SRD list, in the list's order, each block without
 * its text and with the image the room gives it (its own or the shipped
 * icon), so the worker's tokens wear what the Monsters panel would place.
 */
export function stockPool(list: readonly SrdMonster[], theme: Theme, images: Pick<RoomState, "srdImages">): StockMonster[] {
  return list.flatMap((m) => {
    if (!inPool(theme, m)) return [];
    const { statBlock: _text, ...rest } = m;
    const image = monsterImage(images, { srdId: m.srdId });
    return [image ? { ...rest, image } : rest];
  });
}
