import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stampCells } from "#shared/project.ts";
import { daisClear, doorLines } from "./dress.ts";
import { paintedOf, samples } from "./plan.samples.ts";
import { DUNGEON_WOOD_PROPS, PROPS, stampSize, WALL_PIECES } from "./props.ts";
import { MAX_ROOM_STAMPS, MAX_STAMPS, roomCap, THEMES } from "./settings.ts";
import { THEME_SPECS } from "./themes.ts";
import { STATUE_STAMP } from "./trapSpots.ts";

/*
 * Dressing (phase 2, 5.5, D-261107-201, 262): every stamp's box inside one
 * room's floor, off the ways and the pin square, at the catalog's size, at
 * most 4 a room and 160 a dungeon with the lights and statues. A secret
 * doorway leaves no mark, so its lines and inside squares take stamps as
 * plain floor does.
 */

describe("dressing", () => {
  test("every stamp's box lies in one room's floor, off the ordinary ways, the dais's clear squares, the pin square and the overlays, at most 4 a room", () => {
    let secretSquares = 0;
    for (const theme of THEMES) {
      for (const { p, seed } of samples(160 + theme.length, 8, { theme, dressing: "full", lit: 100, secrets: 6, w: 70, h: 70, rooms: 20 })) {
        const W = p.plan.w;
        const painted = paintedOf(p);
        const secret = new Set(p.secret.map((c) => c.doorway.id));
        const perRoom = new Map<number, number>();
        const taken = new Set<number>();
        for (const st of p.plan.stamps) {
          const size = stampSize(st.key);
          assert.deepEqual(size && { w: st.w, h: st.h }, size, `${seed}: ${st.key} off its catalog size`);
          const box = stampCells(st);
          const rooms = new Set<number>();
          for (let y = box.y0; y < box.y1; y++) {
            for (let x = box.x0; x < box.x1; x++) {
              const k = y * W + x;
              rooms.add(p.board.roomAt[k]! - 1);
              assert.ok(painted.has(k), `${seed}: ${st.key} over rock at ${x},${y}`);
              assert.ok(!["water", "pit", "pillar", "rubble"].includes(painted.get(k)!), `${seed}: ${st.key} on ${painted.get(k)}`);
            }
          }
          assert.equal(rooms.size, 1, `${seed}: ${st.key}'s box straddles`);
          const i = [...rooms][0]!;
          assert.ok(i >= 0, `${seed}: ${st.key} in a corridor`);
          perRoom.set(i, (perRoom.get(i) ?? 0) + 1);
          const ways = doorLines(p.board, i, (d) => secret.has(d.id));
          const all = doorLines(p.board, i);
          const dais = p.daises.get(i);
          const clear = new Set(dais ? daisClear(dais) : []);
          // A statue's picture is centered on its block, which the trap's own rules keep off the ways too.
          for (let y = box.y0; y < box.y1; y++) {
            for (let x = box.x0; x < box.x1; x++) {
              const k = y * W + x;
              assert.ok(!ways.has(k), `${seed}: ${st.key} on an ordinary doorway line at ${x},${y}`);
              assert.ok(!clear.has(k), `${seed}: ${st.key} by a dais's stair`);
              assert.notEqual(k, p.pins.get(i), `${seed}: ${st.key} on the pin square`);
              assert.ok(!taken.has(k), `${seed}: two stamps share ${x},${y}`);
              taken.add(k);
              if (all.has(k) && st.key !== STATUE_STAMP.key) secretSquares++;
            }
          }
          if (st.key !== STATUE_STAMP.key && st.key !== THEME_SPECS[theme].light.stamp) {
            const floor = p.plan.rooms[p.kept.indexOf(i)]!.floor;
            assert.ok((theme === "dungeon" && floor === "wood" ? DUNGEON_WOOD_PROPS : PROPS[theme]).includes(st.key), `${seed}: ${st.key} is not a ${theme} prop`);
          }
        }
        for (const [i, n] of perRoom) assert.ok(n <= MAX_ROOM_STAMPS, `${seed}: room ${i} holds ${n} stamps`);
      }
    }
    assert.ok(secretSquares > 0, "a secret doorway's line holds a prop or a light somewhere");
  });

  test("a wall piece stands with a long side against the room's edge", () => {
    let pieces = 0;
    for (const { p, seed } of samples(170, 20, { dressing: "full", w: 80, h: 80, rooms: 30 })) {
      for (const st of p.plan.stamps) {
        if (!WALL_PIECES.has(st.key)) continue;
        pieces++;
        const box = stampCells(st);
        const i = p.board.roomAt[box.y0 * p.plan.w + box.x0]! - 1;
        const r = p.board.rooms[i]!;
        const across = st.rotation % 180 === 0 ? st.w : st.h;
        const down = st.rotation % 180 === 0 ? st.h : st.w;
        const northSouth = box.y0 === r.y || box.y1 === r.y + r.h;
        const eastWest = box.x0 === r.x || box.x1 === r.x + r.w;
        assert.ok((northSouth && across >= down) || (eastWest && down >= across), `${seed}: ${st.key} turned ${st.rotation} off its wall`);
      }
    }
    assert.ok(pieces > 10, `${pieces} wall pieces`);
  });

  test("None places only lights and statues, Some fewer than Full, and the largest choices stay within 160 stamps", () => {
    const count = (dressing: "none" | "some" | "full") => samples(171, 10, { dressing, lit: 0, traps: 0, w: 60, h: 60, rooms: 16 }).reduce((n, { p }) => n + p.plan.stamps.length, 0);
    assert.equal(count("none"), 0);
    assert.ok(count("some") < count("full"));
    for (const { p } of samples(172, 4, { dressing: "full", lit: 100, traps: 6, w: 100, h: 100, rooms: roomCap(100, 100), density: "dense" })) assert.ok(p.plan.stamps.length <= MAX_STAMPS);
  });
});
