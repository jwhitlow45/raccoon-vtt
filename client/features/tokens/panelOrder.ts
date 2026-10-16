import type { TokenKind } from "#shared/model.ts";

/*
 * The token panel's order (docs/design-v1-token-panel.md 3.5), ranked by
 * use: the name, the image, the stat block (or the summary line alone),
 * then play from HP down, and setup folded at the foot. A plain function
 * for node --test. Each section still keeps its own rule for what it
 * shows, so a section listed here may draw nothing, such as Notes with no
 * note a player may read.
 */

export type PanelSectionId =
  | "name"
  | "image"
  | "statBlock"
  | "summary"
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
  /** The viewer's copy holds any of the summary line's items: AC, speed, Passive Perception or a sheet link. */
  summary: boolean;
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
  else if (input.summary) out.push("summary");
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
