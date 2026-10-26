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

type Hook = { pick(pick: ViewPick | "follow"): void; turn(turn: Turn): void };

function flagged(): boolean {
  return typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] === true;
}

/** Installs `__rvttIsoHook` while the test flag is set. */
export function useIsoTestHook(key: string, sceneId: string): void {
  const on = flagged();
  useEffect(() => {
    if (!on) return;
    const hook: Hook = {
      pick: (pick) => pickView(key, pick === "follow" ? null : pick),
      turn: (turn) => turnView(key, sceneId, turn),
    };
    const g = globalThis as Record<string, unknown>;
    g[HOOK] = hook;
    return () => {
      if (g[HOOK] === hook) delete g[HOOK];
    };
  }, [on, key, sceneId]);
}
