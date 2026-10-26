import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { holderTileKey } from "#shared/keys.ts";
import type { RoomState, Scene } from "#shared/model.ts";
import { cellVision } from "#shared/perPlayerTestutil.ts";
import { projectState } from "#shared/project.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { member, P1, reveal, room, scene, token } from "#shared/testutil.ts";
import { worldFor } from "../movement/press.ts";
import { dropView } from "../movement/drop.ts";
import { seenIn, walkersFor } from "./walk.ts";

/**
 * What a player's device reads on a per-player scene
 * (docs/design-v1-per-player-vision.md 6.6, decision 10): its copy holds
 * creatures only that player sees and ground only they remember, so every
 * public answer (who every player sees, the attach list's limits, what a
 * drag tows) reads what every viewer shares, while the player's own drag
 * walks the ground they remember.
 */

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

/**
 * A dark per-player scene with fog: Thorn, p1's own, beside a goblin, and
 * a scout in the room the DM revealed. p1 alone remembers the strip east
 * of Thorn. The stub sight sees a cell around Thorn.
 */
function table(vision: Scene["vision"], fogEnabled = true): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.scenes.s1 = scene("s1", { fogEnabled, vision });
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] };
  reveal(s, "s1", { x: 0, y: 0, w: 4, h: 4 });
  const own = Object.values(rasterizeFogOps({}, "s1", s.scenes.s1.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 8, y: 0, w: 6, h: 4 } }]))[0]!;
  s.exploredBy[holderTileKey("s1", "p1", own.tx, own.ty)] = { ...own, memberId: "p1" };
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 10, y: 1 });
  s.tokens.gob = token("gob", { kind: "monster", name: "Goblin", x: 11, y: 1 });
  s.tokens.scout = token("scout", { kind: "monster", name: "Scout", x: 1, y: 1 });
  return s;
}

const copy = (s: RoomState): RoomState => projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;

describe("a player's copy of a per-player scene (6.6, decision 10)", () => {
  test("with vision on, a creature only this player sees is held but seen by no one else, and a party member always is", () => {
    const view = copy(table({ on: true, light: "dark", perPlayer: true }));
    assert.ok(view.tokens.gob, "p1's own sight shows the goblin");
    const seen = seenIn(view, "player");
    assert.equal(seen(view.tokens.gob!), false, "not by the copy's own sight");
    assert.equal(seen(view.tokens.thorn!), true);
    assert.equal(dropView(view, "player").seen(view.tokens.gob!), false, "a drop lands by the same rule");
  });

  test("with fog alone, a creature on ground only this player remembers is seen by no one else, one on shared ground by all", () => {
    const view = copy(table({ on: false, light: "dark", perPlayer: true }));
    assert.ok(view.tokens.gob && view.tokens.scout);
    const seen = seenIn(view, "player");
    assert.equal(seen(view.tokens.gob!), false, "p1's own ground is no one else's");
    assert.equal(seen(view.tokens.scout!), true, "the DM's reveal is everyone's, whatever the sight");
  });

  test("with vision and fog off, every creature the copy holds is seen by all", () => {
    const view = copy(table({ on: false, light: "dark", perPlayer: true }, false));
    assert.equal(seenIn(view, "player")(view.tokens.gob!), true);
  });

  test("a drag tows no creature only this player sees, so no device draws a link others cannot see", () => {
    const s = table({ on: true, light: "dark", perPlayer: true });
    s.tokens.gob = { ...s.tokens.gob!, attached: { to: "thorn", kind: "drag" } };
    const view = copy(s);
    assert.deepEqual(walkersFor(view, "thorn", "player").map((t) => t.id), [], "a link players cannot all see moves nothing on any device");
  });

  test("this player's own drag walks the ground they remember, which every other device's shared ruler does not", () => {
    const view = copy(table({ on: false, light: "dark", perPlayer: true }));
    const ground = worldFor(view, view.tokens.thorn!, "player").input.seen!;
    assert.equal(ground(12, 2), true, "p1 remembers it");
    assert.equal(ground(20, 20), false);
    assert.equal(ground(1, 1), true);
  });
});
