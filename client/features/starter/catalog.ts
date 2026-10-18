import { indexWorks, type FoundWork, type StarterPack } from "#shared/starter.ts";
import { preloadInBackground } from "../../lib/retryableLazy.ts";

/**
 * The starter packs' catalog for the room (docs/design-v1-starter-art.md
 * 4): about 500 works with their credits, in a chunk of its own that the
 * room's first load never carries. It loads with the panels the room
 * preloads once connected, for both roles, since a player may pick a
 * starter portrait for their own character. Its thumbnails are not
 * preloaded: a pick needs the server anyway, so having them on the device
 * early would buy nothing offline, and a phone would download every pack's
 * previews for a picker it may never open.
 *
 * Plain module state, with no React or component imports, since the panel
 * registry imports it to register the preload and runs under node --test.
 * The picker reads it through useStarterPacks (StarterBrowser.tsx).
 */

let loading: Promise<readonly StarterPack[]> | undefined;
let loaded: readonly StarterPack[] | null = null;
const listeners = new Set<() => void>();

export function loadStarterPacks(): Promise<readonly StarterPack[]> {
  loading ??= import("#shared/starterArt.ts")
    .then((m) => {
      loaded = m.STARTER_PACKS;
      for (const listener of listeners) listener();
      return loaded;
    })
    .catch((err: unknown) => {
      // The next caller tries again, which works where the browser fetches a failed module anew.
      loading = undefined;
      throw err;
    });
  return loading;
}

preloadInBackground(loadStarterPacks, ["dm", "player"]);

let index: ReadonlyMap<string, FoundWork> | null = null;

/**
 * A work by its key, once the catalog is on the page, else null. For a row
 * already in the room that names its work, such as a starter map used for a
 * second scene, where waiting on the catalog would leave a tap unanswered.
 */
export function loadedStarterWork(key: string): FoundWork | null {
  if (!loaded) return null;
  index ??= indexWorks(loaded);
  return index.get(key) ?? null;
}

/** Hears the load finish, whoever asked for it. Returns what stops listening. */
export function onStarterPacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The catalog once a load has finished on this page, else null. */
export function loadedStarterPacks(): readonly StarterPack[] | null {
  return loaded;
}
