import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chunkKey } from "./keys.ts";
import type { FreeWall, RoomState, Token } from "./model.ts";
import {
  DOOR_DM_ONLY,
  DOOR_LOCKED,
  DOOR_TOO_FAR,
  LEDGE_IN_THE_WAY,
  NOT_A_SQUEEZE,
  TELEPORT_OFF_MAP,
  WALL_IN_THE_WAY,
  canApply,
  mayMoveToken,
  type PermissionDeps,
} from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { encodeHeights } from "./heightCodec.ts";
import { movementRules, type MovementRules } from "./ruleHooks.ts";
import { DM, P1, P2, room, token } from "./testutil.ts";

/**
 * Wave 4's permissions (docs/design-v1-maps-vision.md 4.1): walls and ledges
 * stopping players' moves, teleports, squeezes, doors within reach, and the
 * redo of a move. The movement test is part 4B's, so these run on a stand-in
 * that the permissions only call: a wall along x = 10 and a ledge along
 * y = 10, a squeeze fitting only half a cell off the grid, and a clear line
 * to a door from anyone but a token named "Behind a pillar".
 */
const fake: MovementRules = {
  legBlocker: (_state, t, to) => ((t.x < 10) !== (to.x < 10) ? "wall" : (t.y < 10) !== (to.y < 10) ? "ledge" : null),
  squeezeFits: (_state, end) => end.at.x % 1 === 0.5,
  lineClear: (_state, t) => t.name !== "Behind a pillar",
};
const real = { ...movementRules };
before(() => Object.assign(movementRules, fake));
after(() => Object.assign(movementRules, real));

const deps: PermissionDeps = { canUseAsset: () => true };
const DOOR = { kind: "door", state: "closed", secret: false, discovered: false } as const;
const freeDoor: FreeWall = { id: "freedoorfree", a: [12, 2.5], b: [13, 2.5], f: DOOR };
/** A free door on a grid line, whose two sides are two cells. */
const lineDoor: FreeWall = { id: "linedoorline", a: [14, 4], b: [15, 4], f: DOOR };

function setup(): RoomState {
  const state = room();
  state.scenes.s1!.blockMovement = true;
  state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 1, y: 1 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 2, y: 2 });
  state.buildChunks[chunkKey("s1", 0, 0)] = {
    sceneId: "s1",
    cx: 0,
    cy: 0,
    rev: 0,
    cells: {},
    edges: {
      "5,5,n": DOOR,
      "6,5,w": { ...DOOR, state: "locked" },
      "7,5,w": { ...DOOR, secret: true },
      "8,5,w": { kind: "wall" },
    },
    walls: [freeDoor, lineDoor],
  };
  return state;
}

function decide(op: Op, who = P1, state = setup()): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

describe("walls and ledges stop players' moves", () => {
  test("a player's move across a wall or a ledge is refused on a scene that blocks movement, and the DM's never", () => {
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 12, y: 1 }), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 1, y: 12 }), `forbidden: ${LEDGE_IN_THE_WAY}`);
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 4, y: 4 }), "ok");
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 12, y: 1 }, DM), "ok");
    // Rising where it stands crosses no edge.
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 1, y: 1, elevation: 30 }), "ok");
  });

  test("the drag preview's question is rights alone, whatever walls stand between", () => {
    const state = setup();
    assert.equal(mayMoveToken(state, P1, "own").ok, true);
    assert.deepEqual(mayMoveToken(state, P1, "gob"), { ok: false, code: "forbidden", message: "that is not yours" });
    assert.equal(mayMoveToken(state, DM, "gob").ok, true);
    assert.equal(mayMoveToken(state, DM, "missing").ok, false);
  });

  test("a scene without the setting stops nothing, as every scene from before wave 4", () => {
    const state = setup();
    delete state.scenes.s1!.blockMovement;
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 12, y: 1 }, P1, state), "ok");
  });

  test("a group move is refused when any of its legs is stopped, and rights come first", () => {
    const state = setup();
    state.meta.settings.playersMoveAny = "all";
    assert.equal(decide({ t: "token.moveMany", moves: [{ tokenId: "own", x: 3, y: 3 }, { tokenId: "gob", x: 12, y: 2 }] }, P1, state), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(decide({ t: "token.moveMany", moves: [{ tokenId: "own", x: 3, y: 3 }, { tokenId: "gob", x: 3, y: 2 }] }, P1, state), "ok");
    assert.equal(decide({ t: "token.moveMany", moves: [{ tokenId: "own", x: 12, y: 3 }, { tokenId: "gob", x: 3, y: 2 }] }), "forbidden: that is not yours");
  });

  test("a teleport skips the wall and ledge test and nothing else: rights, the lock and the map's edge still count", () => {
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 12, y: 12, teleport: "wall" }), "ok");
    assert.equal(decide({ t: "token.move", tokenId: "gob", x: 12, y: 2, teleport: "wall" }), "forbidden: that is not yours");
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 39.5, y: 1, teleport: "wall" }), `forbidden: ${TELEPORT_OFF_MAP}`);
    assert.equal(decide({ t: "token.move", tokenId: "own", x: -1, y: 1, teleport: "ledge" }), `forbidden: ${TELEPORT_OFF_MAP}`);
    const state = setup();
    state.tokens.own!.locked = true;
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 12, y: 1, teleport: "wall" }, P1, state), "forbidden: that token is locked");
  });

  test("a squeeze is refused with invalid unless the opening is one, from anyone", () => {
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 2.5, y: 3, squeeze: true }), "ok");
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 2, y: 3, squeeze: true }), `invalid: ${NOT_A_SQUEEZE}`);
    assert.equal(decide({ t: "token.move", tokenId: "gob", x: 2, y: 3, squeeze: true }, DM), `invalid: ${NOT_A_SQUEEZE}`);
    assert.equal(decide({ t: "token.move", tokenId: "gob", x: 2.5, y: 3, squeeze: true }, DM), "ok");
    // A teleport lands squeezed by the same rule.
    assert.equal(decide({ t: "token.move", tokenId: "own", x: 12.5, y: 3, squeeze: true, teleport: "wall" }), "ok");
  });
});

describe("a player's undo and redo of a move", () => {
  const moved = (state: RoomState, x: number): Token => ({ ...state.tokens.own!, x });

  test("an undo is never stopped, and a redo is tested like a new move unless it is a teleport's", () => {
    const state = setup();
    const back: Op = { t: "sys.restore", entries: [{ key: "token:own", value: moved(state, 12) }], from: "undo", deps: true };
    assert.equal(decide(back, P1, state), "ok");
    const redo: Op = { ...back, from: "redo" };
    assert.equal(decide(redo, P1, state), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(decide({ ...redo, teleport: true }, P1, state), "ok");
    assert.equal(decide({ t: "sys.restore", entries: [{ key: "token:own", value: moved(state, 4) }], from: "redo", deps: true }, P1, state), "ok");
  });

  test("an undo may put a squeeze back or take it off with the place", () => {
    const state = setup();
    state.tokens.own = { ...state.tokens.own!, x: 2.5, squeeze: true };
    const { squeeze: _squeeze, ...unsqueezed } = state.tokens.own;
    assert.equal(decide({ t: "sys.restore", entries: [{ key: "token:own", value: { ...unsqueezed, x: 1 } }], from: "undo", deps: true }, P1, state), "ok");
    // Anything but the pose is still not the player's to put back.
    assert.equal(
      decide({ t: "sys.restore", entries: [{ key: "token:own", value: { ...unsqueezed, x: 1, name: "Renamed" } }], from: "undo", deps: true }, P1, state),
      "forbidden: an undo of yours only moves tokens back",
    );
  });
});

describe("doors", () => {
  test("a player opens and closes a door their own token reaches", () => {
    const state = setup();
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 5, y: 6 });
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open" }, P1, state), "ok");
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "closed" }, P1, state), "ok");
    // Another player's token reaches nothing for them.
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open" }, P2, state), `forbidden: ${DOOR_TOO_FAR}`);
  });

  test("reach is 5 ft or one cell, whichever is more, by the room's diagonal rule, from either side, with a clear line to the door", () => {
    const at = (x: number, y: number, extra: Partial<Token> = {}, feetPerCell = 5) => {
      const state = setup();
      state.meta.settings.feetPerCell = feetPerCell;
      state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x, y, ...extra });
      return state;
    };
    const open: Op = { t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open" };
    for (const feetPerCell of [5, 10]) {
      const label = `${feetPerCell} ft per cell`;
      assert.equal(decide(open, P1, at(5, 5, {}, feetPerCell)), "ok", `${label}: beside the door, south`);
      assert.equal(decide(open, P1, at(5, 3, {}, feetPerCell)), "ok", `${label}: beside the door's north cell`);
      assert.equal(decide(open, P1, at(6, 6, {}, feetPerCell)), "ok", `${label}: diagonally, every diagonal one cell`);
      assert.equal(decide(open, P1, at(5, 7, {}, feetPerCell)), `forbidden: ${DOOR_TOO_FAR}`, `${label}: one cell away`);
      const euclid = at(6, 6, {}, feetPerCell);
      euclid.meta.settings.diagonal = "euclid";
      assert.equal(decide(open, P1, euclid), `forbidden: ${DOOR_TOO_FAR}`, `${label}: true distance puts the diagonal past one cell`);
    }
    assert.equal(decide(open, P1, at(5, 6, { name: "Behind a pillar" })), `forbidden: ${DOOR_TOO_FAR}`);
  });

  test("reach counts elevation by the same rule, so a creature flying above the door does not reach it", () => {
    const at = (elevation: number, feetPerCell = 5) => {
      const state = setup();
      state.meta.settings.feetPerCell = feetPerCell;
      state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 5, y: 5, elevation });
      return state;
    };
    const open: Op = { t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open" };
    assert.equal(decide(open, P1, at(30)), `forbidden: ${DOOR_TOO_FAR}`, "30 ft up");
    assert.equal(decide(open, P1, at(5)), "ok", "a hop of 5 ft is within 5 ft");
    assert.equal(decide(open, P1, at(10)), `forbidden: ${DOOR_TOO_FAR}`);
    assert.equal(decide(open, P1, at(10, 10)), "ok", "one layer up at 10 ft per cell");
    assert.equal(decide(open, P1, at(30, 10)), `forbidden: ${DOOR_TOO_FAR}`);
    // On raised ground the door's cells are measured at their ground, so a creature standing up there reaches it.
    const raised = at(20);
    raised.buildChunks[chunkKey("s1", 0, 0)] = { ...raised.buildChunks[chunkKey("s1", 0, 0)]!, heights: encodeHeights(Int16Array.from({ length: 256 }, () => 20)) };
    assert.equal(decide(open, P1, raised), "ok");
  });

  test("a free door's sides are the cells beside its midpoint", () => {
    const state = setup();
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 12, y: 3 });
    const op: Op = { t: "door.set", sceneId: "s1", door: { cx: 0, cy: 0, id: freeDoor.id }, state: "open" };
    assert.equal(decide(op, P1, state), "ok");
    // The door runs through the middle of row 2, so both its sides are that row's cell.
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 12, y: 1 });
    assert.equal(decide(op, P1, state), "ok", "from the north");
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 12, y: 0 });
    assert.equal(decide(op, P1, state), `forbidden: ${DOOR_TOO_FAR}`);
    // On a grid line, each side is its own cell.
    const onLine: Op = { t: "door.set", sceneId: "s1", door: { cx: 0, cy: 0, id: lineDoor.id }, state: "open" };
    for (const [y, answer] of [[2, "ok"], [5, "ok"], [1, `forbidden: ${DOOR_TOO_FAR}`], [6, `forbidden: ${DOOR_TOO_FAR}`]] as const) {
      state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 14, y });
      assert.equal(decide(onLine, P1, state), answer, `from row ${y}`);
    }
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 12, y: 5 });
    assert.equal(decide(op, P1, state), `forbidden: ${DOOR_TOO_FAR}`);
  });

  test("a locked door says so, players never lock or mark found, and what they cannot see as a door is not there", () => {
    const state = setup();
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 6, y: 6 });
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "6,5,w" }, state: "open" }, P1, state), `forbidden: ${DOOR_LOCKED}`);
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "locked" }, P1, state), `forbidden: ${DOOR_DM_ONLY}`);
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open", found: true }, P1, state), `forbidden: ${DOOR_DM_ONLY}`);
    for (const door of [{ edge: "7,5,w" }, { edge: "8,5,w" }, { edge: "9,5,w" }, { cx: 0, cy: 0, id: "nonenonenone" }]) {
      assert.equal(decide({ t: "door.set", sceneId: "s1", door, state: "open" }, P1, state), "gone: that is not here", JSON.stringify(door));
    }
    assert.equal(decide({ t: "door.set", sceneId: "s2", door: { edge: "5,5,n" }, state: "open" }, P1, state), "gone: that is not here");
    const dark = setup();
    dark.meta.view.blackout = true;
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "5,5,n" }, state: "open" }, P1, dark), "gone: that is not here");
  });

  test("a door out of reach answers the same whether it is locked or not, so no request lists the locks", () => {
    const state = setup();
    // A locked free door too, beside the closed one.
    const chunk = state.buildChunks[chunkKey("s1", 0, 0)]!;
    chunk.walls = [...chunk.walls!, { id: "lockedfreedr", a: [12, 6], b: [13, 6], f: { ...DOOR, state: "locked" } }];
    const doors = [{ edge: "5,5,n" }, { edge: "6,5,w" }, { cx: 0, cy: 0, id: freeDoor.id }, { cx: 0, cy: 0, id: "lockedfreedr" }];
    const answers = (who: typeof P1, s: RoomState) =>
      doors.flatMap((door) => (["open", "closed"] as const).map((to) => decide({ t: "door.set", sceneId: "s1", door, state: to }, who, s)));
    // A player with no token on the scene, and one whose token stands far from every door.
    assert.deepEqual(new Set(answers(P2, state)), new Set([`forbidden: ${DOOR_TOO_FAR}`]));
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 30, y: 25 });
    assert.deepEqual(new Set(answers(P1, state)), new Set([`forbidden: ${DOOR_TOO_FAR}`]));
    // Within reach, the lock tells.
    state.tokens.own = token("own", { name: "Familiar", ownerIds: ["p1"], x: 12, y: 6 });
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { cx: 0, cy: 0, id: "lockedfreedr" }, state: "open" }, P1, state), `forbidden: ${DOOR_LOCKED}`);
  });

  test("the DM sets any door to any state, found or not", () => {
    assert.equal(decide({ t: "door.set", sceneId: "s1", door: { edge: "7,5,w" }, state: "locked", found: true }, DM), "ok");
  });

  test("the server's explore is no client's op, and players paint no heights or stairs", () => {
    const tile = "A".repeat(683) + "=";
    assert.equal(decide({ t: "sys.explore", sceneId: "s1", tiles: [{ tx: 0, ty: 0, bits: tile }] }, DM).split(":")[0], "forbidden");
    assert.equal(decide({ t: "sys.explore", sceneId: "s1", tiles: [{ tx: 0, ty: 0, bits: tile }] }).split(":")[0], "forbidden");
    assert.equal(decide({ t: "build.height", sceneId: "s1", cells: ["1,1"], height: 5 }).split(":")[0], "forbidden");
    assert.equal(decide({ t: "build.stairs", sceneId: "s1", cells: ["1,1"], up: "a" }).split(":")[0], "forbidden");
  });
});

describe("a token's light and party membership", () => {
  test("owners set their token's light, and only the DM makes a creature a party member", () => {
    assert.equal(decide({ t: "token.update", tokenId: "own", patch: { light: { bright: 20, dim: 20 } } }), "ok");
    assert.equal(decide({ t: "token.update", tokenId: "own", patch: { light: null } }), "ok");
    assert.equal(decide({ t: "token.update", tokenId: "gob", patch: { light: { bright: 20, dim: 20 } } }), "forbidden: that is not yours");
    assert.equal(decide({ t: "token.update", tokenId: "own", patch: { partyVision: true } }), "forbidden: owners cannot change partyVision");
    assert.equal(decide({ t: "token.update", tokenId: "gob", patch: { partyVision: true } }, DM), "ok");
  });
});
