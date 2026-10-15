import type { Actor, CustomMonster, MonsterId, Token } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";

/**
 * Which full stat block a token links to (docs/design-v1-dm-tools.md 3.6),
 * as plain functions for node --test. A token keeps one link: the room
 * monster it came from (`Actor.monsterId`, the DM's alone) or the SRD
 * monster (`Actor.srdId`). The block is read where the token is, while
 * the token's own HP, AC, speeds and conditions stay its own, since the
 * token is an independent copy that may have changed since it was placed.
 */

export type TokenStatBlock =
  /** One of the room's own monsters. */
  | { kind: "room"; monster: CustomMonster }
  /** An SRD monster, read from the SRD chunk once it loads. */
  | { kind: "srd"; srdId: string }
  /** A room monster deleted since the token was linked. */
  | { kind: "deleted"; monsterId: MonsterId }
  | { kind: "none" };

/** The link a token's actor holds. A room monster's link wins over an SRD id, since attaching one clears the other. */
export function tokenStatBlock(actor: Pick<Actor, "srdId" | "monsterId"> | undefined, monsters: Readonly<Record<string, CustomMonster | undefined>> | undefined): TokenStatBlock {
  if (actor?.monsterId !== undefined) {
    const monster = monsters?.[actor.monsterId];
    return monster ? { kind: "room", monster } : { kind: "deleted", monsterId: actor.monsterId };
  }
  if (actor?.srdId !== undefined) return { kind: "srd", srdId: actor.srdId };
  return { kind: "none" };
}

/** Whether the section has a block to fold: a link with nothing to show, none or a deleted monster, shows its note whatever Hide says. */
export function statBlockFoldable(link: TokenStatBlock): boolean {
  return link.kind === "room" || link.kind === "srd";
}

/**
 * Who reads the block on this token. The DM, on a monster or an NPC. An
 * owner, only for an SRD monster they play, such as a druid's Wild Shape:
 * the SRD is openly licensed and the owner already receives `srdId`. A room
 * monster's block never reaches a player, since it may be text from a book
 * the group owns, and their projection never carries `monsterId` anyway.
 */
export function statBlockShown(input: { dm: boolean; owner: boolean; kind: Token["kind"]; actor: Pick<Actor, "srdId"> | undefined }): boolean {
  if (input.dm) return input.kind === "monster" || input.kind === "npc";
  return input.owner && input.actor?.srdId !== undefined;
}

/** Links a block and only the link: never the token's numbers. Attaching one kind clears the other, so the token has one block. */
export function attachPatch(link: { monsterId: MonsterId } | { srdId: string }): ActorPatch {
  return "monsterId" in link ? { monsterId: link.monsterId, srdId: null } : { srdId: link.srdId, monsterId: null };
}

export const DETACH_PATCH: ActorPatch = { monsterId: null, srdId: null };

export type Suggestion = { key: string; link: { monsterId: MonsterId } | { srdId: string }; view: StatBlockMonster; source: "room" | "srd" };

/**
 * The monsters the attach picker suggests for a token with no link: the
 * room's own and the SRD's of exactly its name, letter case aside, the
 * room's first since the DM entered those for this table.
 */
export function nameSuggestions(
  name: string,
  room: readonly { monster: CustomMonster; view: StatBlockMonster }[],
  srd: readonly (StatBlockMonster & { srdId: string })[],
): Suggestion[] {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return [];
  const out: Suggestion[] = [];
  for (const { monster, view } of room) {
    if (view.name.trim().toLowerCase() === wanted) out.push({ key: `room:${monster.id}`, link: { monsterId: monster.id }, view, source: "room" });
  }
  for (const m of srd) {
    if (m.name.trim().toLowerCase() === wanted) out.push({ key: `srd:${m.srdId}`, link: { srdId: m.srdId }, view: m, source: "srd" });
  }
  return out;
}
