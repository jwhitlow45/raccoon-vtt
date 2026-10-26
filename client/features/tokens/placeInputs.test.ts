import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tokenRefHex } from "#shared/rules/footprint.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { monsterView } from "#shared/statBlock.ts";
import { customMonster, imageRef, room, srdImage } from "#shared/testutil.ts";
import { footprint, snapPosition } from "../../lib/scene.ts";
import { pendingTokens } from "./placeInputs.ts";

describe("what one tap of Add token places", () => {
  test("monsters from the room's own keep their link and wear the monster's image, around the tap", () => {
    const state = room();
    state.scenes.s1!.bounds = { w: 20, h: 20 };
    state.monsters.m1 = customMonster("m1", { name: "Cave Lurker", defaultImage: imageRef("lurker-pic") });
    let n = 0;
    const tokens = pendingTokens(
      { kind: "monster", monster: monsterView(state.monsters.m1), monsterId: "m1", count: 2, hp: null, hidden: false, inLair: false },
      { view: state, scene: state.scenes.s1!, world: { x: 5, y: 5 }, newId: () => `t${n++}` },
    );
    assert.equal(tokens.length, 2);
    for (const t of tokens) {
      assert.ok("inline" in t.actor);
      assert.equal(t.actor.inline.monsterId, "m1");
      assert.deepEqual(t.image, imageRef("lurker-pic"));
    }
    assert.notDeepEqual([tokens[0]!.x, tokens[0]!.y], [tokens[1]!.x, tokens[1]!.y], "never stacked");
  });

  test("SRD monsters wear their shipped icon, or the room's image for them once the DM sets one", async () => {
    const wolf = (await loadMonsters()).find((m) => m.srdId === "wolf")!;
    const state = room();
    const place = () =>
      pendingTokens(
        { kind: "monster", monster: wolf, count: 2, hp: null, hidden: false, inLair: false },
        { view: state, scene: state.scenes.s1!, world: { x: 5, y: 5 }, newId: () => "w" },
      ).map((t) => t.image);
    assert.deepEqual(place(), [
      { icon: "lorc/wolf-head", color: "#ad7f58" },
      { icon: "lorc/wolf-head", color: "#ad7f58" },
    ]);
    state.srdImages.wolf = srdImage("wolf", "wolf-pic");
    assert.deepEqual(place(), [imageRef("wolf-pic"), imageRef("wolf-pic")]);
  });

  test("a blank token and a character's token carry no monster link", () => {
    const state = room();
    const [blank] = pendingTokens({ kind: "blank", tokenKind: "monster" }, { view: state, scene: state.scenes.s1!, world: { x: 2, y: 2 }, newId: () => "b1" });
    assert.ok(blank && "inline" in blank.actor);
    assert.equal("monsterId" in blank.actor.inline, false);
    assert.deepEqual(pendingTokens({ kind: "character", characterId: "gone", name: "Gone" }, { view: state, scene: state.scenes.s1!, world: { x: 2, y: 2 }, newId: () => "c1" }), []);
  });
});

describe("Add token on a hex scene (docs/design-v1-hex-grids.md 4.2)", () => {
  test("a batch of goblins lands each on its own hex's anchor, as a drop would snap it", () => {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, bounds: { w: 20, h: 20 }, gridShape: "hexRows" };
    state.monsters.m1 = customMonster("m1", { name: "Goblin" });
    let n = 0;
    const tokens = pendingTokens(
      { kind: "monster", monster: monsterView(state.monsters.m1), monsterId: "m1", count: 3, hp: null, hidden: false, inLair: false },
      { view: state, scene: state.scenes.s1!, world: { x: 5.3, y: 5.3 }, newId: () => `t${n++}` },
    );
    const g = sceneGrid(state.scenes.s1!);
    assert.ok(g.shape === "hex");
    const hexes = new Set<string>();
    for (const t of tokens) {
      assert.deepEqual(snapPosition(g, t.x, t.y, footprint(t)), { x: t.x, y: t.y });
      hexes.add(hexKey(tokenRefHex(g, t)));
    }
    assert.equal(hexes.size, 3, "never stacked");
  });
});
