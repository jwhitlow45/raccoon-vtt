import type { ImageRef, RoomState } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import type { Theme } from "./settings.ts";

/*
 * The SRD monsters each theme stocks its rooms from (docs/design/design-v1-dungeon-stock.md
 * 4, D-261127-065 and 216).
 */

/** A pool block: an SRD monster without its stat block text, which the worker never reads, and the room's image for it. */
export type StockMonster = Omit<SrdMonster, "statBlock"> & { image?: ImageRef };

export function stockPool(_list: readonly SrdMonster[], _theme: Theme, _images: Pick<RoomState, "srdImages">): StockMonster[] {
  return [];
}
