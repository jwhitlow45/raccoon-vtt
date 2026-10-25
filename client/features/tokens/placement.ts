import { createStore } from "zustand/vanilla";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import type { TokenKind } from "#shared/model.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import type { ToolContext } from "../tools.ts";
import type { MonsterDrop, Point } from "./factory.ts";

/**
 * What the "Add token" tool places with the next tap on the map: a blank
 * token, a character's token, or a batch of monsters from the browser, SRD
 * or the room's own. The monster browser and the characters panel set it
 * and switch to the tool, so the DM picks a creature in a panel and then
 * taps where it goes.
 *
 * Kept outside the room store because it is a tool's own scratch state,
 * like a ruler's points, and never leaves this device.
 */
export type Pending =
  | { kind: "blank"; tokenKind: TokenKind }
  | { kind: "character"; characterId: string; name: string }
  /** `monsterId` names one of the room's own monsters. An SRD one is known by its view's `srdId`. */
  | ({ kind: "monster"; monster: StatBlockMonster; monsterId?: string; count: number } & MonsterDrop)
  /**
   * Tokens another feature places around the tap, such as a saved encounter
   * (client/features/encounters). `place` sends them and returns the token
   * to select, or null when it placed none.
   */
  | { kind: "batch"; what: string; place(world: Point, ctx: ToolContext): string | null };

export const DEFAULT_PENDING: Pending = { kind: "blank", tokenKind: "monster" };

/** The blank tokens the tool offers, in the row's order, which the tool's key steps through too. */
export const BLANK_KINDS: readonly { value: TokenKind; label: string }[] = [
  { value: "monster", label: "Blank monster" },
  { value: "npc", label: "Blank NPC" },
  { value: "object", label: "Blank object" },
  { value: "pc", label: "Blank player character" },
];

/** One Room page's pending choice (client/state/scope.ts), and where the tap that places it started. */
export const placementSlot = scopeSlot(() => ({
  store: createStore<{ pending: Pending }>(() => ({ pending: DEFAULT_PENDING })),
  downAt: null as { x: number; y: number } | null,
}));

export function setPending(scope: RoomScope, pending: Pending): void {
  scope.get(placementSlot).store.setState({ pending });
}

export function resetPending(scope: RoomScope): void {
  scope.get(placementSlot).store.setState({ pending: DEFAULT_PENDING });
}

export const PLACE_TOOL_ID = "add-token";

export function describePending(p: Pending): string {
  switch (p.kind) {
    case "blank":
      return `a blank ${p.tokenKind === "npc" ? "NPC" : p.tokenKind === "pc" ? "player character" : p.tokenKind}`;
    case "character":
      return p.name;
    case "monster": {
      const what = p.count === 1 ? p.monster.name : `${p.count} × ${p.monster.name}`;
      return p.hidden ? `${what}, hidden` : what;
    }
    case "batch":
      return p.what;
  }
}
