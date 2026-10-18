import { LIMITS } from "#shared/limits.ts";
import type { Actor, RoomState, Token, TokenLight } from "#shared/model.ts";
import { footprintGround } from "#shared/rules/heights.ts";
import { visionReport, type NoSightReason, type Senses, type VisionWorld } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";

/**
 * Who lends the party sight on a scene, as the DM's Vision settings and
 * token panel list it (docs/design-v1-maps-vision.md section 4.3.2), read
 * from the DM's view, which holds every creature, light and build chunk on
 * the scene the DM looks at.
 *
 * The answer is the server's own report (shared/rules/vision.ts
 * `visionReport`), so the list shows every reason the party's sight uses,
 * including one only the rules can tell: an eye that cannot be stepped off a
 * wall lends nothing. This file only adds what the rows word: whether a
 * creature is Blinded, and how far inside the ground it is.
 */

export type NoSight = NoSightReason;

export type SourceRow = {
  token: Token;
  lends: boolean;
  reason?: NoSight;
  senses: Senses;
  /** A carried light that gives any light. */
  light?: TokenLight;
  /** Blinded: it sees only by blindsight (the SRD's "even if you have the Blinded condition"). */
  blinded: boolean;
  /** Inside the ground, how far below it, in feet. */
  belowFt?: number;
};

/* Sight reads the derived walls through a world, as the server's rule hooks pass it (shared/ruleHooks.ts). */
const WORLD: VisionWorld = { walls: sceneWalls };

function actorOf(state: RoomState, token: Token): Actor | undefined {
  return "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
}

/** Every party member on the scene, sources first in the cap's order, and how many the cap leaves out. */
export function partyReport(state: RoomState, sceneId: string): { rows: SourceRow[]; overCap: number } {
  const report = visionReport(state, sceneId, WORLD);
  const rows: SourceRow[] = [];
  for (const member of report.members) {
    const token = state.tokens[member.tokenId];
    if (!token) continue;
    const actor = actorOf(state, token);
    rows.push({
      token,
      lends: member.lends,
      ...(member.reason ? { reason: member.reason } : {}),
      senses: member.senses,
      ...(member.light ? { light: member.light } : {}),
      blinded: Array.isArray(actor?.effects) && actor.effects.some((e) => e.key === "blinded"),
      ...(member.reason === "ground" ? { belowFt: footprintGround(state.buildChunks, token) - token.elevation } : {}),
    });
  }
  return { rows, overCap: report.overCap };
}

/** Why a member lends no sight, as its row says it. */
export function noSightText(row: Pick<SourceRow, "reason" | "belowFt">): string {
  switch (row.reason) {
    case "hidden":
      return "Hidden from players: lends no sight";
    case "object":
      return "An object: lends no sight";
    case "down":
      return "Down or Unconscious: lends no sight";
    case "ground":
      return `Inside the ground (${row.belowFt ?? 0} ft below): lends no sight`;
    case "cap":
      return `Past the ${LIMITS.partySourcesPerScene} creatures that lend sight: shown, lends none`;
    case "wall":
      return "Standing on a wall it cannot step off: lends no sight";
    default:
      return "Lends the party its sight";
  }
}
