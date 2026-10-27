import type { Senses } from "#shared/rules/vision.ts";
import { senseFeetText } from "./reach.ts";

/*
 * The senses that see (docs/design-v1-maps-vision.md section 4.3.2) are read
 * by the server's own rule in shared/rules/vision.ts, so the token panel and
 * a scene's What players see settings word exactly the ranges the party's sight uses.
 */
export { parseSenses, type Senses } from "#shared/rules/vision.ts";

/**
 * What a creature sees, in the token panel's words: "Sees in the dark to
 * 60 ft". One line per sense, strongest first, or a line saying it needs
 * light. A range the room's grid cuts short says what it reaches (reach.ts).
 */
export function sensesLines(s: Senses, feetPerCell: number): string[] {
  const lines: string[] = [];
  const ft = (feet: number) => senseFeetText(feet, feetPerCell);
  if (s.truesight > 0) lines.push(`Sees through any darkness to ${ft(s.truesight)} (Truesight)`);
  if (s.darkvision > 0) lines.push(`Sees in the dark to ${ft(s.darkvision)}`);
  if (s.blindsight > 0) lines.push(`Senses its surroundings to ${ft(s.blindsight)} without light (Blindsight)`);
  if (lines.length === 0) lines.push("Sees only where there is light");
  return lines;
}

/** The senses in a few words, for a row in a scene's What players see settings: "Darkvision 60 ft, Blindsight 10 ft". */
export function sensesShort(s: Senses, feetPerCell: number): string {
  const parts: string[] = [];
  const ft = (feet: number) => senseFeetText(feet, feetPerCell);
  if (s.darkvision > 0) parts.push(`Darkvision ${ft(s.darkvision)}`);
  if (s.blindsight > 0) parts.push(`Blindsight ${ft(s.blindsight)}`);
  if (s.truesight > 0) parts.push(`Truesight ${ft(s.truesight)}`);
  return parts.length > 0 ? parts.join(", ") : "needs light";
}
