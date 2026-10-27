import { useEffect } from "react";
import { ISO_TEST_FLAG } from "../../features/view/choice.ts";
import { pickView, turnView, type ViewPick } from "../../features/view/store.ts";
import type { Turn } from "../../lib/view.ts";
import type { Item } from "./buckets.ts";
import type { VolumesNow } from "./volumes.ts";

/**
 * A way for tests and the bench to pick and turn without the View menu:
 * with the test flag (features/view/choice.ts ISO_TEST_FLAG) set before
 * the page loads (Playwright's addInitScript), `__rvttIsoHook` picks and
 * turns as the menu does. Nothing a user can do sets it, and it offers
 * nothing the menu does not (docs/design-v1-isometric-view.md 13).
 */
const HOOK = "__rvttIsoHook";

export type Hook = { pick(pick: ViewPick | "follow"): void; turn(turn: Turn): void; layout?(): BoardLayout | null };

/**
 * The isometric board's depth list as the tests read it
 * (docs/design-v1-iso-area-shapes.md 8): its entries in drawing order, a
 * standee by its token's id and an area's band by the area and the band,
 * with the relief's own pieces left out, which areas stand now and
 * whether one waits to, and the colors of the rings at each standee's base.
 */
export type BoardLayout = {
  order: ({ kind: "standee"; id: string } | { kind: "band"; area: string; band: number })[];
  standing: string[];
  waiting: boolean;
  rings: Record<string, string[]>;
};

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

/** The layout the board on screen made last, while the test flag is set: a View as a player board over the DM's makes its own after. */
let lastLayout: BoardLayout | null = null;

/** Keeps the board's layout for the hook, with the test flag only: anything else costs nothing. */
export function reportLayout(items: readonly Item[], volumes: VolumesNow | null, rings: ReadonlyMap<string, readonly string[]> | null): void {
  if (!flagged()) return;
  const order: BoardLayout["order"] = [];
  for (const item of items) {
    if (item.kind === "standee") order.push({ kind: "standee", id: item.id });
    else for (const p of item.pieces) if (p.kind === "volume") order.push({ kind: "band", area: p.area, band: p.band });
  }
  lastLayout = { order, standing: [...(volumes?.standing ?? [])].sort(), waiting: volumes?.waiting ?? false, rings: Object.fromEntries([...(rings ?? [])].map(([id, colors]) => [id, [...colors]])) };
}

/** Installs `__rvttIsoHook` while the test flag is set. */
export function useIsoTestHook(key: string, sceneId: string): void {
  const on = flagged();
  useEffect(() => {
    if (!on) return;
    return installHook({
      pick: (pick) => pickView(key, pick === "follow" ? null : pick),
      turn: (turn) => turnView(key, sceneId, turn),
      layout: () => lastLayout,
    });
  }, [on, key, sceneId]);
}
