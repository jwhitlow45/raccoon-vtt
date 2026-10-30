import { ABILITY_KEYS, type AbilityKey } from "#shared/model.ts";

/** One ability as a stat block's grid shows it, its numbers as the block's text writes them ("+5", "−1"). */
export type AbilityBox = { key: AbilityKey; score: string; mod: string; save: string; proficient: boolean };

export type SplitBlock = { before: string; abilities: AbilityBox[]; after: string };

const HEADER = /^\|\s*\|\s*Score\s*\|\s*Mod\s*\|\s*Save\s*\|\s*$/;
const RULE = /^\|(\s*-+\s*\|){4}\s*$/;
const ROW = /^\|\s*(Str|Dex|Con|Int|Wis|Cha)\s*\|\s*(\d+)\s*\|\s*([+\-−]\d+)\s*\|\s*([+\-−]\d+)\s*\|\s*$/;

/**
 * A monster block's ability table, read out of its Markdown so the view can
 * draw it three across as a PC's block does (docs/design-v1-dice-ui.md 6.3).
 * The stored text never changes. Only the exact table every block is
 * written with (shared/statBlock.ts, the SRD's own) is read: its header,
 * its rule, and the six abilities in order. Anything else is null, and the
 * block draws as Markdown, table and all.
 *
 * A save that differs from its modifier is the block's proficient save,
 * the one the 2024 block sets apart.
 */
export function splitAbilityTable(text: string): SplitBlock | null {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => HEADER.test(line));
  if (at < 0 || !RULE.test(lines[at + 1] ?? "")) return null;
  const abilities: AbilityBox[] = [];
  for (const [i, key] of ABILITY_KEYS.entries()) {
    const row = ROW.exec(lines[at + 2 + i] ?? "");
    if (!row || row[1]!.toLowerCase() !== key) return null;
    const [, , score, mod, save] = row as unknown as [string, string, string, string, string];
    abilities.push({ key, score, mod, save, proficient: save.replace("−", "-") !== mod.replace("−", "-") });
  }
  const end = at + 2 + ABILITY_KEYS.length;
  // A table cell line straight after the six rows means a table of another shape.
  if ((lines[end] ?? "").startsWith("|")) return null;
  return { before: lines.slice(0, at).join("\n"), abilities, after: lines.slice(end).join("\n") };
}
