import type { RoomState, TokenKind } from "#shared/model.ts";
import { reactionTarget } from "../encounter/ready.ts";
import type { SelfRef } from "./durations.ts";

/*
 * The token panel's order (docs/design-v1-token-panel.md 3.5), ranked by
 * use: the name, the image, the stat block, then play from HP down, and setup folded at the foot. A plain function
 * for node --test. Each section still keeps its own rule for what it
 * shows, so a section listed here may draw nothing, such as Notes with no
 * note a player may read.
 */

export type PanelSectionId =
  | "name"
  | "image"
  | "statBlock"
  | "hp"
  | "conditions"
  | "uses"
  | "reaction"
  | "position"
  | "attach"
  | "rangeRings"
  | "notes"
  | "rest"
  | "sight"
  | "stats"
  | "settings"
  | "companion"
  | "owners"
  | "remove";

export type PanelOrderInput = {
  dm: boolean;
  /** An owner of the token, directly or through its character, who is not the DM. */
  owner: boolean;
  kind: TokenKind;
  /** The token is a companion (docs/design-v1-combat-flow.md 3.6). */
  companion: boolean;
  /** The viewer reads this token's stat block (statBlockLink.ts statBlockShown). */
  statBlockShown: boolean;
  /** The viewer's copy holds an actor, whose stat card the Stats fold edits. */
  actor: boolean;
  /** An owner who may rename the token, a PC's or a companion's, whose Name fields sit in Token settings. */
  ownerRenames: boolean;
  /**
   * The token is a character's and the viewer is the DM or plays it, so it
   * holds the character's class resources (docs/design-v1-combat-controls.md 7.2),
   * which its Uses lists and adds to.
   */
  classResources?: boolean;
  /** Whether the creature has uses to show this viewer (CombatUses.tsx useUsesPresence), as the bar's Uses button reads it. */
  uses?: "yes" | "loading" | "no";
  /** The viewer may mark the creature's Reaction used in the fight (encounter/ReactionSection.tsx reactionFor). */
  reaction?: boolean;
  /** The bar offers this viewer an attach control for the token (attach/detach.ts attachControls). */
  attach?: boolean;
  /** The DM locked the token, which keeps its size from its owners. */
  locked?: boolean;
  /** A companion's owner who is not the DM, who dismisses it in Delete's place (access.ts `dismiss`). */
  dismiss?: boolean;
};

/**
 * Combat's sections in their order (docs/design-v1-token-sections.md 3):
 * what a fight changes turn by turn first, then the rings, which are set
 * once and read on the map, then Rest. A character's page keeps the same
 * order without the rings (cardCombat).
 */
const COMBAT: readonly PanelSectionId[] = ["hp", "conditions", "uses", "reaction", "rangeRings", "rest"];

export function panelSections(input: PanelOrderInput): PanelSectionId[] {
  const { dm, owner } = input;
  const full = dm || owner;
  const out: PanelSectionId[] = ["name", "image"];
  if (input.statBlockShown) out.push("statBlock");
  out.push("hp", "conditions");
  // Uses never reach anyone else, whose copy holds none of a creature's uses. A character's always stand for the DM and its players, so Add is reached with none yet.
  if (full && (input.classResources === true || (input.uses ?? "no") !== "no")) out.push("uses");
  if (input.reaction) out.push("reaction");
  if (full) out.push("position");
  // Whoever the bar offers Attach, Get off, Let go or Put down gets the same here, a player who is not an owner included (D-261024-40).
  if (input.attach) out.push("attach");
  out.push("rangeRings", "notes");
  if (full && input.kind !== "object") out.push("rest");
  if (full) out.push("sight");
  // A player lent a character's token holds no stat card, but sizes the token from the bar while it is unlocked, so Stats holds that Size alone.
  if ((full && input.actor) || (owner && input.locked !== true)) out.push("stats");
  if (dm || input.ownerRenames) out.push("settings");
  // Next to Owners, which a companion's link decides.
  if (input.companion && full) out.push("companion");
  if (dm) out.push("owners");
  if (dm || input.dismiss === true) out.push("remove");
  return out;
}

/**
 * Whether the DM's Token settings hold "Make a companion": on any token
 * that is neither a PC nor already a companion (docs/design-v1-combat-flow.md
 * 3.6.9). The button and its form are that design's.
 */
export function offersMakeCompanion(input: Pick<PanelOrderInput, "dm" | "kind" | "companion">): boolean {
  return input.dm && input.kind !== "pc" && !input.companion;
}

/**
 * Whether a token's panel holds its character's class resources, which its
 * Uses lists, edits and adds to: on a character's token, for the DM and
 * the character's players (docs/design-v1-combat-controls.md 7.2). A
 * player lent only the token holds nothing of the character's card, its
 * resources included.
 */
export function holdsClassResources(input: { dm: boolean; character: boolean; playsCharacter: boolean }): boolean {
  return input.character && (input.dm || input.playsCharacter);
}

/** The panel's groups by use (docs/design-v1-token-panel-groups.md 2). Each folds as one. */
export type PanelGroupId = "combat" | "notes" | "position" | "image";

/** One part of the panel, top to bottom: a section on its own, or a group of sections under one fold. */
export type PanelPart = { group: null; id: PanelSectionId } | { group: PanelGroupId; sections: PanelSectionId[] };

export type PanelGroupsInput = PanelOrderInput & {
  /** The viewer has a note here to read or write: one for everyone, the card's, the DM's, or the right to write one. */
  notes: boolean;
  /** The viewer may change the token's picture. */
  image: boolean;
};

const PLACE: readonly PanelSectionId[] = ["position", "attach", "sight"];
const SETUP: readonly PanelSectionId[] = ["stats", "settings", "companion", "owners", "remove"];

/**
 * The panel grouped by use, as the project owner asked (2026-10-17): the
 * name with its picture and quick numbers, the stat block, then Combat
 * (what a fight changes), Notes, Position and Image, then setup. Each
 * group holds panelSections' sections in its order, so nothing moves
 * against its neighbors, and a group with nothing in it is not drawn.
 *
 * The quick numbers and the picture stand in the name's header, the
 * picture's buttons in Image. Position is the DM's and the owners', and a
 * viewer's the bar offers an attach control, who sees those controls
 * alone: a player looking at another creature reads its elevation in the
 * quick numbers. Notes shows only with a note to read or write.
 */
export function panelGroups(input: PanelGroupsInput): PanelPart[] {
  const sections = panelSections(input);
  const has = (id: PanelSectionId) => sections.includes(id);
  const out: PanelPart[] = [];
  const alone = (ids: readonly PanelSectionId[]) => {
    for (const id of ids) if (has(id)) out.push({ group: null, id });
  };
  const group = (id: PanelGroupId, ids: readonly PanelSectionId[]) => {
    const held = ids.filter(has);
    if (held.length > 0) out.push({ group: id, sections: held });
  };
  alone(["name", "statBlock"]);
  group("combat", COMBAT);
  if (input.notes) group("notes", ["notes"]);
  group("position", PLACE);
  if (input.image) group("image", ["image"]);
  alone(SETUP);
  return out;
}

/** Whose folds a viewer's taps keep: their own creatures' (the DM's, an owner's) or other creatures'. */
export function panelRelation(input: Pick<PanelOrderInput, "dm" | "owner">): "own" | "other" {
  return input.dm || input.owner ? "own" : "other";
}

/**
 * Whether the creature's Reaction is spent in the fight, which every viewer
 * reads in the row's "Reaction used" tag and so in Combat's summary: its
 * row's, or a companion's own while it shares its character's turn.
 */
export function reactionSpent(view: Pick<RoomState, "tokens" | "characters" | "encounter"> | null | undefined, self: SelfRef): boolean {
  const answer = reactionTarget(view, self);
  if (!answer || !view) return false;
  if (answer.kind === "companion") return view.tokens[answer.tokenId]?.companion?.reactionUsed === true;
  return view.encounter?.entries.find((e) => e.id === answer.entryId)?.reactionUsed === true;
}

/**
 * Combat's one-line summary while it is folded, the token panel's and a
 * character's page's: "HP 52/60 · 1 condition · Reaction used · rings 30 ft".
 * The rings stay last, so a summary the group's row cuts keeps what a
 * fight changes.
 */
export function combatSummary(input: { hp: string; effects: number; reactionUsed: boolean; rings?: readonly number[] }): string {
  const { effects } = input;
  const rings = input.rings ?? [];
  return [input.hp, effects > 0 ? `${effects} ${effects === 1 ? "condition" : "conditions"}` : "", input.reactionUsed ? "Reaction used" : "", rings.length > 0 ? `rings ${rings.join(", ")} ft` : ""].filter(Boolean).join(" · ");
}

/** A character's page, top to bottom (docs/design-v1-look-pass.md 3.1): the header with its actions row, then parts that are groups but Remove. */
export type CardPartId = "header" | "statBlock" | "combat" | "companions" | "notes" | "image" | "stats" | "owners" | "remove";

export type CardGroupsInput = {
  dm: boolean;
  /** A player who plays the character, alone or with others. */
  plays: boolean;
  /** The viewer reads the character's stat block (statBlockLink.ts statBlockShown). */
  statBlock: boolean;
  /** The viewer's copy holds a companion of the character, or the viewer may add one. */
  companions: boolean;
  /** A note to read, or the right to write one. */
  notes: boolean;
  /** The viewer may change the character's picture. */
  image: boolean;
};

/**
 * Which parts a character's page shows, in the token panel's order by use:
 * the header with the quick numbers and its actions (headerActions), the
 * stat block, Combat, Companions, Notes, then setup folded at the foot,
 * and Remove last. A
 * player opens the page for companions more often than to edit its
 * numbers (docs/design-v1-combat-flow.md 3.7.5), so Companions follows
 * Combat. An empty group is not drawn: Notes with nothing to read and no
 * right to write, Companions with none to see or add, and Played by for a
 * player. Only the DM and the character's players open its page, so
 * anyone else sees its header alone.
 */
export function cardGroups(input: CardGroupsInput): CardPartId[] {
  const out: CardPartId[] = ["header"];
  if (!input.dm && !input.plays) return out;
  if (input.statBlock) out.push("statBlock");
  out.push("combat");
  if (input.companions) out.push("companions");
  if (input.notes) out.push("notes");
  if (input.image) out.push("image");
  out.push("stats");
  if (input.dm) out.push("owners");
  out.push("remove");
  return out;
}

/** What a creature's header offers in its actions row (CreatureHeader.tsx `actions`), left to right. */
export type HeaderActionId = "place" | "placeMine" | "viewAs";

export type HeaderActionsInput = {
  dm: boolean;
  /** Whose header: a token's, in its panel, or a character's, on its page. */
  on: "token" | "page";
  /** A player who plays the page's character, alone or with others. */
  plays?: boolean;
  /** The room lets players place their characters' tokens now (playersPlace). */
  playersPlace?: boolean;
  /** How many players the DM may view the token as (viewAs.tsx viewAsPlayers). */
  viewAsPlayers?: number;
};

/** Whether the room lets a player place a token of their character now: the room allows it, and the players are on a scene. */
export function playersPlace(view: Pick<RoomState, "meta" | "scenes">): boolean {
  const sceneId = view.meta.playerSceneId;
  return view.meta.settings.playersCreateCharacters === true && sceneId !== null && view.scenes[sceneId] !== undefined;
}

/**
 * The actions under a creature's header, one row for the token panel and
 * the character's page alike (docs/design-v1-design-pass.md 4.3): the
 * DM's Place a token and a player's Place my token on the page, and the
 * DM's View as on a token some player owns. The header draws no row for
 * an empty list, so a goblin's panel has no empty row and no gap. A
 * player's Place my token stays once the character is on the map, where
 * it says so in the button's place.
 */
export function headerActions(input: HeaderActionsInput): HeaderActionId[] {
  if (input.on === "page") {
    if (input.dm) return ["place"];
    return input.plays === true && input.playersPlace === true ? ["placeMine"] : [];
  }
  return input.dm && (input.viewAsPlayers ?? 0) > 0 ? ["viewAs"] : [];
}

/** The sections of a character's Combat. */
export type CardCombatId = "hp" | "conditions" | "uses" | "reaction" | "rest";

/**
 * A character's Combat on its page, in the token panel's order with no
 * rings, which a page with no map has none of. Uses always stands, since
 * only the DM and the character's players open the page, and both edit
 * its class resources. Reaction stands while the viewer may mark the
 * character's row's (encounter/ReactionSection.tsx reactionFor).
 */
export function cardCombat(input: { reaction: boolean }): CardCombatId[] {
  return input.reaction ? ["hp", "conditions", "uses", "reaction", "rest"] : ["hp", "conditions", "uses", "rest"];
}
