import { sameImage } from "#shared/imageRef.ts";
import type { Character, Effect, Encounter, ImageRef, MemberId, Token } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { MAX_ENTRIES_PER_OP, type ActorTarget, type ClientOp, type TokenGroupPatch } from "#shared/protocol.ts";
import { tokenAccess, type Role } from "./access.ts";

/**
 * Editing several selected tokens at once (docs/design-v1-dm-tools.md 3.5),
 * as plain functions for node --test: what the group action bar offers this
 * viewer, whether a condition is lit for the group, and the ops each tap
 * sends. Every tap is one undo step: one many-op, or several sent as one
 * gesture when a selection passes the protocol's 100 per op.
 */

type GroupToken = Pick<Token, "id" | "kind" | "ownerIds" | "actor" | "visibility" | "locked" | "elevation">;

export type GroupView = {
  role: Role;
  memberId: MemberId | null | undefined;
  characters: Readonly<Record<string, Character | undefined>>;
  playersApplyDamage: boolean;
};

export type GroupOffers = {
  /** Every creature (objects left out) takes conditions from this viewer, and there is at least one. */
  conditions: boolean;
  /** Every token's elevation is this viewer's to change. */
  elevation: boolean;
  /** Hidden, Locked, Add to the fight, Delete and More. */
  dm: boolean;
};

/**
 * An action shows only when the viewer may apply it to every selected
 * token, as the server would check each one (`tokenAccess` per token), so
 * a player who selected their own creatures gets conditions and elevation
 * and nothing they would be refused.
 */
export function groupOffers(tokens: readonly GroupToken[], view: GroupView): GroupOffers {
  const access = tokens.map((token) => {
    const character = "ref" in token.actor ? view.characters[token.actor.ref] : undefined;
    return {
      token,
      access: tokenAccess({
        role: view.role,
        memberId: view.memberId,
        view: { characters: character ? { [character.id]: character } : {}, meta: { settings: { playersApplyDamage: view.playersApplyDamage } } },
        token,
      }),
    };
  });
  const creatures = access.filter((a) => a.token.kind !== "object");
  return {
    conditions: creatures.length > 0 && creatures.every((a) => a.access.effects),
    elevation: tokens.length > 0 && access.every((a) => a.access.canEditToken("elevation")),
    dm: view.role === "dm",
  };
}

/** One creature of the group, once per actor: two tokens of one character share their effects. */
export type GroupCreature = { holder: string; target: ActorTarget; effects: readonly Effect[] };

export function groupCreatures(tokens: readonly GroupToken[], characters: Readonly<Record<string, Character | undefined>>): GroupCreature[] {
  const seen = new Set<string>();
  const out: GroupCreature[] = [];
  for (const token of tokens) {
    if (token.kind === "object") continue;
    const holder = "ref" in token.actor ? `character:${token.actor.ref}` : `token:${token.id}`;
    if (seen.has(holder)) continue;
    seen.add(holder);
    const effects = "ref" in token.actor ? (characters[token.actor.ref]?.actor.effects ?? []) : token.actor.inline.effects;
    out.push({ holder, target: { tokenId: token.id }, effects });
  }
  return out;
}

/** Lit when every creature has it, half lit when some do. */
export type Lit = "all" | "some" | "none";

export function conditionLit(creatures: readonly GroupCreature[], key: Effect["key"]): Lit {
  const having = creatures.filter((c) => c.effects.some((e) => e.key === key)).length;
  if (having === 0) return "none";
  return having === creatures.length ? "all" : "some";
}

/**
 * A tap on a condition: lit, it comes off every creature that has it.
 * Otherwise it goes on every one that lacks it, Exhaustion at level 1 as
 * the single bar adds it. One `actor.effects` per 100 changes.
 */
export function conditionOps(creatures: readonly GroupCreature[], key: Effect["key"], newId: () => string): ClientOp[] {
  if (conditionLit(creatures, key) === "all") {
    const remove = creatures.flatMap((c) => c.effects.filter((e) => e.key === key).map((e) => ({ target: c.target, effectId: e.id })));
    return chunks(remove, LIMITS.effectsPerManyOp).map((part): ClientOp => ({ t: "actor.effects", remove: part }));
  }
  const add = creatures
    .filter((c) => !c.effects.some((e) => e.key === key))
    .map((c) => ({ target: c.target, effect: { id: newId(), key, ...(key === "exhaustion" ? { level: 1 } : {}) } }));
  return chunks(add, LIMITS.effectsPerManyOp).map((part): ClientOp => ({ t: "actor.effects", add: part }));
}

/** Every token's elevation moved by the same step, each from its own height. One `token.update` each, sent as one gesture. */
export function elevationOps(tokens: readonly Pick<Token, "id" | "elevation">[], delta: number): ClientOp[] {
  return tokens.map((t): ClientOp => ({ t: "token.update", tokenId: t.id, patch: { elevation: (t.elevation ?? 0) + delta } }));
}

/** The group's elevation when they all share one, else null. */
export function sharedElevation(tokens: readonly Pick<Token, "elevation">[]): number | null {
  const first = tokens[0]?.elevation ?? 0;
  return tokens.every((t) => (t.elevation ?? 0) === first) ? first : null;
}

export function flagLit(tokens: readonly GroupToken[], flag: "hidden" | "locked"): Lit {
  const on = tokens.filter((t) => (flag === "hidden" ? t.visibility === "dm" : t.locked)).length;
  if (on === 0) return "none";
  return on === tokens.length ? "all" : "some";
}

/** Hidden and Locked: lit for all, a tap turns it off for all. Otherwise a tap turns it on for all. */
export function flagPatch(tokens: readonly GroupToken[], flag: "hidden" | "locked"): TokenGroupPatch {
  const off = flagLit(tokens, flag) === "all";
  return flag === "hidden" ? { visibility: off ? "all" : "dm" } : { locked: !off };
}

/** One patch for every token: one `token.updateMany` per 100. */
export function updateManyOps(tokenIds: readonly string[], patch: TokenGroupPatch): ClientOp[] {
  return chunks(tokenIds, LIMITS.tokensPerManyOp).map((part): ClientOp => ({ t: "token.updateMany", tokenIds: part, patch }));
}

export function deleteManyOps(tokenIds: readonly string[]): ClientOp[] {
  return chunks(tokenIds, LIMITS.tokensPerManyOp).map((part): ClientOp => ({ t: "token.deleteMany", tokenIds: part }));
}

/**
 * Adds a member to every token's owners, or takes them off every one,
 * keeping each token's other owners. Tokens that end with the same list
 * share one `token.updateMany`, since its patch sets one list for all.
 */
export function ownerOps(tokens: readonly Pick<Token, "id" | "ownerIds">[], memberId: MemberId, on: boolean): ClientOp[] {
  const byList = new Map<string, { ownerIds: string[]; tokenIds: string[] }>();
  for (const t of tokens) {
    const current = t.ownerIds ?? [];
    if (current.includes(memberId) === on) continue;
    const ownerIds = on ? [...current, memberId] : current.filter((id) => id !== memberId);
    const key = JSON.stringify([...ownerIds].sort());
    const group = byList.get(key) ?? { ownerIds, tokenIds: [] };
    group.tokenIds.push(t.id);
    byList.set(key, group);
  }
  return [...byList.values()].flatMap((g) => updateManyOps(g.tokenIds, { ownerIds: g.ownerIds }));
}

/** Who owns every token, and who owns some. */
export function ownersLit(tokens: readonly Pick<Token, "ownerIds">[], memberId: MemberId): Lit {
  const having = tokens.filter((t) => (t.ownerIds ?? []).includes(memberId)).length;
  if (having === 0) return "none";
  return having === tokens.length ? "all" : "some";
}

/** The value every token shares, or undefined when they differ. */
export function shared<T>(tokens: readonly Token[], read: (t: Token) => T): T | undefined {
  const first = tokens[0];
  if (!first) return undefined;
  const value = read(first);
  return tokens.every((t) => read(t) === value) ? value : undefined;
}

/**
 * Whether every token shows the same image, and that image, which is
 * undefined both when they differ and when none has one. So the More
 * sheet tells "They differ" only for tokens that do, not for three
 * goblins that all draw their initials.
 */
export function sharedImage(tokens: readonly Pick<Token, "image">[]): { same: boolean; image: ImageRef | undefined } {
  const first = tokens[0]?.image;
  const same = tokens.every((t) => sameImage(t.image, first));
  return { same, image: same ? first : undefined };
}

/**
 * A two-tap Delete's words, as shown and as named. Armed with a question of
 * its own, "Delete 3 tokens?", the question is its name too, so a screen
 * reader hears what the button shows (LP5-ROLLS-12). The single token's bar
 * asks only "Sure?", so its armed name says what the second tap does.
 */
export function deleteButtonWords(armed: boolean, armedText?: string): { text: string; label: string } {
  if (!armed) return { text: "Delete", label: "Delete" };
  return armedText !== undefined ? { text: armedText, label: armedText } : { text: "Sure?", label: "Tap again to delete" };
}

/**
 * The selected tokens "Add to the fight" would add: those not in it yet,
 * objects left out, as the tracker's "Everyone here" and the group's
 * conditions leave them out. A box drawn over a fight often catches a
 * barrel or a marker, which takes no turn (LP5-ROLLS-7).
 */
export function fightCandidates<T extends Pick<Token, "id" | "kind">>(tokens: readonly T[], encounter: Pick<Encounter, "entries"> | null | undefined): T[] {
  const taken = new Set((encounter?.entries ?? []).map((e) => e.tokenId));
  return tokens.filter((t) => t.kind !== "object" && !taken.has(t.id));
}

/**
 * "Add to the fight": rows for the creatures not in it yet (fightCandidates).
 * With no fight on, the same tap starts one with them, as the tracker's
 * "Start a fight with" does.
 */
export function fightOps(tokens: readonly Pick<Token, "id" | "kind">[], encounter: Pick<Encounter, "entries"> | null | undefined, newId: () => string): ClientOp[] {
  const entries = fightCandidates(tokens, encounter).map((t) => ({ id: newId(), tokenId: t.id }));
  const parts = chunks(entries, MAX_ENTRIES_PER_OP);
  if (!encounter) {
    const [first = [], ...rest] = parts;
    return [{ t: "encounter.start", entries: first }, ...rest.map((part): ClientOp => ({ t: "encounter.add", entries: part }))];
  }
  return parts.map((part): ClientOp => ({ t: "encounter.add", entries: part }));
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
