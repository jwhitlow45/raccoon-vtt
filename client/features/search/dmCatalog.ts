import { preloadInBackground, RetryableLoad, retryFailedLoads } from "../../lib/retryableLazy.ts";
import type { Catalog } from "./catalog/types.ts";

/**
 * The DM's catalog on this device (designs/qol/search.md 5.8 and 5.9). It
 * is data, not a component, so it loads by a RetryableLoad, as the icon
 * index and the starter packs load beside the panels: with the DM's panels
 * once the room is connected, and directly when a DM opens the search
 * before that preload ends. A direct load runs only for a role that is
 * exactly "dm". `roleMayLoad` is not used here: it lets an unknown role
 * through, which suits a panel but not the DM's entries, so a search
 * opened before the room said who this is loads nothing.
 *
 * A failed load stays failed until `retry`, so a sheet that renders while
 * offline does not retry in a tight loop. Where the browser keeps a failed
 * module for the page's life (Chrome), a retry fails again at once, and
 * `tries` tells the sheet to offer Reload instead.
 *
 * This file must stay in the room's own chunk (a static import from the
 * room), since the preload registers when it is first imported and
 * preloadLazies runs once, when the room connects.
 */

export type DmCatalogState =
  /** A viewer who is not the DM, or not yet known: nothing loads, and the search shows no DM part. */
  | { status: "none" }
  /** A DM's, not asked for yet: `peek` alone answers it, since `request` starts the load. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; catalog: Catalog }
  /** `tries` counts the failed loads since the page opened. */
  | { status: "failed"; tries: number };

export type DmCatalog = {
  /** The catalog's state for a viewer of `role`, starting its load for a DM. */
  request(role: unknown): DmCatalogState;
  /** The state now, without starting anything: `idle` for a DM's not asked for yet. */
  peek(role: unknown): DmCatalogState;
  /** Tries a failed load again: every failed load's reset first, as LoadBoundary's Retry does, then this one. */
  retry(role: unknown): void;
  /** The preload's start, which preloadLazies calls for a DM's room alone. */
  preload(): Promise<unknown>;
  /** Hears each change of state. Returns what stops listening. */
  subscribe(listener: () => void): () => void;
};

const NONE: DmCatalogState = { status: "none" };
const IDLE: DmCatalogState = { status: "idle" };
const LOADING: DmCatalogState = { status: "loading" };

export function createDmCatalog(load: () => Promise<Catalog>): DmCatalog {
  const loader = new RetryableLoad(load);
  const listeners = new Set<() => void>();
  let state: DmCatalogState | null = null;
  let running: Promise<unknown> | null = null;
  let tries = 0;

  const set = (next: DmCatalogState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  // A request may come from a render, so the step to loading is told to no one: the caller has the answer.
  // A retry comes from a press, and the sheet hears it.
  const start = (tell: boolean): Promise<unknown> => {
    if (tell) set(LOADING);
    else state = LOADING;
    running = loader.run().then(
      (catalog) => set({ status: "ready", catalog }),
      () => {
        tries += 1;
        set({ status: "failed", tries });
      },
    );
    return running;
  };

  const isDm = (role: unknown) => role === "dm";

  return {
    request(role) {
      if (!isDm(role)) return NONE;
      if (state === null) void start(false);
      return state ?? LOADING;
    },
    peek(role) {
      return isDm(role) ? (state ?? IDLE) : NONE;
    },
    retry(role) {
      if (!isDm(role) || state?.status !== "failed") return;
      retryFailedLoads();
      void start(true);
    },
    preload() {
      return state === null ? start(true) : (running ?? Promise.resolve());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The one place that imports catalog/dm.ts, by a dynamic import, so the bundler gives it a chunk of its own. */
export const dmCatalog = createDmCatalog(() => import("./catalog/dm.ts").then((m) => m.DM_CATALOG));

preloadInBackground(() => dmCatalog.preload(), ["dm"]);
