import type { Character, MemberId, RoomState, Token } from "#shared/model.ts";
import type { ActorPatch, TokenPatch } from "#shared/protocol.ts";

/**
 * What this device may change on a token or a character, so the panels can
 * hide or disable what the role cannot do (design section 8.1). The server
 * decides for real in shared/permissions.ts. These lists mirror its owner
 * whitelists, and access.test.ts checks them against canApply, so the two
 * cannot drift apart unnoticed.
 *
 * A viewer's copy of the room is a projection: a player's copy of someone
 * else's token has no `ownerIds`, and their copy of someone else's character
 * has none either. Missing lists simply mean "not yours".
 */

/** Token fields an owner may patch. `name` and `publicName` only on a PC. */
export const OWNER_TOKEN_FIELDS: ReadonlySet<keyof TokenPatch> = new Set(["image", "altImages", "rotation", "elevation", "name", "publicName", "notes", "rangeRings", "light"]);
const OWNER_PC_ONLY_FIELDS: ReadonlySet<keyof TokenPatch> = new Set(["name", "publicName"]);
/**
 * What a companion's owners may patch beyond those (docs/design-v1-combat-flow.md
 * 3.6.4): its name, what it is, its turn and its Reaction. Its stats go
 * through `actor`, limited by OWNER_ACTOR_FIELDS, on the token itself.
 */
const COMPANION_OWNER_FIELDS: ReadonlySet<keyof TokenPatch> = new Set(["name", "actor", "kind", "companion", "companionReaction"]);

/** Actor fields an owner may patch, and only through `character.update`: an inline actor is the DM's. */
export const OWNER_ACTOR_FIELDS: ReadonlySet<keyof ActorPatch> = new Set([
  "hp",
  "speeds",
  "ac",
  "initBonus",
  "passivePerception",
  "senses",
  "notes",
  "sheetUrl",
]);

/**
 * The stat block links a companion's owners set beside those
 * (docs/design-v1-companion-stat-blocks.md 4.1): an SRD block or one of the
 * character's own, never a room monster.
 */
const COMPANION_OWNER_ACTOR_FIELDS: ReadonlySet<keyof ActorPatch> = new Set([...OWNER_ACTOR_FIELDS, "srdId", "blockId"]);

/**
 * The shape a character's players take on its own actor beside those
 * (docs/design-v1-pc-stats.md 4.1): an SRD creature and whether it is Wild
 * Shape, through `character.update`.
 */
const CHARACTER_OWNER_ACTOR_FIELDS: ReadonlySet<keyof ActorPatch> = new Set([...OWNER_ACTOR_FIELDS, "srdId", "wildShape"]);

/** Character fields an owner may patch, the stat block among them (docs/design-v1-pc-stats.md 4.1). `actor` is limited further by OWNER_ACTOR_FIELDS. */
export const OWNER_CHARACTER_FIELDS: ReadonlySet<string> = new Set(["name", "defaultImage", "actor", "level", "stats"]);

type View = Pick<RoomState, "characters"> | null | undefined;

function listed(ids: readonly MemberId[] | undefined, memberId: MemberId | null | undefined): boolean {
  return !!memberId && (ids ?? []).includes(memberId);
}

export function characterOf(view: View, token: Pick<Token, "actor">): Character | undefined {
  return "ref" in token.actor ? view?.characters[token.actor.ref] : undefined;
}

/** Ownership counts directly and through the token's character, as the server's `ownsToken` does. */
export function ownsToken(view: View, memberId: MemberId | null | undefined, token: Pick<Token, "ownerIds" | "actor">): boolean {
  if (listed(token.ownerIds, memberId)) return true;
  const character = characterOf(view, token);
  return character !== undefined && listed(character.ownerIds, memberId);
}

/**
 * Everyone who owns a token, directly or through its character, each once,
 * as ownsToken counts them. The Owners group's folded summary reads it, so
 * a PC whose player owns it only through the character card never reads
 * "None".
 */
export function tokenOwnerIds(view: View, token: Pick<Token, "ownerIds" | "actor">): MemberId[] {
  return [...new Set([...(token.ownerIds ?? []), ...(characterOf(view, token)?.ownerIds ?? [])])];
}

export function ownsCharacter(memberId: MemberId | null | undefined, character: Pick<Character, "ownerIds">): boolean {
  return listed(character.ownerIds, memberId);
}

/**
 * Whether the viewer may add, edit or shape a character's stat block: the
 * DM, or a player who owns the character, as the server's character.update
 * allows. A player who owns only a token of it, such as the DM's NPC lent to
 * them, may roll for it but not change it, so every entry point to the
 * editor and to a shape asks this one question (ASTRA-18).
 */
export function editsPcStats(you: { memberId: MemberId; role: Role } | null | undefined, character: Pick<Character, "ownerIds">): boolean {
  return you?.role === "dm" || ownsCharacter(you?.memberId, character);
}

export type Role = "dm" | "player";

export type TokenAccess = {
  dm: boolean;
  owner: boolean;
  /** The DM or an owner: sees the whole stat card and its numbers. */
  full: boolean;
  /** Where actor edits go: the character a PC token points at, or the token's own copy. */
  actorVia: "character" | "token";
  canEditToken(field: keyof TokenPatch): boolean;
  canEditActor(field: keyof ActorPatch): boolean;
  /** `all` for damage, healing, set and temp. `relative` is damage and healing only (the room's `playersApplyDamage`). */
  hp: "all" | "relative" | "none";
  effects: boolean;
  deathSaves: boolean;
  life: boolean;
  /** The DM or an owner of a companion: changes what it is and its turn (docs/design-v1-combat-flow.md 3.6.9). */
  companion: boolean;
  /** A companion's owner who is not the DM: Dismiss in Delete's place. */
  dismiss: boolean;
  /** Changes the creature's size on the fly (canResize). */
  resize: boolean;
};

/**
 * Who changes a creature's size on the fly (docs/design-v1-token-window.md
 * 8.1, shared/permissions.ts resizeCheck): the DM, on any token, and the
 * token's owners, companions included, while it is unlocked and its size
 * is one of the six. A Custom size is the DM's, and the DM's lock keeps a
 * token where it is. A player who may move any token does not own it.
 */
export function canResize(who: Pick<TokenAccess, "dm" | "owner">, token: { locked?: boolean; size?: Token["size"] }): boolean {
  return who.dm || (who.owner && token.locked !== true && token.size !== "custom");
}

export function tokenAccess(input: {
  role: Role;
  memberId: MemberId | null | undefined;
  view: (View & { meta?: { settings?: { playersApplyDamage?: boolean } } }) | null | undefined;
  token: Pick<Token, "ownerIds" | "actor" | "kind"> & { companion?: Token["companion"]; locked?: boolean; size?: Token["size"] };
}): TokenAccess {
  const { role, memberId, view, token } = input;
  const dm = role === "dm";
  const owner = !dm && ownsToken(view, memberId, token);
  const full = dm || owner;
  const actorVia = "ref" in token.actor ? "character" : "token";
  // A companion is to its player what their character is (docs/design-v1-combat-flow.md 3.6.4).
  const companionOwner = owner && token.companion !== undefined;
  // A character's card is its own players' to edit, as the server's character.update holds. A player who owns only a token of it, one lent to them, owns the token and none of the card.
  const character = characterOf(view, token);
  const playsCharacter = character !== undefined && ownsCharacter(memberId, character);
  return {
    dm,
    owner,
    full,
    actorVia,
    canEditToken(field) {
      if (dm) return true;
      if (companionOwner && COMPANION_OWNER_FIELDS.has(field)) return true;
      if (!owner || !OWNER_TOKEN_FIELDS.has(field)) return false;
      return !OWNER_PC_ONLY_FIELDS.has(field) || token.kind === "pc";
    },
    canEditActor(field) {
      if (dm) return true;
      if (companionOwner) return COMPANION_OWNER_ACTOR_FIELDS.has(field);
      return owner && playsCharacter && CHARACTER_OWNER_ACTOR_FIELDS.has(field);
    },
    hp: full ? "all" : view?.meta?.settings?.playersApplyDamage ? "relative" : "none",
    effects: full,
    deathSaves: full,
    life: dm,
    companion: token.companion !== undefined && full,
    dismiss: companionOwner,
    resize: canResize({ dm, owner }, token),
  };
}

export type CharacterAccess = {
  dm: boolean;
  owner: boolean;
  full: boolean;
  canEdit(field: "name" | "size" | "ownerIds" | "defaultImage" | "level" | "stats"): boolean;
  canEditActor(field: keyof ActorPatch): boolean;
};

export function characterAccess(input: { role: Role; memberId: MemberId | null | undefined; character: Pick<Character, "ownerIds"> }): CharacterAccess {
  const dm = input.role === "dm";
  const owner = !dm && ownsCharacter(input.memberId, input.character);
  return {
    dm,
    owner,
    full: dm || owner,
    canEdit: (field) => dm || (owner && OWNER_CHARACTER_FIELDS.has(field)),
    canEditActor: (field) => dm || (owner && CHARACTER_OWNER_ACTOR_FIELDS.has(field)),
  };
}
