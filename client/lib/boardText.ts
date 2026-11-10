import type { BoardSizes } from "./boardScale.ts";
import { countText, labelSuffix, type NameTag } from "./labels.ts";

/**
 * Where each token's name and HP go on the board, and what gives way when
 * the board is crowded (option C of the 2026-10-14 review). Pure, so it
 * runs under plain Node tests with a fake measure.
 *
 * The rules, in the order they bind:
 *
 * - Text that fits is never cut. A name is whole on one line, whole on two
 *   balanced lines, or cut once on one line keeping what follows it (a
 *   duplicate's number, a DM's bracketed preview or a disguise's shown name)
 *   and at least four letters ("Kobold… 4"). A disguise's shown name that
 *   still does not fit is cut inside, before its number ("Orc (as Gob… 2)").
 *   Never a shorter fragment: below that, the token's own initials or number
 *   badge name it.
 * - No label covers another token's body, chips, badge or HP bar, the move
 *   marker, an area's name, a label written on the map, or a label placed
 *   before it, at any zoom. Map labels keep their place: a token's label
 *   moves or gives way instead. Only
 *   the focus plate of a selected or hovered token may cover the board.
 * - Labels are placed one at a time, most important first. A label tries
 *   below its token, then above it (the acting creature also tries its
 *   sides), and gives up its HP before its name. A creature that is
 *   Bloodied or Dying keeps that word alone before its name alone, so the
 *   word a table reads in a fight outlasts the name, which the token's
 *   initials or number badge and a tap still give.
 * - A label keeps the shape and side it had on the last layout while they
 *   still fit, and takes another only when that one clearly fits, so a
 *   pinch does not make labels jump between frames (KEEP_CLEARANCE_PX).
 *   Its shape (where the name wraps, whether the HP shares its line) is
 *   decided at one fixed size (SHAPE_PX), so a pinch does not wrap it back
 *   and forth.
 */

/** Width in screen pixels of `text` at font size `px`. */
export type Measure = (text: string, px: number) => number;

export type Box = { x0: number; y0: number; x1: number; y1: number };

export type LabelLine = { text: string; px: number; kind: "name" | "hp" };

export type LabelStyle = {
  namePx: number;
  hpPx: number;
  /** Line advance as a multiple of the font size. */
  leading: number;
  /** On screen, the widest a cut name grows into free room. */
  maxWidth: number;
  /** The halo's reach on each side, outside the measured text. */
  padX: number;
  /** Clearance kept between a label and anything it keeps off. */
  gapPx: number;
  room: Room;
  /** The most the text size moves at one rounding step of a zoom (boardScale.ts). */
  stepPx: number;
};

/**
 * The room a label's text has, in ems of the name's size before rounding
 * (boardScale.ts), the halo left out. Its shape is decided against this at
 * SHAPE_PX.
 */
export type Room = {
  /** Lines wrap at this width when the whole name fits that way, so a label stays close to its token. */
  wrapEm: number;
  /** The widest a line gets before the name is cut instead. */
  maxEm: number;
  /** The token's width and a gap each side: the name shares a line with its HP ("Thorn · 18/24") while that line fits. */
  ownEm: number;
};

/**
 * The size every label's shape is decided at. Drawn text sizes are rounded
 * to half pixels, so text grows in steps of about 4% while a token and its
 * gaps grow smoothly with the zoom. A name measured at its drawn size
 * against those widths could cross its wrap back and forth at every step of
 * one smooth zoom. Measured here instead, against room given in ems of the
 * unrounded size, the shape depends only on that room. The room holds still
 * while the text scales with the zoom, and only grows with the zoom while
 * the text is held at its floor or ceiling, so a zoom one way crosses each
 * wrap once. One fixed size also keeps the choice clear of a font's hinting,
 * whose widths do not scale exactly with the size, and measures each string
 * once instead of at every half-pixel step. The chosen lines are then drawn,
 * measured and placed at the drawn size.
 */
export const SHAPE_PX = 100;
/** The halo's reach as a share of the font size, before rounding up to whole pixels. */
const HALO_EM = 1 / 8;
const LEADING = 1.17;

/**
 * Room is kept to 1/1024 em, so float error in a ratio that holds still
 * while the zoom scales cannot flip a name sitting exactly on its wrap, and
 * the shape cache keeps hitting there.
 */
const ems = (v: number) => Math.round(v * 1024) / 1024;

/** A token's label style at a zoom, for a token `tokenPx` wide on screen. */
export function labelStyle(
  sizes: Pick<BoardSizes, "namePx" | "hpPx" | "gapPx" | "stepPx"> & { unrounded: Pick<BoardSizes["unrounded"], "namePx" | "gapPx"> },
  tokenPx: number,
  cellPx: number,
): LabelStyle {
  const u = sizes.unrounded;
  return {
    namePx: sizes.namePx,
    hpPx: sizes.hpPx,
    leading: LEADING,
    maxWidth: 15 * sizes.namePx,
    padX: Math.ceil(sizes.namePx * HALO_EM),
    gapPx: sizes.gapPx,
    stepPx: sizes.stepPx,
    room: {
      wrapEm: ems(Math.max((tokenPx + cellPx) / u.namePx, 10) - 2 * HALO_EM),
      maxEm: 15 - 2 * HALO_EM,
      ownEm: ems((tokenPx + 2 * u.gapPx) / u.namePx - 2 * HALO_EM),
    },
  };
}

/** The widest box a label in this style can draw: a whole name wraps to `wrapEm`, which grows with the token, and no shape passes `maxWidth`. */
export function widestLabel(style: Pick<LabelStyle, "maxWidth" | "namePx" | "padX" | "room">): number {
  return Math.max(style.maxWidth, style.room.wrapEm * style.namePx + 2 * style.padX) + 2;
}

/** The focus plate's style: the focus sizes, up to 16 ems a line, on a plate padded 6 px each side, the HP always on its own line. */
export function focusStyle(sizes: Pick<BoardSizes, "focusNamePx" | "focusHpPx" | "gapPx" | "stepPx" | "unrounded">): LabelStyle {
  const padX = 6;
  const maxEm = ems(16 - (2 * padX) / sizes.unrounded.focusNamePx);
  return {
    namePx: sizes.focusNamePx,
    hpPx: sizes.focusHpPx,
    leading: LEADING,
    maxWidth: 16 * sizes.focusNamePx,
    padX,
    gapPx: sizes.gapPx,
    stepPx: sizes.stepPx,
    room: { wrapEm: maxEm, maxEm, ownEm: 0 },
  };
}

export type Side = "below" | "above" | "right" | "left";

export type LabelInput = {
  id: string;
  /** The token's footprint on screen. */
  box: Box;
  /** Where a label below starts (under the HP bar) and where a label above ends (over the chips), in screen pixels. */
  belowY: number;
  aboveY: number;
  name: string;
  /** What follows the name (labels.ts): a number, a DM's preview, a disguise's shown name. */
  tag?: NameTag;
  /** The HP text this viewer sees: numbers, or a word. Null when they see none. */
  hp: string | null;
  /** Bloodied or Dying, from what this viewer may know of the creature's HP. */
  alert: boolean;
  /** Higher places first: the selected token 3, the acting creature 2, the party and your own tokens 1, the rest 0. A hover never changes it. */
  rank: number;
  /** The acting creature's label may move beside its token when above and below are taken. */
  sides: boolean;
  /** The highest a label beside the token may start: under its own chips and badge. */
  sideTopY?: number;
  /** A token too small on screen for its HP line: only its name may show. */
  nameOnly: boolean;
  style: LabelStyle;
};

export type PlacedLabel = {
  lines: LabelLine[];
  /** The label's box on screen, its halo included. Empty when nothing shows. */
  box: Box;
  side: Side;
  nameShown: boolean;
  hpShown: boolean;
  cut: boolean;
  /** The text it was laid out from, so the next layout can tell a renamed token or new HP from a zoom. */
  source: string;
};

const ELLIPSIS = "…";
/** Letters a cut name keeps at the least: fewer say less than the token's own initials. */
export const MIN_CUT_LETTERS = 4;
/**
 * Letters a disguise's shown name keeps when it is cut inside its brackets.
 * The real name before it already says which creature this is, so the
 * shown name may give way further than a name does ("Orc (as Gob… 2)").
 */
export const MIN_AS_LETTERS = 3;

export function lineHeight(px: number, leading: number): number {
  return Math.round(px * leading);
}

/** The full name as the board shows it: "Goblin 3", "Goblin (3)", "Orc (as Goblin 2)". */
export function fullName(name: string, tag: NameTag | undefined): string {
  return tag === undefined ? name : `${name}${labelSuffix(tag)}`;
}

/**
 * What follows a name, in the units a wrap keeps whole: a number "2" or a
 * preview "(3)" as one unit, and a disguise as its words, "(as" glued to
 * the first and the number and closing bracket to the last, so no line
 * ends on "(as" and the number never stands alone.
 */
function tagUnits(tag: NameTag | undefined): string[] {
  if (tag === undefined) return [];
  const count = countText(tag);
  if (tag.as === undefined) return count ? [count] : [];
  const words = tag.as.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [`(as${count ? ` ${count}` : ""})`];
  words[0] = `(as ${words[0]}`;
  words[words.length - 1] = `${words[words.length - 1]}${count ? ` ${count}` : ""})`;
  return words;
}

/**
 * A name wrapped whole into at most `maxLines` lines of `width`, or null
 * when it does not fit whole. The number of a numbered duplicate is never
 * broken: it rides on the last word's line when the two fit together
 * ("Sorcerer 4"), and moves to the next line whole when they do not. A
 * disguise's bracket wraps between its words (tagUnits) and never breaks
 * inside one. A
 * word wider than a line breaks with a hyphen after a letter, never after
 * a digit or a space, and only when the whole name then fits. Lines are
 * balanced when no word broke, so a centered label reads as a block
 * ("Owlbear Matriarch" over "of the Thornwood") and takes less room from
 * its neighbors.
 */
export function wrapWhole(name: string, tag: NameTag | undefined, width: number, maxLines: number, px: number, measure: Measure): string[] | null {
  const fits = (t: string) => measure(t, px) <= width;
  const units: { text: string; breakable: boolean }[] = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, breakable: true }));
  const tail = tagUnits(tag);
  if (tail.length === 1 && tag?.as === undefined) {
    const suffix = tail[0]!;
    const last = units[units.length - 1];
    if (last && fits(`${last.text} ${suffix}`)) units[units.length - 1] = { text: `${last.text} ${suffix}`, breakable: false };
    else units.push({ text: suffix, breakable: false });
  } else {
    for (const text of tail) units.push({ text, breakable: false });
  }
  if (units.length === 0) return null;
  const lines: string[] = [];
  let cur = "";
  let broke = false;
  for (const unit of units) {
    const joined = cur ? `${cur} ${unit.text}` : unit.text;
    if (fits(joined)) {
      cur = joined;
      continue;
    }
    if (cur) lines.push(cur);
    cur = unit.text;
    while (!fits(cur)) {
      if (!unit.breakable) return null;
      const chars = [...cur];
      let n = chars.length - 1;
      while (n > 1 && !(fits(`${chars.slice(0, n).join("")}-`) && /\p{L}/u.test(chars[n - 1]!))) n--;
      if (n <= 1) return null;
      broke = true;
      lines.push(`${chars.slice(0, n).join("")}-`);
      cur = chars.slice(n).join("");
    }
    if (lines.length >= maxLines) return null;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) return null;
  return broke ? lines : balanced(units.map((u) => u.text), lines, width, px, measure);
}

/**
 * `units` rewrapped into no more lines than `lines` at the narrowest width
 * that still needs no more, as CSS `text-wrap: balance` does. A unit (a
 * word, or the last word with its number) is never split. The search runs
 * over whole pixels below `width`, which may be fractional, so it starts
 * from the lines already found at `width` itself: a width floored below a
 * word's own must never turn valid lines into one too wide.
 */
function balanced(units: string[], lines: string[], width: number, px: number, measure: Measure): string[] {
  const count = lines.length;
  const greedy = (w: number): string[] | null => {
    const out: string[] = [];
    let cur = "";
    for (const unit of units) {
      const joined = cur ? `${cur} ${unit}` : unit;
      if (measure(joined, px) <= w) cur = joined;
      else {
        if (!cur || measure(unit, px) > w) return null;
        out.push(cur);
        cur = unit;
      }
    }
    if (cur) out.push(cur);
    return out.length <= count ? out : null;
  };
  let lo = 1;
  let hi = Math.floor(width);
  let best = lines;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const attempt = greedy(mid);
    if (attempt) {
      best = attempt;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}

/**
 * The name cut once on one line: as many letters as fit, an ellipsis, and
 * what follows the name ("Kobold Sc… 4", "Goblin Wa… (3)", "Bartholo…").
 * A disguise's shown name is cut only once the name is down to its least
 * (`shortestName`), keeping MIN_AS_LETTERS letters and its number
 * ("Orc (as Gob… 2)"). Null when not even that fits.
 */
export function cutName(name: string, tag: NameTag | undefined, width: number, px: number, measure: Measure): string | null {
  const suffix = tag === undefined ? "" : labelSuffix(tag);
  const outer = longestCut([...name.trim()], MIN_CUT_LETTERS, (head) => `${head}${ELLIPSIS}${suffix}`, width, px, measure);
  if (outer !== null || tag?.as === undefined) return outer;
  const count = countText(tag);
  const lead = `${shortestName(name, px, measure)} (as `;
  return longestCut([...tag.as.trim()], MIN_AS_LETTERS, (head) => `${lead}${head}${ELLIPSIS}${count ? ` ${count}` : ""})`, width, px, measure);
}

/** The longest cut of `chars` that `make` turns into text within `width`, keeping at least `least` letters, or null. */
function longestCut(chars: readonly string[], least: number, make: (head: string) => string, width: number, px: number, measure: Measure): string | null {
  const text = (n: number) => make(chars.slice(0, n).join("").trimEnd());
  const letters = (n: number) => chars.slice(0, n).filter((c) => /\S/.test(c)).length;
  let lo = 1;
  let hi = chars.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measure(text(mid), px) <= width) {
      if (letters(mid) >= least) best = text(mid);
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** A name at its least before a disguise's bracket is cut: its shortest allowed cut, or the whole name where that is narrower. */
function shortestName(name: string, px: number, measure: Measure): string {
  const whole = name.trim();
  const chars = [...whole];
  let n = 0;
  let letters = 0;
  while (n < chars.length && letters < MIN_CUT_LETTERS) {
    if (/\S/.test(chars[n]!)) letters++;
    n++;
  }
  if (n >= chars.length) return whole;
  const cut = `${chars.slice(0, n).join("").trimEnd()}${ELLIPSIS}`;
  return measure(cut, px) < measure(whole, px) ? cut : whole;
}

export type Content = { lines: LabelLine[]; nameShown: boolean; hpShown: boolean; cut: boolean };

/** A label's possible content: fixed lines, or the name cut to whatever room is free beside them. */
export type Template = { kind: "lines"; content: Content } | { kind: "cut"; hp: LabelLine | null; widest: string | null };

/**
 * What a label may show, richest first, in levels: each level is one
 * content (the whole name and HP, say) in the shapes it may take, and
 * placement tries every shape of a level on one side before the next side,
 * so a label stays under its token as one line before it moves over it as
 * two. Whole names come before cut ones. Ordinary HP gives way before the
 * name. A Bloodied or Dying creature keeps its word with a cut name, then
 * the word alone, before its name alone.
 */
export function templates(input: LabelInput, measure: Measure): Template[][] {
  // A pinch lays every label out on every frame, mostly with the same text at the same sizes, so the shapes are kept.
  const s0 = input.style;
  const r0 = s0.room;
  const key = [input.name, tagKey(input.tag), input.nameOnly ? null : input.hp, input.alert, s0.namePx, s0.hpPx, r0.wrapEm, r0.maxEm, r0.ownEm].join("\u0000");
  let byMeasure = templateCache.get(measure);
  if (!byMeasure) templateCache.set(measure, (byMeasure = new Map()));
  const hit = byMeasure.get(key);
  if (hit) return hit;
  if (byMeasure.size >= 4000) byMeasure.clear();
  const made = makeTemplates(input, measure);
  byMeasure.set(key, made);
  return made;
}

const templateCache = new WeakMap<Measure, Map<string, Template[][]>>();

/** A tag as a cache key: its text, which tells every tag apart. */
function tagKey(tag: NameTag | undefined): string {
  return tag === undefined ? "" : labelSuffix(tag);
}

function makeTemplates(input: LabelInput, measure: Measure): Template[][] {
  const s = input.style;
  const room = s.room;
  const name = (text: string): LabelLine => ({ text, px: s.namePx, kind: "name" });
  const full = fullName(input.name, input.tag);
  const wholeForms: string[][] = [];
  const seen = new Set<string>();
  for (const [em, maxLines] of [
    [room.wrapEm, 1],
    [room.wrapEm, 2],
    [room.maxEm, 1],
    [room.maxEm, 2],
  ] as const) {
    const lines = wrapWhole(input.name, input.tag, Math.max(0, em) * SHAPE_PX, maxLines, SHAPE_PX, measure);
    const key = lines?.join("\n");
    if (lines && key !== undefined && !seen.has(key)) {
      seen.add(key);
      wholeForms.push(lines);
    }
  }
  const hp = input.nameOnly ? null : input.hp;
  const hpLine: LabelLine | null = hp ? { text: hp, px: s.hpPx, kind: "hp" } : null;
  // The longest cut the width rule allows, decided like a shape, so a font whose widths do not scale with its size cannot move it at each step.
  const widest = cutName(input.name, input.tag, Math.max(0, room.maxEm) * SHAPE_PX, SHAPE_PX, measure);
  const out: Template[][] = [];
  const shape = (lines: LabelLine[], nameShown: boolean, hpShown: boolean): Template => ({ kind: "lines", content: { lines, nameShown, hpShown, cut: false } });

  if (hpLine) {
    // "Thorn · 18/24" on one line while it stays over its own token, else the HP under the name, which takes less from neighbors.
    const one = `${full} · ${hpLine.text}`;
    const oneEm = measure(one, SHAPE_PX) / SHAPE_PX;
    const whole: Template[] = [];
    if (oneEm <= room.ownEm) whole.push(shape([name(one)], true, true));
    for (const lines of wholeForms) whole.push(shape([...lines.map(name), hpLine], true, true));
    if (oneEm > room.ownEm && oneEm <= room.maxEm) whole.push(shape([name(one)], true, true));
    out.push(whole);
    if (input.alert) {
      out.push([{ kind: "cut", hp: hpLine, widest }]);
      out.push([shape([hpLine], false, true)]);
    }
  }
  out.push(wholeForms.map((lines) => shape(lines.map(name), true, false)));
  out.push([{ kind: "cut", hp: null, widest }]);
  return out.filter((level) => level.length > 0);
}

export function linesSize(lines: readonly LabelLine[], style: Pick<LabelStyle, "padX" | "leading">, measure: Measure): { width: number; height: number } {
  if (lines.length === 0) return { width: 0, height: 0 };
  return {
    width: Math.max(...lines.map((l) => measure(l.text, l.px))) + 2 * style.padX,
    height: lines.reduce((h, l) => h + lineHeight(l.px, style.leading), 0),
  };
}

function boxAt(input: LabelInput, side: Side, width: number, height: number): Box {
  const cx = (input.box.x0 + input.box.x1) / 2;
  const cy = (input.box.y0 + input.box.y1) / 2;
  const gap = input.style.gapPx;
  // A side label is centered on its token, but never higher than the bottom of its own chips, which can run past a small token's edge.
  const sideY0 = Math.max(cy - height / 2, input.sideTopY ?? Number.NEGATIVE_INFINITY);
  switch (side) {
    case "below":
      return { x0: cx - width / 2, y0: input.belowY, x1: cx + width / 2, y1: input.belowY + height };
    case "above":
      return { x0: cx - width / 2, y0: input.aboveY - height, x1: cx + width / 2, y1: input.aboveY };
    case "right":
      return { x0: input.box.x1 + gap, y0: sideY0, x1: input.box.x1 + gap + width, y1: sideY0 + height };
    case "left":
      return { x0: input.box.x0 - gap - width, y0: sideY0, x1: input.box.x0 - gap, y1: sideY0 + height };
  }
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function grow(b: Box, by: number): Box {
  return { x0: b.x0 - by, y0: b.y0 - by, x1: b.x1 + by, y1: b.y1 + by };
}

/**
 * What a label keeps off: a token's body or one of its marks, another
 * layer's pill, or a label the DM wrote on the map. `owner` is the token it
 * belongs to.
 */
export type Obstacle = { box: Box; owner?: string; kind: "body" | "mark" | "pill" | "map" };

/**
 * How firmly a label holds the shape it showed on the last layout. Text
 * grows with the zoom in rounding steps, about 4% at a time, while the
 * room between tokens grows smoothly. So beside a neighbor, a shape that
 * fit before a step could miss after it and fit again within the step, at
 * every step of one smooth zoom. A shown shape is kept while it fits with
 * KEEP_CLEARANCE_PX of clearance instead of the full gap, and another
 * replaces it only when that one fits with room to spare for a step's jump
 * as well (`clearly` in placeLabels). The band between the two is wider
 * than a step, so a label changes only on a real change: the zoom moving
 * on past the band, a token moving, a neighbor coming or going, or its own
 * text changing, which lays it out afresh. A label never overlaps anything
 * either way, and a hidden one shows again only where a shape clearly fits.
 */
const KEEP_CLEARANCE_PX = 0;
/** The spare height a change asks for, in text steps: a step moves each line's rounded height and the marks above it. */
const STEP_Y = 4;

/**
 * Places every label, most important first: rank, then a Bloodied or Dying
 * creature, then the bigger creature, then the shorter name, then the id,
 * so the order never depends on how the tokens happen to be listed or on
 * the zoom. Sizes compare to the square pixel, since boxes of one size
 * differ by float error with where they stand, and that error reordered a
 * pack at every frame of a zoom. Names compare at SHAPE_PX, which a
 * font's hinting does not reorder.
 *
 * `obstacles` holds every visible token's body (tiny ones too, which have
 * no label of their own) and marks, and the other layers' pills. A label
 * keeps off all of them but its own body. `previous` is the last layout's
 * result, whose shapes and sides hold as KEEP_CLEARANCE_PX says. `within`
 * is the screen's left and right in the same pixels, where the viewer has one.
 */
export function placeLabels(
  inputs: readonly LabelInput[],
  obstacles: readonly Obstacle[],
  measure: Measure,
  previous?: ReadonlyMap<string, PlacedLabel>,
  within?: Pick<Box, "x0" | "x1">,
): Map<string, PlacedLabel> {
  const natural = new Map(inputs.map((input) => [input.id, measure(fullName(input.name, input.tag), SHAPE_PX)]));
  const order = [...inputs].sort(
    (a, b) =>
      b.rank - a.rank ||
      Number(b.alert) - Number(a.alert) ||
      Math.round(area(b.box) - area(a.box)) ||
      natural.get(a.id)! - natural.get(b.id)! ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const placed: Box[] = [];
  const out = new Map<string, PlacedLabel>();
  for (const input of order) {
    const s = input.style;
    const gap = s.gapPx;
    const free = (box: Box, clearance: number) => {
      // A label stays between the screen's sides, so a long name beside the edge is cut with an ellipsis or goes to another side, never cut off by the screen.
      if (within && (box.x0 < within.x0 || box.x1 > within.x1)) return false;
      const probe = grow(box, clearance);
      return !placed.some((p) => overlaps(probe, p)) && !obstacles.some((o) => !(o.kind === "body" && o.owner === input.id) && overlaps(probe, o.box));
    };
    const fits: Fits = (box) => free(box, gap);
    const still: Fits = (box) => free(box, KEEP_CLEARANCE_PX);
    // Spare room for one step's jump of this text and the text beside it, since a step widens a text by stepPx for each em of its
    // width, half on each side. None from the label's own token, whose marks it sits against by design.
    const clearly: Fits = (box) => {
      if (within && (box.x0 < within.x0 || box.x1 > within.x1)) return false;
      const probe = grow(box, gap);
      const selfEm = (box.x1 - box.x0) / s.namePx;
      const off = (other: Box, otherEm: number) => {
        const x = ((selfEm + otherEm) * s.stepPx) / 2;
        const y = STEP_Y * s.stepPx;
        return overlaps({ x0: probe.x0 - x, y0: probe.y0 - y, x1: probe.x1 + x, y1: probe.y1 + y }, other);
      };
      return !placed.some((p) => off(p, (p.x1 - p.x0) / s.namePx)) && !obstacles.some((o) => (o.owner === input.id ? o.kind !== "body" && overlaps(probe, o.box) : off(o.box, 0)));
    };
    const sides: Side[] = input.sides ? ["below", "above", "right", "left"] : ["below", "above"];
    const levels = templates(input, measure);
    const source = [input.name, tagKey(input.tag), input.nameOnly ? null : input.hp, input.alert].join("\u0000");
    const last = previous?.get(input.id);
    const kept = last?.source === source ? last : undefined;
    const keptSide = kept && kept.lines.length > 0 && sides.includes(kept.side) ? kept.side : undefined;
    const tryOrder = keptSide ? [keptSide, ...sides.filter((side) => side !== keptSide)] : sides;
    const at = (content: Content, side: Side): PlacedLabel => {
      const size = linesSize(content.lines, s, measure);
      return { ...content, box: boxAt(input, side, size.width, size.height), side, source };
    };
    /** The first shape that fits in the order shapes are preferred, or only those before `until`. */
    const search = (test: Fits, until?: ShapeAt): PlacedLabel | null => {
      for (const [l, level] of levels.entries()) {
        for (const [i, side] of tryOrder.entries()) {
          for (const [t, template] of level.entries()) {
            // The kept side comes first, so everything preferred to the kept shape comes before it here.
            if (until && l === until.level && i === 0 && t === until.template) return null;
            const content = template.kind === "lines" ? template.content : cutToRoom(input, template, side, test, measure);
            if (!content) continue;
            const label = at(content, side);
            if (test(label.box)) return label;
          }
        }
      }
      return null;
    };
    let result: PlacedLabel | null;
    if (!kept) result = search(fits);
    else if (!keptSide) result = kept.lines.length === 0 ? search(clearly) : search(fits);
    else {
      const shape = keptShape(input, levels, kept);
      if (!shape) result = search(fits);
      else {
        const longer = shape.cut ? cutToRoom(input, shape.cut, keptSide, clearly, measure) : null;
        const same = at(shape.content, keptSide);
        result =
          search(clearly, shape) ??
          (longer && [...longer.lines[0]!.text].length > [...shape.content.lines[0]!.text].length ? at(longer, keptSide) : null) ??
          (still(same.box) ? same : null) ??
          search(fits);
      }
    }
    if (!result) {
      out.set(input.id, { lines: [], box: { x0: 0, y0: 0, x1: 0, y1: 0 }, side: "below", nameShown: false, hpShown: false, cut: false, source });
      continue;
    }
    placed.push(result.box);
    out.set(input.id, result);
  }
  return out;
}

type Fits = (box: Box) => boolean;

/** Where the kept shape sits among a label's templates, and its content at the current sizes. */
type ShapeAt = { level: number; template: number; content: Content; cut: Extract<Template, { kind: "cut" }> | null };

/**
 * The last layout's shape among this layout's templates, or null when the
 * label's text changed so that it is no longer one of them. A cut name
 * matches the cut it came from while it is still a cut of the same name.
 */
function keptShape(input: LabelInput, levels: Template[][], kept: PlacedLabel): ShapeAt | null {
  const sameLine = (a: LabelLine, b: LabelLine) => a.text === b.text && a.kind === b.kind;
  for (const [level, templatesAt] of levels.entries()) {
    for (const [template, t] of templatesAt.entries()) {
      if (t.kind === "lines") {
        const lines = t.content.lines;
        if (!kept.cut && lines.length === kept.lines.length && lines.every((line, i) => sameLine(line, kept.lines[i]!))) return { level, template, content: t.content, cut: null };
        continue;
      }
      const [name, hp, ...rest] = kept.lines;
      if (!kept.cut || !name || name.kind !== "name" || rest.length > 0 || (hp?.text ?? null) !== (t.hp?.text ?? null) || !isCutOf(name.text, input)) continue;
      if (!t.widest || [...name.text].length > [...t.widest].length) continue;
      const lines: LabelLine[] = [{ text: name.text, px: input.style.namePx, kind: "name" }];
      if (t.hp) lines.push(t.hp);
      return { level, template, content: { lines, nameShown: true, hpShown: !!t.hp, cut: true }, cut: t };
    }
  }
  return null;
}

/** Whether `text` is a cut of the label's name as cutName makes them: the name cut, or a disguise's shown name cut after the name at its least. */
function isCutOf(text: string, input: Pick<LabelInput, "name" | "tag">): boolean {
  const name = input.name.trim();
  const tail = `${ELLIPSIS}${input.tag === undefined ? "" : labelSuffix(input.tag)}`;
  if (text.endsWith(tail) && isHeadOf(text.slice(0, text.length - tail.length), name, MIN_CUT_LETTERS)) return true;
  const as = input.tag?.as?.trim();
  if (as === undefined) return false;
  const count = countText(input.tag!);
  const close = `${ELLIPSIS}${count ? ` ${count}` : ""})`;
  if (!text.endsWith(close)) return false;
  const open = text.indexOf(" (as ");
  if (open < 0) return false;
  const lead = text.slice(0, open);
  const leadOk = lead === name || (lead.endsWith(ELLIPSIS) && isHeadOf(lead.slice(0, -ELLIPSIS.length), name, MIN_CUT_LETTERS));
  return leadOk && isHeadOf(text.slice(open + 5, text.length - close.length), as, MIN_AS_LETTERS);
}

/** Whether `head` begins `whole`, shorter than it, with at least `least` letters. */
function isHeadOf(head: string, whole: string, least: number): boolean {
  return head.length < whole.length && whole.startsWith(head) && [...head].filter((c) => /\S/.test(c)).length >= least;
}

/**
 * The name cut to the widest room free on `side`, with the template's HP
 * under it if any: the box grows until it would touch something, and the
 * cut keeps to the template's widest. Null when not even MIN_CUT_LETTERS
 * letters fit.
 */
function cutToRoom(input: LabelInput, template: Extract<Template, { kind: "cut" }>, side: Side, free: (box: Box) => boolean, measure: Measure): Content | null {
  const { hp, widest } = template;
  if (!widest) return null;
  const s = input.style;
  const nameH = lineHeight(s.namePx, s.leading);
  const height = nameH + (hp ? lineHeight(hp.px, s.leading) : 0);
  const least = minCutWidth(input, measure);
  if (least === null) return null;
  const floor = Math.max(least, hp ? measure(hp.text, hp.px) : 0) + 2 * s.padX;
  if (floor > s.maxWidth || !free(boxAt(input, side, floor, height))) return null;
  let lo = floor;
  let hi = s.maxWidth;
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2;
    if (free(boxAt(input, side, mid, height))) lo = mid;
    else hi = mid;
  }
  const roomy = cutName(input.name, input.tag, lo - 2 * s.padX, s.namePx, measure);
  if (!roomy) return null;
  const text = [...roomy].length > [...widest].length ? widest : roomy;
  const lines: LabelLine[] = [{ text, px: s.namePx, kind: "name" }];
  if (hp) lines.push(hp);
  return { lines, nameShown: true, hpShown: !!hp, cut: true };
}

/**
 * The width of the shortest cut a label allows, or null when it allows
 * none: four letters, the ellipsis and what follows the name, or for a
 * disguise its shown name cut to three letters after the name at its least.
 */
function minCutWidth(input: LabelInput, measure: Measure): number | null {
  const px = input.style.namePx;
  const widths: number[] = [];
  const head = leastHead(input.name, MIN_CUT_LETTERS);
  if (head !== null) widths.push(measure(`${head}${ELLIPSIS}${input.tag === undefined ? "" : labelSuffix(input.tag)}`, px));
  const as = input.tag?.as;
  const asHead = as === undefined ? null : leastHead(as, MIN_AS_LETTERS);
  if (asHead !== null) {
    const count = countText(input.tag!);
    widths.push(measure(`${shortestName(input.name, px, measure)} (as ${asHead}${ELLIPSIS}${count ? ` ${count}` : ""})`, px));
  }
  return widths.length === 0 ? null : Math.min(...widths);
}

/** The first `least` letters of `text`, or null when that is all of it, so no cut is shorter than the whole. */
function leastHead(text: string, least: number): string | null {
  const chars = [...text.trim()];
  let n = 0;
  let letters = 0;
  while (n < chars.length && letters < least) {
    if (/\S/.test(chars[n]!)) letters++;
    n++;
  }
  return n >= chars.length ? null : chars.slice(0, n).join("").trimEnd();
}

/**
 * A numbered token with a picture shows its number on its body when its
 * label shows no name: a pack of goblins sharing one picture is otherwise
 * told apart only by a tap. A body without a picture already shows its
 * initials with the number ("G3"). Too small a token has no room for it.
 * `number` is the badge's (labels.ts badgeNumber): a DM's preview shows
 * too, outlined.
 */
export function showsNumberBadge(token: { image: boolean; number: number | undefined; widthPx: number }, label: Pick<PlacedLabel, "nameShown"> | undefined): boolean {
  return token.image && token.number !== undefined && token.widthPx >= 20 && !label?.nameShown;
}

function area(b: Box): number {
  return (b.x1 - b.x0) * (b.y1 - b.y0);
}

/**
 * The selected or hovered token's whole label for its focus plate: the
 * name wrapped onto up to three lines (cut on the last only if it still
 * does not fit, since the action bar's header is the full reveal), then its
 * HP. Shaped at SHAPE_PX like a label.
 */
export function focusLines(input: Pick<LabelInput, "name" | "tag" | "hp" | "style">, measure: Measure): LabelLine[] {
  const s = input.style;
  const width = s.room.maxEm * SHAPE_PX;
  const name = (text: string): LabelLine => ({ text, px: s.namePx, kind: "name" });
  let lines = wrapWhole(input.name, input.tag, width, 3, SHAPE_PX, measure);
  if (!lines) {
    // The name's own lines lead, and the last carries the rest of it cut with all that follows it, so the number is never lost.
    const own = wrapWhole(input.name, undefined, width, Number.MAX_SAFE_INTEGER, SHAPE_PX, measure) ?? [input.name.trim()];
    const lead = own.slice(0, Math.min(2, own.length - 1));
    const base = own.slice(lead.length).join(" ");
    const suffix = input.tag === undefined ? "" : labelSuffix(input.tag);
    const last = cutName(base, input.tag, width, SHAPE_PX, measure) ?? `${[...base].slice(0, MIN_CUT_LETTERS).join("")}${ELLIPSIS}${suffix}`;
    lines = [...lead, last];
  }
  const out = lines.map(name);
  if (input.hp) out.push({ text: input.hp, px: s.hpPx, kind: "hp" });
  return out;
}
