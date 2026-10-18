import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import type { Size } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { layoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";

/*
 * The token panel's folds (docs/design-v1-token-panel.md 3.5 and
 * docs/design-v1-token-panel-groups.md 5): which of its sections and
 * groups show open, as this device last left them,
 * kept for the Room so a crossing of 900 px, which remounts the panel in
 * the other tree, never refolds anything. Plain functions and slots, for
 * node --test.
 */

export const FOLD_KEYS = ["statBlock", "stats", "settings", "companion", "owners", "combat", "notes", "position", "image", "other.statBlock", "other.combat", "other.notes"] as const;
export type FoldKey = (typeof FOLD_KEYS)[number];

/** The folds kept apart by relation (docs/design-v1-token-panel-groups.md 5), so a tap on another creature's Notes never folds the viewer's own. */
export type RelationFold = "statBlock" | "combat" | "notes";

/** A relation fold's key: the plain key for the viewer's own creatures, `other.` and the key for the rest. */
export function relationKey(key: RelationFold, relation: "own" | "other"): FoldKey {
  return relation === "own" ? key : `other.${key}`;
}
export type Folds = Readonly<Record<FoldKey, boolean>>;

export const FOLDS_KEY = "rvtt.tokenPanelFolds";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Where each section starts with nothing stored. The stat block opens on a
 * layout at least 900 px wide and 600 tall, where the side panel has room
 * for it beside the map. Elsewhere a block of one to three phone screens
 * would push HP and conditions out of view, so it starts folded, and so
 * does every setup section everywhere.
 */
export function foldDefaults(layout: Size): Folds {
  const wide = layout.width >= theme.layout.wideMinWidth && layout.height >= 600;
  // Combat holds what a fight changes (docs/design-v1-token-panel-groups.md 2), so it starts open on every layout.
  // Another creature's Notes shows only when it holds the DM's note for everyone, which is why a player opens it, so it starts open.
  return {
    statBlock: wide,
    stats: false,
    settings: false,
    companion: false,
    owners: false,
    combat: true,
    notes: false,
    position: false,
    image: false,
    "other.statBlock": wide,
    "other.combat": true,
    "other.notes": true,
  };
}

/** What storage holds, as an object, or nothing for a missing key, bad JSON, something not an object, or storage that throws. */
function stored(storage: ReadStorage | null): Record<string, unknown> {
  try {
    const raw = storage?.getItem(FOLDS_KEY) ?? null;
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The folds: each stored boolean, and the default at this layout for anything else. */
export function resolveFolds(storage: ReadStorage | null, layout: Size): Folds {
  const from = stored(storage);
  const defaults = foldDefaults(layout);
  const out = { ...defaults };
  for (const key of FOLD_KEYS) {
    const value = from[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** Stores one section's fold beside what is already stored, so a section never tapped keeps following its default. */
export function writeFold(storage: WriteStorage | null, key: FoldKey, open: boolean): void {
  try {
    if (!storage) return;
    const next: Record<string, boolean> = {};
    const from = stored(storage);
    for (const k of FOLD_KEYS) if (typeof from[k] === "boolean") next[k] = from[k] as boolean;
    next[key] = open;
    storage.setItem(FOLDS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage full: the fold lasts for this Room, which is all a blocked storage allows.
  }
}

export type PanelFolds = {
  /** The folds, resolved the first time any panel asks, from storage and the defaults at that layout, then kept. */
  get(layout: Size): Folds;
  /** A viewer's tap on a fold. `write` is false in "view as a player", which reads storage and never writes it. */
  tap(key: FoldKey, open: boolean, write: boolean): void;
  subscribe(listener: () => void): () => void;
};

export function createPanelFolds(storage: WriteStorage | null): PanelFolds {
  let folds: Folds | null = null;
  const listeners = new Set<() => void>();
  return {
    get(layout) {
      folds ??= resolveFolds(storage, layout);
      return folds;
    },
    tap(key, open, write) {
      const current = folds ?? resolveFolds(storage, { width: 0, height: 0 });
      folds = { ...current, [key]: open };
      if (write) writeFold(storage, key, open);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deviceStorage(): WriteStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Per Room page (state/scope.ts): the Token sheet and the side panel's tab draw in separate trees, and both read this. */
export const panelFoldsSlot = scopeSlot(() => createPanelFolds(deviceStorage()));

/**
 * The stat block a request opened (3.4), shown open whatever the folds
 * say while it names the selected token. In the Room scope, so it lasts
 * through the remount a crossing of 900 px makes. It clears when the
 * selection moves to another token or to none, and when the viewer taps
 * the stat block's fold. It never writes the folds or storage.
 */
export const statBlockOpenedSlot = scopeSlot(() => createStore<{ tokenId: string | null }>(() => ({ tokenId: null })));

/** The override after the selection changes: kept only while it names the selected token. */
export function overrideAfterSelect(override: { tokenId: string | null }, selectedId: string | null): { tokenId: string | null } {
  return override.tokenId !== null && override.tokenId !== selectedId ? { tokenId: null } : override;
}

/** Whether a token's stat block shows open: the request's override, else the folds of the viewer's relation to it. */
export function statBlockOpen(folds: Folds, override: { tokenId: string | null }, tokenId: string, relation: "own" | "other" = "own"): boolean {
  return override.tokenId === tokenId || folds[relationKey("statBlock", relation)];
}

/** The folds for this Room, kept up to date with every tap. */
export function usePanelFolds(): { folds: Folds; slot: PanelFolds } {
  const slot = useScoped(panelFoldsSlot);
  const folds = useSyncExternalStore(slot.subscribe, () => slot.get(layoutSize(window, uiScale())));
  return { folds, slot };
}
