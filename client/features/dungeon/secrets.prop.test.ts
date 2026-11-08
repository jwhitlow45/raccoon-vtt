import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { holds } from "#shared/propertyTestutil.ts";
import { Board, doorEdge, type Doorway } from "./layout.ts";
import { planDungeon } from "./plan.ts";
import { paintedOf, samples } from "./plan.samples.ts";
import { Stream } from "./random.ts";
import { chooseSecrets, floodFrom, stillWhole, type Candidate } from "./secrets.ts";
import { CROCKFORD, versionChar, type Seed } from "./seed.ts";
import { clampSettings, roomCap, secretCount, SECRETS_MAX } from "./settings.ts";

/*
 * Secret doors and secret rooms (phase 2, 5.3, D-261107-204, 261): on loop
 * doorways and leaf rooms' only doorways, never the stub's, a locked door
 * or a doorway with a stair run, both edges of a Wide doorway, and only
 * while a flood with every secret door a wall still reaches every room but
 * the secret rooms, each of which it reaches through its own door.
 */

const seedArb: fc.Arbitrary<Seed> = fc.array(fc.constantFrom(...CROCKFORD), { minLength: 15, maxLength: 15 }).map((c) => versionChar() + c.join(""));
const settingsArb = fc
  .record({
    w: fc.integer({ min: 30, max: 100 }),
    h: fc.integer({ min: 30, max: 100 }),
    rooms: fc.integer({ min: 4, max: 40 }),
    density: fc.constantFrom("sparse", "normal", "dense"),
    corridors: fc.constantFrom("straight", "bending", "winding"),
    wide: fc.boolean(),
    loops: fc.boolean(),
    theme: fc.constantFrom("dungeon", "crypt", "mine", "sewer"),
    heights: fc.constantFrom(0, 25, 75),
    secrets: fc.integer({ min: 1, max: SECRETS_MAX }),
    deadEnds: fc.boolean(),
  } as const)
  .map((s) => clampSettings({ ...s, rooms: Math.min(s.rooms, roomCap(s.w, s.h)) }));

describe("secret doors", () => {
  test("never the stub's, a locked door or a doorway with a run, both of a Wide doorway's edges, at most the share, and the flood keeps every room", () => {
    holds(
      fc.property(settingsArb, seedArb, (s, seed) => {
        const p = planDungeon(s, seed);
        const W = p.plan.w;
        const states = new Map(p.plan.doors.map((d) => [d.edge, d.state]));
        assert.ok(p.secret.length <= secretCount(s.secrets, p.kept.length));
        for (const c of p.secret) {
          const d = c.doorway;
          assert.notEqual(d, p.stub, "the stub's doorway");
          assert.equal(d.run, null, "a doorway with a stair run");
          assert.ok(d.link >= 0);
          if (c.kind === "loop") assert.equal(p.links[d.link]!.kind, "loop");
          else {
            assert.notEqual(d.room, p.entrance);
            assert.equal(p.board.doorways.filter((o) => !o.removed && o.room === d.room).length, 1, "a leaf room has one doorway");
          }
          // Every edge of the doorway is the secret door: never locked, never one edge of two.
          for (const k of d.inside) assert.equal(states.get(doorEdge(k % W, Math.floor(k / W), d.side)), "secret");
        }
        // Doors are drawn before secret doors, so the same plan without them shows each secret doorway's door was closed, never locked.
        if (p.secret.length > 0) {
          const plain = new Map(planDungeon({ ...s, secrets: 0 }, seed).plan.doors.map((d) => [d.edge, d.state]));
          for (const c of p.secret) for (const k of c.doorway.inside) assert.equal(plain.get(doorEdge(k % W, Math.floor(k / W), c.doorway.side)), "closed", "a locked door turned secret");
        }
        // The plan's own secret edges are exactly the chosen doorways'.
        const edges = p.secret.flatMap((c) => c.doorway.inside.map((k) => doorEdge(k % W, Math.floor(k / W), c.doorway.side)));
        assert.deepEqual(p.plan.doors.filter((d) => d.state === "secret").map((d) => d.edge).sort(), edges.sort());
        // Secret rooms are the leaf kind's rooms.
        const secretRooms = new Set(p.secret.flatMap((c) => (c.kind === "leaf" ? [c.doorway.room] : [])));
        assert.deepEqual(p.plan.rooms.flatMap((r, i) => (r.secret ? [p.kept[i]] : [])).sort(), [...secretRooms].sort());
        const painted = paintedOf(p);
        assert.ok(stillWhole(p.board, (k) => painted.has(k), p.entrance, p.kept, p.secret));
      }),
      40,
    );
  });

  test("the flood with every secret door a wall reaches every room but the secret rooms, and each secret room through its own door", () => {
    let rooms = 0;
    for (const { p, seed } of samples(81, 25, { secrets: 6, w: 80, h: 80, rooms: 30 })) {
      const painted = paintedOf(p);
      const isPainted = (k: number) => painted.has(k);
      const walls = p.secret.map((c) => c.doorway);
      const all = floodFrom(p.board, isPainted, p.entrance, walls);
      const reached = (seen: Uint8Array, i: number) => {
        const r = p.board.rooms[i]!;
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (seen[p.board.cell(x, y)] === 1) return true;
        return false;
      };
      for (const i of p.kept) {
        const secret = p.secret.find((c) => c.kind === "leaf" && c.doorway.room === i);
        if (!secret) {
          assert.ok(reached(all, i), `${seed}: room ${i} cut off`);
          continue;
        }
        rooms++;
        assert.ok(!reached(all, i), `${seed}: secret room ${i} reached without its door`);
        assert.ok(reached(floodFrom(p.board, isPainted, p.entrance, walls.filter((d) => d !== secret.doorway)), i), `${seed}: secret room ${i} not reached through its door`);
      }
    }
    assert.ok(rooms > 20, `${rooms} secret rooms`);
  });

  test("a candidate that would cut a room off is refused: walling a tree link's way into a room with rooms past it, unless corridors join round it", () => {
    let refused = 0;
    let kept = 0;
    for (const { p } of samples(82, 20, { secrets: 0, loops: false, w: 70, h: 70, rooms: 20 })) {
      const W = p.plan.w;
      const painted = paintedOf(p);
      for (const d of p.board.doorways) {
        if (d.removed || d.link < 0 || d.room !== p.links[d.link]!.b) continue;
        if (!p.links.some((l) => l.kind === "tree" && l.a === d.room && !p.board.rooms[l.b]!.dropped)) continue;
        // The walk the generator's flood must agree with, written apart from it: painted squares, every edge but the doorway's.
        const walled = new Set(d.inside.map((k, j) => `${k},${d.outside[j]}`));
        const r0 = p.board.rooms[p.entrance]!;
        const seen = new Set<number>();
        for (let y = r0.y; y < r0.y + r0.h; y++) for (let x = r0.x; x < r0.x + r0.w; x++) if (painted.has(y * W + x)) seen.add(y * W + x);
        const queue = [...seen];
        while (queue.length > 0) {
          const k = queue.pop()!;
          for (const n of [k - 1, k + 1, k - W, k + W]) {
            if (n < 0 || seen.has(n) || !painted.has(n) || Math.abs((n % W) - (k % W)) > 1 || walled.has(`${k},${n}`) || walled.has(`${n},${k}`)) continue;
            seen.add(n);
            queue.push(n);
          }
        }
        const whole = p.kept.every((i) => {
          const r = p.board.rooms[i]!;
          for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (seen.has(y * W + x)) return true;
          return false;
        });
        assert.equal(stillWhole(p.board, (k) => painted.has(k), p.entrance, p.kept, [{ doorway: d, kind: "loop" } satisfies Candidate]), whole);
        if (whole) kept++;
        else refused++;
      }
    }
    assert.ok(refused > 20, `${refused} branch doorways refused, ${kept} kept where corridors join round them`);
  });

  test("a secret room is whole only when its own door opens onto ground the entrance reaches", () => {
    // Room A, the entrance, and room B joined by one corridor along row 3. With A's door secret too, B's door opens onto a corridor nobody reaches.
    const board = new Board(20, 10, [
      { x: 2, y: 2, w: 3, h: 3 },
      { x: 12, y: 2, w: 3, h: 3 },
    ]);
    const W = 20;
    const door = (id: number, room: number, side: "e" | "w", inside: number, outside: number): Doorway => ({ id, room, side, at: 1, width: 1, inside: [inside], outside: [outside], link: 0, run: null, flat: null, removed: false });
    const a = door(0, 0, "e", 3 * W + 4, 3 * W + 5);
    const b = door(1, 1, "w", 3 * W + 12, 3 * W + 11);
    const corridor = new Set([5, 6, 7, 8, 9, 10, 11].map((x) => 3 * W + x));
    const painted = (k: number) => board.roomAt[k] !== 0 || corridor.has(k);
    assert.equal(stillWhole(board, painted, 0, [0, 1], [{ doorway: b, kind: "leaf" }]), true);
    assert.equal(stillWhole(board, painted, 0, [0, 1], [{ doorway: a, kind: "loop" }]), false, "B cut off");
    assert.equal(stillWhole(board, painted, 0, [0, 1], [{ doorway: a, kind: "loop" }, { doorway: b, kind: "leaf" }]), false, "B's door opens onto ground nobody reaches");
  });

  test("a candidate the flood refuses is never chosen, and the draw goes on to the next", () => {
    const fake = (id: number, kind: "loop" | "leaf"): Candidate => ({ doorway: { id } as Doorway, kind });
    const candidates = [fake(0, "loop"), fake(1, "loop"), fake(2, "leaf"), fake(3, "leaf"), fake(4, "loop")];
    for (let label = 0; label < 20; label++) {
      const key = new Uint8Array(32);
      key[0] = label;
      const chosen = chooseSecrets(new Stream(key, new Uint8Array(12)), candidates, 3, (set) => !set.some((c) => c.doorway.id === 1 || c.doorway.id === 2));
      assert.equal(chosen.length, 3);
      assert.ok(chosen.every((c) => c.doorway.id !== 1 && c.doorway.id !== 2), "a refused candidate was kept");
    }
  });

  test("both kinds are chosen, and caves and None have none", () => {
    const kinds = new Set(samples(83, 20, { secrets: 4, w: 80, h: 80, rooms: 30 }).flatMap(({ p }) => p.secret.map((c) => c.kind)));
    assert.deepEqual([...kinds].sort(), ["leaf", "loop"]);
    for (const { p } of samples(84, 10, { theme: "cave", secrets: 6 })) assert.equal(p.secret.length, 0);
    for (const { p } of samples(85, 10, { secrets: 0 })) assert.equal(p.secret.length, 0);
  });
});
