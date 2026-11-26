import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GROUND, UPPER, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { MAX_MOVES, MAX_RESTORE_ENTRIES, opSchema, type Op } from "#shared/protocol.ts";
import { fallRecord } from "#shared/floorLinksTestutil.ts";
import { token } from "#shared/testutil.ts";
import { scopeActor } from "./undoScopeTesting.ts";

/*
 * A step's fall records are bounded by what one step can move, not by the
 * moves an op names (docs/design/design-v1-floors.md phase 4, 4.5,
 * FLR4-SOL-02): fallsKept keeps a record only for a root whose key the
 * step's inverse holds, and an inverse holds at most MAX_RESTORE_ENTRIES.
 * So a move naming MAX_MOVES creatures that also drags one more over a
 * hole makes MAX_MOVES + 1 records, and its undo and redo still run.
 */

/** Ana's creature `id` on Upper floor. */
const mine = (id: string, x: number, y: number, over: Partial<Token> = {}): Token => token(id, { kind: "npc", name: id, ownerIds: ["p1"], sceneId: UPPER, x, y, ...over });

/**
 * The tower's floors 40 by 40, with 16 openings, the most a scene holds: one
 * 4 by 4 at 6, 6, where Thorn walks in dragging a goblin, and 15 rows of 8
 * squares, at rows 20, 23 and 26, each with a row of Ana's creatures just
 * below it that step up into it.
 */
function crowd(): { state: RoomState; moves: { tokenId: string; x: number; y: number }[] } {
  let state = tower();
  for (const id of [GROUND, UPPER]) state.scenes[id] = { ...state.scenes[id]!, bounds: { w: 40, h: 40 } };
  state = withOpening(state, { id: "o1", pairId: "o2", rect: { x: 6, y: 6, w: 4, h: 4 } });
  let n = 0;
  for (const y of [20, 23, 26]) for (const x of [0, 8, 16, 24, 32]) state = withOpening(state, { id: `h${n}`, pairId: `l${n++}`, rect: { x, y, w: 8, h: 1 } });
  const tokens: Record<string, Token> = { ...state.tokens };
  tokens.thorn = { ...tokens.thorn!, sceneId: UPPER, x: 3, y: 7 };
  tokens.goblin = mine("goblin", 2, 7, { attached: { to: "thorn", kind: "drag" } });
  const moves = [{ tokenId: "thorn", x: 8, y: 7 }];
  for (const y of [20, 23, 26]) {
    for (let x = 0; x < 40 && moves.length < MAX_MOVES; x++) {
      const id = `c${y}_${x}`;
      tokens[id] = mine(id, x, y + 1);
      moves.push({ tokenId: id, x, y });
    }
  }
  return { state: { ...state, tokens }, moves };
}

describe("a step's fall records (FLR4-SOL-02)", () => {
  test("a restore takes as many records as an inverse holds entries, and no more", () => {
    const restore = (n: number) => ({ t: "sys.restore", from: "undo", entries: [{ key: "token:thorn", value: null }], falls: Array.from({ length: n }, (_, i) => fallRecord({ tokenId: `t${i}`, fallId: `120:${i}` })) });
    assert.equal(opSchema.safeParse(restore(MAX_MOVES + 1)).success, true);
    assert.equal(opSchema.safeParse(restore(MAX_RESTORE_ENTRIES)).success, true);
    assert.equal(opSchema.safeParse(restore(MAX_RESTORE_ENTRIES + 1)).success, false);
  });

  test("Ana's move of MAX_MOVES creatures that drags a goblin through a hole too undoes and redoes, all of them", async (t) => {
    const { state, moves } = crowd();
    assert.equal(moves.length, MAX_MOVES);
    const { actor, connect } = await scopeActor(t, state, { idGate: false });
    const ana = await connect(state.members.p1!, "player");
    const now = () => actor.committed.state;
    const floors = () => [...moves.map((m) => m.tokenId), "goblin"].map((id) => now().tokens[id]!.sceneId);
    await ana.apply({ t: "token.moveMany", moves } satisfies Op);
    assert.deepEqual(new Set(floors()), new Set([GROUND]), "every named creature and the goblin fell");
    assert.equal(Object.keys(now().falls ?? {}).length, 10, "the room keeps its 10 newest cards");
    await ana.restore("play", "undo");
    assert.deepEqual(new Set(floors()), new Set([UPPER]), "the undo takes all of them back up");
    await ana.restore("play", "redo");
    assert.deepEqual(new Set(floors()), new Set([GROUND]), "the redo takes them down again");
  });

  test("both of Thorn's tokens in one group move onto the hole make one card, which Ana's undo takes away and her redo writes once", async (t) => {
    const base = withOpening(tower());
    const state: RoomState = { ...base, tokens: { thorn: { ...base.tokens.thorn!, sceneId: UPPER, x: 6, y: 4 }, thorn2: { ...base.tokens.thorn!, id: "thorn2", sceneId: UPPER, x: 7, y: 4 } } };
    const { actor, connect } = await scopeActor(t, state, { idGate: false });
    const ana = await connect(state.members.p1!, "player");
    const now = () => actor.committed.state;
    const cards = () => Object.values(now().falls ?? {}).map((c) => [c.tokenId, ...(c.riders ?? [])]);
    await ana.apply({ t: "token.moveMany", moves: [{ tokenId: "thorn", x: 6, y: 6 }, { tokenId: "thorn2", x: 7, y: 7 }] } satisfies Op);
    assert.deepEqual(cards(), [["thorn", "thorn2"]], "one card for Thorn");
    await ana.restore("play", "undo");
    assert.deepEqual([now().tokens.thorn!.sceneId, now().tokens.thorn2!.sceneId, cards()], [UPPER, UPPER, []]);
    await ana.restore("play", "redo");
    assert.deepEqual([now().tokens.thorn!.sceneId, now().tokens.thorn2!.sceneId, cards()], [GROUND, GROUND, [["thorn", "thorn2"]]], "both records carried the card, written once");
  });
});

