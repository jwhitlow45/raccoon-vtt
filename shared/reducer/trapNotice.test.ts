import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey } from "../keys.ts";
import { describeEvent } from "../logText.ts";
import type { RoomState, Trap, TrapRig, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { projectState } from "../project.ts";
import { applyOp } from "../reducer.ts";
import { rasterizeFogOps } from "../rules/fog.ts";
import { actor, character, DM, env, P1, reveal, room, token, trap as trapOf } from "../testutil.ts";

/** The Passive Perception hint (docs/design-v1-traps.md 4.6). */

const plate = (over: Partial<TrapRig> = {}): Partial<Trap> => ({
  zone: { cells: [{ x: 10, y: 5, w: 1, h: 1 }] },
  rig: { ...trapOf("x").rig!, who: "party", notice: true, find: [{ ability: "wis", skill: "perception", dc: 15, what: "the pressure plate" }], ...over },
});

function world(passive = 16, over: Partial<Trap> = plate()): RoomState {
  return room({
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ passivePerception: passive }) }) },
    tokens: {
      thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], actor: { ref: "thorn" }, x: 0, y: 5 }),
      gob: token("gob", { name: "Goblin", kind: "monster", x: 0, y: 8, actor: { inline: actor({ passivePerception: 20 }) } }),
    },
    traps: { pit: trapOf("pit", over) },
  });
}

let seq = 20;

function walk(state: RoomState, x: number, who: Viewer = P1, extra: Partial<Op> = {}, tokenId = "thorn", y = 5) {
  const res = applyOp(state, { t: "token.move", tokenId, x, y, ...extra } as Op, who, env(seq++));
  assert.ok(res.ok, res.ok ? "" : res.message);
  return res;
}

const notices = (s: RoomState) => s.trapLog.filter((e) => e.data?.type === "trapNotice");

describe("the Passive Perception hint", () => {
  test("a party creature ending a walk within 10 ft whose Passive Perception meets the DC: a DM line and noticedBy, never found", () => {
    const res = walk(world(), 8);
    const lines = notices(res.state);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]!.data, { type: "trapNotice", trapId: "pit", sceneId: "s1", tokenId: "thorn", passive: 16, dc: 15 });
    assert.equal(describeEvent(lines[0]!.data!, res.state, true), "Thorn's Passive Perception (16) would notice the pressure plate of Hidden Pit (DC 15).");
    assert.equal(res.state.traps.pit!.rig!.noticedBy, "thorn");
    assert.equal(res.state.traps.pit!.found, false, "the DM marks it found");
    assert.equal(res.trapped, undefined, "players saw nothing, so the step is no trapped one");
    assert.ok(res.trapWrote?.has("trap:pit"), "kept out of the player's undo of the move");
  });

  test("10 ft is near enough, 15 ft is not, and a Passive Perception under the DC hints nothing", () => {
    assert.equal(notices(walk(world(), 8).state).length, 1, "one square between: 10 ft");
    assert.equal(notices(walk(world(), 7).state).length, 0, "15 ft");
    assert.equal(notices(walk(world(14), 9).state).length, 0, "14 under DC 15");
    assert.equal(notices(walk(world(15), 9).state).length, 1, "15 meets DC 15");
  });

  test("it hints once a trap, until its find checks change", () => {
    const first = walk(world(), 8).state;
    assert.equal(notices(walk(first, 9).state).length, 1, "no second line");
    const changed = applyOp(first, { t: "trap.update", trapId: "pit", patch: { rig: { find: [{ ability: "wis", skill: "perception", dc: 12 }] } } }, DM, env(seq++));
    assert.ok(changed.ok);
    assert.equal(changed.state.traps.pit!.rig!.noticedBy, undefined);
    assert.equal(notices(walk(changed.state, 9).state).length, 2);
  });

  test("none for a creature not in the party, a teleport, a found, disarmed or quiet trap, or one with no Perception check", () => {
    assert.equal(notices(walk(world(), 8, DM, {}, "gob", 6).state).length, 0, "the goblin");
    assert.equal(notices(walk(world(), 8, DM, { teleport: "wall" }).state).length, 0, "a teleport is no walk");
    assert.equal(notices(walk(world(16, { ...plate(), found: true }), 8).state).length, 0);
    assert.equal(notices(walk(world(16, { ...plate(), state: "disarmed" }), 8).state).length, 0);
    assert.equal(notices(walk(world(16, plate({ notice: false })), 8).state).length, 0);
    assert.equal(notices(walk(world(16, plate({ find: [{ ability: "int", skill: "investigation", dc: 10 }] })), 8).state).length, 0);
  });

  test("players must see the zone: none under the fog, one once it is revealed", () => {
    const fogged = world();
    fogged.scenes.s1 = { ...fogged.scenes.s1!, fogEnabled: true };
    reveal(fogged, "s1", { x: 0, y: 0, w: 9, h: 10 });
    assert.equal(notices(walk(fogged, 8).state).length, 0);
    reveal(fogged, "s1", { x: 0, y: 0, w: 12, h: 10 });
    assert.equal(notices(walk(fogged, 8).state).length, 1);
  });

  test("on a vision scene the zone must be in the party's sight", () => {
    const lit = world();
    lit.scenes.s1 = { ...lit.scenes.s1!, fogEnabled: true, vision: { on: true, light: "bright" } };
    assert.equal(notices(walk(lit, 8).state).length, 1, "bright light, nothing in the way");
    const dark = world();
    dark.scenes.s1 = { ...dark.scenes.s1!, fogEnabled: true, vision: { on: true, light: "dark" } };
    assert.equal(notices(walk(dark, 8).state).length, 0, "darkness and no darkvision");
  });

  test("a walk that comes back to where it started is a walk: Thorn steps toward the plate and back, and the hint comes", () => {
    const state = world();
    state.tokens.thorn = { ...state.tokens.thorn!, x: 8 };
    assert.equal(notices(walk(state, 8, P1, { route: [[9, 5], [8, 5]] } as Partial<Op>).state).length, 1);
    assert.equal(notices(walk(state, 8).state).length, 0, "a move to where it stands is no walk");
  });

  test("each square of the zone is measured on its own ground, so a raised one beside it never makes the near one far", () => {
    const raised = (zone: Trap["zone"]) => {
      const r = applyOp(world(16, { ...plate(), zone }), { t: "build.height", sceneId: "s1", cells: ["11,5"], height: 50 }, DM, env(seq++));
      assert.ok(r.ok);
      return r.state;
    };
    assert.equal(notices(walk(raised({ cells: [{ x: 10, y: 5, w: 2, h: 1 }] }), 8).state).length, 1, "one rectangle of both squares");
    assert.equal(notices(walk(raised({ cells: [{ x: 10, y: 5, w: 1, h: 1 }, { x: 11, y: 5, w: 1, h: 1 }] }), 8).state).length, 1, "a rectangle each");
    assert.equal(notices(walk(raised({ cells: [{ x: 11, y: 5, w: 1, h: 1 }] }), 9).state).length, 0, "the raised square alone is 50 ft up");
  });
});

describe("the hint on a per-player scene (docs/design-v1-per-player-vision.md decision 14, review PV1-O11)", () => {
  test("with fog alone, the zone counts as seen on ground only one holder remembers", () => {
    const s = world();
    s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } };
    reveal(s, "s1", { x: 0, y: 0, w: 9, h: 10 });
    s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] };
    assert.equal(notices(walk(s, 8).state).length, 0, "the zone lies under every layer");
    const tile = Object.values(rasterizeFogOps({}, "s1", s.scenes.s1!.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 9, y: 4, w: 3, h: 3 } }]))[0]!;
    s.exploredBy[holderTileKey("s1", "p1", tile.tx, tile.ty)] = { ...tile, memberId: "p1" };
    assert.equal(notices(walk(s, 8).state).length, 1, "p1's own map holds the zone");
    // The DM's device predicts the hint from its own copy, which holds every holder's map joined as exploredAny (review PV1-O14).
    const copy = projectState(s, DM, { sceneId: "s1" }) as unknown as RoomState;
    assert.ok((copy as RoomState & { exploredAny?: object }).exploredAny);
    const predicted = applyOp(copy, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, DM, env(seq++));
    assert.ok(predicted.ok, predicted.ok ? "" : predicted.message);
    assert.equal(notices(predicted.state).length, 1, "as the server does");
  });
});
