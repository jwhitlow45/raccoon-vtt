import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stampCells } from "#shared/project.ts";
import { doorKey, editLayout, editsHold, REPORTS, type DungeonEdits, type RoomEdit } from "./edits.ts";
import { NEW_SCENE } from "./fit.ts";
import { planDungeon, planFitted, type Planned } from "./plan.ts";
import { clampSettings, DEFAULT_SETTINGS, MAX_SECRET_DOORS, type DungeonSettings } from "./settings.ts";
import { FIRE_STATUE, HIDDEN_PIT, STATUE_STAMP } from "./trapSpots.ts";

/*
 * Per-room edits (phase 3, section 4): they freeze the layout they were
 * made on, height and door pins go into the pipeline, and trap, Lit and
 * dressing pins reconcile after it over the room's whole contents, each
 * checked against every allowance, with a report for what did not take.
 */

const CTX = { feetPerCell: 5 };
const edited = (s: DungeonSettings, seed: string, base: Planned, rooms: Record<number, RoomEdit>): DungeonEdits => ({ layout: editLayout(s, seed, base.fitted, null), rooms });

describe("edits freeze the layout", () => {
  test("round 2's seed: 15 placed and 9 kept of 24 asked, and an edited room stays the same room on every replan", () => {
    const seed = "900000000000000Z";
    const s = clampSettings({ ...DEFAULT_SETTINGS, w: 50, h: 57, rooms: 24, wide: true, density: "dense", corridors: "winding", heights: 75 });
    const base = planFitted(s, seed, CTX);
    assert.equal(base.board.rooms.length, 15);
    assert.equal(base.kept.length, 9);
    assert.equal(base.fitted, 24, "fitted is the count asked of placeRooms, not the rooms kept");
    for (const i of base.kept) {
      const again = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [i]: { lit: true, dressing: "full" } }) });
      const [was, now] = [base.board.rooms[i]!, again.board.rooms[i]!];
      assert.deepEqual([now.x, now.y, now.w, now.h], [was.x, was.y, was.w, was.h], `room ${i} stays put`);
      assert.ok(again.facts.find((f) => f.room === i)!.lit);
    }
  });

  test("edits made on other choices, another seed or another base are left out", () => {
    const s = clampSettings({ ...DEFAULT_SETTINGS, traps: 4 });
    const seed = "1K7QH2MXA9F3TWQ5";
    const base = planFitted(s, seed, CTX);
    const room = base.kept.find((i) => i !== base.entrance)!;
    const edits = edited(s, seed, base, { [room]: { lit: !base.facts.find((f) => f.room === room)!.lit } });
    assert.ok(editsHold(edits, s, seed, null));
    assert.ok(!editsHold(edits, { ...s, theme: "crypt" }, seed, null));
    assert.ok(!editsHold(edits, s, "1Q8V2DR4HJ0Y7ZB3", null));
    assert.ok(!editsHold(edits, s, seed, "a-base"));
    const other = planFitted({ ...s, dressing: "full" }, seed, CTX, { edits });
    assert.equal(other.facts.find((f) => f.room === room)!.lit, base.facts.find((f) => f.room === room)!.lit, "the pin is not applied");
  });
});

describe("trap, Lit and dressing pins", () => {
  const seed = "9000000000000000";
  const s = clampSettings({ ...DEFAULT_SETTINGS, theme: "crypt", traps: 6, dressing: "full", lit: 50, key: true, w: 60, h: 60, rooms: 16 });
  const base = planFitted(s, seed, CTX);
  const statueRoom = base.facts.find((f) => f.trap === FIRE_STATUE)!;
  const keyOf = (p: Planned, i: number) => p.plan.key!.find((k) => k.room === p.kept.indexOf(i))!;

  test("a statue trap replaced by a pit takes its statue stamp and its name in the key with it", () => {
    assert.ok(statueRoom, "the fixture holds a statue");
    assert.ok(base.plan.stamps.some((st) => st.key === STATUE_STAMP.key));
    const p = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [statueRoom.room]: { trap: HIDDEN_PIT } }) });
    const fact = p.facts.find((f) => f.room === statueRoom.room)!;
    assert.equal(fact.trap, HIDDEN_PIT);
    assert.equal(p.plan.stamps.filter((st) => st.key === STATUE_STAMP.key).length, base.plan.stamps.filter((st) => st.key === STATUE_STAMP.key).length - 1, "the statue stamp goes");
    assert.deepEqual(keyOf(p, statueRoom.room).traps, ["Hidden Pit"]);
    assert.equal(p.plan.traps.length, base.plan.traps.length);
  });

  test("None removes the trap and what it owns and puts none back, and Lit Off takes the light, its stamp and its label", () => {
    const lit = base.facts.find((f) => f.lit && f.room !== statueRoom.room)!;
    const p = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [statueRoom.room]: { trap: null }, [lit.room]: { lit: false } }) });
    assert.equal(p.facts.find((f) => f.room === statueRoom.room)!.trap, null);
    assert.equal(p.plan.traps.length, base.plan.traps.length - 1);
    assert.deepEqual(keyOf(p, statueRoom.room).traps, []);
    const statues = (q: Planned) => q.plan.stamps.filter((st) => st.key === STATUE_STAMP.key).length;
    assert.equal(statues(p), statues(base) - 1, "its statue stamp goes");
    assert.equal(p.facts.find((f) => f.room === lit.room)!.lit, false);
    assert.equal(p.plan.lights.length, base.plan.lights.length - 1);
    assert.equal(keyOf(p, lit.room).light, undefined);
    const lightStamp = base.plan.lights.find((l) => !p.plan.lights.some((q) => q.x === l.x && q.y === l.y))!;
    assert.ok(!p.plan.stamps.some((st) => st.key === lightStamp.stamp && st.x === lightStamp.x && st.y === lightStamp.y), "its stamp goes");
  });

  test("Lit On puts the theme's light at the room's edge square nearest a corner, and a prop under it goes", () => {
    const dark = base.facts.find((f) => !f.lit && f.room !== base.entrance)!;
    const p = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [dark.room]: { lit: true } }) });
    assert.ok(p.facts.find((f) => f.room === dark.room)!.lit);
    assert.equal(p.plan.lights.length, base.plan.lights.length + 1);
    const light = p.plan.lights.find((l) => !base.plan.lights.some((q) => q.x === l.x && q.y === l.y))!;
    const r = p.board.rooms[dark.room]!;
    const [x, y] = [light.x - 0.5, light.y - 0.5];
    assert.ok(x === r.x || y === r.y || x === r.x + r.w - 1 || y === r.y + r.h - 1, "against the room's edge");
    for (const st of p.plan.stamps.filter((st) => st.key !== light.stamp)) {
      const box = stampCells(st);
      assert.ok(!(box.x0 <= x && x < box.x1 && box.y0 <= y && y < box.y1), "no prop under the light");
    }
    assert.deepEqual(keyOf(p, dark.room).light, "Candelabra");
  });

  test("Dressing redraws the room's props from its own stream, Other props draws again, and no other room's props move", () => {
    const room = base.kept.find((i) => i !== base.entrance && i !== statueRoom.room)!;
    // Props alone: the light's picture and a statue are not dressing.
    const props = (p: Planned, i: number) =>
      JSON.stringify(p.plan.stamps.filter((st) => st.key !== "ph-candelabra" && st.key !== STATUE_STAMP.key && p.board.roomAt[Math.floor(st.y - 0.25) * p.board.W + Math.floor(st.x - 0.25)] === i + 1));
    const a = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [room]: { dressing: "full", propsDraw: 1 } }) });
    const b = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [room]: { dressing: "full", propsDraw: 2 } }) });
    assert.notEqual(props(a, room) + props(b, room), props(base, room) + props(base, room), "the room's props are drawn again");
    for (const other of base.kept.filter((i) => i !== room)) {
      assert.equal(props(a, other), props(base, other), `room ${other}'s props stay`);
      assert.equal(props(b, other), props(base, other), `room ${other}'s props stay`);
    }
    const none = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [room]: { dressing: "none" } }) });
    assert.equal(props(none, room), "[]");
  });

  test("a pin past an allowance is not made: the sixth trap of a wing with five left", () => {
    const allowance = { ...NEW_SCENE, traps: 5 };
    const capped = planDungeon(s, seed, CTX, undefined, { allowance });
    assert.equal(capped.plan.traps.length, 5);
    const empty = capped.facts.find((f) => f.trap === null && f.traps.includes(HIDDEN_PIT))!;
    const pinned = planDungeon(s, seed, CTX, undefined, { allowance, edits: { [empty.room]: { trap: HIDDEN_PIT } } });
    assert.equal(pinned.plan.traps.length, 5);
    assert.equal(pinned.facts.find((f) => f.room === empty.room)!.trap, null);
    assert.deepEqual(pinned.reports.get(empty.room), [REPORTS.noRoom("trap")]);
  });

  test("a room that is gone, and a door that is gone, are reported", () => {
    const p = planDungeon(s, seed, CTX, undefined, { edits: { 999: { lit: true }, [statueRoom.room]: { doors: { "77": "locked" } } } });
    assert.deepEqual(p.reports.get(999), [REPORTS.roomGone]);
    assert.deepEqual(p.reports.get(statueRoom.room), [REPORTS.doorGone]);
  });
});

describe("height and door pins", () => {
  const seed = "1K7QH2MXA9F3TWQ5";
  const s = clampSettings({ ...DEFAULT_SETTINGS, heights: 0, secrets: 2 });
  const base = planFitted(s, seed, CTX);

  test("a height pin raises its room or reports it flat, and the entrance takes none", () => {
    for (const i of base.kept) {
      const p = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [i]: { ground: 10 } }) });
      const ground = p.board.rooms[i]!.ground;
      if (i === base.entrance) assert.equal(ground, 0);
      else assert.ok(ground === 10 || (ground === 0 && p.reports.get(i)?.includes(REPORTS.flat)), `room ${i}: ${ground}`);
    }
  });

  test("a Closed pin on a door the share picks keeps it closed, and Locked locks one", () => {
    const secret = base.facts.flatMap((f) => f.doors.filter((d) => d.state === "secret").map((d) => ({ room: f.room, key: d.key })))[0]!;
    assert.ok(secret, "the fixture draws a secret door");
    const closed = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [secret.room]: { doors: { [secret.key]: "closed" } } }) });
    assert.equal(closed.facts.find((f) => f.room === secret.room)!.doors.find((d) => d.key === secret.key)!.state, "closed");
    const plain = base.facts.flatMap((f) => f.doors.filter((d) => d.state === "closed").map((d) => ({ room: f.room, key: d.key })))[0]!;
    const locked = planFitted(s, seed, CTX, { edits: edited(s, seed, base, { [plain.room]: { doors: { [plain.key]: "locked" } } }) });
    assert.equal(locked.facts.find((f) => f.room === plain.room)!.doors.find((d) => d.key === plain.key)!.state, "locked");
  });

  test("a Secret pin applies with Secret doors None, and one that would cut a room off or climb stairs is reported", () => {
    const none = clampSettings({ ...s, secrets: 0, heights: 75 });
    const flat = planFitted(none, seed, CTX);
    assert.ok(flat.facts.every((f) => f.doors.every((d) => d.state !== "secret")));
    const may = flat.facts.flatMap((f) => f.doors.filter((d) => d.secretOk === null).map((d) => ({ room: f.room, key: d.key })));
    assert.ok(may.length > 0);
    const one = planFitted(none, seed, CTX, { edits: edited(none, seed, flat, { [may[0]!.room]: { doors: { [may[0]!.key]: "secret" } } }) });
    assert.equal(one.facts.find((f) => f.room === may[0]!.room)!.doors.find((d) => d.key === may[0]!.key)!.state, "secret");
    // Every door pinned secret at once: some would cut a room off, and each of those is reported.
    const all: Record<number, RoomEdit> = {};
    for (const f of flat.facts) all[f.room] = { doors: Object.fromEntries(f.doors.map((d) => [d.key, "secret"])) };
    const many = planFitted(none, seed, CTX, { edits: edited(none, seed, flat, all) });
    const lines = [...many.reports.values()].flat();
    assert.ok(lines.includes(REPORTS.secretBreaksReach));
    const stairs = flat.facts.find((f) => f.doors.some((d) => d.secretOk !== null && f.ground !== 0));
    if (stairs) assert.ok(lines.includes(REPORTS.secretOnStairs));
  });

  test("Secret pins and drawn secret doors stay within 12", () => {
    const big = clampSettings({ ...DEFAULT_SETTINGS, w: 100, h: 100, rooms: 40, secrets: 6 });
    const seed12 = "9000000000000000";
    const p = planFitted(big, seed12, CTX);
    const drawn = new Set(p.secret.map((c) => c.doorway.id)).size;
    assert.equal(drawn, MAX_SECRET_DOORS);
    const free = p.facts.flatMap((f) => f.doors.filter((d) => d.secretOk === null && d.state !== "secret").map((d) => ({ room: f.room, key: d.key })))[0]!;
    const pinned = planFitted(big, seed12, CTX, { edits: edited(big, seed12, p, { [free.room]: { doors: { [free.key]: "secret" } } }) });
    assert.notEqual(pinned.facts.find((f) => f.room === free.room)!.doors.find((d) => d.key === free.key)!.state, "secret");
    assert.ok(pinned.reports.get(free.room)?.includes(REPORTS.noRoom("secret door")));
  });

  test("a door's key is its link, and the way in's is stub", () => {
    assert.equal(doorKey(-1), "stub");
    assert.equal(doorKey(7), "7");
  });
});
