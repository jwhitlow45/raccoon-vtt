import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { edge, heights, lift, liftAllBut, paint, remember, wall } from "./discoveryTestutil.ts";
import { chunkKey } from "./keys.ts";
import type { EdgeFeature, RoomState } from "./model.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import {
  DOOR_TOO_FAR,
  LEDGE_IN_THE_WAY,
  SOMETHING_BLOCKS,
  SOMETHING_BLOCKS_BACK,
  WALL_IN_THE_WAY,
  canApply,
  doorReachPassed,
  touchLanding,
  type PermissionDeps,
} from "./permissions.ts";
import type { Op, OpOf } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { sceneGrid } from "./rules/grid.ts";
import { hexAt, hexKey, type HexGrid } from "./rules/hex.ts";
import { NO_ROOM_TO_GROW } from "./rules/resize.ts";
import { DM, P1, actor, character, env, member, room, token } from "./testutil.ts";

/**
 * The touch rule's permissions (docs/design-v1-map-discovery.md 6 and
 * decision 11): what a player hears when the real build stops them, by
 * their live ground on the stopping step, and how the server lands a walk,
 * a squeeze, a resize or a companion placement instead of refusing it in
 * place. Sight is perPlayerTestutil.ts's stub: in the dark Thorn sees the
 * cells one step around him.
 */
const deps: PermissionDeps = { canUseAsset: () => true };

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

const WALL: EdgeFeature = { kind: "wall" };
const BLINDED = { id: "e1", key: "blinded", name: "Blinded" } as never;

/** A dark scene with fog and party vision on whose walls stop moves, Thorn (p1's) at (2, 5), and ground the party explored around him. */
function base(opts: { light?: "dark" | "bright"; fog?: boolean } = {}): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.scenes.s1 = { ...s.scenes.s1!, blockMovement: true, autoWalls: "off", fogEnabled: opts.fog ?? true, vision: { on: true, light: opts.light ?? "dark" } };
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 });
  paint(s, { x: 0, y: 0, w: 24, h: 16 });
  lift(s, "party", { x: 0, y: 3, w: 5, h: 5 });
  return s;
}

function decide(op: Op, state: RoomState, who = P1): string {
  const d = canApply(op, who, state, deps);
  return d.ok ? "ok" : d.message;
}

const east: OpOf<"token.move"> = { t: "token.move", tokenId: "thorn", x: 12, y: 5 };

describe("a walk the real build stops (the touch rule)", () => {
  test("a drag into the dark, a wall there: the generic words, and the server lands it at its last clear spot", () => {
    const s = base();
    edge(s, "8,5,w", WALL);
    assert.equal(decide(east, s), SOMETHING_BLOCKS);
    const landed = touchLanding(east, P1, s, deps);
    assert.deepEqual(landed, { op: { t: "token.move", tokenId: "thorn", x: 7, y: 5 }, words: SOMETHING_BLOCKS });
    assert.equal(decide(landed!.op, s), "ok");
    const r = applyOp(s, landed!.op, P1, env(3));
    assert.ok(r.ok);
    assert.deepEqual([r.state.tokens.thorn!.x, r.state.tokens.thorn!.y], [7, 5]);
  });

  test("a routed walk keeps its pieces up to the cut", () => {
    const s = base();
    edge(s, "8,5,w", WALL);
    const routed: OpOf<"token.move"> = { t: "token.move", tokenId: "thorn", x: 12, y: 6, route: [[5, 5, 0, 0], [11, 5, 0, 0], [12, 6, 0, 0]] };
    assert.equal(decide(routed, s), SOMETHING_BLOCKS);
    const landed = touchLanding(routed, P1, s, deps);
    assert.deepEqual(landed?.op, { t: "token.move", tokenId: "thorn", x: 7, y: 5, route: [[5, 5, 0, 0], [7, 5, 0, 0]] });
    assert.equal(decide(landed!.op, s), "ok");
  });

  test("a walk the held build stops too, as a device in the wall's band may send it, still lands, never refused in place (MD-R9-1)", () => {
    const s = base();
    lift(s, "party", { x: 0, y: 3, w: 16, h: 5 });
    edge(s, "8,5,w", WALL);
    assert.equal(touchLanding(east, P1, s, deps)?.op.t, "token.move");
    assert.deepEqual(touchLanding(east, P1, s, deps), { op: { t: "token.move", tokenId: "thorn", x: 7, y: 5 }, words: SOMETHING_BLOCKS }, "remembered ground names no kind");
  });

  test("a stop on remembered ground by a change out of sight: the generic words", () => {
    const s = base();
    lift(s, "party", { x: 0, y: 3, w: 16, h: 5 });
    // The DM walled the corridor where the party only remembers it open.
    edge(s, "8,5,w", WALL);
    remember(s, null, 0, 0, { edges: { "8,5,w": null } });
    assert.equal(decide(east, s), SOMETHING_BLOCKS);
  });

  test("a stop on ground the DM revealed both sides of: today's words, and the landing carries them", () => {
    const s = base();
    lift(s, "dm", { x: 0, y: 3, w: 16, h: 5 });
    edge(s, "8,5,w", WALL);
    assert.equal(decide(east, s), WALL_IN_THE_WAY);
    assert.deepEqual(touchLanding(east, P1, s, deps), { op: { t: "token.move", tokenId: "thorn", x: 7, y: 5 }, words: WALL_IN_THE_WAY });
  });

  test("the words read the stopping step, not the walk: a walk through remembered ground to a wall the DM revealed both sides of", () => {
    const s = base();
    lift(s, "party", { x: 0, y: 3, w: 16, h: 5 });
    lift(s, "dm", { x: 6, y: 3, w: 5, h: 5 });
    edge(s, "8,5,w", WALL);
    assert.equal(decide(east, s), WALL_IN_THE_WAY);
  });

  test("a blocker just past a live cell's side names no kind: the step reaches the cell it stands in", () => {
    const s = base();
    lift(s, "dm", { x: 0, y: 3, w: 8, h: 5 });
    edge(s, "8,5,w", WALL);
    assert.equal(decide(east, s), SOMETHING_BLOCKS, "cell (8, 5) is not live");
    const open = base();
    lift(open, "dm", { x: 0, y: 3, w: 8, h: 5 });
    // With nothing there the walk is not stopped at all, and a wall further on stops it with the same words.
    edge(open, "10,5,w", WALL);
    assert.equal(decide(east, open), SOMETHING_BLOCKS);
  });

  test("a diagonal past the corner of an unheld raised cell: the generic words, today's where the cell is revealed", () => {
    const make = (revealed: boolean) => {
      const s = base({ light: "bright" });
      s.tokens.thorn = { ...s.tokens.thorn!, x: 2, y: 2 };
      heights(s, { x: 4, y: 3, w: 1, h: 1 }, 10);
      lift(s, "dm", { x: 0, y: 0, w: 10, h: 10 });
      if (!revealed) lift(s, "dm", { x: 4, y: 3, w: 1, h: 1 }, "s1", false);
      return s;
    };
    const diagonal: Op = { t: "token.move", tokenId: "thorn", x: 6, y: 6 };
    assert.equal(decide(diagonal, make(true)), LEDGE_IN_THE_WAY);
    // Thorn's sight reaches (4, 3) from (2, 2) in bright light, so the cell is held but for the DM's hide: take his sight off it too.
    const dark = make(false);
    dark.scenes.s1 = { ...dark.scenes.s1!, vision: { on: true, light: "dark" } };
    assert.equal(decide(diagonal, dark), SOMETHING_BLOCKS);
  });

  test("fog off: today's words and no landing", () => {
    const s = base({ fog: false });
    edge(s, "8,5,w", WALL);
    assert.equal(decide(east, s), WALL_IN_THE_WAY);
    assert.equal(touchLanding(east, P1, s, deps), null);
  });

  test("the DM is never landed, and a refusal the walls do not give stands", () => {
    const s = base();
    edge(s, "8,5,w", WALL);
    assert.equal(touchLanding(east, DM, s, deps), null);
    s.tokens.thorn = { ...s.tokens.thorn!, locked: true };
    assert.equal(touchLanding(east, P1, s, deps), null);
  });

  test("a group's stopped legs each land at their last clear spot", () => {
    const s = base();
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p1"], x: 2, y: 6 });
    edge(s, "8,5,w", WALL);
    const group: Op = { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 12, y: 5 }, { tokenId: "bree", x: 12, y: 6 }] };
    assert.equal(decide(group, s), SOMETHING_BLOCKS);
    const landed = touchLanding(group, P1, s, deps);
    assert.deepEqual(landed?.op, { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 7, y: 5 }, { tokenId: "bree", x: 12, y: 6 }] });
  });
});

describe("a group whose dragged creature an unseen wall stops (MD2-ASTRA-4)", () => {
  /** Thorn at (2, 5) dragging a goblin at (2, 6), Bree at (2, 4) beside them, and a wall the party never saw on the goblin's row. */
  const dragRoom = (wallAt: string) => {
    const s = base();
    s.tokens.gob = token("gob", { name: "Goblin", x: 2, y: 6, attached: { to: "thorn", kind: "drag" } });
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p1"], x: 2, y: 4 });
    edge(s, wallAt, WALL);
    return s;
  };
  const group: OpOf<"token.moveMany"> = { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 12, y: 5 }, { tokenId: "bree", x: 12, y: 4 }] };

  test("the group lands where Thorn's move alone would, Bree's leg as sent, and never refuses in place", () => {
    const s = dragRoom("8,6,w");
    assert.equal(decide(group, s), SOMETHING_BLOCKS);
    const alone = touchLanding({ t: "token.move", tokenId: "thorn", x: 12, y: 5 }, P1, s, deps);
    assert.deepEqual(alone?.op, { t: "token.move", tokenId: "thorn", x: 7, y: 5 });
    const landed = touchLanding(group, P1, s, deps);
    assert.deepEqual(landed, { op: { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 7, y: 5 }, { tokenId: "bree", x: 12, y: 4 }] }, words: SOMETHING_BLOCKS });
    assert.equal(decide(landed!.op, s), "ok");
  });

  test("paired with the wall a cell further on, out of sight too: the same words, each landed by its own wall", () => {
    const [a, b] = [dragRoom("8,6,w"), dragRoom("9,6,w")];
    const [la, lb] = [touchLanding(group, P1, a, deps), touchLanding(group, P1, b, deps)];
    assert.ok(la && lb);
    assert.equal(la.words, lb.words);
    assert.equal(decide(group, a), decide(group, b));
  });
});

describe("a group whose mover's own landing would squeeze (MD2-ASTRA-8, MD2-LK-9)", () => {
  test("goes back to the last spot that mover stands whole, since a group carries no squeeze, and never refuses in place", () => {
    // A Large Thorn at (6, 4) toward (12, 5), into a corridor one cell wide between walls at y = 5 and y = 6 from x = 10, and Bree clear.
    const s = base();
    s.tokens.thorn = { ...s.tokens.thorn!, size: "large", x: 6, y: 4 };
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p1"], x: 2, y: 9 });
    for (let x = 10; x < 20; x++) {
      edge(s, `${x},5,n`, WALL);
      edge(s, `${x},6,n`, WALL);
    }
    const alone = touchLanding({ t: "token.move", tokenId: "thorn", x: 12, y: 5 }, P1, s, deps);
    assert.deepEqual(alone?.op, { t: "token.move", tokenId: "thorn", x: 11.5, y: 4.5, squeeze: true }, "alone it lands squeezed");
    const group: OpOf<"token.moveMany"> = { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 12, y: 5 }, { tokenId: "bree", x: 6, y: 9 }] };
    assert.equal(decide(group, s), SOMETHING_BLOCKS);
    const landed = touchLanding(group, P1, s, deps);
    assert.deepEqual(landed, { op: { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 8, y: 4 }, { tokenId: "bree", x: 6, y: 9 }] }, words: SOMETHING_BLOCKS });
    assert.equal(decide(landed!.op, s), "ok");
  });
});

describe("the touch rule on hexes (MD2-ASTRA-1, MD2-LK-3)", () => {
  for (const gridShape of ["hexRows", "hexColumns"] as const) {
    /** Thorn at (2, 5) on a hex scene with fog on, a free wall all along x = 8, and ground revealed as asked. */
    const hexRoom = (reveal: "none" | "all" | "allButStep", at = 8) => {
      const s = base();
      s.scenes.s1 = { ...s.scenes.s1!, gridShape };
      s.exploredTiles = {};
      s.buildChunks = {};
      wall(s, "abcdefghijkl", [at, 0], [at, 8]);
      wall(s, "bbcdefghijkl", [at, 8], [at, 16]);
      if (reveal === "all") lift(s, "dm", { x: 0, y: 0, w: 24, h: 16 });
      // Every square cell partly revealed, and only the hex the stopping step crosses the wall in under fog.
      if (reveal === "allButStep") liftAllBut(s, "dm", [hexKey(hexAt(sceneGrid(s.scenes.s1) as HexGrid, { x: 8, y: 5.5 }))]);
      return s;
    };

    test(`${gridShape}: a walk past an unseen wall lands at its last clear spot in the generic words, today's on revealed ground`, () => {
      const dark = hexRoom("none");
      assert.equal(decide(east, dark), SOMETHING_BLOCKS);
      assert.deepEqual(touchLanding(east, P1, dark, deps), { op: { t: "token.move", tokenId: "thorn", x: 7, y: 5 }, words: SOMETHING_BLOCKS });
      const lit = hexRoom("all");
      assert.equal(decide(east, lit), WALL_IN_THE_WAY);
      assert.deepEqual(touchLanding(east, P1, lit, deps), { op: { t: "token.move", tokenId: "thorn", x: 7, y: 5 }, words: WALL_IN_THE_WAY });
    });

    test(`${gridShape}: the stopping step crosses one unheld hex, every square cell round it partly revealed: no kind named, wherever in that hex the wall stands`, () => {
      for (const at of [8, 8 + 1 / 64]) {
        const s = hexRoom("allButStep", at);
        assert.equal(decide(east, s), SOMETHING_BLOCKS);
        assert.equal(touchLanding(east, P1, s, deps)?.words, SOMETHING_BLOCKS);
      }
    });
  }
});

describe("a squeeze, a resize and a companion placement (6)", () => {
  test("a crafted squeeze to a far dark spot is never refused there: it lands unsqueezed", () => {
    const s = base();
    s.tokens.thorn = { ...s.tokens.thorn!, size: "large", x: 2, y: 4 };
    // Open ground, no opening at all where it asks to squeeze.
    const crafted: Op = { t: "token.move", tokenId: "thorn", x: 14, y: 10, squeeze: true };
    assert.equal(decide(crafted, s), SOMETHING_BLOCKS);
    assert.deepEqual(touchLanding(crafted, P1, s, deps), { op: { t: "token.move", tokenId: "thorn", x: 14, y: 10 }, words: SOMETHING_BLOCKS });
  });

  test("a squeeze the sender sees refused is refused in place, in today's words where the cells beside are live too", () => {
    const s = base();
    s.tokens.thorn = { ...s.tokens.thorn!, size: "large", x: 2, y: 4 };
    lift(s, "dm", { x: 0, y: 0, w: 24, h: 16 });
    const crafted: Op = { t: "token.move", tokenId: "thorn", x: 14, y: 10, squeeze: true };
    assert.match(decide(crafted, s), /squeezes/);
    assert.equal(touchLanding(crafted, P1, s, deps), null);
  });

  test("a resize beside unheld ground is refused in place with the generic words, and today's where the ground beside is live", () => {
    const make = (beside: boolean) => {
      const s = base();
      s.tokens.thorn = { ...s.tokens.thorn!, x: 5, y: 5 };
      edge(s, "6,5,w", WALL);
      lift(s, "dm", beside ? { x: 0, y: 0, w: 24, h: 16 } : { x: 5, y: 5, w: 2, h: 2 });
      return s;
    };
    const grow: Op = { t: "token.update", tokenId: "thorn", patch: { size: "large", x: 5, y: 5 } };
    assert.equal(decide(grow, make(true)), NO_ROOM_TO_GROW);
    assert.equal(decide(grow, make(false)), SOMETHING_BLOCKS);
    assert.equal(touchLanding(grow, P1, make(false), deps), null, "its footprint lies on live ground, so it is refused in place");
  });

  test("a resize on remembered ground lands at the nearest spot its search tries that fits", () => {
    const s = base();
    // Blinded, Thorn sees nothing, so the ground he grows onto is only remembered.
    s.tokens.thorn = { ...s.tokens.thorn!, x: 5, y: 5, actor: { inline: actor({ effects: [BLINDED] }) } };
    lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
    edge(s, "6,5,w", WALL);
    const grow: Op = { t: "token.update", tokenId: "thorn", patch: { size: "large", x: 5, y: 5 } };
    assert.equal(decide(grow, s), SOMETHING_BLOCKS);
    const landed = touchLanding(grow, P1, s, deps);
    assert.ok(landed && landed.op.t === "token.update");
    assert.equal(decide(landed.op, s), "ok");
    assert.deepEqual([landed.op.patch.x, landed.op.patch.y], [4, 5]);
  });

  test("a companion placed on remembered ground goes to the nearest clear spot the placement takes, refused in place only on live ground", () => {
    const make = (seen: boolean) => {
      const s = base();
      s.characters.bree = character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor(seen ? {} : { effects: [BLINDED] }) });
      s.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 5, y: 5, disposition: "ally" });
      lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
      edge(s, "6,5,w", WALL);
      return s;
    };
    const spirit: Op = {
      t: "token.create",
      token: { id: "ws", sceneId: "s1", kind: "npc", name: "Wildfire Spirit", size: "small", x: 6, y: 5, layer: "token", disposition: "ally", actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, ac: 13, dmNotes: "" }) }, companion: { of: "bree", turn: "shared" } },
    };
    const dark = make(false);
    assert.equal(decide(spirit, dark), SOMETHING_BLOCKS);
    const landed = touchLanding(spirit, P1, dark, deps);
    assert.ok(landed && landed.op.t === "token.create");
    assert.deepEqual([landed.op.token.x, landed.op.token.y], [5, 4], "beside Bree, clear of her, the way the wall leaves open");
    const lit = make(true);
    assert.equal(decide(spirit, lit), WALL_IN_THE_WAY, "the step from Bree touches only cells she sees");
    assert.equal(touchLanding(spirit, P1, lit, deps), null, "she sees where it would stand, so the form predicts the refusal");
  });

  test("a redo beside unheld ground is refused in place, in the generic words after its label", () => {
    const s = base();
    edge(s, "8,5,w", WALL);
    const redo: Op = { t: "sys.restore", entries: [{ key: "token:thorn", value: { ...s.tokens.thorn!, x: 12 } }], from: "redo", deps: true };
    assert.equal(decide(redo, s), SOMETHING_BLOCKS_BACK);
    assert.equal(touchLanding(redo, P1, s, deps), null);
  });
});

describe("door.set on a remembered door (6)", () => {
  /** Thorn, blinded so he sees nothing, beside a door on edge (8, 5) that the party remembers closed. */
  function doorRoom(): RoomState {
    const s = base();
    s.tokens.thorn = { ...s.tokens.thorn!, x: 7, y: 5, actor: { inline: actor({ effects: [BLINDED] }) } };
    lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
    remember(s, null, 0, 0, { edges: { "8,5,w": { kind: "door", state: "closed", secret: false, discovered: false } } });
    return s;
  }
  const open: OpOf<"door.set"> = { t: "door.set", sceneId: "s1", door: { edge: "8,5,w" }, state: "open", by: "thorn" };

  test("gone: reach first, then gone, the touch recorded", () => {
    const far = doorRoom();
    far.tokens.thorn = { ...far.tokens.thorn!, x: 3, y: 5 };
    assert.equal(decide(open, far), DOOR_TOO_FAR, "out of reach it answers as a real door would");
    assert.equal(doorReachPassed(open, P1, far, deps), false);
    const near = doorRoom();
    assert.equal(decide(open, near), "that is not here");
    assert.equal(doorReachPassed(open, P1, near, deps), true);
  });

  test("its state already the one asked: taken, a no-op", () => {
    const s = doorRoom();
    edge(s, "8,5,w", { kind: "door", state: "open", secret: false, discovered: false });
    assert.equal(decide(open, s), "ok");
    const r = applyOp(s, open, P1, env(3));
    assert.ok(r.ok);
  });

  test("a free door moved out of sight: gone after reach, and nothing reads the stored wall's old place", () => {
    const s = doorRoom();
    remember(s, null, 0, 0, { edges: { "8,5,w": null } });
    const before = { id: "d1", a: [8, 5] as [number, number], b: [8, 6] as [number, number], f: { kind: "door" as const, state: "closed" as const, secret: false, discovered: false } };
    wall(s, "d1", [12, 9], [12, 10], before.f);
    const chunk = s.buildChunks[chunkKey("s1", 0, 0)]!;
    // As the map step keeps it: the door where the party saw it, and absent from the cells it now crosses.
    remember(s, null, 0, 0, { walls: { d1: [{ wall: before, cells: ["7,5", "8,5"] }, { wall: null, cells: ["11,9", "12,9"] }] } });
    const op: OpOf<"door.set"> = { t: "door.set", sceneId: "s1", door: { cx: chunk.cx, cy: chunk.cy, id: "d1" }, state: "open", by: "thorn" };
    assert.equal(decide(op, s), "that is not here");
    assert.equal(doorReachPassed(op, P1, s, deps), true, "reach passed on the remembered door, so the touch is recorded");
  });

  test("a remembered door the DM hid again out of sight: gone after reach, the touch recorded, never opened (MD2-O-2)", () => {
    const hidden = { kind: "door" as const, state: "closed" as const, secret: true, discovered: false };
    // An edge door.
    const s = doorRoom();
    edge(s, "8,5,w", hidden);
    assert.equal(decide(open, s), "that is not here");
    assert.equal(doorReachPassed(open, P1, s, deps), true);
    // A free door the party remembers found, hidden again where it stands.
    const f = doorRoom();
    remember(f, null, 0, 0, { edges: { "8,5,w": null } });
    const found = { ...hidden, discovered: true };
    const shown = wall(f, "d1", [8, 5], [8, 6], hidden);
    const chunk = f.buildChunks[chunkKey("s1", 0, 0)]!;
    remember(f, null, 0, 0, { walls: { d1: [{ wall: { ...shown, f: found }, cells: ["7,5", "8,5"] }] } });
    const op: OpOf<"door.set"> = { t: "door.set", sceneId: "s1", door: { cx: chunk.cx, cy: chunk.cy, id: "d1" }, state: "open", by: "thorn" };
    assert.equal(decide(op, f), "that is not here");
    assert.equal(doorReachPassed(op, P1, f, deps), true);
  });
});
