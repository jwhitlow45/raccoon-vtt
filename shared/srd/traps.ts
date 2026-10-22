import type { AbilityKey, ConditionKey, SkillKey, TrapCheck, TrapRig, TrapSound } from "../model.ts";
import type { DamageType } from "../rules/damage.ts";

/**
 * The SRD 5.2.1's example traps (Gameplay Toolbox, "Traps", pages 199 to
 * 201, CC-BY-4.0, see NOTICE.md) as presets for the Trap tool
 * (docs/design-v1-traps.md Appendix A), each at the four party level bands
 * its "At Higher Levels" table scales it to. The DCs, damage and triggers
 * are the SRD's, which scripts/srd-import.ts checks against its text, and
 * each note retells the rest of its entry. The players' lines and sounds
 * are this app's own.
 *
 * Every preset sets Party creatures, creatures on the floor only, and the
 * Passive Perception hint where it has a Perception check.
 */

export type LevelBand = "1-4" | "5-10" | "11-16" | "17-20";
export const LEVEL_BANDS: readonly LevelBand[] = ["1-4", "5-10", "11-16", "17-20"];

/** Where a preset lies: squares of a size, a trip wire, or a door. */
export type PresetZone = { kind: "squares"; w: number; h: number } | { kind: "wire" } | { kind: "door" };

/** Who a preset hits: the creature that set it off, everyone in squares the DM draws, or everyone in a cone the DM places. */
export type PresetHits = "trigger" | "draw" | { cone: number };

/** One band of a preset: what scales with the party's level. */
type Band = { dc?: number; damage?: { formula: string; type: DamageType }[]; cone?: number; depth?: number; escapeDc?: number };

type Spec = {
  id: string;
  name: string;
  /** The SRD's severity and levels, as printed. */
  severity: string;
  zone: PresetZone;
  on: TrapRig["on"];
  resets: TrapRig["resets"];
  uses?: number;
  stops: boolean;
  hits: "trigger" | "draw" | "cone";
  save?: { ability: AbilityKey; onPass: "half" | "none" };
  conditions?: ConditionKey[];
  bands: Record<LevelBand, Band>;
  find: (Omit<TrapCheck, "skill"> & { skill: SkillKey })[];
  disarm: { text: string; check?: TrapCheck };
  message: string;
  sound: TrapSound;
  /** Shows a token the DM picks when it goes off. */
  shows?: true;
  note: (band: Band) => string;
};

const perception = (dc: number, what: string): Spec["find"][number] => ({ ability: "wis", skill: "perception", dc, what });
const investigation = (dc: number, what: string): Spec["find"][number] => ({ ability: "int", skill: "investigation", dc, what });
const same = (band: Band): Record<LevelBand, Band> => ({ "1-4": band, "5-10": band, "11-16": band, "17-20": band });
const dice = (formula: string, type: DamageType) => [{ formula, type }];

const SPECS: readonly Spec[] = [
  {
    id: "collapsing-roof",
    name: "Collapsing Roof",
    severity: "Deadly Trap (Levels 1–4)",
    zone: { kind: "wire" },
    on: [],
    resets: "never",
    stops: true,
    hits: "draw",
    save: { ability: "dex", onPass: "half" },
    bands: {
      "1-4": { dc: 13, damage: dice("2d10", "bludgeoning") },
      "5-10": { dc: 15, damage: dice("4d10", "bludgeoning") },
      "11-16": { dc: 17, damage: dice("10d10", "bludgeoning") },
      "17-20": { dc: 19, damage: dice("18d10", "bludgeoning") },
    },
    find: [perception(11, "the trip wire and the unstable ceiling")],
    disarm: { text: "Once found, the trip wire can be cut or avoided, no check needed." },
    message: "The ceiling comes crashing down!",
    sound: "crash",
    note: () => "Draw the squares under the unstable ceiling: everyone there is hit. Rubble from the collapse turns the trapped area into Difficult Terrain.",
  },
  {
    id: "falling-net",
    name: "Falling Net",
    severity: "Nuisance Trap (Levels 1–4)",
    zone: { kind: "wire" },
    on: [],
    resets: "never",
    stops: true,
    hits: "trigger",
    save: { ability: "dex", onPass: "none" },
    conditions: ["restrained"],
    bands: { "1-4": { dc: 10, escapeDc: 10 }, "5-10": { dc: 12, escapeDc: 12 }, "11-16": { dc: 14, escapeDc: 14 }, "17-20": { dc: 16, escapeDc: 16 } },
    find: [perception(11, "the trip wire and the net")],
    disarm: { text: "Once found, the trip wire can be cut or avoided, no check needed." },
    message: "A weighted net drops from above!",
    sound: "whoosh",
    note: (b) => `The target succeeds automatically if it's Huge or larger: mark those Pass. Restrained until it escapes: an action and a DC ${b.escapeDc} Strength (Athletics) check frees a creature within reach. Reducing the net to 0 Hit Points frees it too.`,
  },
  {
    id: "fire-casting-statue",
    name: "Fire-Casting Statue",
    severity: "Deadly Trap (Levels 1–4)",
    zone: { kind: "squares", w: 1, h: 1 },
    on: ["enter", "turnStart"],
    resets: "nextTurn",
    stops: true,
    hits: "cone",
    save: { ability: "dex", onPass: "half" },
    bands: {
      "1-4": { dc: 15, damage: dice("2d10", "fire"), cone: 15 },
      "5-10": { dc: 15, damage: dice("4d10", "fire"), cone: 30 },
      "11-16": { dc: 15, damage: dice("10d10", "fire"), cone: 60 },
      "17-20": { dc: 15, damage: dice("18d10", "fire"), cone: 120 },
    },
    find: [perception(15, "the pressure plate"), perception(10, "the glyph on the statue")],
    disarm: { text: "Wedge an Iron Spike under the pressure plate, or deface the glyph with a sharp tool." },
    message: "The statue breathes a cone of fire!",
    sound: "whoosh",
    note: (b) => `Place the ${b.cone}-foot cone from the statue. It goes off when a creature moves onto the plate for the first time on a turn, or starts its turn there. Detect Magic shows an aura of Evocation around the statue, and a DC 15 Intelligence (Arcana) check reads the glyph as "fire".`,
  },
  {
    id: "hidden-pit",
    name: "Hidden Pit",
    severity: "Nuisance Trap (Levels 1–4)",
    zone: { kind: "squares", w: 2, h: 2 },
    on: ["enter"],
    resets: "never",
    stops: true,
    hits: "trigger",
    bands: {
      "1-4": { damage: dice("1d6", "bludgeoning"), depth: 10 },
      "5-10": { damage: dice("3d6", "bludgeoning"), depth: 30 },
      "11-16": { damage: dice("6d6", "bludgeoning"), depth: 60 },
      "17-20": { damage: dice("12d6", "bludgeoning"), depth: 120 },
    },
    find: [investigation(15, "the pit's lid")],
    disarm: { text: "Wedge an Iron Spike between the lid and the floor, or hold it shut with Arcane Lock." },
    message: "The floor gives way!",
    sound: "crash",
    note: (b) => `A ${b.depth}-foot pit. The lid stays open once it opens. Climbing out needs a Climb Speed, climbing gear, or magic such as Spider Climb.`,
  },
  {
    id: "poisoned-darts",
    name: "Poisoned Darts",
    severity: "Deadly Trap (Levels 1–4)",
    zone: { kind: "squares", w: 1, h: 1 },
    on: ["enter"],
    resets: "nextTurn",
    uses: 3,
    stops: true,
    hits: "draw",
    save: { ability: "dex", onPass: "none" },
    // Two of the SRD's 1d3 darts, each dart's Poison damage doubled.
    bands: {
      "1-4": { dc: 13, damage: dice("2d6", "poison") },
      "5-10": { dc: 13, damage: dice("4d6", "poison") },
      "11-16": { dc: 13, damage: dice("8d6", "poison") },
      "17-20": { dc: 13, damage: dice("14d6", "poison") },
    },
    find: [perception(15, "the pressure plate"), perception(15, "the holes in the walls")],
    disarm: { text: "Wedge an Iron Spike under the pressure plate, or plug every hole." },
    message: "Darts hiss out of the walls!",
    sound: "hiss",
    note: (b) => `Draw the darts' path: everyone in it is hit. The SRD strikes each with 1d3 darts of ${perDart(b)} Poison damage a dart, which no formula holds, so this deals two darts. Roll 1d3 and change the damage if you like.`,
  },
  {
    id: "poisoned-needle",
    name: "Poisoned Needle",
    severity: "Nuisance Trap (Levels 1–4)",
    zone: { kind: "door" },
    on: [],
    resets: "never",
    stops: false,
    hits: "trigger",
    save: { ability: "con", onPass: "half" },
    conditions: ["poisoned"],
    bands: {
      "1-4": { dc: 11, damage: dice("1d10", "poison") },
      "5-10": { dc: 13, damage: dice("2d10", "poison") },
      "11-16": { dc: 15, damage: dice("4d10", "poison") },
      "17-20": { dc: 17, damage: dice("10d10", "poison") },
    },
    find: [perception(15, "the needle in the lock")],
    disarm: { text: "On a failed check the creature sets it off.", check: { ability: "dex", skill: "sleight-of-hand", dc: 15 } },
    message: "A needle jabs out of the lock!",
    sound: "click",
    note: () => "Poisoned for 1 hour on a failed save, which a fight's rounds cannot count: remove it when the hour is up. Opening the lock with a Knock spell or similar magic does not set it off.",
  },
  {
    id: "rolling-stone",
    name: "Rolling Stone",
    severity: "Deadly Trap (Levels 11–16) or Nuisance Trap (Levels 17–20)",
    zone: { kind: "squares", w: 1, h: 1 },
    on: ["enter"],
    resets: "never",
    stops: true,
    hits: "trigger",
    bands: same({}),
    find: [investigation(15, "the pressure plate")],
    disarm: { text: "Wedge an Iron Spike under the pressure plate." },
    message: "A great stone ball rumbles loose!",
    sound: "rumble",
    shows: true,
    note: () =>
      "Roll Initiative for the stone and everyone nearby: the stone gets +8. On its turn it rolls 60 feet in one direction. A creature whose space it enters, or who enters its space, makes a DC 15 Dexterity save or takes 55 (10d10) Bludgeoning damage and has the Prone condition. A DC 20 Strength (Athletics) check slows it by 15 feet. It is a Large object: AC 17, HP 100, Damage Threshold 10.",
  },
  {
    id: "spiked-pit",
    name: "Spiked Pit",
    severity: "Deadly Trap (Levels 1–4)",
    zone: { kind: "squares", w: 2, h: 2 },
    on: ["enter"],
    resets: "never",
    stops: true,
    hits: "trigger",
    bands: {
      "1-4": { damage: [...dice("1d6", "bludgeoning"), ...dice("2d8", "piercing")], depth: 10 },
      "5-10": { damage: [...dice("3d6", "bludgeoning"), ...dice("3d8", "piercing")], depth: 30 },
      "11-16": { damage: [...dice("6d6", "bludgeoning"), ...dice("8d8", "piercing")], depth: 60 },
      "17-20": { damage: [...dice("12d6", "bludgeoning"), ...dice("13d8", "piercing")], depth: 120 },
    },
    find: [investigation(15, "the pit's lid")],
    disarm: { text: "Wedge an Iron Spike between the lid and the floor, or hold it shut with Arcane Lock." },
    message: "The floor gives way onto spikes!",
    sound: "crash",
    note: (b) => `A ${b.depth}-foot pit with spikes at the bottom. The lid stays open once it opens. Climbing out needs a Climb Speed, climbing gear, or magic such as Spider Climb.`,
  },
];

/** A dart's share of a band's damage: half the doubled formula. */
function perDart(band: Band): string {
  const formula = band.damage?.[0]?.formula ?? "1d6";
  const [n, d] = formula.split("d");
  return `${Number(n) / 2}d${d}`;
}

/** A preset as the Trap tool starts a trap from it: everything but where its zone, its hits and its pit floor lie. */
export type TrapPreset = {
  id: string;
  name: string;
  severity: string;
  band: LevelBand;
  zone: PresetZone;
  hits: PresetHits;
  /** A pit's depth in feet: its floor is the lid's ground less this, at least -100 ft. */
  pitDepth?: number;
  /** Shows a token the DM picks when it goes off. */
  shows?: true;
  rig: Omit<TrapRig, "hits" | "pit" | "noticedBy" | "due">;
};

/** The presets, in the SRD's order. */
export const TRAP_PRESET_IDS: readonly string[] = SPECS.map((s) => s.id);

/** A preset at a party level band, or null for an id that is none. */
export function trapPreset(id: string, band: LevelBand): TrapPreset | null {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) return null;
  const b = spec.bands[band];
  const rig: TrapPreset["rig"] = {
    on: [...spec.on],
    who: "party",
    floor: true,
    resets: spec.resets,
    ...(spec.uses !== undefined ? { usesLeft: spec.uses } : {}),
    stops: spec.stops,
    foundOnSpring: true,
    ...(spec.save && b.dc !== undefined ? { save: { ability: spec.save.ability, dc: b.dc, onPass: spec.save.onPass } } : {}),
    ...(b.damage ? { damage: b.damage.map((d) => ({ ...d })) } : {}),
    ...(spec.conditions ? { conditions: [...spec.conditions] } : {}),
    message: spec.message,
    sound: spec.sound,
    actions: [],
    find: spec.find.map((c) => ({ ...c })),
    notice: spec.find.some((c) => c.skill === "perception"),
    disarm: { text: spec.disarm.text, ...(spec.disarm.check ? { check: { ...spec.disarm.check } } : {}) },
    note: spec.note(b),
    preset: spec.id,
  };
  const hits: PresetHits = spec.hits === "cone" ? { cone: b.cone ?? 15 } : spec.hits;
  return {
    id: spec.id,
    name: spec.name,
    severity: spec.severity,
    band,
    zone: spec.zone,
    hits,
    ...(b.depth !== undefined ? { pitDepth: b.depth } : {}),
    ...(spec.shows ? { shows: true as const } : {}),
    rig,
  };
}

/**
 * What scripts/srd-import.ts checks of each preset against the SRD's text:
 * the words of its trigger, and every DC, damage die and pit depth it uses
 * at each band, as the SRD prints them. A list of strings is any one of
 * them: a higher band's DC is printed in a table row after its damage, or
 * in a sentence of its own.
 */
export function trapPresetFacts(): { name: string; trigger: string; fragments: (string | string[])[] }[] {
  return SPECS.map((spec) => {
    const trigger = spec.zone.kind === "wire" ? "crosses a trip wire" : spec.zone.kind === "door" ? "opens the trap's lock" : "moves onto";
    const fragments: (string | string[])[] = [];
    const first = spec.bands["1-4"];
    for (const band of LEVEL_BANDS) {
      const b = spec.bands[band];
      // The darts' dice are the SRD's per dart, doubled here.
      const formulas = spec.id === "poisoned-darts" ? [perDart(b)] : (b.damage ?? []).map((d) => d.formula);
      for (const f of formulas) fragments.push(`(${f})`);
      if (spec.save && b.dc !== undefined) {
        if (band === "1-4" || b.dc === first.dc) fragments.push(`DC ${b.dc} ${ABILITY_WORDS[spec.save.ability]} saving throw`);
        else fragments.push([`(${formulas.at(-1)}) ${b.dc}`, `DC ${b.dc} at levels ${band.replace("-", "–")}`]);
      }
      if (b.depth !== undefined) fragments.push(band === "1-4" ? `${b.depth}-foot-deep` : `${band.replace("-", "–")} ${b.depth} feet`);
      if (b.cone !== undefined) fragments.push(`${b.cone}-foot Cone`);
      if (b.escapeDc !== undefined) fragments.push(band === "1-4" ? `DC ${b.escapeDc} Strength (Athletics)` : `DC ${b.escapeDc} at levels ${band.replace("-", "–")}`);
    }
    for (const c of spec.find) fragments.push(`DC ${c.dc} ${ABILITY_WORDS[c.ability]} (${SKILL_WORDS[c.skill]})`);
    if (spec.disarm.check?.skill) fragments.push(`DC ${spec.disarm.check.dc} ${ABILITY_WORDS[spec.disarm.check.ability]} (${SKILL_WORDS[spec.disarm.check.skill]})`);
    for (const c of spec.conditions ?? []) fragments.push(`${c[0]!.toUpperCase()}${c.slice(1)} condition`);
    if (spec.resets === "nextTurn") fragments.push("resets at the start of the next turn");
    if (spec.uses !== undefined) fragments.push("fewer than three times");
    return { name: spec.name, trigger, fragments };
  });
}

const ABILITY_WORDS: Record<AbilityKey, string> = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const SKILL_WORDS: Partial<Record<SkillKey, string>> = { perception: "Perception", investigation: "Investigation", "sleight-of-hand": "Sleight of Hand", athletics: "Athletics", arcana: "Arcana" };
