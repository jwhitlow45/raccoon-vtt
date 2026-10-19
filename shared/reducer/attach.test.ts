import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { BuildChunk, EdgeFeature, LogEvent, RoomState, Token, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { encodeHeights } from "../rules/heights.ts";
import { describeMove, planMove } from "../rules/moveLeg.ts";
import { DM, P1, actor, effect, env, room, template, token } from "../testutil.ts";
import type { Env } from "./tx.ts";

/**
 * Holders carrying what they hold (docs/design-v1-attach.md 5 and 8.2): a
 * holder's move takes its group, a carried token's move re-seats it or lets
 * it loose, teleports and scene changes, the link pass, ground changes,
 * attaching and detaching, duplicates, the area sweep and replay below op
 * version 14.
 */

const at = (seq: number, opVersion?: number): Env => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 1, opVersion?: number): RoomState {
  const r = applyOp(state, op, who, at(seq, opVersion));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : `${r.code}: ${r.message}`}`);
  return r.state;
}

function refusal(state: RoomState, op: Op, who: Viewer = DM): string {
  const r = applyOp(state, op, who, at(1));
  assert.ok(!r.ok, `${op.t} should be refused`);
  return r.message;
}

/** A Large warhorse at 4,4 ridden by Bree, who holds a torch and drags a goblin. */
function stable(): RoomState {
  return room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4 }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 4, y: 4, ownerIds: ["p1"], attached: { to: "horse", kind: "ride", steer: true } }),
      torch: token("torch", { name: "Torch", kind: "object", size: "tiny", x: 4.5, y: 4.5, attached: { to: "bree", kind: "carry" } }),
      gob: token("gob", { name: "Goblin 2", size: "small", x: 6, y: 4, attached: { to: "horse", kind: "drag" } }),
    },
  });
}

function heights(state: RoomState, cells: Record<string, number>): void {
  const feet = new Array<number>(256).fill(0);
  for (const [key, ft] of Object.entries(cells)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    feet[y * 16 + x] = ft;
  }
  const chunk: BuildChunk = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, ...(encodeHeights(feet) ? { heights: encodeHeights(feet)! } : {}) };
  state.buildChunks[chunkKey("s1", 0, 0)] = chunk;
}

function place(t: Token | undefined): [number, number, number] {
  assert.ok(t);
  return [t.x, t.y, t.elevation];
}

describe("a holder's move takes its group (8.2)", () => {
  test("every member moves by the holder's dx and dy, and the op names only the holder", () => {
    const s = run(stable(), { t: "token.move", tokenId: "horse", x: 10, y: 6 });
    assert.deepEqual(place(s.tokens.horse), [10, 6, 0]);
    assert.deepEqual(place(s.tokens.bree), [10, 6, 0]);
    assert.deepEqual(place(s.tokens.torch), [10.5, 6.5, 0]);
    assert.deepEqual(place(s.tokens.gob), [12, 6, 0]);
    assert.equal(s.tokens.bree!.attached?.to, "horse");
    assert.equal(s.tokens.gob!.attached?.kind, "drag");
  });

  test("facing is never carried", () => {
    const s = run(stable(), { t: "token.move", tokenId: "horse", x: 8, y: 4, rotation: 90 });
    assert.equal(s.tokens.horse!.rotation, 90);
    assert.equal(s.tokens.bree!.rotation, 0);
  });

  test("what rides takes the holder's change of elevation, and a dragged creature its own ground behind a walker", () => {
    const state = stable();
    heights(state, { "10,6": 10, "11,6": 10, "10,7": 10, "11,7": 10, "12,6": 5 });
    const s = run(state, { t: "token.move", tokenId: "horse", x: 10, y: 6, elevation: 10 });
    assert.deepEqual(place(s.tokens.bree), [10, 6, 10]);
    assert.deepEqual(place(s.tokens.torch), [10.5, 6.5, 10]);
    assert.deepEqual(place(s.tokens.gob), [12, 6, 5]);
  });

  test("a flier lifts what it drags by its own change, never below the ground", () => {
    const state = stable();
    state.tokens.horse = { ...state.tokens.horse!, elevation: 20 };
    state.tokens.bree = { ...state.tokens.bree!, elevation: 20 };
    state.tokens.torch = { ...state.tokens.torch!, elevation: 20 };
    heights(state, { "12,6": 15 });
    const s = run(state, { t: "token.move", tokenId: "horse", x: 10, y: 6, elevation: 30 });
    assert.deepEqual(place(s.tokens.bree), [10, 6, 30]);
    assert.deepEqual(place(s.tokens.gob), [12, 6, 15]);
    const lower = run(state, { t: "token.move", tokenId: "horse", x: 10, y: 6, elevation: 40 });
    assert.deepEqual(place(lower.tokens.gob), [12, 6, 20]);
  });

  test("a selection naming the holder and a member moves each where the op says, the same in either order", () => {
    const one = run(stable(), { t: "token.moveMany", moves: [{ tokenId: "horse", x: 8, y: 4 }, { tokenId: "gob", x: 11, y: 4 }] });
    const other = run(stable(), { t: "token.moveMany", moves: [{ tokenId: "gob", x: 11, y: 4 }, { tokenId: "horse", x: 8, y: 4 }] });
    assert.deepEqual(place(one.tokens.gob), [11, 4, 0]);
    assert.deepEqual(place(one.tokens.bree), [8, 4, 0]);
    for (const id of ["horse", "bree", "torch", "gob"]) assert.deepEqual(place(one.tokens[id]), place(other.tokens[id]), id);
    // Named away out of reach, the goblin comes loose in the link pass.
    assert.equal(one.tokens.gob!.attached, undefined);
  });

  test("a loop the rules let stand moves once, whichever of it is named", () => {
    const state = room({ tokens: { a: token("a", { x: 1, y: 1, attached: { to: "b", kind: "drag" } }), b: token("b", { x: 2, y: 1, attached: { to: "a", kind: "drag" } }) } });
    const s = run(state, { t: "token.move", tokenId: "a", x: 5, y: 1 });
    assert.deepEqual(place(s.tokens.a), [5, 1, 0]);
    assert.deepEqual(place(s.tokens.b), [6, 1, 0]);
  });

  test("a teleport takes what rides and leaves what it drags, whose link then breaks", () => {
    const s = run(stable(), { t: "token.move", tokenId: "horse", x: 20, y: 10, teleport: "wall" });
    assert.deepEqual(place(s.tokens.bree), [20, 10, 0]);
    assert.deepEqual(place(s.tokens.torch), [20.5, 10.5, 0]);
    assert.deepEqual(place(s.tokens.gob), [6, 4, 0]);
    assert.equal(s.tokens.gob!.attached, undefined);
    assert.equal(s.tokens.bree!.attached?.to, "horse");
  });

  test("a scene change takes the whole group, its areas with it", () => {
    const state = stable();
    state.templates.aura = template("aura", { attachedTo: "bree" });
    const s = run(state, { t: "token.update", tokenId: "horse", patch: { sceneId: "s2" } });
    for (const id of ["horse", "bree", "torch", "gob"]) assert.equal(s.tokens[id]!.sceneId, "s2", id);
    assert.equal(s.templates.aura!.sceneId, "s2");
    assert.equal(s.tokens.gob!.attached?.to, "horse");
  });

  test("a carried token sent to another scene alone comes loose", () => {
    const s = run(stable(), { t: "token.update", tokenId: "bree", patch: { sceneId: "s2" } });
    assert.equal(s.tokens.bree!.attached, undefined);
    assert.equal(s.tokens.torch!.sceneId, "s2");
    assert.equal(s.tokens.torch!.attached?.to, "bree");
  });
});

describe("walls and a dragged creature players cannot see (4.2)", () => {
  /** P1's horse drags a hidden goblin, with a wall in the goblin's row and not the horse's. */
  function walled(): RoomState {
    const edges: Record<string, EdgeFeature> = {};
    for (let y = 0; y < 6; y++) edges[`8,${y},w`] = { kind: "wall" };
    return room({
      scenes: { s1: { ...room().scenes.s1!, blockMovement: true }, s2: room().scenes.s2! },
      buildChunks: { [chunkKey("s1", 0, 0)]: { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges } },
      tokens: {
        horse: token("horse", { kind: "npc", size: "large", x: 4, y: 6, ownerIds: ["p1"] }),
        gob: token("gob", { size: "small", x: 6, y: 5, visibility: "dm", attached: { to: "horse", kind: "drag" } }),
      },
    });
  }

  test("on a player's move it stops unseen where its own leg test stops it, and comes loose out of reach", () => {
    const s = run(walled(), { t: "token.move", tokenId: "horse", x: 12, y: 6 }, P1);
    assert.deepEqual(place(s.tokens.horse), [12, 6, 0]);
    assert.deepEqual(place(s.tokens.gob), [7, 5, 0]);
    assert.equal(s.tokens.gob!.attached, undefined);
  });

  test("the DM's move is never stopped by walls", () => {
    const s = run(walled(), { t: "token.move", tokenId: "horse", x: 12, y: 6 });
    assert.deepEqual(place(s.tokens.gob), [14, 5, 0]);
    assert.equal(s.tokens.gob!.attached?.to, "horse");
  });
});

describe("a carried token's own move (4.2)", () => {
  test("stays attached on its holder in a new seat, and comes loose off it", () => {
    const reseated = run(stable(), { t: "token.move", tokenId: "bree", x: 5, y: 5 });
    assert.equal(reseated.tokens.bree!.attached?.to, "horse");
    assert.deepEqual(place(reseated.tokens.torch), [5.5, 5.5, 0]);
    const off = run(stable(), { t: "token.move", tokenId: "bree", x: 8, y: 8 });
    assert.equal(off.tokens.bree!.attached, undefined);
    assert.equal(off.tokens.torch!.attached?.to, "bree");
  });

  test("a dragged creature stays attached within reach and comes loose past it", () => {
    assert.equal(run(stable(), { t: "token.move", tokenId: "gob", x: 6, y: 6 }).tokens.gob!.attached?.to, "horse");
    assert.equal(run(stable(), { t: "token.move", tokenId: "gob", x: 7, y: 4 }).tokens.gob!.attached, undefined);
  });
});

describe("the link pass (5.2)", () => {
  test("runs after a delete, a resize and an elevation change", () => {
    const deleted = run(stable(), { t: "token.delete", tokenId: "horse" });
    assert.equal(deleted.tokens.bree!.attached, undefined);
    assert.equal(deleted.tokens.gob!.attached, undefined);
    assert.equal(deleted.tokens.torch!.attached?.to, "bree");
    // Reduce: the horse shrinks to Medium, which carries no Medium rider.
    const shrunk = run(stable(), { t: "token.update", tokenId: "horse", patch: { size: "medium" } });
    assert.equal(shrunk.tokens.bree!.attached, undefined);
    const raised = run(stable(), { t: "token.update", tokenId: "gob", patch: { elevation: 15 } });
    assert.equal(raised.tokens.gob!.attached, undefined);
  });

  test("keeps a stored kind when the condition that led to it ends", () => {
    const state = room({
      tokens: {
        thorn: token("thorn", { kind: "pc", x: 1, y: 1 }),
        kobold: token("kobold", { size: "small", x: 1, y: 1, attached: { to: "thorn", kind: "carry" }, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } }),
      },
    });
    const s = run(state, { t: "actor.effect.remove", target: { tokenId: "kobold" }, effectId: "g" });
    assert.equal(s.tokens.kobold!.attached?.kind, "carry");
  });
});

describe("attaching (8.2)", () => {
  const loose = () =>
    room({
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4 }),
        bree: token("bree", { name: "Bree", kind: "pc", x: 6, y: 4 }),
        torch: token("torch", { name: "Torch", kind: "object", size: "tiny", x: 6.5, y: 4.5, attached: { to: "bree", kind: "carry" } }),
        gob: token("gob", { name: "Goblin 2", x: 7, y: 5 }),
        ogre: token("ogre", { name: "Ogre", size: "large", x: 20, y: 20 }),
      },
    });

  test("a ride steps onto its seat with what the rider carries, and stores its kind", () => {
    const s = run(loose(), { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    assert.deepEqual(s.tokens.bree!.attached, { to: "horse", kind: "ride", steer: true });
    assert.deepEqual(place(s.tokens.bree), [5, 4, 0]);
    assert.deepEqual(place(s.tokens.torch), [5.5, 4.5, 0]);
  });

  test("a drag leaves the creature where it stands, within reach", () => {
    const s = run(loose(), { t: "token.attach", tokenId: "gob", to: "bree", kind: "drag", x: 7, y: 5, elevation: 0 });
    assert.deepEqual(s.tokens.gob!.attached, { to: "bree", kind: "drag" });
    assert.match(refusal(loose(), { t: "token.attach", tokenId: "gob", to: "bree", kind: "drag", x: 6, y: 5, elevation: 0 }), /stays where it stands/);
    assert.equal(refusal(loose(), { t: "token.attach", tokenId: "ogre", to: "bree", kind: "drag", x: 20, y: 20, elevation: 0 }), "Ogre is too far to drag");
  });

  test("refuses what does not fit, a seat off the holder, steer off a ride, another scene and a loop", () => {
    assert.equal(refusal(loose(), { t: "token.attach", tokenId: "ogre", to: "horse", kind: "ride", x: 4, y: 4, elevation: 0 }), "Warhorse is not big enough to carry Ogre");
    assert.equal(refusal(loose(), { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 7, y: 4, elevation: 0 }), "Bree does not sit on Warhorse there");
    assert.equal(refusal(loose(), { t: "token.attach", tokenId: "gob", to: "bree", kind: "drag", steer: true, x: 7, y: 5, elevation: 0 }), "only a ride is controlled");
    const apart = loose();
    apart.tokens.gob = { ...apart.tokens.gob!, sceneId: "s2" };
    assert.equal(refusal(apart, { t: "token.attach", tokenId: "gob", to: "bree", kind: "drag", x: 7, y: 5, elevation: 0 }), "Goblin 2 and Bree are on different scenes");
    assert.equal(refusal(loose(), { t: "token.attach", tokenId: "bree", to: "torch", kind: "carry", x: 6.5, y: 4.5, elevation: 0 }), "Torch is not big enough to carry Bree");
    const looped = loose();
    looped.tokens.bree = { ...looped.tokens.bree!, x: 7, y: 5, attached: { to: "gob", kind: "drag" } };
    assert.equal(refusal(looped, { t: "token.attach", tokenId: "gob", to: "bree", kind: "drag", x: 7, y: 5, elevation: 0 }), "Goblin 2 would carry itself");
  });

  test("a seat is at its holder's elevation whatever the op says, for the step, what rides along and the description", () => {
    const op: Op = { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 4, elevation: 500 };
    const s = run(loose(), op);
    assert.deepEqual(place(s.tokens.bree), [5, 4, 0]);
    assert.deepEqual(place(s.tokens.torch), [5.5, 4.5, 0]);
    assert.deepEqual(planMove(op, loose(), DM, env(1)).find((m) => m.tokenId === "bree")?.to, { sceneId: "s1", x: 5, y: 4, elevation: 0 });
  });

  test("a second attach replaces the link, and the same holder and seat toggle Controlled", () => {
    let s = run(loose(), { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 });
    s = run(s, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", x: 5, y: 4, elevation: 0 }, DM, 2);
    assert.deepEqual(s.tokens.bree!.attached, { to: "horse", kind: "ride" });
    s.tokens.cat = token("cat", { x: 8, y: 6 });
    s.tokens.dog = token("dog", { x: 8, y: 4 });
    s = run(s, { t: "token.attach", tokenId: "gob", to: "cat", kind: "drag", x: 7, y: 5, elevation: 0 }, DM, 3);
    s = run(s, { t: "token.attach", tokenId: "gob", to: "dog", kind: "drag", x: 7, y: 5, elevation: 0 }, DM, 4);
    assert.equal(s.tokens.gob!.attached?.to, "dog");
  });
});

describe("detaching (8.1)", () => {
  test("a creature gets off beside its holder, leaving a cart too, with what it carries", () => {
    const s = run(stable(), { t: "token.detach", tokenId: "bree", x: 6, y: 5 });
    assert.equal(s.tokens.bree!.attached, undefined);
    assert.deepEqual(place(s.tokens.bree), [6, 5, 0]);
    assert.deepEqual(place(s.tokens.torch), [6.5, 5.5, 0]);
    const cart = room({ tokens: { cart: token("cart", { kind: "object", size: "large", x: 2, y: 2 }), bree: token("bree", { kind: "pc", x: 2, y: 2, attached: { to: "cart", kind: "carry" } }) } });
    assert.equal(run(cart, { t: "token.detach", tokenId: "bree", x: 4, y: 2 }).tokens.bree!.attached, undefined);
  });

  test("refuses a place for Put down and Let go, and one not beside the holder", () => {
    assert.equal(refusal(stable(), { t: "token.detach", tokenId: "torch", x: 7, y: 4 }), "Put down and Let go leave it where it stands");
    assert.equal(refusal(stable(), { t: "token.detach", tokenId: "gob", x: 7, y: 4 }), "Put down and Let go leave it where it stands");
    assert.equal(refusal(stable(), { t: "token.detach", tokenId: "bree", x: 9, y: 4 }), "Bree can only get off beside Warhorse");
    assert.equal(refusal(stable(), { t: "token.detach", tokenId: "bree", x: 5, y: 4 }), "Bree can only get off beside Warhorse");
  });

  test("a place's elevation is the ground there or the creature's own, never another height", () => {
    const raised = stable();
    heights(raised, { "6,5": 10 });
    assert.deepEqual(place(run(raised, { t: "token.detach", tokenId: "bree", x: 6, y: 5, elevation: 10 }).tokens.bree), [6, 5, 10]);
    assert.deepEqual(place(run(raised, { t: "token.detach", tokenId: "bree", x: 6, y: 5, elevation: 0 }).tokens.bree), [6, 5, 0]);
    assert.equal(refusal(raised, { t: "token.detach", tokenId: "bree", x: 6, y: 5, elevation: 5 }), "Bree gets off onto the ground there or at its own height");
  });

  test("Put down and Let go leave it where it stands", () => {
    const s = run(run(stable(), { t: "token.detach", tokenId: "torch" }), { t: "token.detach", tokenId: "gob" }, DM, 2);
    assert.equal(s.tokens.torch!.attached, undefined);
    assert.deepEqual(place(s.tokens.torch), [4.5, 4.5, 0]);
    assert.equal(s.tokens.gob!.attached, undefined);
    assert.match(refusal(s, { t: "token.detach", tokenId: "gob" }), /not attached/);
  });
});

describe("ground changes (5.2)", () => {
  test("a height paint lifts a standing holder with what rides it, and a dragged creature keeps to its own ground", () => {
    const s = run(stable(), { t: "build.height", sceneId: "s1", cells: ["4,4", "5,4", "4,5", "5,5"], height: 10 });
    assert.deepEqual(place(s.tokens.horse), [4, 4, 10]);
    assert.deepEqual(place(s.tokens.bree), [4, 4, 10]);
    assert.deepEqual(place(s.tokens.torch), [4.5, 4.5, 10]);
    assert.deepEqual(place(s.tokens.gob), [6, 4, 0]);
    assert.equal(s.tokens.gob!.attached, undefined, "10 ft below its holder, out of reach");
  });

  test("ground under a rider alone lifts nothing: it stands on its mount", () => {
    const s = run(stable(), { t: "build.height", sceneId: "s1", cells: ["4,4"], height: 5 });
    assert.equal(s.tokens.bree!.elevation, s.tokens.horse!.elevation);
  });
});

describe("a scene's duplicate (5.2)", () => {
  test("copies links between the copies and drops one whose holder stayed", () => {
    const state = stable();
    state.tokens.bree = { ...state.tokens.bree!, kind: "npc" };
    state.tokens.horse = { ...state.tokens.horse!, kind: "pc" };
    const s = run(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } });
    const copies = Object.values(s.tokens).filter((t) => t.sceneId === "s3");
    const byName = Object.fromEntries(copies.map((t) => [t.name, t]));
    assert.equal(byName.Bree!.attached, undefined, "the horse, a PC, was not copied");
    assert.equal(byName.Torch!.attached?.to, byName.Bree!.id);
  });
});

describe("the area sweep along a group's move (9)", () => {
  test("a rider carried through an area that hits on entering is reminded, as its mount is", () => {
    const state = stable();
    state.tokens.gob = { ...state.tokens.gob!, attached: undefined, x: 30, y: 20 };
    state.templates.cloud = template("cloud", { origin: { x: 10, y: 5, z: 0 }, size: 10, shape: "sphere", triggers: ["enter"], ownerId: "dm1", spell: "Stinking Cloud" });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [{ id: "e1", tokenId: "gob", value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false }] };
    const s = run(state, { t: "token.move", tokenId: "horse", x: 16, y: 4 });
    const hit = s.log.flatMap((e) => (e.data?.type === "area" ? [(e.data as Extract<LogEvent, { type: "area" }>).tokenId] : [])).sort();
    assert.deepEqual(hit, ["bree", "horse"]);
  });
});

describe("one description of a move (contract 3.1)", () => {
  test("describeMove after the reducer equals planMove before it, carried entries naming their holders", () => {
    const op: Op = { t: "token.move", tokenId: "horse", x: 9, y: 7 };
    const before = stable();
    const plan = planMove(op, before, DM, {});
    const after = run(before, op);
    assert.deepEqual(describeMove(op, before, after, DM, {}), plan);
    assert.deepEqual(
      plan.map((m) => [m.tokenId, m.carriedBy ?? null]),
      [
        ["bree", "horse"],
        ["gob", "horse"],
        ["horse", null],
        ["torch", "bree"],
      ],
    );
  });
});

describe("replay below op version 14 (8.6)", () => {
  test("a move is the token alone, and nothing comes loose", () => {
    const s = run(stable(), { t: "token.move", tokenId: "horse", x: 10, y: 6 }, DM, 1, 13);
    assert.deepEqual(place(s.tokens.bree), [4, 4, 0]);
    assert.equal(s.tokens.bree!.attached?.to, "horse");
  });

  test("a height paint lifts every token standing on the ground there, as before", () => {
    const s = run(stable(), { t: "build.height", sceneId: "s1", cells: ["4,4"], height: 5 }, DM, 1, 13);
    assert.equal(s.tokens.bree!.elevation, 5);
  });
});

