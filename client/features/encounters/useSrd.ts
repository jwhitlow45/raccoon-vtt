import { useEffect, useMemo, useState } from "react";
import { loadMonsters, type SrdMonster } from "#shared/srd/monsters.ts";
import { srdIndex } from "./draft.ts";

export type SrdList = {
  /** Null until the list arrives. */
  list: readonly SrdMonster[] | null;
  /** The list by SRD id, null until it arrives. */
  byId: ReadonlyMap<string, SrdMonster> | null;
  /** The load did not work. Only a reload can try again (features/monsters/SrdLoadFailed.tsx). */
  failed: boolean;
};

/**
 * The 330 SRD stat blocks for the encounter builder. They are about half a
 * megabyte in a chunk of their own (shared/srd/monsters.ts), shared with the
 * monster browser, so the first open of either downloads them and the
 * other finds them in memory.
 */
export function useSrdMonsters(): SrdList {
  const [list, setList] = useState<readonly SrdMonster[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadMonsters().then(
      (monsters) => live && setList(monsters),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  const byId = useMemo(() => (list ? srdIndex(list) : null), [list]);
  return { list, byId, failed };
}
