import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "#shared/keys.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { reachWork } from "#shared/project.ts";
import { actor, room, scene, token } from "#shared/testutil.ts";
import { candidateKeys, type CommittedBatch } from "./fanout.ts";

/*
 * Every token's tile reach is worked out in the fan-out of the batch that
 * replaced the token or changed its scene's grid, a global batch's too,
 * so the next batch's fan-out, often a player's, works out only its own
 * creatures' reaches, whatever the DM did out of sight before it. Counted,
 * never timed.
 */

const SHADES = 100;

/** A dark scene with vision on, the party's creature, and the DM's hidden ones. */
function dark(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
  state.tokens.pc = token("pc", { kind: "pc", ownerIds: ["p1"], x: 4, y: 4, actor: { inline: actor({ senses: "darkvision 30 ft" }) } });
  for (let i = 0; i < SHADES; i++) state.tokens[`shade${i}`] = token(`shade${i}`, { visibility: "dm", x: 10 + (i % 20), y: 10 + Math.floor(i / 20) });
  return state;
}

function batch(before: RoomState, after: RoomState, touched: string[], global: boolean): CommittedBatch {
  return { pub: 1, before, after, touched, global, acks: new Map(), rejects: new Map(), restored: new Map() };
}

const withTokens = (state: RoomState, change: (tokens: Record<string, Token>) => void): RoomState => {
  const tokens = { ...state.tokens };
  change(tokens);
  return { ...state, tokens };
};

/** The reaches the player's walk east works out in its fan-out, after `hidden` as the batch before it. */
function walkReaches(hidden: (state: RoomState) => { after: RoomState; global: boolean; touched: string[] }): number {
  const start = dark();
  candidateKeys(batch(start, start, [], false), ["s1"]);
  const { after, global, touched } = hidden(start);
  candidateKeys(batch(start, after, touched, global), ["s1"]);
  const walked = withTokens(after, (tokens) => (tokens.pc = { ...tokens.pc!, x: 5 }));
  const was = reachWork.computed;
  candidateKeys(batch(after, walked, [keys.token("pc")], false), ["s1"]);
  return reachWork.computed - was;
}

const moved = (k: number, global: boolean) => (state: RoomState) => ({
  after: withTokens(state, (tokens) => {
    for (let i = 0; i < k; i++) tokens[`shade${i}`] = { ...tokens[`shade${i}`]!, y: tokens[`shade${i}`]!.y + 1 };
  }),
  global,
  touched: Array.from({ length: k }, (_, i) => keys.token(`shade${i}`)),
});

describe("tile reaches", () => {
  test("the player's walk works out its own creature's reach alone, after the DM's hidden moves in a batch or a global batch", () => {
    for (const global of [false, true]) {
      const counts = [0, 1, 40, 70, SHADES].map((k) => walkReaches(moved(k, global)));
      assert.deepEqual(counts, counts.map(() => 1), `${global ? "a global" : "a"} batch of hidden moves before it`);
    }
  });

  test("a grid change with every token unchanged works its reaches out in its own batch", () => {
    for (const global of [false, true]) {
      const hexes = walkReaches((state) => ({ after: { ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1!, gridShape: "hexRows" } } }, global, touched: [keys.scene("s1")] }));
      const squares = walkReaches((state) => ({ after: { ...state, scenes: { ...state.scenes, s1: { ...state.scenes.s1!, name: "Renamed" } } }, global, touched: [keys.scene("s1")] }));
      assert.deepEqual([hexes, squares], [1, 1], `${global ? "a global" : "a"} batch before the walk`);
    }
  });
});
