import type { Actor, CreatureSize } from "../model.ts";
import { MAX_LEGENDARY_USES, MAX_NAME } from "../protocol.ts";

/**
 * One SRD 5.2.1 stat block (CC-BY-4.0, see NOTICE.md), as generated into
 * monsters.json by scripts/srd-import.ts. The light fields fill a token's
 * stat card. `statBlock` is the whole block for the DM's view.
 *
 * `statBlock` is Markdown limited to this subset, so a small renderer is
 * enough: blank-line separated paragraphs, `## ` for the name, `### ` for the
 * sections (Traits, Actions, Bonus Actions, Reactions, Legendary Actions),
 * `**bold**` and one `*italic*` line, `- ` lists, and one pipe table for the
 * ability scores. `*`, `_`, `` ` `` and `\` in running text are escaped with a
 * backslash. Numbers keep the SRD's typography (− for minus, – in ranges).
 */
export type SrdMonster = {
  /** A stable slug of the name, such as "adult-red-dragon". */
  srdId: string;
  name: string;
  /** The first size listed. "Medium or Small" blocks are medium here. */
  size: Exclude<CreatureSize, "custom">;
  /** The creature type with any tag, such as "Dragon (Chromatic)". */
  type: string;
  alignment: string;
  ac: number;
  /** `formula` uses an ASCII minus, such as "1d4 - 1". */
  hp: { average: number; formula: string };
  /** Feet. Speeds that apply only in another form (lycanthropes) are left out. */
  speeds: Actor["speeds"];
  /** 2024 blocks print both: "Initiative +7 (17)". The score is 10 + bonus. */
  initiative: { bonus: number; score: number };
  passivePerception: number;
  /** Special senses without Passive Perception, or "" for none. */
  senses: string;
  languages: string;
  /** "0", "1/8", "1/4", "1/2", or "1" to "30". */
  cr: string;
  xp: number;
  /** XP when encountered in its lair, given for some legendary creatures. */
  xpInLair?: number;
  legendaryActions?: { uses: number; usesInLair?: number };
  legendaryResistance?: { uses: number; usesInLair?: number };
  statBlock: string;
};

/**
 * A stat block in this shape from either source: an SRD monster, or a
 * room's own monster seen through shared/statBlock.ts, which has no SRD id.
 */
export type StatBlockMonster = Omit<SrdMonster, "srdId"> & { srdId?: string };

let loading: Promise<readonly SrdMonster[]> | undefined;

/**
 * All 330 stat blocks, about half a megabyte. A dynamic import, so Vite puts
 * them in their own chunk and only the DM's monster browser downloads it.
 * Memoized, because every caller wants the same array. Node needs the JSON
 * import attribute, and vite.config.ts lets the dev server take it too.
 */
export function loadMonsters(): Promise<readonly SrdMonster[]> {
  loading ??= import("./monsters.json", { with: { type: "json" } })
    .then((m) => m.default as unknown as SrdMonster[])
    .catch((err: unknown) => {
      // Let the next caller try again, for example after a dropped connection.
      loading = undefined;
      throw err;
    });
  return loading;
}

/**
 * A stat block line cut to what one actor field holds, with an ellipsis
 * where it was cut. A room's own monster may print a type of 120 characters
 * and senses of 500, an actor holds 80, and the stat block keeps the whole
 * line for the DM. A cut never splits a character outside the BMP.
 */
export function fitLine(text: string, max = MAX_NAME): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** The legendary uses a token gets from a printed count: at most what an actor holds. */
export function tokenUses(uses: number): number {
  return Math.min(MAX_LEGENDARY_USES, uses);
}

/**
 * A fresh actor for a token made from a stat block: full average HP (or the
 * DM's number), AC, speeds, initiative and senses. `inLair` picks the lair
 * values for legendary actions, Legendary Resistance and XP.
 *
 * Every field fits the actor schema whatever a valid custom monster holds,
 * so a monster the DM could save can always be placed: long lines are cut
 * and legendary uses capped (fitLine, tokenUses).
 */
export function monsterActor(m: StatBlockMonster, options: { hp?: number; inLair?: boolean } = {}): Actor {
  const hp = options.hp ?? m.hp.average;
  const pick = (uses: { uses: number; usesInLair?: number } | undefined) =>
    uses ? tokenUses(options.inLair ? (uses.usesInLair ?? uses.uses) : uses.uses) : 0;
  const actionsMax = pick(m.legendaryActions);
  const resistMax = pick(m.legendaryResistance);
  return {
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac: m.ac,
    speeds: { ...m.speeds },
    initBonus: m.initiative.bonus,
    initScore: m.initiative.score,
    passivePerception: m.passivePerception,
    senses: fitLine(m.senses),
    creatureType: fitLine(m.type),
    cr: m.cr,
    xp: options.inLair ? (m.xpInLair ?? m.xp) : m.xp,
    ...(m.srdId !== undefined ? { srdId: m.srdId } : {}),
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    ...(actionsMax > 0 || resistMax > 0 ? { legendary: { actionsMax, actionsUsed: 0, resistMax, resistUsed: 0 } } : {}),
    notes: "",
    dmNotes: "",
  };
}
