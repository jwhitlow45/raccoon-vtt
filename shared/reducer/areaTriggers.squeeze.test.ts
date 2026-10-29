import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights, lift, wall } from "../discoveryTestutil.ts";
import type { LogEvent, RoomState } from "../model.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, entry, env, member, P1, room, scene, template, token } from "../testutil.ts";

/**
 * A squeezing walker's own area line (live play LP25-A-AREA-1,
 * D-261029-59 revised): it is judged by the walker's full footprint at
 * every op version. Whether a walk squeezes is the narrow space's to say,
 * walls under the fog among them, so reading the line by the squares a
 * walker squeezes onto let walls no player had seen decide whether a player
 * read it (reviews FU36-DATA-01 and FU36-ASTRA-01). Two rooms whose players
 * start with the same copy, one with walls under the fog, must give the
 * players the same lines.
 */

const VERSIONS = [29, 30, undefined] as const;

function sceneRoom(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off", fogEnabled: true }) } });
  s.buildChunks = {};
  s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"] });
  s.encounter = { rev: 0, round: 1, activeEntryId: "e-horse", entries: [entry("e-horse", { tokenId: "horse", value: 15 })] };
  return s;
}

/** Rock from x 8 to 16 but for a corridor along row 10, walled round, each wall at most 8 squares long, the hall, the corridor and the room past it revealed, a cloud in the corridor. */
function corridor(): RoomState {
  const s = sceneRoom();
  const runs: [[number, number], [number, number]][] = [
    ...[8, 16].flatMap((x): [[number, number], [number, number]][] => [[[x, 0], [x, 5]], [[x, 5], [x, 10]], [[x, 11], [x, 16]], [[x, 16], [x, 20]]]),
    [[8, 10], [16, 10]],
    [[8, 11], [16, 11]],
  ];
  runs.forEach(([a, b], i) => wall(s, `fu36ar${String(i).padStart(6, "0")}`, a, b));
  lift(s, "dm", { x: 0, y: 0, w: 8, h: 20 });
  lift(s, "dm", { x: 8, y: 10, w: 8, h: 1 });
  lift(s, "dm", { x: 16, y: 0, w: 14, h: 20 });
  s.templates.cloud = template("cloud", { size: 5, origin: { x: 12.5, y: 10.5, z: 0 }, spell: "Stinking Cloud", ownerId: "dm1", triggers: ["enter"] });
  return s;
}

/** Along the hall's row in line with the corridor, through the corridor squeezed, and out into the room. */
const THROUGH: Op = { t: "token.move", tokenId: "horse", x: 18, y: 9, route: [[7.5, 9.5, 0, 0], [15.5, 9.5, 0, 0], [18, 9, 0, 0]] };

function moved(s: RoomState, op: Op, opVersion: number | undefined): { line: Extract<LogEvent, { type: "area" }> | undefined; state: RoomState } {
  const r = applyOp(s, op, DM, { ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.message);
  const line = r.log.map((e) => e.data).find((d): d is Extract<LogEvent, { type: "area" }> => d?.type === "area" && d.tokenId === "horse");
  return { line, state: r.state };
}

/** The area lines Pat's copy holds. */
function patReads(state: RoomState): string[] {
  return projectState(state, P1, { sceneId: "s1" }).log.flatMap((e) => (e.data?.type === "area" ? [`${e.data.tokenId} ${e.data.trigger}`] : []));
}

/** Two rooms Pat starts with the same copy of, the same walk in each: Pat reads the same lines after it at every op version. */
function samePair(open: RoomState, walled: RoomState, op: Op): void {
  assert.equal(stableStringify(projectState(walled, P1, { sceneId: "s1" })), stableStringify(projectState(open, P1, { sceneId: "s1" })), "Pat's copies start the same");
  for (const opVersion of VERSIONS) {
    const a = moved(structuredClone(open), op, opVersion);
    const b = moved(structuredClone(walled), op, opVersion);
    assert.ok(a.line, `op ${opVersion ?? "live"}: the warhorse entered the area`);
    assert.deepEqual(patReads(b.state), patReads(a.state), `op ${opVersion ?? "live"}: the walls under the fog decide nothing Pat reads`);
  }
}

/** Only row 10 revealed, a cloud in it, and in the second room walls under the fog either side that make a narrow space of it (review FU36-ASTRA-01). */
function rowPair(): [RoomState, RoomState] {
  const open = sceneRoom();
  lift(open, "dm", { x: 0, y: 10, w: 30, h: 1 });
  open.templates.cloud = template("cloud", { size: 5, origin: { x: 12.5, y: 10.5, z: 0 }, spell: "Stinking Cloud", ownerId: "dm1", triggers: ["enter"] });
  const walled = structuredClone(open);
  wall(walled, "fu36aw000001", [9, 9.75], [15, 9.75]);
  wall(walled, "fu36aw000002", [9, 11.25], [15, 11.25]);
  return [open, walled];
}

/** A corridor between ledges 5 ft up, the corridor and the halls revealed, a line across it, and in the second room a wall under the fog beside it (review FU36-DATA-01). */
function ledgePair(): [RoomState, RoomState] {
  const open = sceneRoom();
  open.meta = { ...open.meta, settings: { ...open.meta.settings, aoeCoverage: "center", aoeInclusion: "anyCell" } };
  heights(open, { x: 8, y: 9, w: 8, h: 1 }, 5);
  heights(open, { x: 8, y: 11, w: 8, h: 1 }, 5);
  lift(open, "dm", { x: 0, y: 0, w: 8, h: 20 });
  lift(open, "dm", { x: 8, y: 10, w: 8, h: 1 });
  lift(open, "dm", { x: 16, y: 0, w: 14, h: 20 });
  open.templates.line = template("line", { shape: "line", size: 10, width: 5, yaw: 135, origin: { x: 12.5, y: 10.5, z: 0 }, label: "Line", ownerId: "dm1", triggers: ["enter"] });
  const walled = structuredClone(open);
  wall(walled, "fu36aw000003", [10, 11.125], [12, 11.125]);
  return [open, walled];
}

const INTO_LEDGES: Op = { t: "token.move", tokenId: "horse", x: 10.5, y: 9.5, squeeze: true, route: [[7.5, 9.5, 0, 0], [10.5, 9.5, 0, 0]] };

describe("a squeezing walker's own area line, by its full footprint (LP25-A-AREA-1, D-261029-59 revised)", () => {
  test("the warhorse squeezing through the cloud in the corridor: its full footprint reaches the rock beside the corridor, so its line is the DM's at every op version", () => {
    for (const opVersion of VERSIONS) {
      const { line, state } = moved(corridor(), THROUGH, opVersion);
      assert.ok(line, "the warhorse entered the cloud");
      assert.equal(line.hidden, true, `op ${opVersion ?? "live"}`);
      assert.deepEqual(patReads(state), []);
    }
  });

  test("walls under the fog either side of a revealed row decide nothing Pat reads of a Large walker through a cloud there (review FU36-ASTRA-01)", () => {
    const [open, walled] = rowPair();
    samePair(open, walled, THROUGH);
  });

  test("a wall under the fog beside a squeeze between ledges decides nothing Pat reads of a line the warhorse enters (review FU36-DATA-01)", () => {
    const [open, walled] = ledgePair();
    samePair(open, walled, INTO_LEDGES);
  });
});
