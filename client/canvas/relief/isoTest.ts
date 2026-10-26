import { useEffect } from "react";
import { ISO_TEST_FLAG } from "../../features/view/choice.ts";
import { pickView, turnView, type ViewPick } from "../../features/view/store.ts";
import type { Turn } from "../../lib/view.ts";

/**
 * A way for tests and the bench to pick and turn without the View menu:
 * with the test flag (features/view/choice.ts ISO_TEST_FLAG) set before
 * the page loads (Playwright's addInitScript), `__rvttIsoHook` picks and
 * turns as the menu does. Nothing a user can do sets it, and it offers
 * nothing the menu does not (docs/design-v1-isometric-view.md 13).
 */
const HOOK = "__rvttIsoHook";

export type Hook = { pick(pick: ViewPick | "follow"): void; turn(turn: Turn): void };

function flagged(): boolean {
  return typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] === true;
}

/**
 * Every mounted board's hook, the newest last. View as a player mounts a
 * board over the DM's, which takes the hook while it stands. As it goes it
 * hands the hook back to the board under it, which a plain delete took
 * away for good (ISO5P2-FV-4).
 */
const installed: Hook[] = [];

/** Sets `hook` as `__rvttIsoHook`, and returns what takes it away. */
export function installHook(hook: Hook): () => void {
  const g = globalThis as Record<string, unknown>;
  installed.push(hook);
  g[HOOK] = hook;
  return () => {
    installed.splice(installed.indexOf(hook), 1);
    const top = installed.at(-1);
    if (top) g[HOOK] = top;
    else delete g[HOOK];
  };
}

/** Installs `__rvttIsoHook` while the test flag is set. */
export function useIsoTestHook(key: string, sceneId: string): void {
  const on = flagged();
  useEffect(() => {
    if (!on) return;
    return installHook({
      pick: (pick) => pickView(key, pick === "follow" ? null : pick),
      turn: (turn) => turnView(key, sceneId, turn),
    });
  }, [on, key, sceneId]);
}
