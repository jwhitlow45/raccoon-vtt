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
 * While `active`, the load starts on first need. A failure stays, so a
 * caller can say so instead of looking stuck (SrdLoadFailed.tsx), until a
 * reload or a new `attempt`, such as the Dice panel's pick of another
 * creature, which tries again as a view mounted afresh would.
 */
export function useSrdBlocks(active = true, attempt = ""): { list: readonly SrdMonster[] | null; failed: boolean } {
  const list = useSyncExternalStore(onMonstersLoaded, loadedMonsters, loadedMonsters);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!active || list) return;
    let live = true;
    loadMonsters().catch(() => {
      if (live) setFailedFor(attempt);
    });
    return () => {
      live = false;
    };
  }, [active, list, attempt]);
  return { list, failed: blocksFailed(list, failedFor, attempt) };
}

/** A failed load counts for the attempt it came from, and never once the blocks have loaded, whichever view loaded them. */
export function blocksFailed(list: readonly SrdMonster[] | null, failedFor: string | null, attempt: string): boolean {
  return list === null && failedFor === attempt;
}
