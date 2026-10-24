import type { Actor, Character, RoomState, Token } from "#shared/model.ts";
import { SIZE_CELLS } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { footprint } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { DISPOSITION_RING, initials } from "../../lib/tokenView.ts";
import type { CreaturePicture } from "../tokens/CreatureHeader.tsx";
import { characterKind, kindLine, sizeText, tokenKind, type KindLine } from "../tokens/creatureKind.ts";

/*
 * What the Dice panel's creature card shows of who it rolls for
 * (docs/design-v1-dice-pass.md 5): the picture, a companion's badge and
 * the kind line, built as the token panel's header builds them
 * (panels/TokenPanel.tsx NameBlock), so a creature reads alike in both.
 * Plain functions for node --test. The card itself reads no room.
 */

/** A companion's character's portrait, worn on the companion's picture. */
export type CreatureBadge = Omit<CreaturePicture, "shape" | "aspect" | "ring">;

export type CreatureLook = { picture: CreaturePicture; badge: CreatureBadge | null; line: KindLine };

/**
 * A token's look: its own image in its footprint's shape, an object's
 * square, and a companion's character's portrait as its badge where the
 * viewer's copy holds that character.
 */
export function tokenLook(input: {
  token: Pick<Token, "kind" | "image" | "size" | "w" | "h" | "disposition" | "companion">;
  name: string;
  /** A companion's character, where the viewer's copy holds it. */
  keeper?: Pick<Character, "name" | "defaultImage"> | undefined;
  /** The character a player character's token is of, where the viewer's copy holds it. */
  character?: Pick<Character, "level" | "actor"> | undefined;
  cr?: string | undefined;
  feetPerCell: number;
}): CreatureLook {
  const { token, keeper } = input;
  const fp = footprint(token);
  const kind = tokenKind({ token, companionOf: keeper?.name, character: input.character, cr: input.cr });
  return {
    picture: { image: token.image, shape: token.kind === "object" ? "square" : "circle", aspect: fp.w / fp.h, ring: DISPOSITION_RING[token.disposition] ?? theme.color.neutral, initials: initials(input.name) },
    badge: keeper ? { image: keeper.defaultImage, initials: initials(keeper.name) } : null,
    line: kindLine(kind, sizeText(token.size, fp, input.feetPerCell)),
  };
}

/**
 * A character with no token to show, as a player's pick off the scene: its
 * portrait in the party's ring, as its own page draws it. A character's
 * size is one of the six, Custom being a token's alone.
 */
export function characterLook(character: Pick<Character, "name" | "defaultImage" | "size" | "level" | "actor">, feetPerCell: number): CreatureLook {
  const cells = character.size === "custom" ? 1 : SIZE_CELLS[character.size];
  return {
    picture: { image: character.defaultImage, shape: "circle", aspect: 1, ring: theme.color.ally, initials: initials(character.name) },
    badge: null,
    line: kindLine(characterKind(character), sizeText(character.size, { w: cells, h: cells }, feetPerCell)),
  };
}

/**
 * The look of the creature the panel rolls for, from the viewer's copy:
 * its token where it has one in view (`tokenId`, as a player's pick
 * carries), since that is the picture on the map, else its character.
 * Null for a creature the copy no longer holds.
 */
export function creatureLook(input: {
  view: Pick<RoomState, "tokens" | "characters" | "meta">;
  creature: ActorTarget;
  tokenId?: string | undefined;
  name: string;
}): CreatureLook | null {
  const { view, creature, name } = input;
  const feetPerCell = view.meta.settings.feetPerCell;
  const tokenId = input.tokenId ?? ("tokenId" in creature ? creature.tokenId : undefined);
  const token = tokenId !== undefined ? view.tokens[tokenId] : undefined;
  if (token) {
    const character = "ref" in token.actor ? view.characters[token.actor.ref] : undefined;
    const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
    const keeper = token.companion ? view.characters[token.companion.of] : undefined;
    return tokenLook({ token, name, keeper, character, cr: actor?.cr, feetPerCell });
  }
  if ("tokenId" in creature) return null;
  const character = view.characters[creature.characterId];
  return character ? characterLook(character, feetPerCell) : null;
}
