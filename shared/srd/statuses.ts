import { STATUS_KEYS, type StatusKey } from "../model.ts";
import { RULES_TEXT, type RulesTextEntry } from "./rules-text.ts";

/**
 * The statuses that are not conditions, with a label, a short summary and a
 * default chip color. `rules` is the SRD 5.2.1 text for the rule behind the
 * status (the Hide action for Hidden, the Bless spell for Blessed) and is
 * absent for Marked, which is the app's own free-form marker.
 *
 * The colors are mid-light tints, so a chip stays readable on the dark theme
 * (client/lib/theme.ts) behind a dark glyph. Each is distinct from its
 * neighbors in hue, but a chip always carries its icon too, so color is never
 * the only cue.
 */
export type StatusInfo = {
  key: StatusKey;
  label: string;
  summary: string;
  color: string;
  rules?: RulesTextEntry;
};

const STATUS_DETAILS: Record<StatusKey, Omit<StatusInfo, "key" | "rules">> = {
  concentrating: {
    label: "Concentrating",
    summary: "Keeping a spell or effect going. Damage forces a Constitution save, DC 10 or half the damage, whichever is higher, up to 30.",
    color: "#a78bfa",
  },
  hidden: {
    label: "Hidden",
    summary: "Took the Hide action, so it has the Invisible condition until it makes a sound, attacks, casts a spell with a Verbal component or is found.",
    color: "#94a3b8",
  },
  flying: {
    label: "Flying",
    summary: "Aloft. Falls if Incapacitated, Prone or its Fly Speed drops to 0, unless it can hover.",
    color: "#38bdf8",
  },
  dodging: {
    label: "Dodging",
    summary: "Until its next turn starts, attacks against it have Disadvantage if it can see the attacker, and it has Advantage on Dexterity saves.",
    color: "#2dd4bf",
  },
  raging: {
    label: "Raging",
    summary: "Resistance to Bludgeoning, Piercing and Slashing damage, extra damage on Strength attacks, Advantage on Strength checks and saves. No spells or Concentration.",
    color: "#f87171",
  },
  blessed: {
    label: "Blessed",
    summary: "Adds 1d4 to attack rolls and saving throws.",
    color: "#facc15",
  },
  baned: {
    label: "Baned",
    summary: "Subtracts 1d4 from attack rolls and saving throws.",
    color: "#a3e635",
  },
  hasted: {
    label: "Hasted",
    summary: "Speed doubled, +2 AC, Advantage on Dexterity saves and an extra limited action each turn. When it ends, Incapacitated with Speed 0 until the end of its next turn.",
    color: "#fb923c",
  },
  "hunters-mark": {
    label: "Hunter’s Mark",
    summary: "Takes an extra 1d6 Force damage when the caster hits it. The caster has Advantage on checks to find it.",
    color: "#4ade80",
  },
  hexed: {
    label: "Hex",
    summary: "Takes an extra 1d6 Necrotic damage when the caster hits it, and has Disadvantage on checks with one chosen ability.",
    color: "#e879f9",
  },
  "heroic-inspiration": {
    label: "Heroic Inspiration",
    summary: "Can be spent to reroll any die right after rolling it.",
    color: "#f472b6",
  },
  surprised: {
    label: "Surprised",
    summary: "Caught unawares as combat starts, so it has Disadvantage on its Initiative roll.",
    color: "#fde68a",
  },
  marked: {
    label: "Marked",
    summary: "A free marker for the table, such as a chosen target or a reminder.",
    color: "#60a5fa",
  },
  readied: {
    label: "Readied action",
    summary: "Took the Ready action: when the trigger it chose happens before its next turn, it can act with its Reaction. The marker ends when that turn starts.",
    color: "#818cf8",
  },
};

export const STATUSES = Object.fromEntries(
  STATUS_KEYS.map((key) => {
    const rules = RULES_TEXT.statuses[key];
    return [key, { key, ...STATUS_DETAILS[key], ...(rules ? { rules } : {}) }];
  }),
) as Record<StatusKey, StatusInfo>;
