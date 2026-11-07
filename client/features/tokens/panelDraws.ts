import type { Actor, Character, MemberId, Token } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { hpLess } from "#shared/rules/hp.ts";
import { isCompanion } from "../../canvas/barButtons.ts";
import { statBlockShown } from "../monsters/statBlockLink.ts";
import type { FieldHolder } from "../search/catalog/types.ts";
import { characterAccess, ownsCharacter, tokenAccess, type CharacterAccess, type TokenAccess } from "./access.ts";
import { cardGroups, holdsClassResources, panelGroups, type CardPartId, type PanelGroupId, type PanelPart, type PanelSectionId } from "./panelOrder.ts";

/*
 * What a creature's two surfaces draw for one viewer: the token panel and
 * a character's page. Each surface draws from this, and the room search
 * offers a creature's field only where this says its control stands, so
 * a picked row never waits on an anchor its surface left out.
 */

export type TokenPanelDraws = {
  parts: PanelPart[];
  /** A player who plays the token's character, which a player lent only the token does not. */
  playsCharacter: boolean;
  classResources: boolean;
  /** Stats holds the stat card (Armor Class, the speeds, Passive Perception and Senses), not the bar's Size alone. */
  statCard: boolean;
  /** The card leaves out Armor Class while `hpLess` holds. */
  noAc: boolean;
  /** The character's stat block gives the card's initiative and Passive Perception. */
  fromBlock: boolean;
  /** The stat card's rows the search lands on, or null with no card. */
  stats: StatRows | null;
  /** Notes holds the card's own notes. */
  cardNotes: boolean;
};

/** The stat card's rows the room search lands on, each true where StatsFields draws it. */
export type StatRows = { ac: boolean; pp: boolean; senses: boolean; walk: boolean };

/**
 * StatsFields' rule for its searched rows: a row the viewer may not change
 * draws nothing without a value, so a card with no Armor Class set shows
 * none to an owner who may not set one.
 */
export function statRows(input: { actor: Partial<Actor>; canEdit(field: keyof ActorPatch): boolean; noAc: boolean; fromBlock: boolean }): StatRows {
  const { actor, canEdit } = input;
  return {
    ac: !input.noAc && (canEdit("ac") || actor.ac !== undefined),
    pp: (!input.fromBlock && canEdit("passivePerception")) || actor.passivePerception !== undefined,
    // Senses reads "None" with nothing set, and Walk Speed is 30 ft until set.
    senses: true,
    walk: true,
  };
}

/**
 * The token panel for one viewer. What the panel learns only as it draws
 * (the creature's uses, its Reaction and the bar's attach control) adds
 * sections the search never routes to, so the search leaves them out.
 */
export function tokenPanelDraws(input: {
  access: TokenAccess;
  memberId: MemberId | null | undefined;
  token: Token;
  character: Character | undefined;
  uses?: "yes" | "loading" | "no";
  reaction?: boolean;
  attach?: boolean;
}): TokenPanelDraws {
  const { access, token, character } = input;
  const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
  // A player lent only a token of a character holds none of its card (docs/design/design-v1-pc-stats.md 4.2), so it has no stat card to show or edit there.
  const playsCharacter = character !== undefined && ownsCharacter(input.memberId, character);
  const cardNotes = access.full && actor !== undefined && (access.canEditActor("notes") || actor.notes !== undefined);
  const statCard = actor !== undefined && (character === undefined || access.dm || playsCharacter);
  const classResources = holdsClassResources({ dm: access.dm, character: character !== undefined, playsCharacter });
  const companion = isCompanion(token);
  const parts = panelGroups({
    dm: access.dm,
    owner: access.owner,
    kind: token.kind,
    companion,
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor, companion, character: "ref" in token.actor, ownsCharacter: character ? playsCharacter : undefined }),
    actor: statCard,
    ownerRenames: !access.dm && access.canEditToken("name"),
    classResources,
    uses: input.uses ?? "no",
    reaction: input.reaction ?? false,
    attach: input.attach ?? false,
    locked: token.locked,
    dismiss: access.dismiss,
    notes: access.canEditToken("notes") || !!token.notes || access.dm || cardNotes,
    image: access.canEditToken("image"),
  });
  const noAc = hpLess(actor, token);
  const fromBlock = character?.stats !== undefined;
  const stats = statCard && actor ? statRows({ actor, canEdit: access.canEditActor, noAc, fromBlock }) : null;
  return { parts, playsCharacter, classResources, statCard, noAc, fromBlock, stats, cardNotes };
}

/** Whether the panel's parts hold a section, alone or in its group. */
export function panelHolds(parts: readonly PanelPart[], id: PanelSectionId): boolean {
  return parts.some((p) => (p.group === null ? p.id === id : p.sections.includes(id)));
}

/** Whether the panel draws a group, whose header holds the group's anchor. */
export function panelGroupDrawn(parts: readonly PanelPart[], id: PanelGroupId): boolean {
  return parts.some((p) => p.group === id);
}

export type CharacterPageDraws = {
  parts: CardPartId[];
  /** The page's stat card leaves out Armor Class while `hpLess` holds. */
  noAc: boolean;
  /** The character's stat block gives the card's initiative and Passive Perception. */
  fromBlock: boolean;
  stats: StatRows;
};

/** A character's page for one viewer. */
export function characterPageDraws(input: { access: CharacterAccess; character: Character }): CharacterPageDraws {
  const { access } = input;
  const { actor } = input.character;
  const notes = access.canEditActor("notes") || !!actor.notes?.trim() || access.dm;
  const noAc = hpLess(actor);
  const fromBlock = input.character.stats !== undefined;
  return {
    parts: cardGroups({ dm: access.dm, plays: access.owner, statBlock: access.full, companions: true, notes, image: access.canEdit("defaultImage") }),
    noAc,
    fromBlock,
    stats: statRows({ actor, canEdit: access.canEditActor, noAc, fromBlock }),
  };
}

/**
 * A room search field's `shown`: the field is offered only where its
 * surface draws its control, `onPanel` reading the token panel for the
 * selection and `onPage` a character's page.
 */
export function drawn(onPanel: (d: TokenPanelDraws) => boolean, onPage: (d: CharacterPageDraws) => boolean): (h: FieldHolder) => boolean {
  return (h) => {
    const { token, character } = h;
    if (h.surface === "token") {
      if (!token) return false;
      const access = tokenAccess({ role: h.role, memberId: h.memberId, view: { characters: character ? { [character.id]: character } : {} }, token });
      return onPanel(tokenPanelDraws({ access, memberId: h.memberId, token, character }));
    }
    return character !== undefined && onPage(characterPageDraws({ access: characterAccess({ role: h.role, memberId: h.memberId, character }), character }));
  };
}
