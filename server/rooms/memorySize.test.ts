import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes } from "#shared/limits.ts";
import { type FreeWall, type Label, type MemoryChunk, type Scene, type Stamp } from "#shared/model.ts";
import { int, pick, rng, scene } from "#shared/testutil.ts";
const HEX_ROWS = { shape: "hex", orient: "rows" } as const;
import { chunkCharge, entryCharge, keyBytes, memoryCollectionKey, pieceBytes, wallLargestBytes, wallPieceBound } from "./memorySize.ts";

/**
 * What players' maps cost (docs/design-v1-map-discovery.md 5.5): each free
 * wall at its largest form by its own spans (LK-36), and each memory entry
 * at no less than its own bytes, which MD1's bounds on a fold rest on.
 */

const SQUARE_SCENE: Scene = scene("s1", { bounds: { w: 200, h: 200 }, fogEnabled: true });

describe("a free wall's largest form (LK-36, ASTRA-29, ASTRA-32)", () => {
  test("an 8-cell wall on squares cuts into at most 8 pieces, by its own crossings and split lines", () => {
    // Along a row it crosses cells 0 to 8 and the lines x = 4 and x = 8 lie inside it: (9 + 2 + 1) / 2 = 6.
    assert.equal(wallPieceBound({ shape: "squares" }, { a: [0.5, 2.5], b: [8.5, 2.5] }), 6);
    // The longest diagonal crosses at most 14 cells and 2 lines.
    const diagonal = { a: [0.015625, 0.03125] as [number, number], b: [5.671875, 5.6875] as [number, number] };
    assert.ok(wallPieceBound({ shape: "squares" }, diagonal) <= 8);
    // A short wall inside one cell is one piece.
    assert.equal(wallPieceBound({ shape: "squares" }, { a: [3.25, 3.25], b: [3.75, 3.75] }), 1);
  });

  test("astra's hex wall is counted at 11, its 10 final pieces within it", () => {
    assert.equal(wallPieceBound(HEX_ROWS, { a: [5.1875, 5.375], b: [1.203125, 12.296875] }), 11);
  });

  test("a piece prints in 98 bytes under 1,000 cells, a window's in 100, and a short door counts whole", () => {
    assert.equal(pieceBytes(SQUARE_SCENE, "wall"), 98);
    assert.equal(pieceBytes(SQUARE_SCENE, "window"), 100);
    const door: FreeWall = { id: "abcdefghijkl", a: [12.25, 12.25], b: [12.75, 12.75], f: { kind: "door", state: "closed", secret: false, discovered: false } };
    assert.equal(wallLargestBytes(SQUARE_SCENE, door), serializedBytes(door) + 1);
    assert.ok(Math.abs(serializedBytes(door) + 1 - 125) <= 4, `a short door is ${serializedBytes(door) + 1} bytes with its comma`);
    // A long wall counts at its pieces, more than it stores.
    const long: FreeWall = { id: "abcdefghijkm", a: [0.5, 2.5], b: [8.5, 2.5], f: { kind: "wall" } };
    assert.equal(wallLargestBytes(SQUARE_SCENE, long), 6 * 98);
  });
});

describe("memory's charge (5.5, MD1's byte bounds)", () => {
  /** A random chunk of memory, every kind of entry, with ids and keys of the widest lengths the schema allows. */
  function randomChunk(r: () => number, layer: string | undefined): MemoryChunk {
    const cx = int(r, 0, 14);
    const cy = int(r, 0, 14);
    const sceneId = pick(r, ["s1", "\u0001".repeat(64), "梟".repeat(64)]);
    const cell = () => `${cx * 16 + int(r, 0, 15)},${cy * 16 + int(r, 0, 15)}`;
    const chunk: MemoryChunk = { sceneId, cx, cy, rev: int(r, 0, 1_000_000), ...(layer ? { memberId: layer } : {}) };
    const n = () => int(r, 0, 6);
    chunk.cells = Object.fromEntries(Array.from({ length: n() }, () => [cell(), pick(r, ["stone", "wood", null] as const)]));
    chunk.edges = Object.fromEntries(Array.from({ length: n() }, () => [`${cell()},${pick(r, ["n", "w"])}`, pick(r, ["auto", null, { kind: "wall" }, { kind: "door", state: "open", secret: false, discovered: false }] as const)]));
    chunk.heights = Object.fromEntries(Array.from({ length: n() }, () => [cell(), int(r, -100, 100)]));
    chunk.rough = Object.fromEntries(Array.from({ length: n() }, () => [cell(), r() < 0.5]));
    chunk.walls = Object.fromEntries(
      Array.from({ length: n() }, () => {
        const ax = cx * 16 + int(r, 0, 15 * 64) / 64;
        const ay = cy * 16 + int(r, 0, 15 * 64) / 64;
        const wall: FreeWall = { id: "w".repeat(12), a: [ax, ay], b: [ax + int(r, 1, 300) / 64, ay + int(r, 0, 300) / 64], f: pick(r, [{ kind: "wall" }, { kind: "window" }] as const) };
        return [`${int(r, 100000000000, 999999999999)}`, [{ wall: r() < 0.3 ? null : wall, cells: [cell(), cell()] }]];
      }),
    );
    const label = (id: string): Label => ({ id, rev: int(r, 0, 9999), sceneId, x: int(r, 0, 199), y: int(r, 0, 199), text: "t".repeat(int(r, 1, 120)), size: 1 });
    const stamp = (id: string): Stamp => ({ id, rev: 0, sceneId, art: { key: "barrel" }, x: 3, y: 3, w: 2, h: 2, rotation: 0, z: 0, visibility: "all" });
    chunk.labels = Object.fromEntries(Array.from({ length: n() }, (_, i) => [`label-${i}`, r() < 0.3 ? null : label(`label-${i}`)]));
    chunk.stamps = Object.fromEntries(Array.from({ length: n() }, (_, i) => [`stamp-${i}`, r() < 0.3 ? null : stamp(`stamp-${i}`)]));
    return chunk;
  }

  test("every chunk is charged at least what it stores, its key, quotes and comma included, so a cap bounds its JSON", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const chunk = randomChunk(r, r() < 0.5 ? "0199f0a0-0000-7000-8000-000000000001" : undefined);
      const stored = keyBytes(memoryCollectionKey(chunk)) + serializedBytes(chunk);
      const s = { ...SQUARE_SCENE, id: chunk.sceneId };
      assert.ok(chunkCharge(s, chunk) >= stored, `seed ${seed}: charged ${chunkCharge(s, chunk)}, stores ${stored}`);
    }
  });

  test("a remembered wall is charged its own largest form, so a memory of walls forgets sooner", () => {
    const wall: FreeWall = { id: "abcdefghijkl", a: [0.5, 2.5], b: [8.5, 2.5], f: { kind: "wall" } };
    assert.equal(entryCharge(SQUARE_SCENE, "walls", "abcdefghijkl", [{ wall, cells: ["7,2"] }]), 6 * 98);
    // Absent then, it adds nothing to a player's chunks and is charged what it stores.
    const bare = [{ wall: null, cells: ["7,2"] }];
    assert.equal(entryCharge(SQUARE_SCENE, "walls", "abcdefghijkl", bare), keyBytes("abcdefghijkl") + serializedBytes(bare));
  });
});
