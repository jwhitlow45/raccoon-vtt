import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { crValue, filterTest, monsterFacts, NO_FILTERS, type MonsterFilters } from "./monsterFilters.ts";

/**
 * The monster browser's search. Words match the name, the creature type or
 * the size, in any order ("red dragon", "fey goblin", "huge"). A "cr 5" or
 * "cr1/4" term matches that challenge rating exactly, since a plain "5"
 * would also find CR 15 and 1/5 of everything else. "cr 1-5" or
 * "cr 1/2-3" is a range, both ends included, and a range left open at one
 * end ("cr 10-", "cr -1/2") runs to the top or the bottom, so the list
 * stays useful while the second number is still being typed. For the same
 * reason a fraction still being typed reads as its whole number: "cr 1/"
 * on the way to "cr 1/2" is CR 1 until the 2 arrives.
 */

/** A CR term's bounds, or "bad" for one that names no number, such as "cr 1/0", which then matches nothing. */
export type CrTerm = { min: number; max: number } | "bad";

export type ParsedQuery = { cr: CrTerm | null; words: string[] };

/** A whole number or a fraction, which may still lack its denominator ("1/"). */
const CR_NUMBER = String.raw`\d+(?:\/\d*)?`;
/**
 * "cr" with a number, a range, or a range open at one end. Either a hyphen
 * or an en dash joins a range, since some keyboards turn one into the
 * other. The lookahead keeps "cr 5x" and "cr 1//" from reading as CR terms.
 */
const CR_TERM = new RegExp(String.raw`\bcr\s*(?:(${CR_NUMBER})(?:\s*([-–])\s*(${CR_NUMBER})?)?|[-–]\s*(${CR_NUMBER}))(?![\w/])`);

export function parseQuery(query: string): ParsedQuery {
  let rest = query.toLowerCase();
  let cr: CrTerm | null = null;
  const term = CR_TERM.exec(rest);
  if (term) {
    const [whole, from, dash, to, upTo] = term;
    rest = rest.replace(whole, " ");
    if (from === undefined) cr = range(0, typedCr(upTo ?? ""));
    else if (dash === undefined) cr = range(typedCr(from), typedCr(from));
    else cr = range(typedCr(from), to === undefined ? Infinity : typedCr(to));
  }
  return { cr, words: rest.split(/\s+/).filter(Boolean) };
}

/** A typed CR, where "1/" still waiting for its denominator counts as 1. */
function typedCr(text: string): number | null {
  return crValue(text.replace(/\/$/, ""));
}

/** Lowest first, so "cr 5-1" reads as 1 to 5. */
function range(a: number | null, b: number | null): CrTerm {
  if (a === null || b === null) return "bad";
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * The test for a whole list. The query is parsed and the filters read once
 * here, and each monster's facts were read once when it was first seen
 * (monsterFilters.ts), so a keystroke over 330 monsters only compares.
 */
export function monsterMatcher(query: string, filters: MonsterFilters = NO_FILTERS): (m: StatBlockMonster) => boolean {
  const { cr, words } = parseQuery(query);
  if (cr === "bad") return () => false;
  const filtered = filterTest(filters);
  return (m) => {
    const f = monsterFacts(m);
    if (cr !== null && (f.cr === null || f.cr < cr.min || f.cr > cr.max)) return false;
    if (!words.every((word) => f.words.includes(word))) return false;
    return filtered === null || filtered(f);
  };
}
