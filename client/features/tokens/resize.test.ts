import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canApply } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type RoomState, type Token } from "#shared/model.ts";
import { occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";
import type { HexGrid } from "#shared/rules/hex.ts";
import { NO_ROOM_TO_GROW } from "#shared/rules/resize.ts";
import { DM, P1, character, room, token } from "#shared/testutil.ts";
import { canResize } from "./access.ts";
import { backTo, baseSize, customWords, resizeGroup, resizePatch, stepSize, type ResizeAnswer } from "./resize.ts";
import type { Growth } from "./resizeMemory.ts";

const deps = { canUseAsset: () => true };

/** A test room whose scene s1 holds `edges` and blocks moves unless it says not, with Thorn, Pat's druid, at (4, 4). */
function walled(edges: Record<string, EdgeFeature> = {}, blockMovement = true): RoomState {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, autoWalls: "off", blockMovement };
  for (const [key, f] of Object.entries(edges)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const chunk: BuildChunk = (state.buildChunks[`s1:${cx},${cy}`] ??= { sceneId: "s1", cx, cy, rev: 1, cells: {}, edges: {} });
    chunk.edges[key] = f;
  }
  state.characters.thorn = character("thorn", { ownerIds: ["p1"], name: "Thorn", size: "medium" });
  state.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", x: 4, y: 4, actor: { ref: "thorn" }, ownerIds: [] });
  return state;
}

const CORNER = { "4,4,w": { kind: "wall" }, "4,4,n": { kind: "wall" } } as const;
const sent = (answer: ResizeAnswer) => {
  assert.ok(!("refused" in answer), JSON.stringify(answer));
  return answer;
};
/** The token as the patch leaves it. */
const after = (t: Token, answer: ResizeAnswer): Token => ({ ...t, ...(sent(answer).patch as Partial<Token>) });

describe("resizePatch (docs/design-v1-token-window.md 8.6)", () => {
  test("the DM: the base spot, unchecked over walls, and Custom's width and height set or cleared", () => {
    const state = walled(CORNER);
    const thorn = state.tokens.thorn!;
    assert.deepEqual(sent(resizePatch(state, thorn, { size: "huge" }, "dm")).patch, { size: "huge", x: 3, y: 3 }, "centered on his square, over both walls");
    assert.deepEqual(sent(resizePatch(state, thorn, { size: "large" }, "dm")).patch, { size: "large" }, "spreading right and down keeps the place");
    assert.deepEqual(sent(resizePatch(state, thorn, { size: "custom", w: 3, h: 3 }, "dm")).patch, { size: "custom", w: 3, h: 3, x: 3, y: 3 });
    const custom = { ...thorn, size: "custom" as const, w: 2, h: 3 };
    assert.deepEqual(sent(resizePatch(state, custom, { size: "medium" }, "dm")).patch, { size: "medium", w: null, h: null, x: 4, y: 5 });
  });

  test("an owner on a scene that blocks moves grows away from the walls, and the server takes the patch on the owner's copy", () => {
    const state = walled(CORNER);
    const copy = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const huge = sent(resizePatch(copy, copy.tokens.thorn!, { size: "huge" }, "player"));
    assert.deepEqual(huge.patch, { size: "huge" }, "it keeps its top-left square and grows right and down");
    assert.equal(huge.shifted, true);
    assert.equal(canApply({ t: "token.update", tokenId: "thorn", patch: huge.patch }, P1, state, deps).ok, true);
    assert.equal(canApply({ t: "token.update", tokenId: "thorn", patch: huge.patch }, P1, copy, deps).ok, true, "the client's own check takes it too");
    // A crafted patch at the base spot is one the device never sends: both checks refuse it.
    assert.equal(canApply({ t: "token.update", tokenId: "thorn", patch: { size: "huge", x: 3, y: 3 } }, P1, copy, deps).ok, false);
  });

  test("on a scene that does not block moves, an owner's growth takes the base spot", () => {
    const state = walled(CORNER, false);
    assert.deepEqual(sent(resizePatch(state, state.tokens.thorn!, { size: "huge" }, "player")).patch, { size: "huge", x: 3, y: 3 });
  });

  test("no room is the player's words, sent as nothing: a 5 ft corridor refuses a Large", () => {
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 0; x < 20; x++) {
      edges[`${x},4,n`] = { kind: "wall" };
      edges[`${x},5,n`] = { kind: "wall" };
    }
    const state = walled(edges);
    assert.deepEqual(resizePatch(state, state.tokens.thorn!, { size: "large" }, "player"), { refused: NO_ROOM_TO_GROW });
  });

  test("a shrink on the page that grew it returns to the square it grew from, and to the base spot once the list is stale", () => {
    const state = walled(CORNER, false);
    let thorn = state.tokens.thorn!;
    let growths: Growth[] = [];
    const step = (size: "medium" | "large" | "huge") => {
      const answer = sent(resizePatch(state, thorn, { size }, "player", growths));
      thorn = after(thorn, answer);
      growths = answer.growths;
    };
    step("large");
    step("huge");
    assert.deepEqual({ x: thorn.x, y: thorn.y, size: thorn.size }, { x: 4, y: 4, size: "huge" });
    assert.equal(growths.length, 2);
    // Huge to Medium in one step: the Medium's own square, where the base spot would be (5, 5), the Huge's middle square.
    step("medium");
    assert.deepEqual({ x: thorn.x, y: thorn.y }, { x: 4, y: 4 });
    assert.deepEqual(growths, []);
    // Moved between: the base rule.
    step("huge");
    thorn = { ...thorn, x: 10, y: 10 };
    step("medium");
    assert.deepEqual({ x: thorn.x, y: thorn.y }, { x: 11, y: 11 });
  });
});

describe("a group's resize from More (W5-ASTRA-04)", () => {
  /** A Tiny familiar on a quarter and a Medium wolf, the DM's group. */
  function pair(): RoomState {
    const state = walled({}, false);
    state.tokens.owl = token("owl", { kind: "npc", name: "Owl", size: "tiny", x: 4.5, y: 4.5 });
    state.tokens.wolf = token("wolf", { kind: "npc", name: "Wolf", x: 8, y: 4 });
    return state;
  }
  const applied = (state: RoomState, ops: { tokenId: string; patch: object }[]) => {
    const tokens = { ...state.tokens };
    for (const op of ops) tokens[op.tokenId] = { ...tokens[op.tokenId]!, ...(op.patch as Partial<Token>) };
    return { ...state, tokens };
  };

  test("a group's growth and then its shrink return each creature to the square it grew from, in one op each", () => {
    let state = pair();
    const grown = resizeGroup(state, [state.tokens.owl!, state.tokens.wolf!], { size: "medium" }, "dm", {});
    assert.equal(grown.ops.length, 2);
    state = applied(state, grown.ops);
    assert.deepEqual([state.tokens.owl!.x, state.tokens.owl!.y], [4, 4]);
    // Without the memory the base spot is the square's top-left quarter, not the one it grew from.
    assert.deepEqual(resizeGroup(state, [state.tokens.owl!], { size: "tiny" }, "dm", {}).ops[0]!.patch, { size: "tiny" });
    const shrunk = resizeGroup(state, [state.tokens.owl!, state.tokens.wolf!], { size: "tiny" }, "dm", grown.growths);
    state = applied(state, shrunk.ops);
    assert.deepEqual([state.tokens.owl!.x, state.tokens.owl!.y, state.tokens.owl!.size], [4.5, 4.5, "tiny"], "the owl back on its quarter");
    assert.deepEqual(shrunk.growths, { owl: [], wolf: [] });
  });

  test("a group's growth and a single token's shrink share the memory, and the other way round", () => {
    let state = pair();
    const grown = resizeGroup(state, [state.tokens.owl!, state.tokens.wolf!], { size: "medium" }, "dm", {});
    state = applied(state, grown.ops);
    const single = sent(resizePatch(state, state.tokens.owl!, { size: "tiny" }, "dm", grown.growths.owl));
    assert.deepEqual({ x: single.patch.x, y: single.patch.y }, { x: 4.5, y: 4.5 }, "the owl's own window takes it back");

    state = pair();
    const one = sent(resizePatch(state, state.tokens.owl!, { size: "medium" }, "dm", []));
    state = applied(state, [{ tokenId: "owl", patch: one.patch }]);
    const back = resizeGroup(state, [state.tokens.owl!, state.tokens.wolf!], { size: "tiny" }, "dm", { owl: one.growths });
    state = applied(state, back.ops);
    assert.deepEqual([state.tokens.owl!.x, state.tokens.owl!.y], [4.5, 4.5], "the group's More takes it back");
  });
});

describe("the creature's own size, and the steps", () => {
  const view = { characters: { thorn: { size: "medium" as const }, tiny: { size: "custom" as const } }, monsters: { m1: { size: "medium" as const, sizeAlt: "small" as const } } };
  const npc = { kind: "npc" as const, actor: { inline: {} as never } };
  test("a PC's character, a room monster's block, Medium or Small, an SRD block once loaded, and none", () => {
    assert.deepEqual(baseSize({ token: { kind: "pc", actor: { ref: "thorn" } }, actor: undefined, ...view, srd: null }), ["medium"]);
    assert.equal(baseSize({ token: { kind: "pc", actor: { ref: "tiny" } }, actor: undefined, ...view, srd: null }), null, "a Custom character gives no base");
    assert.deepEqual(baseSize({ token: npc, actor: { monsterId: "m1" }, ...view, srd: null }), ["medium", "small"]);
    assert.equal(baseSize({ token: npc, actor: { srdId: "brown-bear" }, ...view, srd: null }), null, "before the SRD loads");
    assert.deepEqual(baseSize({ token: npc, actor: { srdId: "brown-bear" }, ...view, srd: [{ srdId: "brown-bear", size: "large" }] }), ["large"]);
    assert.equal(baseSize({ token: npc, actor: {}, ...view, srd: null }), null, "an unlinked NPC");
    assert.equal(baseSize({ token: { kind: "object", actor: { inline: {} as never } }, actor: { monsterId: "m1" }, ...view, srd: null }), null, "an object");
  });

  test("a companion's own stat block gives its base, and one deleted since gives none (docs/design-v1-companion-stat-blocks.md 3.2)", () => {
    const blocks = { b1: { size: "tiny" as const }, b2: { size: "medium" as const, sizeAlt: "small" as const } };
    assert.deepEqual(baseSize({ token: npc, actor: { blockId: "b1" }, ...view, blocks, srd: null }), ["tiny"]);
    assert.deepEqual(baseSize({ token: npc, actor: { blockId: "b2" }, ...view, blocks, srd: null }), ["medium", "small"]);
    assert.equal(baseSize({ token: npc, actor: { blockId: "gone" }, ...view, blocks, srd: null }), null);
    assert.equal(backTo("large", baseSize({ token: npc, actor: { blockId: "b1" }, ...view, blocks, srd: null })), "tiny", "an owl grown Large goes back to Tiny");
  });

  test("Back to names the base's first size, only where the token is neither", () => {
    assert.equal(backTo("large", ["medium"]), "medium");
    assert.equal(backTo("small", ["medium", "small"]), null);
    assert.equal(backTo("tiny", ["medium", "small"]), "medium");
    assert.equal(backTo("large", null), null);
  });

  test("one size a press, Medium to Small, and none past the ends or for Custom", () => {
    assert.equal(stepSize("medium", -1), "small");
    assert.equal(stepSize("medium", 1), "large");
    assert.equal(stepSize("tiny", -1), null);
    assert.equal(stepSize("gargantuan", 1), null);
    assert.equal(stepSize("custom", 1), null);
    assert.equal(customWords({ w: 2, h: 3 }, true), "Custom, 2 by 3 squares, set by the DM");
    assert.equal(customWords({ w: 2, h: 3 }, false), "Custom, 2 by 3 squares");
  });

  test("canResize: the DM always, an owner of an unlocked token of the six sizes, nobody else", () => {
    assert.equal(canResize({ dm: true, owner: false }, { locked: true, size: "custom" }), true);
    assert.equal(canResize({ dm: false, owner: true }, { locked: false, size: "large" }), true);
    assert.equal(canResize({ dm: false, owner: true }, { locked: true, size: "large" }), false);
    assert.equal(canResize({ dm: false, owner: true }, { locked: false, size: "custom" }), false);
    assert.equal(canResize({ dm: false, owner: false }, { locked: false, size: "large" }), false);
  });

  test("canApply agrees with canResize for the DM and the owner", () => {
    const state = walled({}, false);
    for (const viewer of [DM, P1]) {
      const answer = sent(resizePatch(state, state.tokens.thorn!, { size: "large" }, viewer.role));
      assert.equal(canApply({ t: "token.update", tokenId: "thorn", patch: answer.patch }, viewer, state, deps).ok, true, viewer.memberId);
    }
  });
});

describe("resizePatch on a hex scene (docs/design-v1-hex-grids.md 4.2)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    test(`${orient}: a Medium grows Large with its hex as the Large's top hex, which the server takes, and shrinks back onto it`, () => {
      const state = room();
      state.scenes.s1 = { ...state.scenes.s1!, gridShape: orient === "rows" ? "hexRows" : "hexColumns" };
      state.characters.thorn = character("thorn", { ownerIds: ["p1"], name: "Thorn", size: "medium" });
      const home = { col: 6, row: 5 };
      state.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ...placedOnHex(g, { size: "medium", x: 0, y: 0 }, home), actor: { ref: "thorn" }, ownerIds: [] });
      const thorn = state.tokens.thorn;
      for (const role of ["dm", "player"] as const) {
        const grown = resizePatch(state, thorn, { size: "large" }, role);
        const large = after(thorn, grown);
        assert.deepEqual(tokenRefHex(g, large), home, `${role}: the Large's reference hex`);
        assert.deepEqual(occupiedHexes(g, large)[0], home, "its top hex");
        assert.ok(canApply({ t: "token.update", tokenId: "thorn", patch: sent(grown).patch }, role === "dm" ? DM : P1, state, deps).ok);
        for (const growths of [[], sent(grown).growths]) {
          const back = after(large, resizePatch(state, large, { size: "medium" }, role, growths));
          assert.deepEqual(tokenRefHex(g, back), home, `${role}: back on its hex${growths.length ? ", remembered" : ""}`);
        }
      }
    });
  }
});
