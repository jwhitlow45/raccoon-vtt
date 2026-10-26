import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHUNK_CELLS, FOG_SUBCELLS, type BuildChunk, type FogTile, type Token } from "#shared/model.ts";
import { tileKey } from "#shared/keys.ts";
import { encodeTile, TILE_BYTES, TILE_SUB } from "#shared/rules/fog.ts";
import { encodeHeights } from "#shared/rules/heights.ts";
import { actor, effect, token as makeToken } from "#shared/testutil.ts";
import { dropLanding, dropView } from "../features/movement/drop.ts";
import { raised, world } from "../features/movement/testing.ts";
import { seenChunks } from "./relief/seenChunks.ts";
import { SHADOW_CORE, shadowShape, tokenLift } from "./tokenShadow.ts";

/** A scene "s1" whose first chunk has these heights, keyed "x,y". */
function chunks(heights: Record<string, number>): Record<string, BuildChunk> {
  const feet = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0);
  for (const [key, v] of Object.entries(heights)) {
    const [x, y] = key.split(",").map(Number);
    feet[y! * CHUNK_CELLS + x!] = v;
  }
  return { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: {}, heights: encodeHeights(feet) } };
}

const token = (x: number, y: number, elevation: number, size: Token["size"] = "medium") => ({ sceneId: "s1", x, y, elevation, size });

describe("token shadows", () => {
  test("only a token above the ground casts one", () => {
    assert.equal(shadowShape(0), null);
    assert.equal(shadowShape(-10), null);
    assert.ok(shadowShape(5));
  });

  test("the shadow drifts from 0.2 cell just off the ground to 0.6 at 30 ft, and shrinks and fades as the token rises", () => {
    assert.ok(Math.abs(shadowShape(0.001)!.offset - 0.2) < 1e-4);
    assert.ok(Math.abs(shadowShape(15)!.offset - 0.4) < 1e-9);
    assert.equal(shadowShape(30)!.offset, 0.6);
    assert.equal(shadowShape(120)!.offset, 0.6);
    const lifts = [5, 10, 20, 30];
    const shapes = lifts.map((l) => shadowShape(l)!);
    for (let i = 1; i < shapes.length; i++) {
      assert.ok(shapes[i]!.offset > shapes[i - 1]!.offset);
      assert.ok(shapes[i]!.scale < shapes[i - 1]!.scale);
      assert.ok(shapes[i]!.alpha < shapes[i - 1]!.alpha);
    }
    assert.deepEqual(shadowShape(60), shadowShape(30));
  });

  test("from 5 ft up, the shadow's dark core shows past the token's disc on its lower right, Medium, Large and Huge alike", () => {
    // A round token `side` cells across, its disc's radius side / 2. Along the diagonal down and to the right the
    // shadow's center sits offset * sqrt(2) from the token's, and its full darkness reaches SHADOW_CORE of its radius.
    for (const side of [1, 2, 3]) {
      for (const lift of [5, 10, 15, 20, 30, 60]) {
        const shape = shadowShape(lift, { w: side, h: side })!;
        const coreReach = shape.offset * Math.SQRT2 + SHADOW_CORE * shape.scale * (side / 2);
        assert.ok(coreReach >= 0.6 * side, `a ${side}-cell token at ${lift} ft: the core reaches ${coreReach.toFixed(3)} cells from the middle`);
      }
    }
  });

  test("a Medium or smaller token's shadow offset is the one-cell offset, and a larger one's scales with its shorter side", () => {
    assert.deepEqual(shadowShape(10, { w: 1, h: 1 }), shadowShape(10));
    assert.deepEqual(shadowShape(10, { w: 0.5, h: 0.5 }), shadowShape(10));
    assert.ok(Math.abs(shadowShape(10, { w: 2, h: 2 })!.offset - 2 * shadowShape(10)!.offset) < 1e-12);
    assert.ok(Math.abs(shadowShape(10, { w: 1, h: 3 })!.offset - shadowShape(10)!.offset) < 1e-12);
  });

  test("on a scene without heights the ground is 0", () => {
    assert.equal(tokenLift({}, token(3, 3, 30)), 30);
    assert.equal(tokenLift({}, token(3, 3, 0)), 0);
  });

  test("a token standing on raised ground has no lift, so a platform never looks like flight", () => {
    const c = chunks({ "3,3": 10 });
    assert.equal(tokenLift(c, token(3, 3, 10)), 0);
    assert.equal(tokenLift(c, token(3, 3, 25)), 15);
  });

  test("a token inside the ground casts none", () => {
    assert.equal(tokenLift(chunks({ "3,3": 10 }), token(3, 3, 0)), 0);
  });

  test("a footprint's ground is the highest ground under it", () => {
    const c = chunks({ "4,4": 20 });
    assert.equal(tokenLift(c, token(3, 3, 30, "large")), 10);
  });

  test("while dragged, the shadow shows the lift the token would land with", () => {
    const c = chunks({ "6,3": 10, "8,3": 40 });
    // On the ground, it stays on the ground wherever it lands.
    assert.equal(tokenLift(c, token(3, 3, 0), { x: 6, y: 3 }), 0);
    // Flying at 30 ft over a 10 ft platform: 20 ft above it.
    assert.equal(tokenLift(c, token(3, 3, 30), { x: 6, y: 3 }), 20);
    // Over ground higher than it flies, it lands on that ground.
    assert.equal(tokenLift(c, token(3, 3, 30), { x: 8, y: 3 }), 0);
    // Burrowed at -5 ft, it keeps its elevation, which is above the ground of a pit.
    const pit = chunks({ "3,3": 0, "6,3": -20 });
    assert.equal(tokenLift(pit, token(3, 3, -5), { x: 6, y: 3 }), 15);
    // A drop where it already stands is no move.
    assert.equal(tokenLift(c, token(6, 3, 30), { x: 6, y: 3 }), 20);
  });
});

describe("a dragged token's shadow lands as the drop does (review AT-O-23)", () => {
  test("a kobold re-seated on the low half of a horse straddling a step keeps the horse's 10 ft, so its shadow shows the lift", () => {
    const horse = makeToken("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, elevation: 10, ownerIds: ["p1"] });
    const kobold = makeToken("kobold", { name: "Kobold", size: "small", x: 5, y: 4, elevation: 10, attached: { to: "horse", kind: "carry" }, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } });
    const s = world({ blockMovement: false, heights: raised(5, 4, 6, 6, 10), tokens: [horse, kobold] });
    const at = { x: 4, y: 4 };
    assert.equal(tokenLift(s.buildChunks, s.tokens.kobold!, at), 0, "by its own footing it would land on the low ground");
    assert.equal(tokenLift(s.buildChunks, s.tokens.kobold!, at, dropLanding(dropView(s, "player"), s.tokens.kobold!, at)), 10);
  });
});

describe("a player's shadow reads only the ground the fog shows (FLIER-SHADOW-FOG)", () => {
  /** Fog over the whole first tile but the cells listed, keyed "x,y". */
  function fogShowing(...cells: string[]): Record<string, FogTile> {
    const bits = new Uint8Array(TILE_BYTES);
    for (const key of cells) {
      const [x, y] = key.split(",").map(Number);
      for (let sy = 0; sy < FOG_SUBCELLS; sy++) {
        for (let sx = 0; sx < FOG_SUBCELLS; sx++) {
          const i = (y! * FOG_SUBCELLS + sy) * TILE_SUB + x! * FOG_SUBCELLS + sx;
          bits[i >> 3] = bits[i >> 3]! | (1 << (i & 7));
        }
      }
    }
    return { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(bits) } };
  }
  const bounds = { w: 16, h: 16 };

  test("a flier over a fogged platform casts the shadow of its whole height, as over the ground the player has seen", () => {
    const c = chunks({ "3,3": 10 });
    const seen = seenChunks({ chunks: c, sceneId: "s1", bounds, fog: fogShowing() });
    assert.equal(tokenLift(c, token(3, 3, 25)), 15, "the room's real ground");
    assert.equal(tokenLift(seen, token(3, 3, 25)), 25);
    // A still token at the platform's height on fogged ground keeps a shadow too, as it is 10 ft over the ground the player sees.
    assert.equal(tokenLift(seen, token(3, 3, 10)), 10);
  });

  test("ground with any revealed sub-cell is seen, and the DM reads the real ground", () => {
    const c = chunks({ "3,3": 10 });
    assert.equal(tokenLift(seenChunks({ chunks: c, sceneId: "s1", bounds, fog: fogShowing("3,3") }), token(3, 3, 25)), 15);
    const corner = new Uint8Array(TILE_BYTES);
    const i = 3 * FOG_SUBCELLS * TILE_SUB + 3 * FOG_SUBCELLS;
    corner[i >> 3] = 1 << (i & 7);
    const one = { [tileKey("s1", 0, 0)]: { sceneId: "s1", tx: 0, ty: 0, rev: 1, bits: encodeTile(corner) } };
    assert.equal(tokenLift(seenChunks({ chunks: c, sceneId: "s1", bounds, fog: one }), token(3, 3, 25)), 15, "one sub-cell of the platform revealed");
    assert.equal(seenChunks({ chunks: c, sceneId: "s1", bounds, fog: null }), c);
  });

  test("the same visible state over different hidden heights gives the same shadow, still and while dragged", () => {
    const fog = fogShowing("2,2", "3,2");
    for (const hidden of [0, 10, 30, -20]) {
      const c = chunks({ "2,2": 5, "6,6": hidden, "7,6": hidden });
      const seen = seenChunks({ chunks: c, sceneId: "s1", bounds, fog });
      assert.equal(tokenLift(seen, token(6, 6, 20)), 20, `still, over hidden ${hidden} ft`);
      assert.equal(tokenLift(seen, token(2, 2, 20), { x: 6, y: 6 }), 20, `dragged onto hidden ${hidden} ft`);
      assert.equal(tokenLift(seen, token(2, 2, 5), { x: 6, y: 6 }), 0, `a walker dragged onto hidden ${hidden} ft lands on the ground it sees`);
    }
  });

  test("heights past the scene's edge read as no ground, and other scenes' chunks are left alone", () => {
    const c = { ...chunks({ "12,3": 10 }), "s2:0,0": { ...chunks({ "3,3": 10 })["s1:0,0"]!, sceneId: "s2" } };
    const fog = fogShowing("12,3");
    const seen = seenChunks({ chunks: c, sceneId: "s1", bounds: { w: 10, h: 10 }, fog });
    assert.equal(tokenLift(seen, token(12, 3, 25)), 25);
    assert.equal(seen["s2:0,0"], c["s2:0,0"]);
    // Kept while nothing changes, so every shadow shares one copy.
    assert.equal(seenChunks({ chunks: c, sceneId: "s1", bounds: { w: 10, h: 10 }, fog }), seen);
  });
});
