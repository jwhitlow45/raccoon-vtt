import { MAX_DAMAGE_PARTS, type HpChange } from "#shared/protocol.ts";
import { parseParts, partAmounts, partsText } from "#shared/rules/typedDamage.ts";

/**
 * The HP quick entry (features section 5): `-7` deals 7 damage, `+5` heals
 * 5, `=20` sets current HP to 20, and `t5` gives 5 temporary HP. A number
 * with no sign uses the mode picked next to the field, because a phone's
 * number pad has no minus key.
 *
 * Several terms add up, so `-7-3` is 10 damage and `+5+3` heals 8. A signed
 * expression is a change to current HP: `-3+10` comes out as healing 7.
 * Typographic minus signs (as in the SRD's text) count as minus.
 */
export type HpMode = "damage" | "heal" | "set" | "temp";

export const HP_MODES: readonly { mode: HpMode; label: string }[] = [
  { mode: "damage", label: "Damage" },
  { mode: "heal", label: "Heal" },
  { mode: "set", label: "Set" },
  { mode: "temp", label: "Temp" },
];

/**
 * The mode the entry falls back to once a change is applied. Damage and
 * healing come in runs, a hit after a hit, so they stay. Temporary HP and a
 * set value are one-off corrections, and the next number typed after one is
 * almost always damage again.
 */
export function modeAfterApply(mode: HpMode): HpMode {
  return mode === "temp" || mode === "set" ? "damage" : mode;
}

/** The protocol's cap on any HP amount. */
export const MAX_HP_AMOUNT = 100_000;

export type HpParse = { ok: true; change: HpChange; summary: string } | { ok: false; error: string };

const EMPTY = "Type a number.";
const UNREADABLE = "Use a number, such as -7, +5, =20 or t5.";

/** Integer terms joined by + and -, with an optional leading sign. Null when unreadable. */
function sum(text: string): { value: number; signed: boolean } | null {
  const compact = text.replace(/\s+/g, "");
  if (!/^[+-]?\d+([+-]\d+)*$/.test(compact)) return null;
  const terms = compact.match(/[+-]?\d+/g) ?? [];
  let value = 0;
  for (const term of terms) value += Number(term);
  return { value, signed: compact.startsWith("+") || compact.startsWith("-") };
}

function tooLarge(n: number): boolean {
  return !Number.isSafeInteger(n) || n > MAX_HP_AMOUNT;
}

export function parseHpInput(raw: string, mode: HpMode): HpParse {
  const text = raw.trim().replace(/[\u2212\u2013\u2014]/g, "-").toLowerCase();
  if (text === "") return { ok: false, error: EMPTY };

  const temp = /^t(?:emp)?\s*[:=+]?\s*(.*)$/.exec(text);
  if (temp) {
    const s = sum(temp[1] ?? "");
    if (!s || temp[1] === "") return { ok: false, error: UNREADABLE };
    if (s.value < 0) return { ok: false, error: "Temporary HP cannot be negative." };
    if (tooLarge(s.value)) return { ok: false, error: "That number is too large." };
    return { ok: true, change: { kind: "temp", amount: s.value }, summary: `Set Temporary HP to ${s.value}` };
  }

  if (text.startsWith("=")) {
    const s = sum(text.slice(1));
    if (!s) return { ok: false, error: UNREADABLE };
    return set(s.value);
  }

  if (/\d\s*[a-z]{3,}/.test(text)) {
    const negative = text.startsWith("-");
    if ((!negative && mode !== "damage") || text.startsWith("+")) return { ok: false, error: "Damage types go with damage only." };
    const parsed = parseParts(negative ? text.slice(1).trim() : text);
    if (!parsed.ok) return parsed;
    const parts = partAmounts(parsed.parts, []);
    if (!parts) return { ok: false, error: "Type the rolled damage, such as 10 Fire." };
    if (parts.length > MAX_DAMAGE_PARTS) return { ok: false, error: `Use at most ${MAX_DAMAGE_PARTS} damage parts.` };
    const amount = parts.reduce((total, part) => total + part.amount, 0);
    if (tooLarge(amount)) return { ok: false, error: "That number is too large." };
    return { ok: true, change: { kind: "damage", amount, parts }, summary: `${partsText(parts)} damage` };
  }

  const s = sum(text);
  if (!s) return { ok: false, error: UNREADABLE };
  if (tooLarge(Math.abs(s.value))) return { ok: false, error: "That number is too large." };
  if (s.signed) {
    if (s.value === 0) return { ok: false, error: "That adds up to no change." };
    return s.value < 0 ? damage(-s.value) : heal(s.value);
  }
  if (s.value < 0) return { ok: false, error: "Use a positive number, or start with + or -." };
  switch (mode) {
    case "damage":
      return s.value === 0 ? { ok: false, error: "That adds up to no change." } : damage(s.value);
    case "heal":
      return s.value === 0 ? { ok: false, error: "That adds up to no change." } : heal(s.value);
    case "set":
      return set(s.value);
    case "temp":
      return { ok: true, change: { kind: "temp", amount: s.value }, summary: `Set Temporary HP to ${s.value}` };
  }
}

function damage(amount: number): HpParse {
  return { ok: true, change: { kind: "damage", amount }, summary: `${amount} damage` };
}

function heal(amount: number): HpParse {
  return { ok: true, change: { kind: "heal", amount }, summary: `Heal ${amount}` };
}

function set(cur: number): HpParse {
  if (cur < 0) return { ok: false, error: "HP cannot be negative." };
  if (tooLarge(cur)) return { ok: false, error: "That number is too large." };
  return { ok: true, change: { kind: "set", cur }, summary: `Set HP to ${cur}` };
}

/**
 * A critical hit on a creature at 0 HP counts as two failed death saves
 * (design section 9.6). Only damage carries the flag.
 */
export function withCrit(change: HpChange, crit: boolean): HpChange {
  return change.kind === "damage" && crit ? { ...change, crit: true } : change;
}
