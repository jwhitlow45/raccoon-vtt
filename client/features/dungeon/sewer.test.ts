import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { doorLines } from "./dress.ts";
import { Board } from "./layout.ts";
import { paintedOf, samples, xyOf } from "./plan.samples.ts";
import { channelWater } from "./sewer.ts";

/*
 * A sewer's water (phase 2, 5.1, D-261107-262): on Wide a channel beside a
 * dry walkway, on Narrow every corridor square but the ordinary doorways'
 * outside squares, the runs and the stub's stairs, and cisterns crossed by
 * dry walkways along the ordinary doorway lines. A secret doorway leaves no
 * dry mark: its outside square and its line through a cistern are water.
 */

const NARROW = samples(61, 30, { theme: "sewer", secrets: 6, w: 60, h: 60, rooms: 16 });
const WIDE = samples(62, 20, { theme: "sewer", wide: true, secrets: 6, w: 70, h: 70, rooms: 16 });

describe("a sewer's water", () => {
  test("Wide blocks: stepped east or west the south row is water, stepped north or south the east column, and a turn's shared squares stay dry", () => {
    const board = new Board(20, 20, []);
    const W = 20;
    // East along row 5 from x 2 to 6, then south down columns 6 and 7 to row 9.
    const chain = [5 * W + 2, 5 * W + 3, 5 * W + 4, 5 * W + 5, 5 * W + 6, 6 * W + 6, 7 * W + 6, 8 * W + 6];
    const corridor = new Set<number>();
    for (const k of chain) for (const q of [k, k + 1, k + W, k + W + 1]) corridor.add(q);
    const water = channelWater(board, true, corridor, [{ chain }], () => false);
    const at = (x: number, y: number) => water.has(y * W + x);
    for (let x = 2; x <= 5; x++) {
      assert.ok(at(x, 6), `south row water at ${x}`);
      assert.ok(!at(x, 5), `north row dry at ${x}`);
    }
    for (let y = 8; y <= 9; y++) {
      assert.ok(at(7, y), `east column water at ${y}`);
      assert.ok(!at(6, y), `west column dry at ${y}`);
    }
    assert.ok(!at(6, 6) && !at(7, 6), "the turn's squares under both kinds stay dry");
    assert.deepEqual([...channelWater(board, true, corridor, [{ chain }], (k) => k === 6 * W + 3)].includes(6 * W + 3), false, "a dry square stays dry");
  });

  test("Narrow: every corridor square is water but the ordinary doorways' outside squares, the runs and the stub's stairs, and a secret doorway's outside square is water", () => {
    let secretMouths = 0;
    for (const { p, seed } of NARROW) {
      const W = p.plan.w;
      const painted = paintedOf(p);
      const secret = new Set(p.secret.map((c) => c.doorway.id));
      const dry = new Set<number>();
      for (const d of p.board.doorways) {
        if (d.removed) continue;
        if (!secret.has(d.id)) for (const k of d.outside) dry.add(k);
        if (d.run) for (const k of [...d.run.near, ...d.run.stairs.map((st) => st.cell), ...d.run.far]) dry.add(k);
      }
      const edge = (k: number) => {
        const [x, y] = xyOf(k, W);
        return x === 0 || y === 0 || x === W - 1 || y === p.plan.h - 1;
      };
      for (const [k, t] of painted) {
        if (p.board.roomAt[k] !== 0) continue;
        const [x, y] = xyOf(k, W);
        if (dry.has(k) || ((p.stubPath ?? []).includes(k) && edge(k))) assert.notEqual(t, "water", `${seed}: ${x},${y} should be dry`);
        else assert.equal(t, "water", `${seed}: corridor ${x},${y} is ${t}`);
      }
      for (const c of p.secret) {
        for (const k of c.doorway.outside) {
          assert.equal(painted.get(k), "water", `${seed}: a secret doorway's outside square is dry`);
          secretMouths++;
        }
      }
    }
    assert.ok(secretMouths > 10, `${secretMouths} secret doorways' outside squares`);
  });

  test("Wide: a walkway runs dry along every corridor, and the runs and the stub's stairs stay dry", () => {
    for (const { p, seed } of WIDE) {
      const painted = paintedOf(p);
      const corridor = [...painted.keys()].filter((k) => p.board.roomAt[k] === 0);
      const water = corridor.filter((k) => painted.get(k) === "water").length;
      assert.ok(water > corridor.length * 0.25 && water < corridor.length * 0.65, `${seed}: ${water} of ${corridor.length} corridor squares are water`);
      for (const d of p.board.doorways) {
        if (d.removed || !d.run) continue;
        for (const k of [...d.run.near, ...d.run.stairs.map((st) => st.cell), ...d.run.far]) assert.notEqual(painted.get(k), "water", `${seed}: a run in water`);
      }
    }
  });

  test("cisterns: water over the inset rectangle of a room 5 by 5 or larger, crossed dry by its ordinary doorway lines, a secret doorway's line taking the water", () => {
    let cisterns = 0;
    let secretLines = 0;
    for (const { p, seed } of [...NARROW, ...WIDE]) {
      const W = p.plan.w;
      const painted = paintedOf(p);
      const secret = new Set(p.secret.map((c) => c.doorway.id));
      for (const i of p.cisterns) {
        cisterns++;
        const r = p.board.rooms[i]!;
        assert.ok(r.w >= 5 && r.h >= 5 && !p.daises.has(i));
        const open = doorLines(p.board, i, (d) => secret.has(d.id));
        const all = doorLines(p.board, i);
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const k = y * W + x;
            const inset = x > r.x && y > r.y && x < r.x + r.w - 1 && y < r.y + r.h - 1;
            const want = inset && !open.has(k);
            assert.equal(painted.get(k) === "water", want, `${seed}: cistern ${i} at ${x},${y}`);
            if (want && all.has(k)) secretLines++;
          }
        }
      }
    }
    assert.ok(cisterns > 20, `${cisterns} cisterns`);
    assert.ok(secretLines > 0, "a secret doorway's line runs through water");
  });
});
