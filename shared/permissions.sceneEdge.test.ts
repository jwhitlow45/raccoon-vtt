import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "./model.ts";
import { MOVE_OFF_MAP, TELEPORT_OFF_MAP, canApply, type PermissionDeps } from "./permissions.ts";
import { opSchema, type Op } from "./protocol.ts";
import { hexCenter, type HexGrid } from "./rules/hex.ts";
import { DM, P1, room, scene, token } from "./testutil.ts";

/**
 * A player's plain move ends with the token wholly inside the scene, as a
 * teleport does (DROP-OFF-MAP, D-261122-160), whatever the scene's walls
 * and whoever's token it is. The DM's moves are not checked. A refusal
 * reads the token's own footprint and the scene's bounds, so it never
 * says anything about a creature or a square a player cannot see.
 */
const deps: PermissionDeps = { canUseAsset: () => true };
const COLUMNS: HexGrid = { shape: "hex", orient: "columns" };

/** The scene is 40 by 30, as every test scene is. */
function table(blocking: boolean, setup?: (s: RoomState) => void, moveAny = true): RoomState {
  const state = room({
    scenes: { s1: scene("s1", blocking ? { blockMovement: true } : {}) },
    tokens: {
      own: token("own", { name: "Thorn", kind: "pc", x: 5, y: 5, ownerIds: ["p1"] }),
      big: token("big", { name: "Horse", size: "large", x: 10, y: 10, ownerIds: ["p1"] }),
      gob: token("gob", { name: "Goblin", x: 20, y: 20 }),
    },
  });
  if (moveAny) state.meta.settings.playersMoveAny = "all";
  setup?.(state);
  return state;
}

function answer(state: RoomState, op: Op, who = P1): string {
  const d = canApply(opSchema.parse(op), who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

const off = `forbidden: ${MOVE_OFF_MAP}`;

for (const blocking of [false, true]) {
  describe(`a plain move on a scene whose walls ${blocking ? "stop" : "do not stop"} moves`, () => {
    test("a Medium creature ends on the scene, up to every edge, and never past one", () => {
      const state = table(blocking);
      for (const [x, y] of [[0, 0], [39, 29], [39, 0], [0, 29], [20, 14]] as const) assert.equal(answer(state, { t: "token.move", tokenId: "own", x, y }), "ok", `${x},${y}`);
      for (const [x, y] of [[-1, 5], [5, -1], [40, 5], [5, 30], [-10, 5], [5, -10], [200, 200], [39.5, 5], [-0.5, 5]] as const) {
        assert.equal(answer(state, { t: "token.move", tokenId: "own", x, y }), off, `${x},${y}`);
      }
    });

    test("a Large creature needs its whole box on the scene", () => {
      const state = table(blocking);
      assert.equal(answer(state, { t: "token.move", tokenId: "big", x: 38, y: 28 }), "ok");
      assert.equal(answer(state, { t: "token.move", tokenId: "big", x: 39, y: 28 }), off);
      assert.equal(answer(state, { t: "token.move", tokenId: "big", x: 38, y: -1 }), off);
    });

    test("a token the player may move but does not own is held to it too", () => {
      const state = table(blocking);
      assert.equal(answer(state, { t: "token.move", tokenId: "gob", x: 3, y: -4 }), off);
      assert.equal(answer(state, { t: "token.move", tokenId: "gob", x: 3, y: 4 }), "ok");
    });

    test("a group move is refused whole when one leg ends past the edge, and rights come first", () => {
      const state = table(blocking);
      const legs = (y: number): Op => ({ t: "token.moveMany", moves: [{ tokenId: "own", x: 6, y: 6 }, { tokenId: "gob", x: 21, y }] });
      assert.equal(answer(state, legs(21)), "ok");
      assert.equal(answer(state, legs(-2)), off);
      assert.equal(answer(table(blocking, undefined, false), legs(-2)), "forbidden: that is not yours");
    });

    test("a walk's route already keeps its stops on the scene, and its last stretch is no way out", () => {
      const state = table(blocking);
      assert.equal(answer(state, { t: "token.move", tokenId: "own", x: 7, y: 5, route: [[6, 5, 0, 0], [7, 5, 0, 0]] }), "ok");
      assert.match(answer(state, { t: "token.move", tokenId: "own", x: 5, y: -4, route: [[5, 4, 0, 0], [5, -4, 0, 0]] }), /^invalid: /);
    });

    test("a redo of a move ends inside the scene as a new move does", () => {
      const state = table(blocking);
      const redo = (x: number): Op => ({ t: "sys.restore", entries: [{ key: "token:own", value: { ...state.tokens.own!, x } }], from: "redo", deps: true });
      assert.equal(answer(state, redo(8)), "ok");
      assert.equal(answer(state, redo(-8)), off);
      // Walked along routes, a redo ends where its last stretch does.
      const routed = (x: number): Op => ({ ...(redo(x) as Extract<Op, { t: "sys.restore" }>), routes: { own: [[[x < 0 ? 4 : x, 5, 0, 0]]] } });
      assert.equal(answer(state, routed(8)), "ok");
      assert.equal(answer(state, routed(-8)), off);
    });

    test("a seat and a get-off place end inside the scene", () => {
      const state = table(blocking, (s) => {
        s.tokens.big = { ...s.tokens.big!, x: 0, y: 0 };
        s.tokens.own = { ...s.tokens.own!, x: 1, y: 1 };
      });
      const ride = (x: number, y: number): Op => ({ t: "token.attach", tokenId: "own", to: "big", kind: "ride", x, y, elevation: 0 });
      assert.equal(answer(state, ride(1, 0)), "ok");
      assert.equal(answer(state, ride(-1, 0)), off);
      const riding = table(blocking, (s) => {
        s.tokens.big = { ...s.tokens.big!, x: 0, y: 0 };
        s.tokens.own = { ...s.tokens.own!, x: 1, y: 0, attached: { to: "big", kind: "ride" } };
      });
      assert.equal(answer(riding, { t: "token.detach", tokenId: "own", x: 2, y: 1 }), "ok");
      assert.equal(answer(riding, { t: "token.detach", tokenId: "own", x: 0, y: -1 }), off);
    });

    test("the DM is never held to it, and a teleport keeps its own words", () => {
      const state = table(blocking);
      assert.equal(answer(state, { t: "token.move", tokenId: "own", x: -3, y: 80 }, DM), "ok");
      assert.equal(answer(state, { t: "token.move", tokenId: "own", x: -3, y: 5, teleport: "wall" }), `forbidden: ${TELEPORT_OFF_MAP}`);
    });

    test("a token left past the edge may change in place, and come back, but not go further out", () => {
      const parked = table(blocking, (s) => (s.tokens.own = { ...s.tokens.own!, x: -3, y: 5 }));
      assert.equal(answer(parked, { t: "token.move", tokenId: "own", x: -3, y: 5, elevation: 10 }), "ok");
      assert.equal(answer(parked, { t: "token.move", tokenId: "own", x: -4, y: 5 }), off);
      assert.equal(answer(parked, { t: "token.move", tokenId: "own", x: 2, y: 5 }), "ok");
    });

    test("a token a player cannot see answers as one that is not there, from the edge rule or not", () => {
      const hidden = table(blocking, (s) => (s.tokens.gob = { ...s.tokens.gob!, visibility: "dm" } as Token));
      assert.equal(answer(hidden, { t: "token.move", tokenId: "gob", x: 3, y: -4 }), "gone: that is not here");
      assert.equal(answer(hidden, { t: "token.moveMany", moves: [{ tokenId: "own", x: 6, y: 6 }, { tokenId: "gob", x: 3, y: -4 }] }), "gone: that is not here");
    });

    test("the refusal is the same wherever a hidden creature stands", () => {
      const op: Op = { t: "token.move", tokenId: "own", x: 5, y: -2 };
      const lone = answer(table(blocking), op);
      const crowded = answer(table(blocking, (s) => (s.tokens.lurker = token("lurker", { name: "Lurker", x: 5, y: -2, visibility: "dm" }))), op);
      assert.equal(lone, off);
      assert.equal(crowded, lone);
    });
  });
}

describe("a teleport lands full size, whatever squeeze the token carries (MOVELEDGE-ASTRA-1)", () => {
  test("a squeezed Large creature's teleport to the edge is refused on squares, as a full one's is", () => {
    for (const squeeze of [false, true]) {
      const state = table(true, (s) => (s.tokens.big = { ...s.tokens.big!, ...(squeeze ? { squeeze: true } : {}) } as Token));
      assert.equal(answer(state, { t: "token.move", tokenId: "big", x: 38.5, y: 5, teleport: "wall" }), `forbidden: ${TELEPORT_OFF_MAP}`, `squeezed ${squeeze}`);
      assert.equal(answer(state, { t: "token.move", tokenId: "big", x: 38, y: 5, teleport: "wall" }), "ok", `squeezed ${squeeze}`);
    }
  });

  test("and on hexes, at a corner where only the squeezed hex would fit", () => {
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexColumns", bounds: { w: 20, h: 14 } }) } });
    const c = hexCenter(COLUMNS, { col: 0, row: 0 });
    state.tokens.own = { ...token("own", { name: "Thorn", kind: "pc", size: "large", x: c.x - 0.5, y: c.y - 0.5, ownerIds: ["p1"] }), squeeze: true } as Token;
    assert.equal(answer(state, { t: "token.move", tokenId: "own", x: c.x - 0.5, y: c.y - 0.5, teleport: "wall" }), `forbidden: ${TELEPORT_OFF_MAP}`);
  });
});

describe("a plain move on hexes", () => {
  const hexState = (setup?: (s: RoomState) => void): RoomState => {
    const state = room({ scenes: { s1: scene("s1", { gridShape: "hexColumns", bounds: { w: 20, h: 14 } }) } });
    const c = hexCenter(COLUMNS, { col: 4, row: 4 });
    state.tokens.own = token("own", { name: "Thorn", kind: "pc", x: c.x - 0.5, y: c.y - 0.5, ownerIds: ["p1"] });
    setup?.(state);
    return state;
  };
  const at = (col: number, row: number): { x: number; y: number } => {
    const c = hexCenter(COLUMNS, { col, row });
    return { x: c.x - 0.5, y: c.y - 0.5 };
  };

  test("ends on a hex of the scene, and row -10 is refused", () => {
    const state = hexState();
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(0, 0) }), "ok");
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(5, 6) }), "ok");
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(5, -10) }), off);
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(-1, 3) }), off);
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(5, 40) }), off);
  });

  test("a Large creature needs all three of its hexes on the scene", () => {
    const state = hexState((s) => (s.tokens.own = { ...s.tokens.own!, size: "large", ownerIds: ["p1"] }));
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(5, 6) }), "ok");
    assert.equal(answer(state, { t: "token.move", tokenId: "own", ...at(0, 0) }), off);
  });
});
