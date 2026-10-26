import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema, MAX_MOVES } from "#shared/protocol.ts";
import { groupDrop, groupFollowers, moveOps, tokensByCenter, tokensInBox } from "./group.ts";
import { SQUARES } from "#shared/rules/grid.ts";
import { snapAnchor, type HexGrid } from "#shared/rules/hex.ts";
import { occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";
import { footprint } from "./scene.ts";

const tok = (id: string, x: number, y: number, size: "tiny" | "medium" | "large" = "medium", locked = false) => ({ id, x, y, size, locked });

describe("moving a group", () => {
  const tokens = [tok("a", 2, 2), tok("b", 4, 2), tok("mouse", 3.5, 4, "tiny"), tok("door", 8, 8, "medium", true)];
  const onScene = new Map(tokens.map((t) => [t.id, t]));

  test("the rest of the selection follows, minus what this member may not move", () => {
    const canMove = (t: { locked: boolean }) => !t.locked;
    assert.deepEqual(
      groupFollowers(["a", "b", "door", "elsewhere"], "a", onScene, canMove).map((t) => t.id),
      ["b"],
    );
    assert.deepEqual(groupFollowers(["b", "mouse"], "a", onScene, canMove), [], "dragging a token outside the selection moves it alone");
  });

  test("a token whose holder, or one above it, moves too is left out, so a rider and its mount move once (docs/design-v1-attach.md 4.2)", () => {
    const linked = [
      { id: "horse", holder: undefined },
      { id: "rider", holder: "horse" },
      { id: "torch", holder: "rider" },
      { id: "thorn", holder: undefined },
    ];
    const byId = new Map(linked.map((t) => [t.id, t]));
    const holderOf = (t: { holder: string | undefined }) => (t.holder ? byId.get(t.holder) : undefined);
    const all = () => true;
    assert.deepEqual(groupFollowers(["thorn", "horse", "rider", "torch"], "thorn", byId, all, holderOf).map((t) => t.id), ["horse"]);
    assert.deepEqual(groupFollowers(["rider", "torch", "thorn"], "rider", byId, all, holderOf).map((t) => t.id), ["thorn"], "the torch goes with the rider dragged");
    // A rider's press that moves its mount names the mount, so a selected rider and torch on it stay out.
    assert.deepEqual(groupFollowers(["rider", "torch", "thorn", "horse"], "rider", byId, all, holderOf, ["horse"]).map((t) => t.id), ["thorn"]);
    assert.deepEqual(groupFollowers(["thorn", "rider"], "thorn", byId, all).map((t) => t.id), ["rider"], "without links every selected token follows");
  });

  test("each token snaps by its own footprint, and one that does not move is left out", () => {
    assert.deepEqual(groupDrop(SQUARES, tokens.slice(0, 3), 1.4, -0.2), [
      { tokenId: "a", x: 3, y: 2 },
      { tokenId: "b", x: 5, y: 2 },
      { tokenId: "mouse", x: 5, y: 4 },
    ]);
    assert.deepEqual(groupDrop(SQUARES, [tokens[2]!], 0.6, 0), [{ tokenId: "mouse", x: 4, y: 4 }]);
    assert.deepEqual(groupDrop(SQUARES, tokens.slice(0, 2), 0.3, 0.3), []);
  });

  test("a party of four group-dragged on hexes lands each on its own anchor (hex grids 4.2)", () => {
    for (const orient of ["rows", "columns"] as const) {
      const g: HexGrid = { shape: "hex", orient };
      // A party standing on their anchors: three Medium on their hexes' centers and a Large on its corner.
      const on = (id: string, size: "medium" | "large", hex: { col: number; row: number }) => ({ id, size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex) });
      const party = [on("a", "medium", { col: 2, row: 2 }), on("b", "medium", { col: 3, row: 2 }), on("c", "medium", { col: 2, row: 3 }), on("ogre", "large", { col: 5, row: 1 })];
      const moves = groupDrop(g, party, 2.3, 1.6);
      assert.equal(moves.length, 4, orient);
      for (const m of moves) {
        const t = party.find((p) => p.id === m.tokenId)!;
        const box = footprint(t);
        const anchor = { x: m.x + box.w / 2, y: m.y + box.h / 2 };
        assert.deepEqual(anchor, snapAnchor(g, t.size, anchor), `${orient}: ${t.id} stands on an anchor of its size`);
        assert.deepEqual(m, { tokenId: t.id, ...placedOnHex(g, { ...t, x: m.x, y: m.y }, tokenRefHex(g, { ...t, x: m.x, y: m.y })) });
      }
      // Each lands on its own hexes: no two of the party share one.
      const taken = moves.flatMap((m) => occupiedHexes(g, { ...party.find((p) => p.id === m.tokenId)!, x: m.x, y: m.y }).map((h) => `${h.col},${h.row}`));
      assert.equal(new Set(taken).size, taken.length, `${orient}: no hex taken twice`);
    }
  });

  test("one token is a plain move, a group is one moveMany the server accepts", () => {
    assert.deepEqual(moveOps([]), []);
    assert.deepEqual(moveOps([{ tokenId: "a", x: 1, y: 1 }]), [{ t: "token.move", tokenId: "a", x: 1, y: 1 }]);
    const many = moveOps(Array.from({ length: MAX_MOVES + 1 }, (_, i) => ({ tokenId: `t${i}`, x: i, y: 0 })));
    assert.equal(many.length, 2);
    for (const op of many) assert.ok(clientOpSchema.safeParse(op).success);
    assert.equal(many[0]!.t === "token.moveMany" ? many[0]!.moves.length : 0, MAX_MOVES);
  });

  test("a box picks every token its area overlaps", () => {
    assert.deepEqual(
      tokensInBox(tokens, { x: 5.5, y: 1 }, { x: 2.5, y: 4.2 }).map((t) => t.id),
      ["a", "b", "mouse"],
    );
    assert.deepEqual(tokensInBox(tokens, { x: 0, y: 0 }, { x: 1, y: 1 }), []);
  });
});

describe("a box in the isometric view (docs/design-v1-isometric-view.md 6.2)", () => {
  test("takes the tokens whose ring's center shows inside it on screen, whatever their footprints overlap", () => {
    const tokens = [
      { id: "in", c: { x: 50, y: 50 } },
      { id: "edge", c: { x: 100, y: 20 } },
      { id: "out", c: { x: 101, y: 50 } },
      { id: "above", c: { x: 50, y: 9 } },
    ];
    assert.deepEqual(
      tokensByCenter(tokens, { x: 100, y: 80 }, { x: 10, y: 10 }, (t) => t.c).map((t) => t.id),
      ["in", "edge"],
    );
  });
});

