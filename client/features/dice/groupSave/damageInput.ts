import { parseHpInput } from "../../tokens/hpInput.ts";
import type { PartAmount } from "#shared/rules/typedDamage.ts";

/** A plain override is final damage, including zero. Typed damage still meets the creature's defenses. */
export function parseDamageOverride(value: number | string): { ok: true; amount: number; parts?: PartAmount[] } | { ok: false; error: string } {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const amount = Number(text);
    return amount <= 100_000 ? { ok: true, amount } : { ok: false, error: "That number is too large." };
  }
  if (/^[+\-\u2212\u2013\u2014]/.test(text)) return { ok: false, error: "Use a positive damage amount or 0." };
  const parsed = parseHpInput(text, "damage");
  if (!parsed.ok) return parsed;
  return parsed.change.kind === "damage" && parsed.change.parts
    ? { ok: true, amount: parsed.change.amount, parts: parsed.change.parts }
    : { ok: false, error: "Use a number or typed damage, such as 10 Fire." };
}
