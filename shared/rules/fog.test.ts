import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FogOp, FogTile } from "../model.ts";
import { rng, token } from "../testutil.ts";
import {
  FULL_TILE,
  TILE_BYTES,
  allRevealedTiles,
  decodeTile,
  encodeTile,
  fullTileBits,
  getBit,
  isAboveFog,
  isCellFullyFogged,
  isRangeFullyFogged,
  isTokenFullyFogged,
  labelCells,
  rasterizeFogOps,
} from "./fog.ts";
import { occupiedCells } from "./footprint.ts";
import { boxTouchesCell, labelBox } from "./labels.ts";
import { SQUARES } from "./grid.ts";

const bounds = { w: 40, h: 40 };

function apply(tiles: Record<string, FogTile>, ops: FogOp[]): Record<string, FogTile> {
  const next = { ...tiles };
  for (const [key, tile] of Object.entries(rasterizeFogOps(tiles, "s1", bounds, ops))) {
    if (tile === null) delete next[key];
    else next[key] = tile;
  }
  return next;
}

function revealed(tiles: Record<string, FogTile>, x: number, y: number): boolean {
  return !isCellFullyFogged(tiles, "s1", { x, y });
}

/** Whether one sub-cell is revealed, by sub-cell coordinates. */
function sub(tiles: Record<string, FogTile>, sx: number, sy: number): boolean {
  const tile = tiles[`s1:${Math.floor(sx / 64)},${Math.floor(sy / 64)}`];
  if (!tile) return false;
  return getBit(decodeTile(tile.bits)!, sx % 64, sy % 64);
}

/** The tile decoder as it was before its lookup table, kept to pin the new one to the same answers. */
function referenceDecode(text: string): Uint8Array | null {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (typeof text !== "string" || text.length % 4 !== 0) return null;
  const out = new Uint8Array((text.length / 4) * 3);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const vals: number[] = [];
    for (let j = 0; j < 4; j++) {
      const ch = text[i + j]!;
      if (ch === "=") {
        vals.push(-1);
        continue;
      }
      const v = B64.indexOf(ch);
      if (v < 0) return null;
      vals.push(v);
    }
    const [a, b, c, d] = vals as [number, number, number, number];
    if (a < 0 || b < 0) return null;
    out[o++] = (a << 2) | (b >> 4);
    if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) {
      if (c < 0) return null;
      out[o++] = ((c & 3) << 6) | d;
    }
  }
  if (o !== TILE_BYTES) return null;
  return out.subarray(0, o);
}

describe("tile encoding", () => {
  test("round trips 512 bytes and refuses anything else", () => {
    const bits = new Uint8Array(TILE_BYTES);
    for (let i = 0; i < bits.length; i++) bits[i] = (i * 37) & 0xff;
    const text = encodeTile(bits);
    assert.equal(text.length, Math.ceil(TILE_BYTES / 3) * 4);
    assert.deepEqual(decodeTile(text), bits);
    assert.equal(decodeTile(text.slice(4)), null);
    assert.equal(decodeTile("not base64!"), null);
    assert.equal(decodeTile(""), null);
    assert.equal(FULL_TILE, encodeTile(fullTileBits()));
  });

  test("decodes every input exactly as the decoder before its lookup table did", () => {
    const r = rng(4242);
    const pick = (chars: string) => chars[Math.floor(r() * chars.length)]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const tiles: string[] = [];
    for (let t = 0; t < 40; t++) {
      const bits = new Uint8Array(TILE_BYTES);
      for (let i = 0; i < bits.length; i++) bits[i] = Math.floor(r() * 256);
      tiles.push(encodeTile(bits));
    }
    const inputs: unknown[] = [
      ...tiles,
      FULL_TILE,
      encodeTile(new Uint8Array(TILE_BYTES)),
      "",
      "====",
      "A===",
      "AA==",
      undefined,
      null,
      42,
    ];
    for (const text of tiles.slice(0, 20)) {
      const at = 4 * Math.floor(r() * (text.length / 4 - 1));
      // One character changed: inside the alphabet, "=", outside it, past ASCII, and a lone surrogate.
      for (const ch of [pick(alphabet), "=", pick("!-.*_ \n"), "é", "\ud800"]) inputs.push(text.slice(0, at + 1) + ch + text.slice(at + 2));
      // Bits a canonical tile never carries before the final padding.
      inputs.push(`${text.slice(0, -3)}${pick(alphabet)}==`);
      // Padding inside the text, with the bytes it drops made up by a longer text.
      inputs.push(`${text.slice(0, 8)}AA==AAA=${text.slice(8)}`);
      inputs.push(`AA==${text.slice(0, -4)}${text.slice(-4, -2)}==`);
      inputs.push(text.slice(0, -4));
      inputs.push(`${text}AAAA`);
    }
    for (let k = 0; k < 300; k++) {
      // Random text from the alphabet and "=", around a tile's length.
      const len = 4 * (170 + Math.floor(r() * 4));
      let text = "";
      for (let i = 0; i < len; i++) text += r() < 0.02 ? "=" : pick(alphabet);
      inputs.push(text);
    }
    let decoded = 0;
    for (const text of inputs) {
      const want = referenceDecode(text as string);
      const got = decodeTile(text as string);
      if (want === null) assert.equal(got, null, JSON.stringify(text)?.slice(0, 60));
      else {
        decoded++;
        assert.ok(got, JSON.stringify(text)?.slice(0, 60));
        assert.deepEqual([...got], [...want]);
      }
    }
    // Both kinds of answer were exercised.
    assert.ok(decoded > 40 && decoded < inputs.length);
  });
});

describe("rasterization", () => {
  test("a rect reveals exactly the sub-cells whose centers are inside", () => {
    const tiles = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 2, y: 3, w: 1.5, h: 1 } }]);
    assert.ok(revealed(tiles, 2, 3));
    assert.ok(revealed(tiles, 3, 3));
    assert.ok(!revealed(tiles, 4, 3));
    assert.ok(!revealed(tiles, 2, 4));
    // Cell 3,3 is half covered: its left two sub-columns on, the right two off.
    assert.ok(sub(tiles, 12, 12));
    assert.ok(sub(tiles, 13, 12));
    assert.ok(!sub(tiles, 14, 12));
    assert.ok(!sub(tiles, 8, 11));
    assert.ok(sub(tiles, 8, 12));
  });

  test("hide after reveal restores fog, and a tile that becomes empty disappears", () => {
    let tiles = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }]);
    assert.equal(Object.keys(tiles).length, 1);
    tiles = apply(tiles, [{ id: "b", mode: "hide", shape: { kind: "rect", x: 0, y: 0, w: 4, h: 4 } }]);
    assert.deepEqual(tiles, {});
  });

  test("ops rasterize in order, so reveal then hide differs from hide then reveal", () => {
    const reveal: FogOp = { id: "a", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 2, h: 2 } };
    const hide: FogOp = { id: "b", mode: "hide", shape: { kind: "rect", x: 1, y: 0, w: 1, h: 2 } };
    const a = apply({}, [reveal, hide]);
    const b = apply({}, [hide, reveal]);
    assert.ok(revealed(a, 0, 0) && !revealed(a, 1, 0));
    assert.ok(revealed(b, 0, 0) && revealed(b, 1, 0));
    // Applying one at a time gives the same bits as applying both at once.
    const stepwise = apply(apply({}, [reveal]), [hide]);
    assert.deepEqual(stepwise, a);
  });

  test("a polygon follows its edges and a stroke is a capsule chain", () => {
    const tri = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "poly", points: [0, 0, 8, 0, 0, 8] } }]);
    assert.ok(revealed(tri, 0, 0));
    assert.ok(revealed(tri, 3, 3));
    assert.ok(!revealed(tri, 6, 6));
    assert.ok(!sub(tri, 20, 20));
    assert.ok(sub(tri, 10, 10));
    const stroke = apply({}, [{ id: "b", mode: "reveal", shape: { kind: "stroke", points: [2, 2, 10, 2], width: 1 } }]);
    assert.ok(revealed(stroke, 5, 1));
    assert.ok(revealed(stroke, 5, 2));
    assert.ok(!revealed(stroke, 5, 4));
    assert.ok(!revealed(stroke, 12, 2));
    assert.ok(revealed(stroke, 10, 2));
  });

  test("cells and all cover whole cells and the whole scene inside the bounds", () => {
    const cells = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "cells", cells: ["1,1", "17,17", "bogus"] } }]);
    assert.ok(revealed(cells, 1, 1));
    assert.ok(revealed(cells, 17, 17));
    assert.ok(!revealed(cells, 2, 1));
    assert.equal(Object.keys(cells).length, 2);
    const all = apply({}, [{ id: "b", mode: "reveal", shape: { kind: "all" } }]);
    assert.equal(Object.keys(all).length, 9);
    assert.ok(revealed(all, 39, 39));
    // The edge tile covers cells 32..47 but the scene stops at 40: the rest stays fogged.
    assert.ok(!sub(all, 160, 0));
    assert.ok(sub(all, 159, 0));
    assert.deepEqual(allRevealedTiles("s1", bounds).map((t) => t.bits), Object.values(all).map((t) => t.bits));
    assert.deepEqual(apply(all, [{ id: "c", mode: "hide", shape: { kind: "all" } }]), {});
  });

  test("shapes outside the bounds change nothing", () => {
    assert.deepEqual(rasterizeFogOps({}, "s1", bounds, [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 50, y: 50, w: 5, h: 5 } }]), {});
    assert.deepEqual(rasterizeFogOps({}, "s1", bounds, [{ id: "a", mode: "hide", shape: { kind: "rect", x: 1, y: 1, w: 5, h: 5 } }]), {});
  });

  test("an unchanged tile is not reported", () => {
    const tiles = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 2, h: 2 } }]);
    const again = rasterizeFogOps(tiles, "s1", bounds, [{ id: "b", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 1, h: 1 } }]);
    assert.deepEqual(again, {});
  });
});

describe("footprints and withholding", () => {
  test("occupied cells snap to whole cells, and a Tiny creature takes the cell that contains it", () => {
    assert.deepEqual(occupiedCells(SQUARES, token("t", { size: "medium", x: 2.4, y: 2.6 })), [{ x: 2, y: 3 }]);
    assert.deepEqual(occupiedCells(SQUARES, token("t", { size: "large", x: 1, y: 1 })), [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }]);
    assert.deepEqual(occupiedCells(SQUARES, token("t", { size: "tiny", x: 2.3, y: 2.7 })), [{ x: 2, y: 2 }]);
    assert.deepEqual(occupiedCells(SQUARES, token("t", { size: "tiny", x: 2.8, y: 2.9 })), [{ x: 3, y: 3 }]);
    assert.equal(occupiedCells(SQUARES, token("t", { size: "custom", w: 1.5, h: 2, x: 0, y: 0 })).length, 4);
    assert.equal(occupiedCells(SQUARES, token("t", { size: "gargantuan", x: 0, y: 0 })).length, 16);
  });

  test("a token is withheld only when every occupied cell is fully fogged", () => {
    const tiles = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 5, y: 5, w: 0.25, h: 0.25 } }]);
    assert.ok(isTokenFullyFogged(SQUARES, {}, "s1", token("t", { x: 5, y: 5 })));
    assert.ok(!isTokenFullyFogged(SQUARES, tiles, "s1", token("t", { x: 5, y: 5 })));
    assert.ok(!isTokenFullyFogged(SQUARES, tiles, "s1", token("t", { size: "large", x: 4, y: 4 })));
    assert.ok(isTokenFullyFogged(SQUARES, tiles, "s1", token("t", { x: 6, y: 5 })));
    assert.ok(isCellFullyFogged({ "s1:0,0": { sceneId: "s1", tx: 0, ty: 0, rev: 0, bits: "corrupt" } }, "s1", { x: 0, y: 0 }));
  });

  test("a label covers its estimated text box, at least one cell", () => {
    assert.deepEqual(labelCells({ x: 5.5, y: 5.5, text: "", size: 1 }), { x0: 5, y0: 5, x1: 6, y1: 6 });
    assert.deepEqual(labelCells({ x: 10, y: 4, text: "Trap door", size: 1 }), { x0: 7, y0: 3, x1: 13, y1: 5 });
    assert.deepEqual(labelCells({ x: 0, y: 0, text: "Hall", size: 2 }), { x0: -3, y0: -1, x1: 3, y1: 1 });
  });

  test("the fog withholds a label by exactly the cells an erase would take it with", () => {
    const r = rng(7);
    for (let i = 0; i < 2_000; i++) {
      const label = { x: r() * 30, y: r() * 30, text: "x".repeat(Math.floor(r() * 20)), size: 0.1 + r() * 4 };
      const range = labelCells(label);
      const box = labelBox(label);
      for (let y = range.y0 - 2; y < range.y1 + 2; y++) {
        for (let x = range.x0 - 2; x < range.x1 + 2; x++) {
          const inRange = x >= range.x0 && x < range.x1 && y >= range.y0 && y < range.y1;
          assert.equal(inRange, boxTouchesCell(box, x, y), `${JSON.stringify(label)} at ${x},${y}`);
        }
      }
    }
  });

  test("a range is fully fogged only when no cell in it has a revealed sub-cell, across tiles", () => {
    const tiles = apply({}, [{ id: "a", mode: "reveal", shape: { kind: "rect", x: 20, y: 3, w: 0.25, h: 0.25 } }]);
    const brute = (r: { x0: number; y0: number; x1: number; y1: number }) => {
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (!isCellFullyFogged(tiles, "s1", { x, y })) return false;
      return true;
    };
    for (const range of [
      { x0: 0, y0: 0, x1: 20, y1: 10 },
      { x0: 0, y0: 0, x1: 21, y1: 10 },
      { x0: 20, y0: 3, x1: 21, y1: 4 },
      { x0: -40, y0: -40, x1: 0, y1: 0 },
      { x0: 15, y0: 0, x1: 40, y1: 3 },
      { x0: 17, y0: 2, x1: 33, y1: 18 },
    ]) {
      assert.equal(isRangeFullyFogged(tiles, "s1", range), brute(range), JSON.stringify(range));
    }
    assert.ok(isRangeFullyFogged({}, "s1", { x0: 0, y0: 0, x1: 200, y1: 200 }));
  });

  test("aboveFog is the one rule: a player owner or the DM's exemption, never a reveal on the creature's turn", () => {
    assert.ok(!isAboveFog(token("t"), false));
    assert.ok(isAboveFog(token("t"), true));
    assert.ok(isAboveFog(token("t", { fogExempt: true }), false));
    assert.ok(!isAboveFog(token("t", { fogExemptAuto: true }), false), "a revealed creature follows the fog like any other");
  });
});
