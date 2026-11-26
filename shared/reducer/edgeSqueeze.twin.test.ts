import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lift, wall } from "../discoveryTestutil.ts";
import type { RoomState, Viewer } from "../model.ts";
import { canApply, SOMETHING_BLOCKS } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import { opSchema, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { sceneWalls } from "../rules/walls.ts";
import { DM, env, member, P1, P2, room, scene, token, trap } from "../testutil.ts";

/**
 * What a player receives depends only on what they see, now that the map's
 * edge pinches a squeeze on squares (change format 66,
 * docs/design/design-v1-maps-vision.md 4.1). The only
 * new input is the scene's bounds, which every copy holds. Two rooms differ
 * only in a corridor's inner wall along the north side, under the fog in
 * one and absent in the other: a stop a trap makes between a walk's ends
 * there reads ground every player sees alone, so every player's copy after
 * it is the same, and a player's own walk or teleport that ends there is
 * taken or refused in the touch rule's generic words, never ones that tell
 * the wall from no wall.
 */

const deps = { canUseAsset: () => true };

/** A scene 30 by 20 with fog on, every square revealed but a block over the corridor from x 9 to 27 and y 0 to 3. */
function twin(walled: boolean): RoomState {
  const s = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off", fogEnabled: true }) },
  });
  s.buildChunks = {};
  lift(s, "dm", { x: 0, y: 0, w: 9, h: 20 });
  lift(s, "dm", { x: 27, y: 0, w: 3, h: 20 });
  lift(s, "dm", { x: 9, y: 3, w: 18, h: 17 });
  if (walled) {
    wall(s, "edgesqw00001", [10, 1], [18, 1]);
    wall(s, "edgesqw00002", [18, 1], [26, 1]);
  }
  // Thorn, Large, squeezed in the corridor as the DM left him, and a pit on 16, 0 that stops whoever walks onto it.
  s.tokens.thorn = { ...token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", size: "large", x: 11.5, y: -0.5, ownerIds: ["p1"] }), squeeze: true };
  s.traps.pit = trap("pit", { zone: { cells: [{ x: 16, y: 0, w: 1, h: 1 }] }, rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false } });
  return s;
}

/** Every player's copy of the scene, as one string. */
const copies = (s: RoomState) => [P1, P2].map((v) => stableStringify(projectState(s, v, { sceneId: "s1" }))).join("\n");

function answer(s: RoomState, op: Op, who: Viewer = P1): string {
  const d = canApply(opSchema.parse(op), who, s, deps);
  return d.ok ? "ok" : d.message;
}

describe("the map's edge as a squeeze reads it tells a player nothing the fog hides", () => {
  const [walled, open] = [twin(true), twin(false)];

  test("the twins differ only in the wall, which no player's copy holds", () => {
    assert.equal(sceneWalls(walled.scenes.s1!, walled.buildChunks).stored.xy.length, 8, "the wall is stored");
    assert.equal(copies(walled), copies(open));
  });

  test("a trap's stop between the walk's ends in the corridor reads only ground every player sees, so every copy after it is the same", () => {
    // The DM walks Thorn along the corridor, through the pit, and out onto revealed ground: walls stop no move of the DM's, so
    // both twins take it, and the stop alone could read the wall.
    const op: Op = { t: "token.move", tokenId: "thorn", x: 28, y: 0 };
    for (const s of [walled, open]) assert.equal(answer(s, op, DM), "ok");
    const after = [walled, open].map((s) => {
      const r = applyOp(structuredClone(s), op, DM, env(1));
      assert.ok(r.ok, r.ok ? "" : r.message);
      assert.equal(r.state.traps.pit!.state, "sprung", "the pit went off");
      return r.state;
    });
    assert.deepEqual(after[0]!.tokens.thorn, after[1]!.tokens.thorn, "Thorn stops alike");
    assert.equal(copies(after[0]!), copies(after[1]!));
  });

  test("a player's walk or teleport that ends in the corridor is taken or refused in the touch rule's generic words in both", () => {
    const ends: Op[] = [
      { t: "token.move", tokenId: "thorn", x: 21.5, y: -0.5, squeeze: true },
      { t: "token.move", tokenId: "thorn", x: 15, y: 0 },
      { t: "token.move", tokenId: "thorn", x: 21.5, y: -0.5, squeeze: true, teleport: "unknown" },
      { t: "token.move", tokenId: "thorn", x: 15, y: 0, teleport: "unknown" },
    ];
    const seen = new Set<string>();
    for (const op of ends) {
      for (const s of [walled, open]) {
        const a = answer(s, op);
        seen.add(a);
        assert.ok(a === "ok" || a === SOMETHING_BLOCKS, `${JSON.stringify(op)}: ${a}`);
      }
    }
    assert.deepEqual([...seen].sort(), [SOMETHING_BLOCKS, "ok"].sort(), "the walls decide, and the words never say which");
  });
});
