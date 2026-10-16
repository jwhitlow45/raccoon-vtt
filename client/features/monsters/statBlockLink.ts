import type { Actor, CompanionBlock, CompanionBlockId, CustomMonster, MonsterId, Token } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";

/**
 * Which full stat block a token links to (docs/design-v1-dm-tools.md 3.6,
 * docs/design-v1-companion-stat-blocks.md 3.2), as plain functions for
 * node --test. A token keeps one link: the room monster it came from
 * (`Actor.monsterId`, the DM's alone), the SRD monster (`Actor.srdId`), or
 * on a companion, one of its character's stat blocks (`Actor.blockId`).
 * The block is read where the token is, while the token's own HP, AC,
 * speeds and conditions stay its own, since the token is an independent
 * copy that may have changed since it was placed.
 */

export type TokenStatBlock =
  /** One of the room's own monsters. */
  | { kind: "room"; monster: CustomMonster }
  /** An SRD monster, read from the SRD chunk once it loads. */
  | { kind: "srd"; srdId: string }
  /** One of its character's companion stat blocks. */
  | { kind: "block"; block: CompanionBlock }
  /** A room monster deleted since the token was linked. */
  | { kind: "deleted"; monsterId: MonsterId }
  /** A companion stat block deleted since the companion was linked. */
  | { kind: "deletedBlock"; blockId: CompanionBlockId }
  | { kind: "none" };

type Blocks = Readonly<Record<string, CompanionBlock | undefined>> | undefined;

/**
 * The link a token's actor holds: a companion's block, then a room
 * monster, then an SRD id. An actor holds one since attaching any clears
 * the others, so the order matters only for data from before that rule.
 */
export function tokenStatBlock(actor: Pick<Actor, "srdId" | "monsterId" | "blockId"> | undefined, monsters: Readonly<Record<string, CustomMonster | undefined>> | undefined, blocks?: Blocks): TokenStatBlock {
  if (actor?.blockId !== undefined) {
    const block = blocks?.[actor.blockId];
    return block ? { kind: "block", block } : { kind: "deletedBlock", blockId: actor.blockId };
  }
  if (actor?.monsterId !== undefined) {
    const monster = monsters?.[actor.monsterId];
    return monster ? { kind: "room", monster } : { kind: "deleted", monsterId: actor.monsterId };
  }
  if (actor?.srdId !== undefined) return { kind: "srd", srdId: actor.srdId };
  return { kind: "none" };
}

/** Whether the section has a block to fold: a link with nothing to show, none or a deleted block, shows its note whatever Hide says. */
export function statBlockFoldable(link: TokenStatBlock): boolean {
  return link.kind === "room" || link.kind === "srd" || link.kind === "block";
}

/**
 * Who reads the block on this token. On a companion, the DM and its
 * players, whatever it links, while it is a creature: an effect has no
 * block (docs/design-v1-companion-stat-blocks.md 5.5). Elsewhere the DM, on
 * a monster or an NPC, and an owner only for an SRD monster they play, such
 * as a druid's Wild Shape: the SRD is openly licensed and the owner already
 * receives `srdId`. A room monster's block never reaches a player, since
 * it may be text from a book the group owns, and their projection never
 * carries `monsterId` anyway.
 */
export function statBlockShown(input: { dm: boolean; owner: boolean; kind: Token["kind"]; actor: Pick<Actor, "srdId"> | undefined; companion?: boolean }): boolean {
  if (input.companion) return (input.dm || input.owner) && input.kind !== "object";
  if (input.dm) return input.kind === "monster" || input.kind === "npc";
  return input.owner && input.actor?.srdId !== undefined;
}

/**
 * Whether "Stat block" in the bar or a tracker row has a block to open for
 * this viewer: one they read, linked and still there.
 */
export function opensStatBlock(shown: boolean, link: TokenStatBlock): boolean {
  return shown && (link.kind === "room" || link.kind === "srd" || link.kind === "block");
}

export type BlockLink = { monsterId: MonsterId } | { srdId: string } | { blockId: CompanionBlockId };

/**
 * Links a block and only the link: never the token's numbers. Setting one
 * link clears the others (docs/design-v1-companion-stat-blocks.md 3.2), so
 * the patch names only the one it sets, which lets a companion's player
 * replace a room monster's link they never see.
 */
export function attachPatch(link: BlockLink): ActorPatch {
  if ("monsterId" in link) return { monsterId: link.monsterId };
  if ("blockId" in link) return { blockId: link.blockId };
  return { srdId: link.srdId };
}

/** The DM's Detach, which clears whichever link the token holds. */
export const DETACH_PATCH: ActorPatch = { monsterId: null, srdId: null, blockId: null };

/** A companion's player's Detach, which names only the links a player may set. A room monster's link is the DM's. */
export const OWNER_DETACH_PATCH: ActorPatch = { srdId: null, blockId: null };

export type Suggestion = { key: string; link: BlockLink; view: StatBlockMonster; source: "room" | "srd" | "block" };

/**
 * The blocks a picker suggests for a token with no link: those of exactly
 * its name, letter case aside, from the lists it offers in their order (the
 * room's own monsters or the character's own blocks first, then the SRD's).
 */
export function nameSuggestions(name: string, own: readonly Suggestion[], srd: readonly (StatBlockMonster & { srdId: string })[]): Suggestion[] {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return [];
  const out: Suggestion[] = own.filter((s) => s.view.name.trim().toLowerCase() === wanted);
  for (const m of srd) {
    if (m.name.trim().toLowerCase() === wanted) out.push({ key: `srd:${m.srdId}`, link: { srdId: m.srdId }, view: m, source: "srd" });
  }
  return out;
}
