import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { lift } from "../discoveryTestutil.ts";
import { MAP_DISCOVERY_OP_VERSION } from "../migrate.ts";
import type { LogEvent, RoomState } from "../model.ts";
import { cellVision } from "../perPlayerTestutil.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { visionRules } from "../ruleHooks.ts";
import { DM, P1, P2, entry, env, member, room, template, token } from "../testutil.ts";

/**
 * Area reminders by each receiver's live ground (docs/design-v1-map-discovery.md
 * decision 13): a player reads a reminder only when every ray its
 * inclusion test reads, from where the area starts to the creature, lies
 * on their sight or the DM's reveals, or on revealed ground with fog on and
 * vision off. Sight is perPlayerTestutil.ts's stub: in the dark each
 * creature sees one cell around it.
 */
const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

/** A goblin's turn at (12, 5) inside a DM's Cloudkill centered on cell (8, 5), on a scene with fog on. */
function fight(vision?: "dark"): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true, ...(vision ? { vision: { on: true, light: vision } } : {}) };
  s.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 12, y: 5 });
  s.templates.cloud = template("cloud", { size: 40, origin: { x: 8.5, y: 5.5, z: 0 }, spell: "Cloudkill", ownerId: "dm1", triggers: ["turnEnd"] });
  s.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 })] };
  return s;
}

/** Ends the goblin's turn and returns the reminder written, and the state. */
function turnEnd(s: RoomState, opVersion?: number): { reminder: LogEvent | undefined; state: RoomState } {
  const r = applyOp(s, { t: "encounter.next" } as Op, DM, { ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return { reminder: r.log.find((e) => e.data?.type === "area")?.data, state: r.state };
}

function reads(state: RoomState, who = P1): boolean {
  return projectState(state, who, { sceneId: "s1" }).log.some((e) => e.data?.type === "area");
}

describe("an area's reminder by the receiver's live ground (decision 13)", () => {
  test("an area aimed past unrevealed ground, nothing moving: no reminder for players, revealed whole it reaches them", () => {
    const open = fight();
    lift(open, "dm", { x: 0, y: 0, w: 24, h: 16 });
    const seen = turnEnd(open);
    assert.equal(seen.reminder?.type === "area" && seen.reminder.hidden, undefined);
    assert.ok(reads(seen.state), "on revealed ground every player reads it");
    // One cell between the cloud's middle and the goblin left under fog: a wall the DM never revealed may stand there.
    const gap = fight();
    lift(gap, "dm", { x: 0, y: 0, w: 24, h: 16 });
    lift(gap, "dm", { x: 10, y: 5, w: 1, h: 1 }, "s1", false);
    const hidden = turnEnd(gap);
    assert.equal(hidden.reminder?.type === "area" && hidden.reminder.hidden, true);
    assert.equal(reads(hidden.state), false);
  });

  test("an 8 x 8 revealed room around the cloud and a goblin against its far side: the goblin's own edge does not count, the room's does", () => {
    const s = fight();
    s.tokens.g1 = { ...s.tokens.g1!, x: 11, y: 5 };
    lift(s, "dm", { x: 5, y: 2, w: 7, h: 8 });
    // The goblin's cell is the room's last column: the ground past its east side stays under fog.
    assert.ok(reads(turnEnd(s).state), "rays end inside the footprint, short of the cells beside it");
    const short = fight();
    short.tokens.g1 = { ...short.tokens.g1!, x: 11, y: 5 };
    lift(short, "dm", { x: 5, y: 2, w: 6, h: 8 });
    assert.equal(reads(turnEnd(short).state), false, "the goblin's own cell under fog");
  });

  test("ops from before map discovery replay with the reminders they wrote", () => {
    const gap = fight();
    lift(gap, "dm", { x: 0, y: 0, w: 24, h: 16 });
    lift(gap, "dm", { x: 10, y: 5, w: 1, h: 1 }, "s1", false);
    const old = turnEnd(gap, MAP_DISCOVERY_OP_VERSION - 1);
    assert.equal(old.reminder?.type === "area" && old.reminder.hidden, undefined);
  });

  test("with vision on, ground the party only explored does not carry a reminder, ground in its sight does", () => {
    const s = fight("dark");
    lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
    // The scout sees cells 10 to 12 of row 5, the goblin's among them.
    s.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 11, y: 5 });
    const explored = turnEnd(s);
    assert.equal(reads(explored.state), false, "the cloud's middle and the cell after it only explored");
    lift(s, "dm", { x: 8, y: 5, w: 2, h: 1 });
    assert.ok(reads(turnEnd(s).state), "the DM revealed cells 8 and 9");
  });

  test("per player: a witness of an area reads its reminder only by their own live ground", () => {
    const s = fight("dark");
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "dark", perPlayer: true } };
    s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
    // p1's scout sees cells 10 to 12 of row 5, p2's Bree the goblin's cell from the east, and the DM revealed cells 8 and 9.
    s.tokens.scout = token("scout", { kind: "pc", name: "Scout", disposition: "ally", ownerIds: ["p1"], x: 11, y: 5 });
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", disposition: "ally", ownerIds: ["p2"], x: 13, y: 5 });
    lift(s, "dm", { x: 8, y: 5, w: 2, h: 1 });
    // Sight is live only on ground its explore step has added to the explored layers, here all of it.
    lift(s, "party", { x: 0, y: 0, w: 24, h: 16 });
    const { reminder, state } = turnEnd(s);
    assert.ok(reminder?.type === "area");
    assert.ok(reads(state, P1), "the rays cross only ground p1 sees or the DM revealed");
    assert.equal(reads(state, P2), false, "p2 sees the goblin and the cloud, but not cells 10 and 11");
    const before = turnEnd(s, MAP_DISCOVERY_OP_VERSION - 1);
    assert.ok(reads(before.state, P2), "before map discovery the witness read it");
  });
});
