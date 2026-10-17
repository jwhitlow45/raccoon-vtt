import { useEffect, useState, useSyncExternalStore } from "react";
import { loadedMonsters, loadMonsters, onMonstersLoaded, type SrdMonster } from "#shared/srd/monsters.ts";

/**
 * The SRD's 330 stat blocks for a view, one rule for every view that shows
 * them: the Monsters panel, the token panel's stat block and summary, the
 * encounter builder and the monster picker. They are read as an external
 * store (shared/srd/monsters.ts loadedMonsters), so a view draws them in
 * its first frame once any view has loaded them this page, and a load that
 * finishes at any moment, even between a view's render and its effect,
 * reaches every view that shows them. Kept in state, a load another view
 * finished in that gap left this one loading for good.
 *
 * While `active`, the load starts on first need. A failure stays until a
 * reload (SrdLoadFailed.tsx), so a caller can say so instead of looking stuck.
 */
export function useSrdBlocks(active = true): { list: readonly SrdMonster[] | null; failed: boolean } {
  const list = useSyncExternalStore(onMonstersLoaded, loadedMonsters, loadedMonsters);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active || list) return;
    let live = true;
    loadMonsters().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [active, list]);
  return { list, failed };
}
