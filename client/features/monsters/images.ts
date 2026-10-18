import type { IconImage, ImageRef, RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { SRD_TOKEN_ICONS } from "#shared/srd/tokenIcons.ts";
import { sameImage as sameImageRef } from "#shared/imageRef.ts";

/**
 * Default images for monsters (features section 15): the image every token
 * placed from a monster starts with, and the DM's option to put a new one on
 * the monster's tokens already on the map. Kept free of React, so the rules
 * for which tokens belong to a monster and which ops an apply sends run
 * under plain Node.
 *
 * An SRD monster's image lives in the room's `srdImages`, keyed by its SRD
 * id. Until the DM sets one it is the monster's shipped icon
 * (shared/srd/tokenIcons.ts, docs/design-v1-starter-art.md section 6),
 * read here and never stored: the DM's choice always wins, and a room made
 * before the defaults gets them with no migration. A room's own monster
 * carries its image in its stat block record and has no default.
 */

/** Which monster: an SRD one by its slug, or one of the room's own by its id. */
export type MonsterRef = { srdId: string } | { monsterId: string };

type Images = Pick<RoomState, "monsters" | "srdImages">;

/**
 * The image the monster's tokens start with: the DM's choice, else an SRD
 * monster's shipped icon, or undefined for a room monster without one and
 * an id the SRD does not have. A view from before images reads as no
 * choice.
 */
export function monsterImage(state: Partial<Images>, ref: MonsterRef): ImageRef | undefined {
  if ("srdId" in ref) return state.srdImages?.[ref.srdId]?.image ?? shippedImage(ref);
  return state.monsters?.[ref.monsterId]?.defaultImage;
}

/**
 * The image a monster shows when the room has none of its own for it: an
 * SRD monster's shipped icon, as a copy so no caller can change the table,
 * and nothing for the room's own. The table is a plain object, so an id
 * such as "constructor" must not find what every object inherits.
 */
export function shippedImage(ref: MonsterRef): IconImage | undefined {
  if (!("srdId" in ref) || !Object.hasOwn(SRD_TOKEN_ICONS, ref.srdId)) return undefined;
  const { icon, color } = SRD_TOKEN_ICONS[ref.srdId]!;
  return { icon, color };
}

/**
 * Which monster a stat block in the browser is: the room's own when the
 * caller knows its id, an SRD one by the `srdId` its view carries, or none
 * for a stat block from neither.
 */
export function refOf(view: Pick<StatBlockMonster, "srdId">, monsterId?: string): MonsterRef | undefined {
  if (monsterId !== undefined) return { monsterId };
  return view.srdId !== undefined ? { srdId: view.srdId } : undefined;
}

export function sameImage(a: ImageRef | undefined, b: ImageRef | undefined): boolean {
  return sameImageRef(a, b);
}

/** What makes two images the same picture whatever their crop: the asset, or the icon's key. */
function pictureOf(image: ImageRef): string {
  return "icon" in image ? `icon:${image.icon}` : `asset:${image.assetId}`;
}

/**
 * Whether a token was placed from this monster. Tokens are independent
 * copies (design section 6), so this reads what a token keeps of where it
 * came from:
 * - An SRD monster's tokens carry its SRD id in their actor, so a goblin the
 *   DM renamed "Snik" is still a Goblin Warrior.
 * - A room monster's tokens placed since wave 5 carry its id
 *   (`Actor.monsterId`, docs/design-v1-dm-tools.md 3.6), which decides.
 * - Older ones, and tokens the DM detached, are found by name, the way the
 *   initiative tracker groups them (groupKeyFor in
 *   shared/rules/initiative.ts): a monster or NPC token with exactly that
 *   name and no SRD id. A token renamed by hand, or one placed before the
 *   monster was renamed, no longer counts, and two of the room's monsters
 *   with one name share their tokens.
 */
export function isTokenOf(token: Pick<Token, "kind" | "name" | "actor">, ref: MonsterRef, monsters: Partial<Images>["monsters"]): boolean {
  if (!("inline" in token.actor)) return false;
  const srdId = token.actor.inline.srdId;
  if ("srdId" in ref) return srdId === ref.srdId;
  const linked = token.actor.inline.monsterId;
  if (linked !== undefined) return linked === ref.monsterId;
  const monster = monsters?.[ref.monsterId];
  return monster !== undefined && srdId === undefined && (token.kind === "monster" || token.kind === "npc") && token.name === monster.name;
}

/**
 * What putting a monster's image on its tokens on one scene would change.
 * Tokens keep no record of who chose their image, so one counts as set by
 * hand when it wears a picture the monster never gave it: not this image,
 * not an SRD monster's shipped icon, and none of the images this monster
 * had while its page was open on this device. The shipped icon stays the
 * monster's after the DM picks another, since tokens placed before that
 * pick wear it.
 *
 * A token a player plays, owned by one or a player character, is never
 * repainted unless the DM asks, whatever it wears: it may be a druid's
 * Wild Shape placed from the SRD, and its look is the player's.
 */
export type ApplyPlan = {
  /** No image, or this monster's own: its shipped icon, an image it had before, or this picture under another crop. */
  plain: string[];
  /** An image of its own, chosen for that token. Replaced only when the DM asks. */
  own: string[];
  /** A token a player plays. Replaced only when the DM asks, with those set by hand. */
  played: string[];
  /** Already wearing exactly this image. */
  done: number;
};

export function planApply(input: {
  tokens: Iterable<Token | undefined>;
  sceneId: string;
  ref: MonsterRef;
  monsters: Partial<Images>["monsters"];
  image: ImageRef;
  /** The monster's earlier images this device saw, oldest first. */
  previous?: readonly ImageRef[];
}): ApplyPlan {
  const plan: ApplyPlan = { plain: [], own: [], played: [], done: 0 };
  const shipped = shippedImage(input.ref);
  const ours = new Set([pictureOf(input.image), ...(shipped ? [pictureOf(shipped)] : []), ...(input.previous ?? []).map(pictureOf)]);
  for (const token of input.tokens) {
    if (!token || token.sceneId !== input.sceneId || !isTokenOf(token, input.ref, input.monsters)) continue;
    if (sameImage(token.image, input.image)) plan.done++;
    else if ((token.ownerIds?.length ?? 0) > 0 || token.kind === "pc") plan.played.push(token.id);
    else if (!token.image || ours.has(pictureOf(token.image))) plan.plain.push(token.id);
    else plan.own.push(token.id);
  }
  plan.plain.sort();
  plan.own.sort();
  plan.played.sort();
  return plan;
}

/** How many tokens wait for the DM's say: those set by hand and those players play. */
export function optInCount(plan: ApplyPlan): number {
  return plan.own.length + plan.played.length;
}

/** The switch that lets the DM include them, named for what is in the group. */
export function optInLabel(plan: ApplyPlan): string {
  const byHand = plan.own.length;
  const played = plan.played.length;
  const n = byHand + played;
  if (played === 0) return n === 1 ? "Include the 1 with an image set by hand" : `Include the ${n} with images set by hand`;
  if (byHand === 0) return n === 1 ? "Include the 1 token a player plays" : `Include the ${n} tokens players play`;
  return `Include the ${n} set by hand or played by players`;
}

/**
 * One `token.update` per token, carrying the image alone so nothing else
 * about a token changes. The caller sends them as one gesture
 * (dispatchGesture in client/state/actions.ts), so one undo takes them all
 * back.
 */
export function applyOps(plan: ApplyPlan, image: ImageRef, includeOwn: boolean): ClientOp[] {
  const ids = includeOwn ? [...plan.plain, ...plan.own, ...plan.played] : plan.plain;
  const copy = (): ImageRef => ("icon" in image ? { icon: image.icon, color: image.color } : { assetId: image.assetId, crop: { ...image.crop } });
  return ids.map((tokenId) => ({ t: "token.update", tokenId, patch: { image: copy() } }));
}
