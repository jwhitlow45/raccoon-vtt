import type { Actor, Effect, HpVisibility, Token } from "#shared/model.ts";
import { theme } from "./theme.ts";

/**
 * Pure pieces of how a token looks: its HP readout, its condition chips, the
 * image crop, and where the fixed-size decorations sit. The canvas draws
 * what these return.
 */

// ---------------------------------------------------------------- HP

export type HpLabel = "Healthy" | "Bloodied" | "Dying" | "Dead";

/** Design section 9.6. Bloodied is computed, never stored. */
export function hpLabel(actor: Pick<Actor, "hp" | "life">): HpLabel {
  if (actor.life === "dead") return "Dead";
  if (actor.life === "dying" || actor.life === "stable") return "Dying";
  return actor.hp.cur <= Math.floor(actor.hp.max / 2) ? "Bloodied" : "Healthy";
}

export type HpDisplay =
  | { kind: "none" }
  | { kind: "label"; label: HpLabel }
  /** `text` is set only when the viewer may see exact numbers. */
  | { kind: "bar"; fraction: number; text?: string };

/**
 * An actor as a viewer's projection delivers it (design section 7.3). A
 * player who may not see a creature's numbers gets `hpLabel` or `hpBar`
 * instead of `hp`, already rounded by the server.
 */
export type HpView = Partial<Pick<Actor, "hp" | "life">> & { hpLabel?: HpLabel; hpBar?: number };

/**
 * What a viewer sees of a token's HP. The server's projection has already
 * removed what this viewer may not know (design section 7.3), so this only
 * decides how to show what arrived. The DM and the owner see the numbers.
 *
 * `hpVisibility` reaches only the DM and owners. A player's copy of someone
 * else's token has none, so the shape of what arrived decides instead:
 * numbers, a rounded bar, a label, or nothing.
 */
export function hpDisplay(input: {
  actor: HpView | undefined;
  hpVisibility: HpVisibility | undefined;
  fullAccess: boolean;
}): HpDisplay {
  const { actor, hpVisibility, fullAccess } = input;
  const hp = actor?.hp;
  const hasHp = !!hp && Number.isFinite(hp.cur) && Number.isFinite(hp.max) && hp.max > 0;
  // Where the numbers should be but did not arrive, the shape of what did decides, not the token's setting: a player who owns a character's token but not the character holds that character's HP as the party's rule sends it.
  const mode: HpVisibility = fullAccess ? (hasHp ? "exact" : projectedMode(actor, hasHp)) : (hpVisibility ?? projectedMode(actor, hasHp));
  if (mode === "hidden") return { kind: "none" };
  if (mode === "label") {
    if (hasHp) return { kind: "label", label: hpLabel({ hp: hp!, life: actor?.life ?? "alive" }) };
    if (actor?.life === "dead") return { kind: "label", label: "Dead" };
    if (actor?.life === "dying" || actor?.life === "stable") return { kind: "label", label: "Dying" };
    if (actor?.hpLabel) return { kind: "label", label: actor.hpLabel };
    return { kind: "none" };
  }
  if (!hasHp) {
    if (mode === "bar" && typeof actor?.hpBar === "number" && Number.isFinite(actor.hpBar)) {
      return { kind: "bar", fraction: Math.min(1, Math.max(0, actor.hpBar)) };
    }
    return { kind: "none" };
  }
  const fraction = Math.min(1, Math.max(0, hp!.cur / hp!.max));
  if (mode === "bar") return { kind: "bar", fraction };
  const temp = hp!.temp > 0 ? ` +${hp!.temp}` : "";
  return { kind: "bar", fraction, text: `${hp!.cur}/${hp!.max}${temp}` };
}

function projectedMode(actor: HpView | undefined, hasHp: boolean): HpVisibility {
  if (hasHp) return "exact";
  if (typeof actor?.hpBar === "number") return "bar";
  if (actor?.hpLabel || actor?.life === "dead" || actor?.life === "dying" || actor?.life === "stable") return "label";
  return "hidden";
}

/**
 * The creature's state as far as this viewer may know it, from the same
 * projected data `hpDisplay` reads, or null when they may know nothing of
 * its HP. It drives the board's label priority and the Bloodied mark, so it
 * comes from the HP itself rather than from the text drawn: the DM's "3/9"
 * is Bloodied too. A bar viewer's rounded bar counts as Bloodied at half or
 * less, as the bar's own amber shows.
 *
 * The bar arrives rounded to the nearest 1/20 (shared/rules/hp.ts), so near
 * half it can disagree with the rules' Bloodied (current HP at most half
 * the maximum, rounded down): 11 of 21 is not Bloodied, but its bar rounds
 * to exactly half and reads as Bloodied here. That is kept on purpose. The
 * state must come only from what this viewer received, never from numbers
 * the server withheld, and it then agrees with the amber the bar shows.
 */
export function healthState(input: { actor: HpView | undefined; hpVisibility: HpVisibility | undefined; fullAccess: boolean }): HpLabel | null {
  const display = hpDisplay(input);
  if (display.kind === "none") return null;
  if (display.kind === "label") return display.label;
  const life = input.actor?.life;
  if (life === "dead") return "Dead";
  if (life === "dying" || life === "stable") return "Dying";
  const hp = input.actor?.hp;
  if (display.text !== undefined && hp && Number.isFinite(hp.cur) && Number.isFinite(hp.max) && hp.max > 0) return hpLabel({ hp, life: "alive" });
  return display.fraction <= 0.5 ? "Bloodied" : "Healthy";
}

/** One line for lists and bars: "Bloodied", "5/20 +3", or "about 25%". */
export function hpText(display: HpDisplay): string | null {
  if (display.kind === "none") return null;
  if (display.kind === "label") return display.label;
  return display.text ?? `about ${Math.round(display.fraction * 100)}%`;
}

// ---------------------------------------------------------------- effect chips

export type Chip = { glyph: string; color: string; label: string };

/**
 * Each effect's chip color, label and letter glyph. The canvas draws the
 * openly licensed icon from public/icons (client/canvas/chipIcons.ts) and
 * falls back to the glyph while the icon loads, if it fails, and for custom
 * statuses. Either way the chip carries a shape as well as a color, so it
 * works for colorblind players.
 */
/**
 * A custom status with no color of its own, and an effect key with no
 * entry below, draw on this slate. It is board art in the status palette,
 * not an interface color.
 */
const OTHER_CHIP_COLOR = "#4b5563";

const CHIPS: Record<string, { glyph: string; color: string; label: string }> = {
  blinded: { glyph: "Bl", color: "#6b7280", label: "Blinded" },
  charmed: { glyph: "Ch", color: "#d946ef", label: "Charmed" },
  deafened: { glyph: "Df", color: "#6b7280", label: "Deafened" },
  exhaustion: { glyph: "Ex", color: "#a16207", label: "Exhaustion" },
  frightened: { glyph: "Fr", color: "#7c3aed", label: "Frightened" },
  grappled: { glyph: "Gr", color: "#b45309", label: "Grappled" },
  incapacitated: { glyph: "In", color: "#be123c", label: "Incapacitated" },
  invisible: { glyph: "Iv", color: "#0e7490", label: "Invisible" },
  paralyzed: { glyph: "Pa", color: "#be123c", label: "Paralyzed" },
  petrified: { glyph: "Pe", color: "#57534e", label: "Petrified" },
  poisoned: { glyph: "Po", color: "#15803d", label: "Poisoned" },
  prone: { glyph: "Pr", color: "#92400e", label: "Prone" },
  restrained: { glyph: "Re", color: "#b45309", label: "Restrained" },
  stunned: { glyph: "St", color: "#ca8a04", label: "Stunned" },
  unconscious: { glyph: "Un", color: "#1e3a8a", label: "Unconscious" },
  concentrating: { glyph: "C", color: "#2563eb", label: "Concentrating" },
  hidden: { glyph: "Hi", color: "#374151", label: "Hidden" },
  flying: { glyph: "Fl", color: "#0284c7", label: "Flying" },
  dodging: { glyph: "Do", color: "#0891b2", label: "Dodging" },
  raging: { glyph: "Ra", color: "#dc2626", label: "Raging" },
  blessed: { glyph: "B+", color: "#ca8a04", label: "Blessed" },
  baned: { glyph: "B-", color: "#7f1d1d", label: "Baned" },
  hasted: { glyph: "Ha", color: "#16a34a", label: "Hasted" },
  "hunters-mark": { glyph: "HM", color: "#15803d", label: "Hunter's Mark" },
  hexed: { glyph: "Hx", color: "#7e22ce", label: "Hexed" },
  "heroic-inspiration": { glyph: "HI", color: "#f38400", label: "Heroic Inspiration" },
  surprised: { glyph: "Su", color: "#9333ea", label: "Surprised" },
  marked: { glyph: "Mk", color: "#e11d48", label: "Marked" },
  readied: { glyph: "Rd", color: "#4f46e5", label: "Readied action" },
};

export function effectChip(effect: Pick<Effect, "key" | "label" | "glyph" | "color" | "level" | "spell">): Chip {
  const count = effectCount(effect);
  const counted = (chip: Chip): Chip => (count === null ? chip : { ...chip, label: `${chip.label} (${count})` });
  if (effect.key === "custom") {
    const label = effect.label?.trim() || "Custom";
    return counted({ glyph: effect.glyph?.trim() || label.slice(0, 2), color: effect.color ?? OTHER_CHIP_COLOR, label });
  }
  const base = CHIPS[effect.key] ?? { glyph: "?", color: OTHER_CHIP_COLOR, label: effect.key };
  if (effect.key === "exhaustion" && effect.level) {
    return { ...base, glyph: `E${effect.level}`, label: `Exhaustion ${effect.level}` };
  }
  if (effect.key === "concentrating" && effect.spell) return counted({ ...base, label: `Concentrating: ${effect.spell}` });
  // A Ready action's trigger rides in its label.
  if (effect.key === "readied" && effect.label?.trim()) return counted({ ...base, label: `Readied: ${effect.label.trim()}` });
  return counted(base);
}

/**
 * The number an effect's icon carries (features section 7): an exhaustion
 * level, or the counter anyone who may edit the effect set on it, such as
 * rounds or charges left. Null when it has none. A counter can be 0, since
 * "none left" is worth showing.
 */
export function effectCount(effect: Pick<Effect, "key" | "level">): number | null {
  if (effect.level === undefined || !Number.isFinite(effect.level)) return null;
  if (effect.key === "exhaustion") return effect.level >= 1 ? effect.level : null;
  return effect.level;
}

// ---------------------------------------------------------------- image crop

/**
 * The part of a token image to show (design section 11.4). `cx` and `cy` are
 * the crop center as fractions of the image's width and height, and `zoom`
 * 1 shows the largest region of the footprint's shape that fits the image.
 * Zoom 2 shows half of that, and so on. The region is kept inside the image.
 */
export function cropSourceRect(
  image: { width: number; height: number },
  crop: { cx: number; cy: number; zoom: number } | undefined,
  aspect = 1,
): { x: number; y: number; width: number; height: number } {
  const zoom = Math.min(20, Math.max(1, Number.isFinite(crop?.zoom) ? crop!.zoom : 1));
  let width = Math.min(image.width, image.height * aspect);
  let height = width / aspect;
  width /= zoom;
  height /= zoom;
  const cx = (Number.isFinite(crop?.cx) ? crop!.cx : 0.5) * image.width;
  const cy = (Number.isFinite(crop?.cy) ? crop!.cy : 0.5) * image.height;
  const x = Math.min(image.width - width, Math.max(0, cx - width / 2));
  const y = Math.min(image.height - height, Math.max(0, cy - height / 2));
  return { x, y, width, height };
}

// ---------------------------------------------------------------- fixed-size decorations

export const CHIP_PX = 18;
export const CHIP_GAP_PX = 2;
/** Room kept free at the top right for the elevation badge. */
export const BADGE_RESERVE_PX = 36;

/**
 * Chips sit along the token's top edge at a fixed screen size (design
 * section 14.2). The name and HP bar sit below the token, so the two never
 * overlap. When the chips do not fit, the last slot shows "+N". A token
 * smaller on screen than two chips still gets two slots, so at least one
 * real chip shows next to the count.
 */
export function chipRow(
  tokenWidthPx: number,
  count: number,
  hasBadge: boolean,
  size: { chip: number; gap: number; badge: number } = { chip: CHIP_PX, gap: CHIP_GAP_PX, badge: BADGE_RESERVE_PX },
): { shown: number; overflow: number; xs: number[] } {
  const available = Math.max(size.chip * 2 + size.gap, tokenWidthPx - (hasBadge ? size.badge : 0));
  const slots = Math.max(1, Math.floor((available + size.gap) / (size.chip + size.gap)));
  const shown = count <= slots ? count : slots - 1;
  const overflow = count - shown;
  const total = shown + (overflow > 0 ? 1 : 0);
  const xs = Array.from({ length: total }, (_, i) => i * (size.chip + size.gap));
  return { shown, overflow, xs };
}

/** Where the elevation badge's 30 px start sits along the token's top edge. */
const BADGE_INSET_PX = 30;

/**
 * The elevation badge's left edge, in screen pixels from the token's left
 * edge: at the top right corner, but never over the chips. On a token too
 * small for both, the badge moves past the last chip, out beyond the
 * token's edge, rather than hiding a condition.
 */
export function badgeLeft(
  tokenWidthPx: number,
  chipXs: readonly number[],
  size: { chip: number; gap: number; inset: number } = { chip: CHIP_PX, gap: CHIP_GAP_PX, inset: BADGE_INSET_PX },
): number {
  const corner = tokenWidthPx - size.inset;
  const last = chipXs[chipXs.length - 1];
  return last === undefined ? corner : Math.max(corner, last + size.chip + size.gap);
}

/** "↑30" or "↓10". Nothing at ground level. */
export function elevationBadge(elevation: number): string | null {
  if (!Number.isFinite(elevation) || elevation === 0) return null;
  return elevation > 0 ? `↑${elevation}` : `↓${-elevation}`;
}

// ---------------------------------------------------------------- ring

/**
 * A creature's ring color by its disposition, one map wherever the app
 * draws one: its token, its picture in the token panel and the Dice panel,
 * the tether to its holder and its range rings, so they never drift apart.
 */
export const DISPOSITION_RING: Readonly<Record<Token["disposition"], string>> = { ally: theme.color.ally, neutral: theme.color.neutral, hostile: theme.color.hostile };

// ---------------------------------------------------------------- name labels

/**
 * What a token without a picture shows, and a tracker row's portrait: two
 * initials, or the first letter and the number of a numbered duplicate, so
 * "Goblin Warrior 3" reads G3 on the map as in the tracker and the group can
 * be told apart.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const last = words[words.length - 1]!;
  if (words.length >= 2 && /^\d+$/.test(last)) return `${words[0]![0]!.toUpperCase()}${last}`;
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return words[0]!.slice(0, 2);
}

/** Marks are hidden below this on-screen size: a 10 px token has no room for chips or a bar. */
export const DECOR_MIN_PX = 14;
