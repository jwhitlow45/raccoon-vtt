import { useEffect } from "react";
import type { Scene } from "#shared/model.ts";
import { pickView, shownView, turnView, useStoredView, type ViewPick } from "../../features/view/store.ts";
import type { Turn, View } from "../../lib/view.ts";

/**
 * The isometric view stays unreachable until its choice ships
 * (features/view/store.ts isoReady, docs/design-v1-isometric-view.md 13).
 * Until then only tests and the bench reach it, by setting this global
 * before the page loads (Playwright's addInitScript). Nothing a user can
 * do sets it. With it set, the board shows the view the stored pick asks
 * for, and `__rvttIsoHook` picks and turns as the View menu will.
 */
export const ISO_TEST_FLAG = "__rvttIsoTest";
const HOOK = "__rvttIsoHook";

type Hook = { pick(pick: ViewPick | "follow"): void; turn(turn: Turn): void };

function flagged(): boolean {
  return typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] === true;
}

/** The view the board shows under the test flag, or null without it, when the board shows Top-down as it always has. */
export function useTestView(key: string, sceneId: string, suggested: Scene["suggestedView"]): View | null {
  const on = flagged();
  const stored = useStoredView(key);
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
  if (!on) return null;
  return shownView({ stored, sceneId, suggested, ready: true });
}
