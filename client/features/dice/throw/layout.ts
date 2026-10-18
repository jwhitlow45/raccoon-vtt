import { keptD20, rolledTerms } from "#shared/dice/roll.ts";
import type { DiceResult, DiceRoll } from "#shared/model.ts";
import { critical } from "../options.ts";

/**
 * Which dice a throw shows and where they land in the tray
 * (docs/design-v1-roll-animation.md 3.1 to 3.3), with no three.js, so the
 * Dice panel's own chunk can plan a throw and the lazy stage only draws it.
 * Every number here is a screen px: the tray's width is measured with
 * getBoundingClientRect, which includes the panel's zoom.
 */

/** The tray's height under the header line, at every interface size. */
export const TRAY_PX = 112;
/** The gap between two dice, and between two rows. */
export const GAP_PX = 8;
/** The smallest die the tray ever draws. */
export const MIN_DIE_PX = 44;

/** A model the stage builds: the polyhedral dice, a percentile's two d10s, and a coin for any other die. */
export type DieKind = "d4" | "d6" | "d8" | "d10" | "d12" | "d20" | "tens" | "units" | "coin";

export const DIE_KINDS: readonly DieKind[] = ["d4", "d6", "d8", "d10", "d12", "d20", "tens", "units", "coin"];

/**
 * One die of a throw. `value` is the number's place on its model: the face
 * less one, or for a percentile's dice the tens and the units. `text` is
 * what the landed face reads, and `at` the face's place in the result.
 */
export type ThrowDie = { kind: DieKind; sides: number; face: number; at: number; value: number; text: string; kept: boolean };

const SHAPED = new Set([4, 6, 8, 10, 12, 20]);

/** A percentile face as its two d10s read it: 84 is "80" and "4", 100 is "00" and "0". */
export function splitD100(face: number): { tens: number; units: number; text: [string, string] } {
  const tens = Math.floor((face % 100) / 10);
  const units = face % 10;
  return { tens, units, text: [String(tens * 10).padStart(2, "0"), String(units)] };
}

/**
 * A result's faces as dice, in the order of its faces, each paired with
 * its die by rolledTerms and marked kept by keptFaces, as faceChips does.
 * Null for a stored formula that no longer parses.
 */
export function throwDice(result: Pick<DiceResult, "formula" | "faces">): ThrowDie[] | null {
  const terms = rolledTerms(result);
  if (!terms) return null;
  const out: ThrowDie[] = [];
  for (const t of terms) {
    if (!("kept" in t)) continue;
    const sides = t.term.sides;
    t.faces.forEach((face, i) => {
      const die = { sides, face, at: t.first + i, kept: t.kept[i] === true };
      if (sides === 100) {
        const split = splitD100(face);
        out.push({ ...die, kind: "tens", value: split.tens, text: split.text[0] });
        out.push({ ...die, kind: "units", value: split.units, text: split.text[1] });
      } else if (SHAPED.has(sides)) out.push({ ...die, kind: `d${sides}` as DieKind, value: face - 1, text: String(face) });
      else out.push({ ...die, kind: "coin", value: 0, text: face.toLocaleString("en-US") });
    });
  }
  return out;
}

/** The kinds of these rolls' dice, for the warm-up: a d20 and a d6 when there are none. */
export function kindsIn(rolls: readonly Pick<DiceResult, "formula" | "faces">[]): DieKind[] {
  const kinds = new Set<DieKind>();
  for (const roll of rolls) for (const die of throwDice(roll) ?? []) kinds.add(die.kind);
  return kinds.size > 0 ? [...kinds] : ["d20", "d6"];
}

/** How a throw's deciding d20 is marked once it lands: the accent's ring, or a natural 1's. */
export type Mark = "critical" | "fumble";

/**
 * One tap's dice: every roll's, in order, and the d20 that decides a D20
 * Test, whose place `decider` names. Its ring follows the Critical chip's
 * rule (critical()): a natural 20, or a critical hit in a weapon's wider
 * range. Null when a roll's formula no longer parses or no die was drawn.
 */
export function tapDice(rolls: readonly DiceRoll[]): { dice: ThrowDie[]; decider: number | null; mark: Mark | null } | null {
  const dice: ThrowDie[] = [];
  let decider: number | null = null;
  let mark: Mark | null = null;
  for (const [r, roll] of rolls.entries()) {
    const own = throwDice(roll);
    if (!own) return null;
    if (r === 0) {
      const d20 = keptD20(roll);
      if (d20) {
        decider = dice.length + own.findIndex((d) => d.at === d20.index);
        mark = critical(roll) ? "critical" : d20.face === 1 ? "fumble" : null;
      }
    }
    dice.push(...own);
  }
  return dice.length > 0 ? { dice, decider, mark } : null;
}

/**
 * The tray's rule (3.3) for n dice in a tray `width` px wide: one row while
 * they fit at 48 px or more, at most 60. Else two rows of ceil(n / 2) while
 * those fit at 44 px or more, at most 48. Else the most columns that fit at
 * 44 px, two rows of them less one, and a disc for the rest.
 */
export function trayLayout(n: number, width: number): { rows: 1 | 2; cols: number; size: number; shown: number } {
  const fit = (cols: number) => (width - (cols - 1) * GAP_PX) / cols;
  const one = Math.min(60, fit(n));
  if (one >= 48) return { rows: 1, cols: n, size: one, shown: n };
  const half = Math.ceil(n / 2);
  const two = Math.min(48, fit(half));
  if (two >= MIN_DIE_PX) return { rows: 2, cols: half, size: two, shown: n };
  const cols = Math.max(1, Math.floor((width + GAP_PX) / (MIN_DIE_PX + GAP_PX)));
  return { rows: 2, cols, size: Math.min(48, fit(cols)), shown: 2 * cols - 1 };
}

/** A die's resting place, its center in px from the tray's top left corner. */
export type TraySlot = { die: ThrowDie; x: number; y: number; size: number; mark: Mark | null };

export type TrayPlan = {
  slots: TraySlot[];
  /** Dice the tray had no room for, a percentile counted as two. */
  more: number;
  /** Where the "+N" disc sits, when there is one. */
  disc: { x: number; y: number; size: number } | null;
  size: number;
};

/**
 * Where each die lands. The deciding d20 goes first, so the cap never hides
 * it, and a percentile's pair is never split: the cap shows one die fewer.
 * Each die sits a few px off its slot's middle, from the throw's own
 * random, so a row never looks ruled.
 */
export function planTray(input: { dice: readonly ThrowDie[]; decider: number | null; mark: Mark | null }, width: number, random: () => number): TrayPlan {
  const order = input.dice.map((die, i) => ({ die, mark: i === input.decider ? input.mark : null }));
  if (input.decider !== null && input.decider > 0) order.unshift(...order.splice(input.decider, 1));
  const layout = trayLayout(order.length, width);
  let shown = Math.min(layout.shown, order.length);
  if (shown < order.length && order[shown - 1]?.die.kind === "tens") shown -= 1;
  const more = order.length - shown;
  const count = shown + (more > 0 ? 1 : 0);
  const { size, cols, rows } = layout;
  const place = (i: number) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, count - row * cols);
    const left = (width - (inRow * size + (inRow - 1) * GAP_PX)) / 2;
    const top = (TRAY_PX - (rows * size + (rows - 1) * GAP_PX)) / 2;
    return { x: left + (i % cols) * (size + GAP_PX) + size / 2, y: top + row * (size + GAP_PX) + size / 2 };
  };
  // Kept inside the tray, so a full row never runs past its edge.
  const jitter = (v: number, room: number) => Math.max(size / 2, Math.min(room - size / 2, v + (random() - 0.5) * 6));
  const slots = order.slice(0, shown).map((o, i) => {
    const at = place(i);
    return { die: o.die, mark: o.mark, x: jitter(at.x, width), y: jitter(at.y, TRAY_PX), size };
  });
  const disc = more > 0 ? { ...place(shown), size } : null;
  return { slots, more, disc, size };
}

/**
 * A throw's own random, seeded by its tag, so a test can pin a throw and
 * the same tag always lands the same way (mulberry32 over FNV-1a).
 */
export function seededRandom(tag: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
