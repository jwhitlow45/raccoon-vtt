import { useMemo, useRef } from "react";
import { sceneTokensLeft } from "#shared/limits.ts";
import type { PartyGroup, RoomState } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import type { RoomViewStore } from "../../state/view.ts";
import { useRoomView } from "../../state/view.ts";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";
import type { DungeonEdits, RoomFacts } from "./edits.ts";
import type { StockChoices, Theme } from "./settings.ts";
import { perRoomCap, stockCapacity, stockClaims } from "./stock.ts";
import { stockPool, type StockMonster } from "./stockPools.ts";
import type { StockRequest } from "./worker.ts";

/*
 * What the Generate a dungeon dialog and the wing pane share of the
 * Monsters rows (docs/design/design-v1-dungeon-stock.md 1 and 4): the SRD
 * list and the theme's pool, the request a preview stocks with, and the
 * creature limit's claim check, which both run on every render and again
 * at Make.
 */

/**
 * By how many creatures the rooms' claims pass what the scene's group has
 * room for, 0 within it (D-261127-280): every kept room shares the
 * capacity (`perRoomCap`), and each claims by the choices and edits alone.
 */
export function overLimitBy(facts: readonly Pick<RoomFacts, "room" | "share">[], edits: DungeonEdits["rooms"] | null, tokensLeft: number, stones: number): number {
  const capacity = stockCapacity(tokensLeft, stones);
  return Math.max(0, stockClaims(facts, edits, perRoomCap(capacity, facts.length)) - capacity);
}

/** The request a preview stocks with, or null at None, while held (a share of 0) or before the pool. */
export function stockRequest(choices: StockChoices, share: number, groups: readonly PartyGroup[], pool: StockMonster[] | null, tokensLeft: number): StockRequest | null {
  if (share <= 0 || pool === null) return null;
  return { choices: { monsters: share, difficulty: choices.difficulty }, party: groups.map((g) => ({ ...g })), pool, tokensLeft };
}

/**
 * The part of a preview's key the stock adds (D-261127-220): the choices,
 * the party (at most 10 groups), the scalar tokens left, and the theme with
 * whether the list loaded and the room's images' revision. The pool itself
 * is never written out.
 */
export function stockKey(choices: StockChoices, share: number, groups: readonly PartyGroup[], tokensLeft: number, theme: Theme, loaded: boolean, imagesRev: number): string | null {
  if (share <= 0) return null;
  return JSON.stringify([choices.difficulty, share, groups, tokensLeft, `${theme}:${loaded}:${imagesRev}`]);
}

export type StockSource = { list: readonly SrdMonster[] | null; failed: boolean; pool: StockMonster[] | null; imagesRev: number };

/**
 * The SRD list, loaded while `active` (the chunk the Monsters panel
 * shares), the theme's pool with the room's images, and a count of the
 * changes to the room's images, which the preview's key reads in the
 * pool's place.
 */
export function useStockSource(active: boolean, theme: Theme): StockSource {
  const { list, failed } = useSrdBlocks(active);
  const srdImages = useRoomView((s) => s.view?.srdImages);
  const rev = useRef<{ images: RoomState["srdImages"] | undefined; n: number }>({ images: srdImages, n: 0 });
  if (rev.current.images !== srdImages) rev.current = { images: srdImages, n: rev.current.n + 1 };
  const pool = useMemo(() => (list ? stockPool(list, theme, { srdImages: srdImages ?? {} }) : null), [list, theme, srdImages]);
  return { list, failed, pool, imagesRev: rev.current.n };
}

/**
 * The tokens the scene's group of floors has room for, live while `active`
 * (else 0): the whole view, since every floor of a scene shares the cap
 * (D-261127-075). A new scene's placeholder is in no room, so it has the
 * whole cap.
 */
export function useTokensLeft(active: boolean, sceneId: string): number {
  return useRoomView((s) => (active && s.view ? sceneTokensLeft(s.view, sceneId) : 0));
}

/** The same count read now, for Make's second check, or null before the room's view. */
export function tokensLeftNow(store: Pick<RoomViewStore, "getState">, sceneId: string): number | null {
  const room = store.getState().view;
  return room ? sceneTokensLeft(room, sceneId) : null;
}
