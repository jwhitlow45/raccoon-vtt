import type { Character, Token } from "#shared/model.ts";
import type { ActorTarget, OpOf } from "#shared/protocol.ts";
import { displayName } from "../../lib/scene.ts";
import { parseHpInput } from "../tokens/hpInput.ts";

/**
 * Damage to the creatures in an area (features section 9), as plain
 * functions for node --test. The DM types the damage the caster rolled,
 * once for every target as the SRD's "Damage against Multiple Targets"
 * says, marks each creature's save, and confirms. A creature that saves
 * takes half, rounded down (SRD 5.2.1, "Half Damage" and "Round Down").
 * Players roll their own dice, so nothing here rolls any.
 */

/** A failed save takes the full damage, a success half, and `none` leaves the creature out. */
export type SaveResult = "fail" | "pass" | "none";

export type DamageTarget = {
  tokenId: string;
  /** Whose HP this is: two tokens of one character share it and are hit once. */
  holder: string;
  target: ActorTarget;
  name: string;
  /** Hidden from players: the DM's list marks it, so the DM knows players will not see the line. */
  hidden: boolean;
  dead: boolean;
  /** An object, such as a door or a cart: listed, since a fireball can burn it, but skipped until the DM marks it. */
  object: boolean;
  hp: { cur: number; max: number; temp: number } | null;
};

/**
 * The creatures an area's damage can reach, from the tokens it catches:
 * each holder once, the living creatures first, then objects and the dead,
 * each by name, as the In area list reads.
 */
export function damageTargets(
  ids: readonly string[],
  tokens: Readonly<Record<string, Token | undefined>>,
  characters: Readonly<Record<string, Character | undefined>>,
): DamageTarget[] {
  const seen = new Set<string>();
  const out: DamageTarget[] = [];
  for (const id of ids) {
    const token = tokens[id];
    if (!token) continue;
    const holder = "ref" in token.actor ? `character:${token.actor.ref}` : `token:${token.id}`;
    if (seen.has(holder)) continue;
    seen.add(holder);
    const actor = "inline" in token.actor ? token.actor.inline : characters[token.actor.ref]?.actor;
    out.push({
      tokenId: token.id,
      holder,
      target: { tokenId: token.id },
      name: displayName(token),
      hidden: token.visibility === "dm",
      dead: actor?.life === "dead",
      object: token.kind === "object",
      hp: actor?.hp ? { cur: actor.hp.cur, max: actor.hp.max, temp: actor.hp.temp } : null,
    });
  }
  const last = (t: DamageTarget) => Number(t.dead || t.object);
  return out.sort((a, b) => last(a) - last(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Every creature fails until marked otherwise, the commonest case. The dead
 * take nothing, and an object is skipped until the DM marks it, since most
 * spells that hit an area name creatures.
 */
export function defaultResult(t: Pick<DamageTarget, "dead" | "object">): SaveResult {
  return t.dead || t.object ? "none" : "fail";
}

/** What one creature takes: all of it on a failed save, half rounded down on a success. */
export function dealt(amount: number, result: SaveResult): number {
  if (result === "fail") return amount;
  if (result === "pass") return Math.floor(amount / 2);
  return 0;
}

export type DamageParse = { ok: true; amount: number } | { ok: false; error: string };

/** The damage rolled, typed as a number or a sum such as 8+6+3. */
export function parseDamage(text: string): DamageParse {
  if (!text.trim()) return { ok: false, error: "Type the damage the caster rolled." };
  const parsed = parseHpInput(text, "damage");
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.change.kind !== "damage") return { ok: false, error: "Type the damage, such as 28 or 8+6+14." };
  return { ok: true, amount: parsed.change.amount };
}

/**
 * The one op that applies it, or null when nobody takes any. Creatures
 * left out, and a save that halves 1 to 0, send nothing.
 */
export function damageOp(
  targets: readonly DamageTarget[],
  results: Readonly<Record<string, SaveResult | undefined>>,
  amount: number,
): OpOf<"actor.damageMany"> | null {
  const hits: OpOf<"actor.damageMany">["hits"] = [];
  for (const t of targets) {
    const n = dealt(amount, results[t.tokenId] ?? defaultResult(t));
    if (n > 0) hits.push({ target: t.target, amount: n });
  }
  return hits.length > 0 ? { t: "actor.damageMany", hits } : null;
}
