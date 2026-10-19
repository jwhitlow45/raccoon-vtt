import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "./keys.ts";
import type { EdgeFeature, RoomState, Token, Viewer } from "./model.ts";
import { RIDE_ON_YOUR_TURN, WALL_IN_THE_WAY, canApply, mayMoveToken, type PermissionDeps } from "./permissions.ts";
import type { Op } from "./protocol.ts";
import { DM, P1, P2, actor, effect, entry, room, token } from "./testutil.ts";

/**
 * Who may attach, detach, drag and direct a mount (docs/design-v1-attach.md
 * 6): each rule for a player, the leg test on a seat step and a get-off
 * leg, the right to steer a controlled mount and to re-seat a carried token.
 */

const deps: PermissionDeps = { canUseAsset: () => true };

function answer(state: RoomState, op: Op, who: Viewer = P1): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : `${d.code}: ${d.message}`;
}

/** P1's Bree at 6,4 beside a warhorse at 4,4 that P1 also plays, a goblin at 7,5 and the DM's ogre. */
function table(setup?: (s: RoomState) => void): RoomState {
  const state = room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, ownerIds: ["p1"] }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 6, y: 4, ownerIds: ["p1"] }),
      gob: token("gob", { name: "Goblin 2", x: 7, y: 5 }),
      ogre: token("ogre", { name: "Ogre", size: "large", x: 20, y: 20 }),
      torch: token("torch", { name: "Torch", kind: "object", size: "tiny", x: 6.5, y: 5.5 }),
    },
  });
  setup?.(state);
  return state;
}

const ride = (x = 5, y = 4): Op => ({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x, y, elevation: 0 });
const drag: Op = { t: "token.attach", tokenId: "gob", to: "bree", kind: "drag", x: 7, y: 5, elevation: 0 };
const grappled = (t: Token): Token => ({ ...t, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } });

describe("ride, perch and carry (6)", () => {
  test("need the right to move both tokens and the two within reach", () => {
    assert.equal(answer(table(), ride()), "ok");
    assert.equal(answer(table((s) => (s.tokens.horse = { ...s.tokens.horse!, ownerIds: [] })), ride()), "forbidden: that is not yours");
    assert.equal(answer(table((s) => (s.tokens.bree = { ...s.tokens.bree!, x: 8 })), ride()), "forbidden: Bree is too far from Warhorse");
    assert.equal(answer(table((s) => (s.tokens.horse = { ...s.tokens.horse!, locked: true })), ride()), "forbidden: that token is locked");
    // Carry Torch: Bree picks up a torch, whoever's it is, only when the room lets her move it.
    const pickUp: Op = { t: "token.attach", tokenId: "torch", to: "bree", kind: "carry", x: 6.5, y: 4.5, elevation: 0 };
    assert.equal(answer(table(), pickUp), "forbidden: that is not yours");
    assert.equal(answer(table((s) => (s.meta.settings.playersMoveAny = "all")), pickUp), "ok");
  });

  test("a hidden token answers as one that is not there", () => {
    assert.equal(answer(table((s) => (s.tokens.horse = { ...s.tokens.horse!, ownerIds: [], visibility: "dm" })), ride()), "gone: that is not here");
  });

  test("on a scene whose walls stop moves, the step onto the seat meets them", () => {
    const walled = table((s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true };
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "6,4,w": { kind: "wall" } as EdgeFeature } };
    });
    assert.equal(answer(walled, ride()), `forbidden: ${WALL_IN_THE_WAY}`);
  });

  test("so does a creature carried by a creature: it is lifted onto its seat, never through a wall, while a drag leaves it where it stands", () => {
    const edges: Record<string, EdgeFeature> = {};
    for (let y = 0; y < 10; y++) edges[`7,${y},w`] = { kind: "wall" };
    const walled = table((s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true };
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
      s.tokens.gob = grappled({ ...s.tokens.gob!, size: "small" });
    });
    const carry: Op = { t: "token.attach", tokenId: "gob", to: "bree", kind: "carry", x: 6, y: 4, elevation: 0 };
    assert.equal(answer(walled, carry), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(answer(walled, carry, DM), "ok");
    assert.equal(answer(walled, drag), "ok");
  });

  test("a ride in a fight waits for the rider's own turn", () => {
    const fight = (active: string) =>
      table((s) => {
        s.encounter = { rev: 0, round: 1, activeEntryId: active, entries: [entry("eb", { tokenId: "bree", value: 15 }), entry("eg", { tokenId: "gob", value: 10, tieOrder: 1 })] };
      });
    assert.equal(answer(fight("eb"), ride()), "ok");
    assert.equal(answer(fight("eg"), ride()), `forbidden: ${RIDE_ON_YOUR_TURN}`);
    // A row the player cannot see acting answers the same.
    const hidden = fight("eg");
    hidden.encounter!.entries[1] = { ...hidden.encounter!.entries[1]!, hidden: true };
    assert.equal(answer(hidden, ride()), `forbidden: ${RIDE_ON_YOUR_TURN}`);
    // A perch is no mounting.
    const owl = fight("eg");
    owl.tokens.owl = token("owl", { kind: "npc", size: "tiny", x: 6, y: 5, ownerIds: ["p1"] });
    assert.equal(answer(owl, { t: "token.attach", tokenId: "owl", to: "bree", kind: "perch", x: 6, y: 4, elevation: 0 }), "ok");
  });
});

describe("drag, and a creature carried (6)", () => {
  test("need the right to move the holder, the two within reach, and the creature's too or a Grappled mark players see", () => {
    assert.equal(answer(table(), drag), "forbidden: Goblin 2 is not marked Grappled");
    assert.equal(answer(table((s) => (s.tokens.gob = grappled(s.tokens.gob!))), drag), "ok");
    assert.equal(answer(table((s) => (s.meta.settings.playersMoveAny = "all")), drag), "ok");
    assert.equal(answer(table((s) => (s.tokens.gob = { ...grappled(s.tokens.gob!), x: 9 })), drag), "forbidden: Goblin 2 is too far to drag");
    const kobold = table((s) => (s.tokens.gob = { ...grappled(s.tokens.gob!), size: "small" }));
    assert.equal(answer(kobold, { t: "token.attach", tokenId: "gob", to: "bree", kind: "carry", x: 6, y: 4, elevation: 0 }), "ok");
  });

  test("a Grappled mark the DM hid from players does not count, so the answer is the same with or without it", () => {
    const hiddenMark = table((s) => {
      s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ effects: [effect("g", { key: "grappled", hiddenFromPlayers: true })] }) } };
    });
    assert.equal(answer(hiddenMark, drag), answer(table(), drag));
  });
});

describe("detaching (6)", () => {
  const riding = (setup?: (s: RoomState) => void) =>
    table((s) => {
      s.tokens.bree = { ...s.tokens.bree!, x: 5, y: 4, attached: { to: "horse", kind: "ride", steer: true } };
      setup?.(s);
    });

  test("the carried creature's player can always get off, and the holder's player can let go or put down", () => {
    assert.equal(answer(riding((s) => (s.tokens.bree = { ...s.tokens.bree!, locked: true })), { t: "token.detach", tokenId: "bree", x: 6, y: 4 }), "ok");
    const held = table((s) => (s.tokens.gob = { ...s.tokens.gob!, attached: { to: "bree", kind: "drag" } }));
    assert.equal(answer(held, { t: "token.detach", tokenId: "gob" }), "ok");
    assert.equal(answer(held, { t: "token.detach", tokenId: "gob" }, P2), "forbidden: that is not yours");
  });

  test("a link to a holder the player cannot see answers as a token attached to nothing", () => {
    const hidden = table((s) => {
      s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 6, y: 4, visibility: "dm" });
      s.tokens.torch = { ...s.tokens.torch!, ownerIds: ["p1"], attached: { to: "imp", kind: "carry" } };
    });
    const loose = table((s) => (s.tokens.torch = { ...s.tokens.torch!, ownerIds: ["p1"] }));
    assert.equal(answer(hidden, { t: "token.detach", tokenId: "torch" }), "invalid: Torch is not attached to anything");
    assert.equal(answer(hidden, { t: "token.detach", tokenId: "torch" }), answer(loose, { t: "token.detach", tokenId: "torch" }));
  });

  test("getting off is a walk from the seat that meets the walls", () => {
    const walled = riding((s) => {
      s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true };
      s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "6,4,w": { kind: "wall" } as EdgeFeature } };
    });
    assert.equal(answer(walled, { t: "token.detach", tokenId: "bree", x: 6, y: 4 }), `forbidden: ${WALL_IN_THE_WAY}`);
    assert.equal(answer(walled, { t: "token.detach", tokenId: "bree", x: 5, y: 6 }), "ok");
  });
});

describe("moving a group (6)", () => {
  /** P2 plays Cora, who rides the DM's warhorse by a controlled ride, and the goblin is dragged by it. */
  const mounted = (steer: boolean) =>
    table((s) => {
      s.tokens.horse = { ...s.tokens.horse!, ownerIds: [] };
      s.tokens.cora = token("cora", { name: "Cora", kind: "pc", x: 4, y: 4, ownerIds: ["p2"], attached: { to: "horse", kind: "ride", ...(steer ? { steer: true as const } : {}) } });
      s.tokens.gob = { ...s.tokens.gob!, x: 6, y: 5, attached: { to: "horse", kind: "drag" } };
    });

  test("a player directs a controlled mount their creature rides, though they own nothing of it", () => {
    const move: Op = { t: "token.move", tokenId: "horse", x: 8, y: 4 };
    assert.equal(answer(mounted(true), move, P2), "ok");
    assert.equal(answer(mounted(false), move, P2), "forbidden: that is not yours");
    assert.equal(answer(mounted(true), move, P1), "forbidden: that is not yours");
    const locked = mounted(true);
    locked.tokens.horse = { ...locked.tokens.horse!, locked: true };
    assert.equal(answer(locked, move, P2), "forbidden: that token is locked");
    // Only a rider and a link every player sees: a rider the DM hid from the others gives no right.
    const hidden = mounted(true);
    hidden.tokens.cora = { ...hidden.tokens.cora!, visibility: "dm" };
    assert.equal(answer(hidden, move, P2), "forbidden: that is not yours");
    assert.equal(mayMoveToken(mounted(true), P2, "horse").ok, true);
  });

  test("the right to move the named token is enough for its group, and its members' drag frames go with it", () => {
    const own = table((s) => (s.tokens.gob = { ...s.tokens.gob!, x: 6, y: 5, attached: { to: "horse", kind: "drag" } }));
    assert.equal(answer(own, { t: "token.move", tokenId: "horse", x: 8, y: 4 }), "ok");
    assert.equal(mayMoveToken(own, P1, "gob").ok, true);
    assert.equal(mayMoveToken(own, P2, "gob").ok, false);
  });

  test("a player re-seats a token carried by one they may move, and only where it keeps its link", () => {
    const held = table((s) => (s.tokens.torch = { ...s.tokens.torch!, x: 6.5, y: 4.5, attached: { to: "bree", kind: "carry" } }));
    assert.equal(answer(held, { t: "token.move", tokenId: "torch", x: 6, y: 4 }), "ok");
    assert.equal(answer(held, { t: "token.move", tokenId: "torch", x: 9, y: 4 }), "forbidden: that is not yours");
    // Pulling a grappled goblin out of reach is the goblin's own move.
    const dragged = table((s) => (s.tokens.gob = { ...grappled(s.tokens.gob!), attached: { to: "bree", kind: "drag" } }));
    assert.equal(answer(dragged, { t: "token.move", tokenId: "gob", x: 7, y: 4 }), "ok");
    assert.equal(answer(dragged, { t: "token.move", tokenId: "gob", x: 9, y: 4 }), "forbidden: that is not yours");
  });

  test("walls test each dragged creature among the public members on the holder's route offset by its place, and never what rides", () => {
    const walled = (hide: boolean) =>
      table((s) => {
        s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true };
        const edges: Record<string, EdgeFeature> = {};
        for (let y = 0; y < 4; y++) edges[`9,${y},w`] = { kind: "wall" };
        s.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
        s.tokens.gob = { ...s.tokens.gob!, x: 6, y: 3, attached: { to: "horse", kind: "drag" }, ...(hide ? { visibility: "dm" as const } : {}) };
        s.tokens.bree = { ...s.tokens.bree!, x: 4, y: 4, attached: { to: "horse", kind: "ride" } };
      });
    const move: Op = { t: "token.move", tokenId: "horse", x: 10, y: 4 };
    assert.equal(answer(walled(false), move), `forbidden: ${WALL_IN_THE_WAY}`);
    // A hidden goblin walks in the private pass: the move is taken and it stops unseen.
    assert.equal(answer(walled(true), move), "ok");
    assert.equal(answer(walled(false), move, DM), "ok");
  });
});
