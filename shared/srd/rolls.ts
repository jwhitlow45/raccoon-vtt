import { blockRollNumbers, type RollNumbers, type SrdRolls } from "../dice/bonus.ts";
import { statBlockFromSrd } from "../statBlock.ts";
import type { SrdMonster } from "./monsters.ts";

/**
 * Every SRD creature's roll numbers by its id (docs/design-v1-dice.md 6.1
 * `SrdRolls`), generated into rolls.json from monsters.json by
 * scripts/srd-import.ts, so the server and a player's device know an SRD
 * token's saves and skills without the half-megabyte monsters chunk. The
 * test checks the file still matches the blocks.
 */

/** One block's numbers, read as a room monster's are (blockRollNumbers), so both kinds of monster roll alike. */
export function srdRollNumbers(m: SrdMonster): RollNumbers {
  return blockRollNumbers(statBlockFromSrd(m));
}

/** The whole table for monsters.json, in its order. */
export function srdRollsOf(monsters: readonly SrdMonster[]): SrdRolls {
  const out: SrdRolls = {};
  for (const m of monsters) out[m.srdId] = srdRollNumbers(m);
  return out;
}

let loading: Promise<SrdRolls> | undefined;

/**
 * The table, about 50 KB, in its own chunk on a client, loaded on first
 * need and memoized as the monsters are (monsters.ts loadMonsters). The
 * server imports the file at boot (server/rooms/dice.ts).
 */
export function loadSrdRolls(): Promise<SrdRolls> {
  loading ??= import("./rolls.json", { with: { type: "json" } })
    .then((m) => m.default as unknown as SrdRolls)
    .catch((err: unknown) => {
      // Let the next caller try again, for example after a dropped connection.
      loading = undefined;
      throw err;
    });
  return loading;
}
