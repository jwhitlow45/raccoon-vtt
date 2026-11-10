import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, character, env, room, scene, token } from "#shared/testutil.ts";
import { meetOps } from "./meet.ts";

/*
 * The meet step's ops for a batch (meet.ts): which batches run it, and how
 * many ops a large meeting takes. Each case is a batch whose only key of
 * its kind brings a creature into the party's copy, or makes one
 * numberable, so the step must run for it.
 */

const SERVER: Viewer = { memberId: "server", role: "dm" };

function roomWith(tokens: Token[], extra: Partial<RoomState> = {}): RoomState {
  return room({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), ...extra });
}

function batch(state: RoomState, ops: Op[], who: Viewer = DM): { before: RoomState; after: RoomState; touched: EntityKey[] } {
  let after = state;
  const touched: EntityKey[] = [];
  for (const op of ops) {
    const result = applyOp(after, op, who, env(1));
    assert.ok(result.ok, result.ok ? "" : `${op.t}: ${result.message}`);
    after = result.state;
    touched.push(...result.touched);
  }
  return { before: state, after, touched };
}

/** The room with its creatures met as a batch's end met them. */
function settled(state: RoomState): RoomState {
  let out = state;
  for (const op of meetOps(state, state, [], { skip: false })) {
    const result = applyOp(out, op, SERVER, env(1));
    assert.ok(result.ok);
    out = result.state;
  }
  return out;
}

const goblins = (extra: Partial<Token> = {}) => [token("a"), token("b", { visibility: "dm", ...extra })];

describe("which batches run the meet step", () => {
  const cases: [string, () => { before: RoomState; after: RoomState; touched: EntityKey[] }][] = [
    ["a creature's own change", () => batch(settled(roomWith(goblins())), [{ t: "token.update", tokenId: "b", patch: { visibility: "all" } }])],
    [
      "a blackout lifted",
      () => {
        const state = settled(roomWith([token("a"), token("b")]));
        const dark = { ...state, meta: { ...state.meta, view: { follow: false, blackout: true } } };
        return batch({ ...dark, tokens: { ...dark.tokens, b: token("b") } }, [{ t: "view.blackout", blackout: false }]);
      },
    ],
    [
      "a floor shown",
      () => {
        const scenes = {
          s1: scene("s1", { floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } }),
          up: scene("up", { floor: { of: "s1", level: 1, name: "Upper", height: 10 } }),
          s2: scene("s2", { order: 1 }),
        };
        return batch(settled(roomWith([token("a"), token("b", { sceneId: "up" })], { scenes })), [{ t: "floor.open", sceneId: "up", open: true }]);
      },
    ],
    [
      "fog lifted",
      () => {
        const scenes = { s1: scene("s1", { fogEnabled: true }), s2: scene("s2", { order: 1 }) };
        const reveal = (id: string, x: number) => ({ id, mode: "reveal" as const, shape: { kind: "rect" as const, x, y: 3, w: 1, h: 1 } });
        const state = settled(batch(roomWith([token("a"), token("b", { x: 9 })], { scenes }), [{ t: "fog.live", sceneId: "s1", ops: [reveal("r1", 3)] }]).after);
        return batch(state, [{ t: "fog.live", sceneId: "s1", ops: [reveal("r2", 9)] }]);
      },
    ],
    [
      "a member made DM",
      () => {
        const characters = { hero: character("hero", { ownerIds: ["p1"] }) };
        const owl = (id: string, over: Partial<Token> = {}) => token(id, { kind: "npc", name: "Owl", ...over });
        const state = settled(roomWith([owl("a"), owl("b", { visibility: "dm" })], { characters }));
        const attached = batch(state, [{ t: "token.update", tokenId: "a", patch: { companion: { of: "hero", turn: "own" } } }, { t: "token.update", tokenId: "b", patch: { visibility: "all" } }]).after;
        return batch(settled(attached), [{ t: "sys.memberSetKind", memberId: "p1", kind: "dm" }], SERVER);
      },
    ],
    [
      "a character's players changed",
      () => {
        const characters = { npc: character("npc", { ownerIds: ["p1"] }) };
        const owl = (id: string, over: Partial<Token> = {}) => token(id, { kind: "npc", name: "Owl", ...over });
        const state = settled(roomWith([owl("a"), owl("b", { visibility: "dm" })], { characters }));
        const attached = batch(state, [{ t: "token.update", tokenId: "a", patch: { companion: { of: "npc", turn: "own" } } }, { t: "token.update", tokenId: "b", patch: { visibility: "all" } }]).after;
        return batch(settled(attached), [{ t: "character.update", characterId: "npc", patch: { ownerIds: [] } }]);
      },
    ],
    [
      "the scene's fog turned off",
      () => {
        const scenes = { s1: scene("s1", { fogEnabled: true }), s2: scene("s2", { order: 1 }) };
        return batch(settled(roomWith([token("a"), token("b")], { scenes })), [{ t: "scene.update", sceneId: "s1", patch: { fogEnabled: false } }]);
      },
    ],
    ["the players moved", () => batch(settled(roomWith([token("a", { sceneId: "s2" }), token("b", { sceneId: "s2" })])), [{ t: "room.setPlayerScene", sceneId: "s2" }])],
  ];
  for (const [what, make] of cases) {
    test(`${what} runs it and meets as the step with no skip does`, () => {
      const { before, after, touched } = make();
      const ops = meetOps(before, after, touched);
      assert.ok(ops.length > 0, "the step found someone to meet");
      assert.deepEqual(ops, meetOps(before, after, touched, { skip: false }));
    });
  }

  test("a batch that touched nothing the step watches skips it", () => {
    const state = settled(roomWith(goblins()));
    const chat = batch(state, [{ t: "log.chat", text: "hello" }]);
    // A creature the party would meet, slipped into the state behind the step's back, shows that the skip alone kept it out.
    const after = { ...chat.after, tokens: { ...chat.after.tokens, b: token("b") } };
    assert.deepEqual(meetOps(state, after, chat.touched), []);
    assert.equal(meetOps(state, after, chat.touched, { skip: false }).length, 1);
  });
});

describe("a large meeting", () => {
  test("names at most a scene's creatures in one op, in id order", () => {
    const tokens = Array.from({ length: 501 }, (_, i) => token(`t${String(i).padStart(3, "0")}`));
    const state = roomWith(tokens);
    const ops = meetOps(state, state, [], { skip: false });
    assert.deepEqual(
      ops.map((op) => op.tokenIds.length),
      [500, 1],
    );
    assert.equal(ops[1]!.tokenIds[0], "t500");
    let after = state;
    for (const op of ops) {
      const result = applyOp(after, op, SERVER, env(1));
      assert.ok(result.ok, result.ok ? "" : result.message);
      after = result.state;
    }
    assert.equal(after.tokens.t000!.number, 1);
    assert.equal(after.tokens.t500!.number, 501);
  });
});
