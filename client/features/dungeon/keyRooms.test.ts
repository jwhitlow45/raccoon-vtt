import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { trapPreset } from "#shared/srd/traps.ts";
import { doorEdge } from "./layout.ts";
import { paintedOf, samples, xyOf } from "./plan.samples.ts";
import { corridorTraps, numberRooms, TRINKET_LINES } from "./keyRooms.ts";

/*
 * The DM key's rooms (phase 2, 5.6): numbered breadth first from the
 * entrance, each pin on free floor nearest the room's middle, doors named
 * by the rooms they lead to, a trinket each without repeats, and no seed.
 */

describe("the key's rooms", () => {
  test("numbers run 1 to n breadth first over the tree from the entrance, children in the order the tree joined them", () => {
    for (const { p, seed } of samples(180, 15, { w: 70, h: 70, rooms: 20 })) {
      const numbers = numberRooms(p.links, p.kept, p.entrance);
      assert.equal(numbers.get(p.entrance), 1);
      assert.deepEqual([...numbers.values()].sort((a, b) => a - b), p.kept.map((_, i) => i + 1));
      // Breadth first: a room's number is above its parent's, and siblings keep the tree's order.
      for (const l of p.links) {
        if (l.kind !== "tree" || !numbers.has(l.b)) continue;
        assert.ok(numbers.get(l.b)! > numbers.get(l.a)!, `${seed}: child before parent`);
      }
      const depth = new Map([[p.entrance, 0]]);
      for (const l of p.links) if (l.kind === "tree" && depth.has(l.a) && numbers.has(l.b)) depth.set(l.b, depth.get(l.a)! + 1);
      const byNumber = [...numbers.entries()].sort((a, b) => a[1] - b[1]).map(([room]) => depth.get(room)!);
      for (let i = 1; i < byNumber.length; i++) assert.ok(byNumber[i]! >= byNumber[i - 1]!, `${seed}: not breadth first`);
      assert.deepEqual(p.plan.key!.map((k) => k.n), p.kept.map((_, i) => i + 1));
    }
  });

  test("each pin stands on free floor nearest its room's middle: never water, a pit, a pillar, a column or a dais", () => {
    for (const theme of ["dungeon", "crypt", "cave", "sewer", "mine"] as const) {
      for (const { p, seed } of samples(181 + theme.length, 8, { theme, w: 60, h: 60, rooms: 16 })) {
        const W = p.plan.w;
        const painted = paintedOf(p);
        const raised = new Set(p.plan.heights.flatMap((h) => h.cells));
        p.plan.rooms.forEach((r, n) => {
          const i = p.kept[n]!;
          const [x, y] = r.pin;
          const free = (k: number) => {
            const [kx, ky] = xyOf(k, W);
            const t = painted.get(k);
            const dais = p.daises.get(i);
            const onDais = dais !== undefined && kx >= dais.rect.x && kx < dais.rect.x + dais.rect.w && ky >= dais.rect.y && ky < dais.rect.y + dais.rect.h;
            return t !== undefined && !["water", "pit", "pillar"].includes(t) && !onDais;
          };
          assert.ok(free(y * W + x), `${seed}: room ${i}'s pin on ${painted.get(y * W + x) ?? "rock"}`);
          if (r.ground === 0) assert.ok(!raised.has(`${x},${y}`), `${seed}: a pin on a dais`);
          const d = (kx: number, ky: number) => (2 * kx + 1 - (2 * r.x + r.w)) ** 2 + (2 * ky + 1 - (2 * r.y + r.h)) ** 2;
          for (let yy = r.y; yy < r.y + r.h; yy++) for (let xx = r.x; xx < r.x + r.w; xx++) if (free(yy * W + xx)) assert.ok(d(xx, yy) >= d(x, y), `${seed}: ${xx},${yy} is nearer room ${i}'s middle than its pin`);
        });
      }
    }
  });

  test("doors name the rooms they lead to, the stub the map's edge, secret and locked ones as they are, a cave's as open", () => {
    for (const theme of ["dungeon", "cave"] as const) {
      for (const { p, seed } of samples(190, 10, { theme, secrets: 4, w: 70, h: 70, rooms: 20 })) {
        const W = p.plan.w;
        const numbers = numberRooms(p.links, p.kept, p.entrance);
        const states = new Map(p.plan.doors.map((d) => [d.edge, d.state]));
        for (const kr of p.plan.key!) {
          const i = p.kept[kr.room]!;
          assert.equal(numbers.get(i), kr.n);
          const doorways = p.board.doorways.filter((d) => !d.removed && d.room === i);
          assert.equal(kr.doors.length, doorways.length, `${seed}: room ${kr.n}'s doors`);
          for (const d of doorways) {
            const link = d.link >= 0 ? p.links[d.link]! : null;
            const to = link ? numbers.get(link.a === i ? link.b : link.a)! : "edge";
            const k = d.inside[0]!;
            const state = theme === "cave" ? "open" : states.get(doorEdge(k % W, Math.floor(k / W), d.side));
            assert.ok(kr.doors.some((kd) => kd.side === d.side && kd.to === to && kd.state === state), `${seed}: room ${kr.n} lacks its ${d.side} door to ${to}, ${state}`);
          }
          assert.equal(kr.secret === true, p.plan.rooms[kr.room]!.secret === true);
        }
      }
    }
  });

  test("each room's traps, light, dais, pit and cistern are its own, and its trinket an SRD line drawn without repeats", () => {
    for (const theme of ["dungeon", "sewer", "mine"] as const) {
      for (const { p, s, seed } of samples(200 + theme.length, 10, { theme, traps: 6, lit: 50, w: 70, h: 70, rooms: 20 })) {
        const W = p.plan.w;
        const key = p.plan.key!;
        const trinkets = key.map((k) => k.trinket);
        assert.equal(new Set(trinkets).size, trinkets.length, `${seed}: a trinket twice`);
        for (const t of trinkets) assert.ok(Number.isInteger(t) && t >= 0 && t < TRINKET_LINES);
        const named = key.flatMap((k) => k.traps).length;
        const inRooms = p.plan.traps.filter((t) => ("cells" in t.zone ? p.board.roomAt[t.zone.cells[0]!.y * W + t.zone.cells[0]!.x] !== 0 : "door" in t.zone)).length;
        assert.equal(named, inRooms, `${seed}: ${named} traps named of ${inRooms} in rooms`);
        for (const k of key) {
          const i = p.kept[k.room]!;
          for (const name of k.traps) assert.ok(p.plan.traps.some((t) => trapPreset(t.preset, s.band)!.name === name));
          const r = p.board.rooms[i]!;
          const lit = p.plan.lights.find((l) => Math.floor(l.x) >= r.x && Math.floor(l.x) < r.x + r.w && Math.floor(l.y) >= r.y && Math.floor(l.y) < r.y + r.h);
          assert.equal(k.light, lit?.label);
          assert.equal(k.dais === true, p.daises.has(i));
          assert.equal(k.cistern === true, p.cisterns.has(i));
          const pit = (p.plan.paint.pit ?? []).some((c) => {
            const [x, y] = c.split(",").map(Number) as [number, number];
            return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
          });
          assert.equal(k.pit === true, pit);
        }
      }
    }
  });

  test("DM key off holds no key, and no plan holds its seed", () => {
    for (const { p, seed } of samples(210, 10, { key: false })) {
      assert.equal(p.plan.key, null);
      assert.ok(!JSON.stringify(p.plan).includes(seed));
    }
    for (const { p, seed } of samples(211, 10, { key: true })) assert.ok(!JSON.stringify(p.plan).includes(seed));
  });
});

describe("the key's corridor traps (LP33-B-KEY-1)", () => {
  test("a trap no room holds is named by the rooms its corridor joins, the way in's stub by the map's edge, a dead end by its name, in the order of those rooms", () => {
    const numbers = new Map([[0, 1], [2, 2], [5, 3]]);
    const links = [{ kind: "tree" as const, a: 0, b: 5 }, { kind: "tree" as const, a: 0, b: 2 }];
    const named = corridorTraps({
      traps: [
        { name: "Pit", squares: [1], inRoom: true },
        { name: "Collapsing Roof", squares: [31], inRoom: false },
        { name: "Net", squares: [11], inRoom: false },
        { name: "Poisoned Darts", squares: [21], inRoom: false },
        { name: "Rolling Stone", squares: [41], inRoom: false },
        { name: "Hidden", squares: [99], inRoom: false },
      ],
      links,
      paths: [[30, 31, 32], [10, 11]],
      stubPath: [20, 21],
      entrance: 0,
      spurPaths: [[40, 41]],
      numbers,
    });
    assert.deepEqual(named, [
      { name: "Net", between: [1, 2] },
      { name: "Collapsing Roof", between: [1, 3] },
      { name: "Poisoned Darts", between: [1, "edge"] },
      { name: "Rolling Stone", between: "deadEnd" },
      { name: "Hidden", between: null },
    ]);
  });

  test("every generated trap is named once, in its room or in the corridors, and the plan holds the corridor ones only with DM key on", () => {
    let corridors = 0;
    for (const { p, seed } of samples(190, 25, { w: 60, h: 60, rooms: 16, traps: 6 })) {
      const inRooms = p.plan.key!.reduce((n, k) => n + k.traps.length, 0);
      const named = p.plan.corridorTraps ?? [];
      corridors += named.length;
      assert.equal(inRooms + named.length, p.plan.traps.length, `${seed}: a trap missing from the key`);
      for (const t of named) assert.ok(t.between === "deadEnd" || t.between === null || t.between[0] >= 1, `${seed}: ${t.name}`);
    }
    assert.ok(corridors > 0, "the samples held no trap in a corridor");
    for (const { p } of samples(190, 6, { w: 60, h: 60, rooms: 16, traps: 6, key: false })) assert.equal(p.plan.corridorTraps, undefined);
  });
});
