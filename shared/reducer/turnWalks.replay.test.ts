import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readEntity } from "../keys.ts";
import type { RoomState, Viewer } from "../model.ts";
import { hash128, stableStringify } from "../project.ts";
import type { Op, RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { guardHash } from "./tx.ts";
import { AT, DM, P1, actor, entry, room, token } from "../testutil.ts";

/*
 * Ops stored at change formats 61 to 64 replay to what they made, whatever
 * change format 65 changes of walks (shared/migrate.ts walksEndWithTurn):
 * a controlled mount's walk on its rider's turn, a getting off, a move off
 * the turn, a remount, Next, Previous, a removal that passes the turn, an
 * undo and a fight's end. The hashes were recorded by the build before 65:
 * each op's state, the keys it wrote and its undo. Record them again with
 * TURNWALKS_RECORD=1 only on that build.
 */

const VERSIONS = [61, 62, 63, 64] as const;

/** The same at each of them: no rule of these formats meets these ops apart. */
const PINNED = [
  "fc8ef64e0451dabdeca6847d89bdcbfe",
  "4d89eb970f126cf493bd88635d8a856e",
  "188ca08b0d24d5ac759323670c7a3633",
  "fc27f1699ef175996e8b5530cfffbdb9",
  "1fd688a1bb708d437baaa2970bf1333f",
  "64e985f04a0871ef9262b58b7a7c1c1f",
  "f046c976d6c700aeca970debe1b49ec1",
  "af77bdd35f12420064c7aa051b4ca226",
  "c187e0cc8e7c8f65e1a73e894c3c2b56",
  "51be17d9e830c5c6a7982f0aa74c2bee",
  "66062bd31f05819e3f48d0739c08d454",
  "8461ed9b8a73b09b50a607962d849ec0",
  "2b558a648b3fa25d2fde971978563db6",
  "43cba0f7778e628e2a1adfbc2bfaf45a",
];

/** Pip's turn, named 7, on a controlled ride on the warhorse, which shares it, with the DM's goblin next. */
function start(): RoomState {
  const state = room({
    tokens: {
      pip: token("pip", { name: "Pip", kind: "pc", size: "small", ownerIds: ["p1"], x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } }),
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      gob: token("gob", { x: 20, y: 20 }),
    },
  });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "rpip",
    entries: [entry("rpip", { tokenId: "pip", value: 20 }), entry("rgob", { tokenId: "gob", value: 5 })],
    turnStart: { entryId: "rpip", tokenId: "pip", sceneId: "s1", x: 4, y: 4, elevation: 0, seen: true, seq: 7, mounts: ["horse"] },
  };
  return state;
}

type Step = { op: Op; who: Viewer } | { undo: number; who: Viewer };

const STEPS: Step[] = [
  { op: { t: "token.move", tokenId: "horse", x: 6, y: 4 }, who: P1 },
  { op: { t: "token.move", tokenId: "horse", x: 8, y: 4 }, who: P1 },
  { op: { t: "token.detach", tokenId: "pip", x: 10, y: 4 }, who: P1 },
  { op: { t: "token.move", tokenId: "horse", x: 8, y: 5 }, who: DM },
  // The undo of the warhorse's second move, once it left the turn.
  { undo: 1, who: P1 },
  { op: { t: "token.attach", tokenId: "pip", to: "horse", kind: "ride", steer: true, x: 7, y: 5, elevation: 0 }, who: P1 },
  { op: { t: "token.move", tokenId: "horse", x: 6, y: 10 }, who: P1 },
  { op: { t: "encounter.next" }, who: DM },
  { op: { t: "token.move", tokenId: "gob", x: 21, y: 20 }, who: DM },
  { op: { t: "encounter.prev" }, who: DM },
  { op: { t: "encounter.next" }, who: DM },
  { op: { t: "encounter.remove", entryIds: ["rgob"] }, who: DM },
  { undo: 11, who: DM },
  { op: { t: "encounter.end" }, who: DM },
];

/** Each step's hash of its state, the keys it wrote and its undo, every op stored at `opVersion`. */
function replay(opVersion: number | undefined): string[] {
  let state = start();
  const inverses: (RestoreEntry[] | null)[] = [];
  return STEPS.map((step, i) => {
    const op: Op =
      "op" in step
        ? step.op
        : {
            t: "sys.restore",
            entries: inverses[step.undo]!.map((e) => ({ key: e.key, value: e.value, expectHash: guardHash(e.key, readEntity(state, e.key)) })),
            from: "undo",
            deps: true,
          };
    const r = applyOp(state, op, step.who, { seq: 11 + i, at: AT, ...(opVersion === undefined ? {} : { opVersion }) });
    assert.ok(r.ok, `step ${i} (${op.t}) at ${opVersion}: ${r.ok ? "" : r.message}`);
    state = r.state;
    inverses.push(r.inverse);
    return hash128(stableStringify({ state: r.state, touched: r.touched, inverse: r.inverse }));
  });
}

if (process.env.TURNWALKS_RECORD === "1") {
  for (const v of VERSIONS) console.log(JSON.stringify({ [v]: replay(v) }));
}

describe("stored ops of change formats 61 to 64 replay to what they made (walksEndWithTurn)", () => {
  for (const v of VERSIONS) {
    test(`at ${v}`, () => {
      assert.deepEqual(replay(v), PINNED);
    });
  }

  test("live, the same ops differ from the getting off on, where the warhorse's walk leaves with it", () => {
    const live = replay(undefined);
    assert.deepEqual(live.slice(0, 2), PINNED.slice(0, 2));
    assert.notEqual(live[2], PINNED[2]);
  });
});
