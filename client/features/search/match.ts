import type { SearchEntry, SearchKind } from "./entry.ts";
import { SMALL_WORDS, SYNONYMS } from "./words.ts";

/**
 * The room search's matcher and ranking (docs/design/design-v1-qol.md 5,
 * Matching), pure, on words folded once when the index is built. It forgives
 * case, accents, apostrophes, word order, plurals, joined words and, from
 * five letters, a typo, and knows the words a table types (words.ts). Nothing
 * here reads how often a result was picked: no typed list ever reorders by
 * use (D-261106-175).
 */

/** Lowercase, accents and apostrophes dropped, anything but letters, digits and `+` to one space. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

export function wordsOf(text: string): string[] {
  const folded = fold(text);
  return folded === "" ? [] : folded.split(" ");
}

/** What the matcher reads of an entry, folded once when the index is built. */
export type Searchable = {
  /** The title's words, and the title folded whole. */
  title: readonly string[];
  titleText: string;
  /** The title's letters without spaces, for a query typed as one word ("longrest"). */
  joined: string;
  /** Each other name folded whole, for a query that is one of them. */
  names: readonly string[];
  /** The other names' words. */
  nameWords: readonly string[];
  /** The value's words: a row shows its value beside its title, so they count as the title's. */
  value: readonly string[];
  /** Where it lives: the weakest field, read only from three typed letters. */
  where: readonly string[];
  /** The best bets, folded whole. */
  bets: readonly string[];
};

export function searchable(entry: Pick<SearchEntry, "title" | "names" | "bets" | "where" | "value">): Searchable {
  const title = wordsOf(entry.title);
  const names = (entry.names ?? []).map(fold).filter((n) => n !== "");
  return {
    title,
    titleText: title.join(" "),
    joined: title.join(""),
    names,
    nameWords: names.flatMap((n) => n.split(" ")),
    value: entry.value ? wordsOf(entry.value) : [],
    where: wordsOf(entry.where),
    bets: (entry.bets ?? []).map(fold).filter((b) => b !== ""),
  };
}

/**
 * How well an entry matches, best first (design-v1-qol.md 5, Matching): one of its best
 * bets typed whole, its whole title, the title's start or another name typed
 * whole, every word in the title, words elsewhere, and last a typo.
 */
export const TIER = { bet: 0, whole: 1, start: 2, title: 3, elsewhere: 4, typo: 5 } as const;
export type Tier = (typeof TIER)[keyof typeof TIER];

/** `cost` orders entries of one tier, after nearness and kind: lower is a closer match. */
export type Match = { tier: Tier; cost: number };

/** One typed word against one word: 0 the word or its plural, 1 its start, 2 inside it, 3 a typo. Null for no match. */
type Grade = 0 | 1 | 2 | 3;

/** The letters a typed word needs before a typo counts, and before two do (D-261106-149). */
export const TYPO_FLOOR = 5;
export const TWO_TYPOS = 8;
/** The letters a typed word needs before it matches inside a word or where an entry lives. */
const INSIDE_FLOOR = 3;
/** What standing for a synonym adds to a word's cost, so the word typed itself always wins a tie. */
const SYNONYM_COST = 2;

/** A query, folded once per keystroke, with the memo of its word grades. */
export type Query = {
  text: string;
  words: readonly string[];
  folded: string;
  joined: string;
  /** Each typed word with the phrases it stands for (words.ts), split once. */
  terms: readonly { typed: string; phrases: readonly (readonly string[])[] }[];
  /** The whole query's phrases, for a one-word query that stands for a whole title. */
  phrases: readonly string[];
  /**
   * Grades by typed word and word. A room holds far fewer different words
   * than entries times words, so each pair's typo distance runs once per
   * keystroke, not once per entry (design-v1-qol.md 5, Size: the p95 keystroke fell
   * from 4.4 ms to 1.3 ms in the prototype's bench).
   */
  memo: Map<string, Map<string, Grade | null>>;
};

export function parseQuery(text: string): Query {
  const words = wordsOf(text);
  const terms = words.map((typed) => ({ typed, phrases: (SYNONYMS[typed] ?? []).map((p) => p.split(" ")) }));
  const phrases = words.length === 1 ? (SYNONYMS[words[0]!] ?? []) : [];
  return { text, words, folded: words.join(" "), joined: words.join(""), terms, phrases, memo: new Map() };
}

function grade(typed: string, word: string, strict: boolean): Grade | null {
  if (word === typed) return 0;
  if (typed.length > 3 && typed.endsWith("s") && word === typed.slice(0, -1)) return 0;
  if (word.startsWith(typed)) return 1;
  if (strict) return null;
  if (typed.length >= INSIDE_FLOOR && word.includes(typed)) return 2;
  // From five letters only: a four-letter word one letter off is too often another word ("conc", "cons").
  if (typed.length >= TYPO_FLOOR) {
    const most = typed.length >= TWO_TYPOS ? 2 : 1;
    if (Math.abs(word.length - typed.length) <= most && distance(typed, word, most) <= most) return 3;
    // A longer word still being typed, with a typo in what is typed so far ("initai" for Initiative).
    if (word.length > typed.length && distance(typed, word.slice(0, typed.length), most) <= most) return 3;
  }
  return null;
}

/** Damerau-Levenshtein distance (an adjacent swap counts one), giving up once every way is past `most`. */
export function distance(a: string, b: string, most: number): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2]! + 1);
      row.push(v);
      low = Math.min(low, v);
    }
    if (low > most) return most + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** The memo's grades of one typed word, found once per field rather than once per word. */
function gradesOf(q: Query, typed: string, strict: boolean): Map<string, Grade | null> {
  const key = strict ? `!${typed}` : typed;
  let byWord = q.memo.get(key);
  if (!byWord) q.memo.set(key, (byWord = new Map()));
  return byWord;
}

function bestIn(q: Query, typed: string, words: readonly string[], strict: boolean): Grade | null {
  if (words.length === 0) return null;
  const grades = gradesOf(q, typed, strict);
  let out: Grade | null = null;
  for (const w of words) {
    let g = grades.get(w);
    if (g === undefined) grades.set(w, (g = grade(typed, w, strict)));
    if (g !== null && (out === null || g < out)) out = g;
    if (out === 0) break;
  }
  return out;
}

/** One typed word's best place in an entry: its cost, whether that place is the title (or the value beside it), and whether it took a typo. */
type Found = { cost: number; title: boolean; typo: boolean };

function better(a: Found | null, b: Found): Found {
  if (!a) return b;
  // A typo loses to any sure match, and a sure match in the title to none elsewhere, since the tier reads both before the cost.
  if (a.typo !== b.typo) return a.typo ? b : a;
  if (a.title !== b.title) return a.title ? a : b;
  return b.cost < a.cost ? b : a;
}

/**
 * Where a typed word matches an entry: in the title (cost by grade), the
 * value (a little dearer), another name (dearer again) or, from three
 * letters, where it lives (dearest). `strict`, for a synonym's words, reads
 * only whole words and starts in the title, the value and the other names.
 */
function wordFound(q: Query, typed: string, s: Searchable, strict: boolean): Found | null {
  let out: Found | null = null;
  const title = bestIn(q, typed, s.title, strict);
  if (title !== null) out = better(out, { cost: title * 3, title: true, typo: title === 3 });
  const value = bestIn(q, typed, s.value, strict);
  if (value !== null) out = better(out, { cost: value * 3 + 1, title: true, typo: value === 3 });
  const name = bestIn(q, typed, s.nameWords, strict);
  if (name !== null) out = better(out, { cost: name * 3 + 1, title: false, typo: name === 3 });
  if (!strict && typed.length >= INSIDE_FLOOR) {
    const where = bestIn(q, typed, s.where, strict);
    if (where !== null) out = better(out, { cost: where * 3 + 2, title: false, typo: where === 3 });
  }
  return out;
}

/** A typed word, or one of the phrases it stands for (words.ts), every word of the phrase matching. */
function termFound(q: Query, term: Query["terms"][number], s: Searchable): Found | null {
  let out = wordFound(q, term.typed, s, false);
  for (const phrase of term.phrases) {
    let found: Found | null = { cost: SYNONYM_COST, title: true, typo: false };
    for (const w of phrase) {
      const f = wordFound(q, w, s, true);
      if (!f) {
        found = null;
        break;
      }
      found = { cost: found.cost + f.cost, title: found.title && f.title, typo: false };
    }
    if (found) out = better(out, found);
  }
  return out;
}

function lower(a: Match | null, tier: Tier, cost: number): Match {
  return !a || tier < a.tier || (tier === a.tier && cost < a.cost) ? { tier, cost } : a;
}

/** How well a query matches an entry, or null for no match. Every word must match, in any order, but a small word may match nothing. */
export function matchEntry(q: Query, s: Searchable): Match | null {
  if (q.words.length === 0) return null;
  if (s.bets.includes(q.folded)) return { tier: TIER.bet, cost: 0 };
  let out: Match | null = null;
  if (s.titleText === q.folded) return { tier: TIER.whole, cost: 0 };
  if (s.titleText.startsWith(q.folded)) out = lower(out, TIER.start, 0);
  if (s.names.includes(q.folded)) out = lower(out, TIER.start, 1);
  // Joined words: "longrest" for Long Rest. The other way round, "dark vision" for Darkvision, matches as a word's start and inside it.
  if (q.words.length === 1 && q.joined.length >= 4) {
    if (s.joined === q.joined) out = lower(out, TIER.start, 0);
    else if (s.joined.startsWith(q.joined)) out = lower(out, TIER.start, 1);
  }
  // A one-word query that stands for a whole title, "ac" for Armor Class, ranks a step below the title typed itself.
  for (const phrase of q.phrases) {
    if (s.titleText === phrase) out = lower(out, TIER.start, SYNONYM_COST);
    else if (s.titleText.startsWith(phrase) && s.titleText[phrase.length] === " ") out = lower(out, TIER.title, SYNONYM_COST);
  }
  if (out && out.tier <= TIER.start) return out;
  let cost = 0;
  let title = true;
  let typo = false;
  let matched = 0;
  for (const term of q.terms) {
    const f = termFound(q, term, s);
    if (!f) {
      if (SMALL_WORDS.has(term.typed)) continue;
      matched = -1;
      break;
    }
    matched++;
    cost += f.cost;
    title &&= f.title;
    typo ||= f.typo;
  }
  if (matched > 0) out = lower(out, typo ? TIER.typo : title ? TIER.title : TIER.elsewhere, cost);
  // Another name's start, "init" for "initiative rules", as weak as a word elsewhere.
  if (q.folded.length >= INSIDE_FLOOR && s.names.some((n) => n.startsWith(q.folded))) out = lower(out, TIER.elsewhere, 0);
  return out;
}

/**
 * Kinds in the order a table reaches for them within one tier
 * (design-v1-qol.md 5, Matching): what is done in play, then the room's
 * things, then where things live, then setup.
 */
export const KIND_GROUP: Readonly<Record<SearchKind, number>> = {
  action: 0,
  key: 0,
  panel: 0,
  dice: 0,
  field: 1,
  token: 1,
  character: 1,
  condition: 1,
  section: 2,
  scene: 2,
  floor: 1,
  playlist: 2,
  track: 2,
  page: 2,
  handout: 2,
  setting: 3,
  monster: 3,
};

/** An entry ready to match: the entry and its folded words. */
export type Indexed = { entry: SearchEntry; s: Searchable };

export function indexed(entry: SearchEntry): Indexed {
  return { entry, s: searchable(entry) };
}

/** The most rows a typed query lists (design-v1-qol.md 5, The results). */
export const MAX_ROWS = 40;

const titles = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type Hit = { item: Indexed; m: Match };

function byRank(a: Hit, b: Hit): number {
  const x = a.item.entry;
  const y = b.item.entry;
  return (
    a.m.tier - b.m.tier ||
    Number(y.near ?? false) - Number(x.near ?? false) ||
    KIND_GROUP[x.kind] - KIND_GROUP[y.kind] ||
    a.m.cost - b.m.cost ||
    x.title.length - y.title.length ||
    titles.compare(x.title, y.title) ||
    titles.compare(x.where, y.where) ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
  );
}

/**
 * The entries a query finds, best first, at most `limit`. A typo's guesses
 * show only where nothing matched without one (D-261106-149). Equal rows
 * always keep one order, the id last.
 */
export function rank(items: readonly Indexed[], q: Query, limit = MAX_ROWS): SearchEntry[] {
  const hits: Hit[] = [];
  let sure = false;
  for (const item of items) {
    const m = matchEntry(q, item.s);
    if (!m) continue;
    hits.push({ item, m });
    if (m.tier !== TIER.typo) sure = true;
  }
  const kept = sure ? hits.filter((h) => h.m.tier !== TIER.typo) : hits;
  kept.sort(byRank);
  return kept.slice(0, limit).map((h) => h.item.entry);
}
