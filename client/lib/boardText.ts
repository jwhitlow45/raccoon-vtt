import type { BoardSizes } from "./boardScale.ts";

/**
 * Where each token's name and HP go on the board, and what gives way when
 * the board is crowded (option C of the 2026-10-14 review). Pure, so it
 * runs under plain Node tests with a fake measure.
 *
 * The rules, in the order they bind:
 *
 * - Text that fits is never cut. A name is whole on one line, whole on two
 *   balanced lines, or cut once on one line keeping its duplicate number and
 *   at least four letters ("Kobold… 4"). Never a shorter fragment: below
 *   that, the token's own initials or number badge name it.
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
 * - A label keeps the side it had on the last layout while that side is
 *   still free, so a pinch does not make labels jump between frames. Its
 *   shape (where the name wraps, whether the HP shares its line) is decided
 *   at one fixed size (SHAPE_PX), so a pinch does not wrap it back and forth.
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
  sizes: Pick<BoardSizes, "namePx" | "hpPx" | "gapPx"> & { unrounded: Pick<BoardSizes["unrounded"], "namePx" | "gapPx"> },
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
    room: {
      wrapEm: ems(Math.max((tokenPx + cellPx) / u.namePx, 10) - 2 * HALO_EM),
      maxEm: 15 - 2 * HALO_EM,
      ownEm: ems((tokenPx + 2 * u.gapPx) / u.namePx - 2 * HALO_EM),
    },
  };
}

/** The focus plate's style: the focus sizes, up to 16 ems a line, on a plate padded 6 px each side, the HP always on its own line. */
export function focusStyle(sizes: Pick<BoardSizes, "focusNamePx" | "focusHpPx" | "gapPx" | "unrounded">): LabelStyle {
  const padX = 6;
  const maxEm = ems(16 - (2 * padX) / sizes.unrounded.focusNamePx);
  return {
    namePx: sizes.focusNamePx,
    hpPx: sizes.focusHpPx,
    leading: LEADING,
    maxWidth: 16 * sizes.focusNamePx,
    padX,
    gapPx: sizes.gapPx,
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
  number?: number;
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
};

const ELLIPSIS = "…";
/** Letters a cut name keeps at the least: fewer say less than the token's own initials. */
export const MIN_CUT_LETTERS = 4;

export function lineHeight(px: number, leading: number): number {
  return Math.round(px * leading);
}

/** The full name as the board shows it: "Goblin 3". */
export function fullName(name: string, number: number | undefined): string {
  return number === undefined ? name : `${name} ${number}`;
}

/**
 * A name wrapped whole into at most `maxLines` lines of `width`, or null
 * when it does not fit whole. The number of a numbered duplicate is never
 * broken: it rides on the last word's line when the two fit together
 * ("Sorcerer 4"), and moves to the next line whole when they do not. A
 * word wider than a line breaks with a hyphen after a letter, never after
 * a digit or a space, and only when the whole name then fits. Lines are
 * balanced when no word broke, so a centered label reads as a block
 * ("Owlbear Matriarch" over "of the Thornwood") and takes less room from
 * its neighbors.
 */
export function wrapWhole(name: string, number: number | undefined, width: number, maxLines: number, px: number, measure: Measure): string[] | null {
  const fits = (t: string) => measure(t, px) <= width;
  const units: { text: string; breakable: boolean }[] = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, breakable: true }));
  if (number !== undefined) {
    const suffix = String(number);
    const last = units[units.length - 1];
    if (last && fits(`${last.text} ${suffix}`)) units[units.length - 1] = { text: `${last.text} ${suffix}`, breakable: false };
    else units.push({ text: suffix, breakable: false });
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
 * the duplicate number ("Kobold Sc… 4", "Bartholo…"). Null when fewer than
 * MIN_CUT_LETTERS letters would fit.
 */
export function cutName(name: string, number: number | undefined, width: number, px: number, measure: Measure): string | null {
  const chars = [...name.trim()];
  const suffix = number === undefined ? "" : ` ${number}`;
  const make = (n: number) => `${chars.slice(0, n).join("").trimEnd()}${ELLIPSIS}${suffix}`;
  const letters = (n: number) => chars.slice(0, n).filter((c) => /\S/.test(c)).length;
  let lo = 1;
  let hi = chars.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measure(make(mid), px) <= width) {
      if (letters(mid) >= MIN_CUT_LETTERS) best = make(mid);
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export type Content = { lines: LabelLine[]; nameShown: boolean; hpShown: boolean; cut: boolean };

/** A label's possible content: fixed lines, or the name cut to whatever room is free beside them. */
export type Template = { kind: "lines"; content: Content } | { kind: "cut"; hp: LabelLine | null };

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
  const key = [input.name, input.number, input.nameOnly ? null : input.hp, input.alert, s0.namePx, s0.hpPx, r0.wrapEm, r0.maxEm, r0.ownEm].join("\u0000");
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

function makeTemplates(input: LabelInput, measure: Measure): Template[][] {
  const s = input.style;
  const room = s.room;
  const name = (text: string): LabelLine => ({ text, px: s.namePx, kind: "name" });
  const full = fullName(input.name, input.number);
  const wholeForms: string[][] = [];
  const seen = new Set<string>();
  for (const [em, maxLines] of [
    [room.wrapEm, 1],
    [room.wrapEm, 2],
    [room.maxEm, 1],
    [room.maxEm, 2],
  ] as const) {
    const lines = wrapWhole(input.name, input.number, Math.max(0, em) * SHAPE_PX, maxLines, SHAPE_PX, measure);
    const key = lines?.join("\n");
    if (lines && key !== undefined && !seen.has(key)) {
      seen.add(key);
      wholeForms.push(lines);
    }
  }
  const hp = input.nameOnly ? null : input.hp;
  const hpLine: LabelLine | null = hp ? { text: hp, px: s.hpPx, kind: "hp" } : null;
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
      out.push([{ kind: "cut", hp: hpLine }]);
      out.push([shape([hpLine], false, true)]);
    }
  }
  out.push(wholeForms.map((lines) => shape(lines.map(name), true, false)));
  out.push([{ kind: "cut", hp: null }]);
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
 * keeps off all of them but its own body. `previous` is the side each label
 * had on the last layout, tried first, with a pixel of slack, so a label
 * holds its place across a pinch until something really takes it.
 */
export function placeLabels(
  inputs: readonly LabelInput[],
  obstacles: readonly Obstacle[],
  measure: Measure,
  previous?: ReadonlyMap<string, Side>,
): Map<string, PlacedLabel> {
  const natural = new Map(inputs.map((input) => [input.id, measure(fullName(input.name, input.number), SHAPE_PX)]));
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
    const gap = input.style.gapPx;
    const free = (box: Box, slack: number) => {
      const probe = grow(box, gap - slack);
      return !placed.some((p) => overlaps(probe, p)) && !obstacles.some((o) => !(o.kind === "body" && o.owner === input.id) && overlaps(probe, o.box));
    };
    const sides: Side[] = input.sides ? ["below", "above", "right", "left"] : ["below", "above"];
    const before = previous?.get(input.id);
    const tryOrder = before && sides.includes(before) ? [before, ...sides.filter((s) => s !== before)] : sides;
    let result: PlacedLabel | null = null;
    search: for (const level of templates(input, measure)) {
      for (const side of tryOrder) {
        const slack = side === before ? 1 : 0;
        for (const template of level) {
          const content = template.kind === "lines" ? template.content : cutToRoom(input, template.hp, side, (box) => free(box, slack), measure);
          if (!content) continue;
          const size = linesSize(content.lines, input.style, measure);
          const box = boxAt(input, side, size.width, size.height);
          if (free(box, slack)) {
            result = { ...content, box, side };
            break search;
          }
        }
      }
    }
    if (!result) {
      out.set(input.id, { lines: [], box: { x0: 0, y0: 0, x1: 0, y1: 0 }, side: "below", nameShown: false, hpShown: false, cut: false });
      continue;
    }
    placed.push(result.box);
    out.set(input.id, result);
  }
  return out;
}

/**
 * The name cut to the widest room free on `side`, with `hp` under it if
 * given: the box grows until it would touch something. Null when not even
 * MIN_CUT_LETTERS letters fit.
 */
function cutToRoom(input: LabelInput, hp: LabelLine | null, side: Side, free: (box: Box) => boolean, measure: Measure): Content | null {
  const s = input.style;
  const nameH = lineHeight(s.namePx, s.leading);
  const height = nameH + (hp ? lineHeight(hp.px, s.leading) : 0);
  const least = cutName(input.name, input.number, Number.POSITIVE_INFINITY, s.namePx, measure) === null ? null : minCutWidth(input, measure);
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
  const text = cutName(input.name, input.number, lo - 2 * s.padX, s.namePx, measure);
  if (!text) return null;
  const lines: LabelLine[] = [{ text, px: s.namePx, kind: "name" }];
  if (hp) lines.push(hp);
  return { lines, nameShown: true, hpShown: !!hp, cut: true };
}

/** The width of the shortest cut a name allows: four letters, the ellipsis and the number. */
function minCutWidth(input: LabelInput, measure: Measure): number {
  const chars = [...input.name.trim()];
  let n = 0;
  let letters = 0;
  while (n < chars.length && letters < MIN_CUT_LETTERS) {
    if (/\S/.test(chars[n]!)) letters++;
    n++;
  }
  const suffix = input.number === undefined ? "" : ` ${input.number}`;
  return measure(`${chars.slice(0, n).join("").trimEnd()}${ELLIPSIS}${suffix}`, input.style.namePx);
}

/**
 * A numbered token with a picture shows its number on its body when its
 * label shows no name: a pack of goblins sharing one picture is otherwise
 * told apart only by a tap. A body without a picture already shows its
 * initials with the number ("G3"). Too small a token has no room for it.
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
export function focusLines(input: Pick<LabelInput, "name" | "number" | "hp" | "style">, measure: Measure): LabelLine[] {
  const s = input.style;
  const width = s.room.maxEm * SHAPE_PX;
  const name = (text: string): LabelLine => ({ text, px: s.namePx, kind: "name" });
  let lines = wrapWhole(input.name, input.number, width, 3, SHAPE_PX, measure);
  if (!lines) {
    const all = wrapWhole(input.name, input.number, width, Number.MAX_SAFE_INTEGER, SHAPE_PX, measure) ?? [fullName(input.name, input.number)];
    const suffix = input.number === undefined ? "" : ` ${input.number}`;
    const rest = all.slice(2).join(" ");
    const base = suffix && rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : rest;
    const last = cutName(base, input.number, width, SHAPE_PX, measure) ?? `${[...base].slice(0, MIN_CUT_LETTERS).join("")}${ELLIPSIS}${suffix}`;
    lines = [...all.slice(0, 2), last];
  }
  const out = lines.map(name);
  if (input.hp) out.push({ text: input.hp, px: s.hpPx, kind: "hp" });
  return out;
}
