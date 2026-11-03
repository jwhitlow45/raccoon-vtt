import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "./model.ts";
import { canApply, type PermissionDeps } from "./permissions.ts";
import { clientOpSchema, type Op } from "./protocol.ts";
import { DM, P1, P2, character, room, token } from "./testutil.ts";

/*
 * Who places a token between squares (docs/design/design-v1-snap-off.md 5.4):
 * a free move is a move, judged as one. A placement in place, and Snap to
 * grid, are token updates of `drawnAt` alone, which an owner sends, a
 * companion's included, on a token the move check lets them move, and the
 * DM on any. A locked token's placement changes only by the DM, undo included.
 */

const deps: PermissionDeps = { canUseAsset: () => true };

function setup(): RoomState {
  const state = room();
  state.characters.hero = character("hero", { ownerIds: ["p1"] });
  state.tokens.own = token("own", { kind: "npc", name: "Owl", ownerIds: ["p1"], x: 3, y: 3 });
  state.tokens.pc = token("pc", { kind: "pc", name: "Hero", actor: { ref: "hero" }, ownerIds: [], x: 5, y: 3 });
  state.tokens.spirit = token("spirit", { kind: "npc", name: "Wildfire Spirit", ownerIds: ["p1"], companion: { of: "hero", turn: "shared" }, x: 6, y: 3 });
  state.tokens.gob = token("gob", { x: 8, y: 3 });
  return state;
}

function code(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : d.code;
}

const place = (tokenId: string, drawnAt: { x: number; y: number } | null): Op => ({ t: "token.update", tokenId, patch: { drawnAt } });

describe("a placement in place (5.4)", () => {
  test("an owner, through the character and as a companion's owner, and the DM on any token", () => {
    for (const id of ["own", "pc", "spirit"]) {
      assert.equal(code(place(id, { x: 3.25, y: 3 })), "ok", id);
      assert.equal(code(place(id, null)), "ok", `${id}, Snap to grid`);
    }
    assert.equal(code(place("gob", { x: 8.25, y: 3 }), DM), "ok");
    const locked = setup();
    locked.tokens.gob!.locked = true;
    assert.equal(code(place("gob", null), DM, locked), "ok", "the DM's lock does not hold the DM");
  });

  test("not a player who may move a token they do not own, nor one who owns none of it", () => {
    const state = setup();
    state.meta.settings.playersMoveAny = "all";
    assert.equal(code(place("gob", { x: 8.25, y: 3 }), P1, state), "forbidden");
    assert.equal(code(place("own", { x: 3.25, y: 3 }), P2, state), "forbidden");
    assert.equal(code({ t: "token.move", tokenId: "gob", x: 9, y: 3, drawnAt: { x: 9.25, y: 3 } }, P1, state), "ok", "a free move is a move, which they may make");
  });

  test("a lock refuses it to an owner, companions included, as it refuses a move", () => {
    const state = setup();
    for (const id of ["own", "pc", "spirit"]) state.tokens[id]!.locked = true;
    for (const id of ["own", "pc", "spirit"]) {
      assert.equal(code(place(id, { x: 3.25, y: 3 }), P1, state), "forbidden", id);
      assert.equal(code(place(id, null), P1, state), "forbidden", `${id}, Snap to grid`);
      assert.equal(code({ t: "token.move", tokenId: id, x: 4, y: 3, drawnAt: { x: 4.25, y: 3 } }, P1, state), "forbidden", `${id}, a free move`);
      assert.equal(code({ t: "token.update", tokenId: id, patch: { rotation: 90 } }, P1, state), "ok", `${id}, facing, which owners keep on a locked token`);
    }
  });

  test("a patch with anything beside it never parses, so no branch of the check sees one", () => {
    for (const other of [{ rotation: 90 }, { elevation: 5 }, { name: "Owl" }, { companionReaction: true }, { size: "large" }]) {
      assert.equal(clientOpSchema.safeParse({ t: "token.update", tokenId: "own", patch: { drawnAt: { x: 3.25, y: 3 }, ...other } }).success, false, JSON.stringify(other));
    }
  });
});

describe("a player's undo that changes a placement (5.4)", () => {
  const back = (state: RoomState, id: string, patch: Partial<Token>): Op => ({
    t: "sys.restore",
    entries: [{ key: `token:${id}`, value: { ...state.tokens[id]!, rev: 7, ...patch } }],
    from: "undo",
    deps: true,
  });

  test("takes back a free move and its placement, as a move's undo takes back its pose", () => {
    const state = setup();
    state.tokens.own = { ...state.tokens.own!, x: 4, nudge: { x: 2, y: 0 } };
    const { nudge: _n, ...unplaced } = state.tokens.own;
    assert.equal(code({ t: "sys.restore", entries: [{ key: "token:own", value: { ...unplaced, x: 3 } }], from: "undo", deps: true }, P1, state), "ok");
    assert.equal(code(back(state, "own", { x: 3, nudge: { x: -1, y: 1 } }), P1, state), "ok", "a redo's placement");
    assert.equal(code(back(state, "own", { x: 3, nudge: { x: -1, y: 1 }, name: "Renamed" }), P1, state), "forbidden", "and nothing else about it");
  });

  test("in place on a locked token is refused when it changes the placement, and passes when it keeps it", () => {
    const state = setup();
    state.tokens.own = { ...state.tokens.own!, nudge: { x: 2, y: 0 }, locked: true };
    assert.equal(code(back(state, "own", { nudge: { x: 3, y: 0 } }), P1, state), "forbidden");
    const { nudge: _n, ...unplaced } = state.tokens.own;
    assert.equal(code({ t: "sys.restore", entries: [{ key: "token:own", value: unplaced }], from: "undo", deps: true }, P1, state), "forbidden", "taking it off");
    assert.equal(code(back(state, "own", { rotation: 90 }), P1, state), "ok", "facing alone, with the placement kept");
    assert.equal(code(back(state, "own", { nudge: { x: 3, y: 0 } }), DM, state), "ok", "the DM's");
    state.tokens.own.locked = false;
    assert.equal(code(back(state, "own", { nudge: { x: 3, y: 0 } }), P1, state), "ok", "unlocked");
  });
});
