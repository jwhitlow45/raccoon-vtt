import type { TokenKind } from "#shared/model.ts";

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
  | "position"
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
};

export function panelSections(input: PanelOrderInput): PanelSectionId[] {
  const { dm, owner } = input;
  const full = dm || owner;
  const out: PanelSectionId[] = ["name", "image"];
  if (input.statBlockShown) out.push("statBlock");
  out.push("hp", "conditions", "position", "rangeRings", "notes");
  if (full && input.kind !== "object") out.push("rest");
  out.push("sight");
  if (full && input.actor) out.push("stats");
  if (dm || input.ownerRenames) out.push("settings");
  // Next to Owners, which a companion's link decides.
  if (input.companion && full) out.push("companion");
  if (dm) out.push("owners", "remove");
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

const COMBAT: readonly PanelSectionId[] = ["hp", "conditions", "rangeRings", "rest"];
const PLACE: readonly PanelSectionId[] = ["position", "sight"];
const SETUP: readonly PanelSectionId[] = ["stats", "settings", "companion", "owners", "remove"];

/**
 * The panel grouped by use, as the project owner asked (2026-10-17): the
 * name with its picture and quick numbers, the stat block, then Combat
 * (what a fight changes), Notes, Position and Image, then setup. Each
 * group holds panelSections' sections in its order, so nothing moves
 * against its neighbors, and a group with nothing in it is not drawn.
 *
 * The quick numbers and the picture stand in the name's header, the
 * picture's buttons in Image. Position is the DM's and the owners': a player
 * looking at another creature reads its elevation in the quick numbers,
 * and Sight shows them nothing. Notes shows only with a note to read or
 * write.
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
  if (input.dm || input.owner) group("position", PLACE);
  if (input.image) group("image", ["image"]);
  alone(SETUP);
  return out;
}

/** Whose folds a viewer's taps keep: their own creatures' (the DM's, an owner's) or other creatures'. */
export function panelRelation(input: Pick<PanelOrderInput, "dm" | "owner">): "own" | "other" {
  return input.dm || input.owner ? "own" : "other";
}


/** A character's page, top to bottom (docs/design-v1-look-pass.md 3.1): the header, the actions row, then parts that are groups but Remove. */
export type CardPartId = "header" | "place" | "statBlock" | "combat" | "companions" | "notes" | "image" | "stats" | "owners" | "remove";

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
 * the header with the quick numbers, Place a token, the stat block, Combat,
 * Companions, Notes, then setup folded at the foot, and Remove last. A
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
  out.push("place");
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
