import type { Character, CreatureSize } from "#shared/model.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import { srdTitle } from "./companionBlocks.ts";
import { SIZE_WORDS } from "./resize.ts";

/*
 * What a creature's header says it is (docs/design-v1-look-pass.md 2.11),
 * the same words in the token panel and on a character's page, as plain
 * functions for node --test.
 */

/** What a creature is, as far as the viewer's copy of the room tells. */
export type CreatureKind =
  | { kind: "character"; level?: number; shape?: { wild: boolean; creature: string } }
  | { kind: "companion"; of: string }
  | { kind: "monster" | "npc"; cr?: string }
  | { kind: "object" };

/**
 * The kind line in its parts: what the creature is, then its size.
 * `companionOf` names a companion's character, whose part the header draws
 * as its own element, a link to the character's page where the viewer may
 * open it.
 */
export type KindLine = { kind: string; size: string; companionOf?: string };

/** "Medium (5 ft)", or a custom size's sides, "Custom (10 by 15 ft)". */
export function sizeText(size: CreatureSize, cells: { w: number; h: number }, feetPerCell: number): string {
  const feet = cells.w === cells.h ? `${cells.w * feetPerCell} ft` : `${cells.w * feetPerCell} by ${cells.h * feetPerCell} ft`;
  return `${SIZE_WORDS[size] ?? size} (${feet})`;
}

/** "Level 5 character", "Companion of Thorn", "Monster, CR 1/4", "Object". */
export function kindWords(input: CreatureKind): string {
  switch (input.kind) {
    case "character": {
      const who = input.level !== undefined ? `Level ${input.level} character` : "Character";
      if (!input.shape) return who;
      // shapeNote's words for each kind (features/pcstats/shape.ts).
      return input.shape.wild ? `${who} in Wild Shape as ${input.shape.creature}` : `${who} in the shape of ${input.shape.creature}`;
    }
    case "companion":
      return `Companion of ${input.of}`;
    case "monster":
    case "npc": {
      const who = input.kind === "monster" ? "Monster" : "NPC";
      return input.cr !== undefined && input.cr !== "" ? `${who}, CR ${input.cr}` : who;
    }
    case "object":
      return "Object";
  }
}

export function kindLine(input: CreatureKind, size: string): KindLine {
  return { kind: kindWords(input), size, ...(input.kind === "companion" ? { companionOf: input.of } : {}) };
}

/** The line as one string, for a screen reader's summary or a test. */
export function kindLineText(line: KindLine): string {
  return `${line.kind} · ${line.size}`;
}

/**
 * A character's kind: its level, and a shape it is in. The creature is named
 * from its SRD id, which needs no load of the SRD (companionBlocks.ts
 * srdTitle), so the header never waits on the shape's block.
 */
export function characterKind(character: Pick<Character, "level" | "actor">): CreatureKind {
  const shape = pcShape(character);
  const srdId = character.actor.srdId;
  return {
    kind: "character",
    ...(character.level !== undefined ? { level: character.level } : {}),
    ...(shape !== "none" && srdId !== undefined ? { shape: { wild: shape === "wild", creature: srdTitle(srdId) } } : {}),
  };
}

/**
 * A token's kind, from what the viewer's copy holds: a companion first,
 * whatever its kind, named by its character where the copy holds that
 * character. A player character's token reads its character's level and
 * shape, and a monster's or NPC's its CR.
 */
export function tokenKind(input: {
  token: { kind: "pc" | "npc" | "monster" | "object"; companion?: unknown };
  /** The name of the companion's character, where the viewer's copy holds it. */
  companionOf?: string;
  /** The character a player character's token is of, where the viewer's copy holds it. */
  character?: Pick<Character, "level" | "actor">;
  cr?: string;
}): CreatureKind {
  const { token } = input;
  if (token.companion !== undefined && input.companionOf !== undefined) return { kind: "companion", of: input.companionOf };
  switch (token.kind) {
    case "pc":
      return input.character ? characterKind(input.character) : { kind: "character" };
    case "monster":
    case "npc":
      return { kind: token.kind, ...(input.cr !== undefined ? { cr: input.cr } : {}) };
    case "object":
      return { kind: "object" };
  }
}
