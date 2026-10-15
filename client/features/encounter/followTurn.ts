import { useSyncExternalStore } from "react";
import type { Encounter, Token } from "#shared/model.ts";
import { footprint } from "../../lib/scene.ts";

/**
 * "The DM's view can follow the active token" (features section 10): with
 * this on, the DM's camera pans to whoever acts each time the turn moves.
 * It is a preference of this device, kept like the turn sound, and off by
 * default. Players' cameras never follow: they have "Follow me" and "Look
 * here" from the DM instead.
 */

const FOLLOW_KEY = "rvtt.followTurn";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) === "on";
  } catch {
    return false;
  }
}

let following = read();

export function useFollowTurn(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => following,
  );
}

export function setFollowTurn(on: boolean): void {
  following = on;
  try {
    localStorage.setItem(FOLLOW_KEY, on ? "on" : "off");
  } catch {
    // Private mode or storage full: the setting lasts until the page closes.
  }
  for (const fn of listeners) fn();
}

type Placed = Pick<Token, "id" | "sceneId" | "x" | "y" | "size" | "w" | "h" | "actor">;

/**
 * The middle of the active combatant's token on the scene shown, or null:
 * no fight, nobody acting, or their token is on another scene. A row added
 * for a character, with no token of its own, finds that character's token.
 */
export function turnFocus(
  encounter: Pick<Encounter, "activeEntryId" | "entries"> | null | undefined,
  tokens: Readonly<Record<string, Placed | undefined>>,
  sceneId: string,
): { x: number; y: number } | null {
  const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!entry) return null;
  let token = entry.tokenId !== undefined ? tokens[entry.tokenId] : undefined;
  if (!token && entry.characterId !== undefined) {
    token = Object.values(tokens).find((t) => t !== undefined && t.sceneId === sceneId && "ref" in t.actor && t.actor.ref === entry.characterId);
  }
  if (!token || token.sceneId !== sceneId) return null;
  const fp = footprint(token);
  return { x: token.x + fp.w / 2, y: token.y + fp.h / 2 };
}
