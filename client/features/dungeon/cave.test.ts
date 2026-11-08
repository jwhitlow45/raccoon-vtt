import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { besideDoorway, erodeRoom } from "./cave.ts";
import { doorLines } from "./dress.ts";
import { Board, placeDoorway } from "./layout.ts";
import { Stream } from "./random.ts";
import { around, paintedOf, samples, xyOf } from "./plan.samples.ts";

/*
 * Cave (phase 2, 5.1, D-261107-199): eroded rooms that stay one piece and
 * keep their doorways, lines and pin square, rock columns standing alone,
 * tunnels that bulge only where a corridor could have gone, and no door.
 */

const CAVES = [...samples(51, 20, { theme: "cave", w: 70, h: 70, rooms: 20 }), ...samples(52, 15, { theme: "cave", wide: true, w: 70, h: 70, rooms: 16, density: "dense" })];

describe("caves", () => {
  test("every cave room is one piece and keeps its doorways' inside squares, the squares beside them, its lines and its pin square", () => {
    let eroded = 0;
    for (const { p, seed } of CAVES) {
      const W = p.plan.w;
      const painted = paintedOf(p);
      for (const i of p.kept) {
        const r = p.board.rooms[i]!;
        const own: number[] = [];
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (painted.has(y * W + x)) own.push(y * W + x);
        eroded += r.w * r.h - own.length;
        const seen = new Set([own[0]!]);
        const queue = [own[0]!];
        const mine = new Set(own);
        while (queue.length > 0) for (const n of around(queue.pop()!, W, p.plan.h)) if (mine.has(n) && !seen.has(n)) (seen.add(n), queue.push(n));
        assert.equal(seen.size, own.length, `${seed}: room ${i} is in pieces`);
        const keep = [...doorLines(p.board, i)];
        for (const d of p.board.doorways) if (d.room === i && !d.removed) keep.push(...d.inside, ...besideDoorway(p.board, d.inside, d.side));
        keep.push(p.pins.get(i)!);
        for (const k of keep) assert.ok(painted.has(k), `${seed}: room ${i} lost ${xyOf(k, W).join(",")}`);
      }
      assert.deepEqual(p.plan.doors, [], "a cave has no doors");
    }
    assert.ok(eroded > 0);
  });

  test("rock columns stand alone, two in from the walls and a square from the lines, the dais and the pin square, so each is walled all round", () => {
    let columns = 0;
    for (const { p, seed } of CAVES) {
      const W = p.plan.w;
      const painted = paintedOf(p);
      for (const i of p.kept) {
        const r = p.board.rooms[i]!;
        const lines = doorLines(p.board, i);
        const dais = p.daises.get(i);
        for (const k of p.unpainted) {
          const [x, y] = xyOf(k, W);
          const inner = x >= r.x + 1 && y >= r.y + 1 && x <= r.x + r.w - 2 && y <= r.y + r.h - 2;
          if (!inner || p.board.roomAt[k] !== i + 1) continue;
          columns++;
          assert.ok(x >= r.x + 2 && y >= r.y + 2 && x <= r.x + r.w - 3 && y <= r.y + r.h - 3, `${seed}: a column at ${x},${y} by the wall`);
          assert.ok(r.w >= 7 && r.h >= 7, `${seed}: a column in a ${r.w} by ${r.h} room`);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const n = k + dy * W + dx;
              if (dx !== 0 || dy !== 0) assert.ok(painted.has(n), `${seed}: column ${x},${y} touches rock at ${x + dx},${y + dy}`);
              assert.ok(!lines.has(n) && n !== p.pins.get(i), `${seed}: column ${x},${y} beside a line or the pin`);
              if (dais) assert.ok(!(n % W >= dais.rect.x && n % W < dais.rect.x + dais.rect.w && Math.floor(n / W) >= dais.rect.y && Math.floor(n / W) < dais.rect.y + dais.rect.h), `${seed}: column ${x},${y} by the dais`);
            }
          }
        }
      }
    }
    assert.ok(columns > 10, `${columns} columns`);
  });

  test("tunnels bulge only onto open rock beside a corridor square: off the margin, the rooms, the squares touching them and the runs", () => {
    let bulges = 0;
    for (const { p, seed } of CAVES) {
      const W = p.plan.w;
      const corridor = new Set([...p.paths.flatMap((x) => x ?? []), ...(p.stubPath ?? [])]);
      for (const k of p.bulges) {
        bulges++;
        const [x, y] = xyOf(k, W);
        assert.ok(p.board.inside(x, y), `${seed}: bulge ${x},${y} in the margin`);
        assert.equal(p.board.roomAt[k], 0);
        assert.ok(!p.board.halo(k), `${seed}: bulge ${x},${y} touches a room`);
        assert.equal(p.board.besideAt[k], 0, `${seed}: bulge ${x},${y} beside a run`);
        assert.equal(p.board.runAt[k], 0);
        assert.ok(around(k, W, p.plan.h).some((n) => corridor.has(n)), `${seed}: bulge ${x},${y} beside no corridor`);
      }
    }
    // About one corridor square in four.
    const squares = CAVES.reduce((n, { p }) => n + new Set(p.paths.flatMap((x) => x ?? [])).size, 0);
    assert.ok(bulges > squares * 0.08 && bulges < squares * 0.25, `${bulges} bulges on ${squares} corridor squares`);
  });

  test("erosion takes the corners and nibbles, never a kept square", () => {
    const board = new Board(30, 30, [{ x: 5, y: 5, w: 8, h: 6 }]);
    const d = placeDoorway(board, 0, ["n"], { x: 8, y: 0, w: 1, h: 1 }, 1, 0)!;
    const keep = new Set([...d.inside, ...besideDoorway(board, d.inside, d.side), ...doorLines(board, 0)]);
    let nibbled = 0;
    for (let i = 0; i < 40; i++) {
      const key = new Uint8Array(32);
      key[0] = i;
      const gone = erodeRoom(new Stream(key, new Uint8Array(12)), board, 0, (k) => keep.has(k));
      for (const k of keep) assert.ok(!gone.has(k));
      for (const k of [board.cell(5, 5), board.cell(12, 5), board.cell(5, 10), board.cell(12, 10)]) assert.ok(gone.has(k), "every corner goes");
      for (const k of gone) {
        const [x, y] = xyOf(k, 30);
        assert.ok(x === 5 || y === 5 || x === 12 || y === 10, `${x},${y} is off the ring`);
      }
      nibbled += gone.size - 4;
    }
    assert.ok(nibbled > 0);
  });
});
