import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { heights, lift, wall } from "../discoveryTestutil.ts";
import { fileStandsSnapped, OP_VERSION, opMigrations, runMigrations } from "../migrate.ts";
import type { RoomState, Token } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { linkHolds } from "./attach.ts";
import { footprintRect } from "./footprint.ts";
import { SQUARES } from "./grid.ts";
import { planWalks } from "./moveLeg.ts";
import { planTrapMove, trapLandings } from "./traps.ts";
import { sceneWalls } from "./walls.ts";
import { DM, env, member, P1, P2, room, scene, token, trap } from "../testutil.ts";

/**
 * A creature in single file half a square off its grid can stop at a trap
 * on ground every player sees (TRAP-FILE-HALF-OFF, D-261107-178, migrate.ts
 * fileStandsSnapped). The file walks its holder's middle, so a Small goblin
 * behind a Large horse stood on no spot between the walk's ends, and a trap
 * stopped no such group there. From op version 52 each such spot is judged
 * at the goblin's own grid's spot beside it, toward where it stood when the
 * walk began, by op 35's stand test where everything that test reads lies
 * on ground every player sees, and the goblin stands there where the group
 * stops. Off that ground it is no stand, as before.
 */

const deps = { canUseAsset: () => true };
const versioned = (opVersion: number | undefined) => ({ ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
const net = () => ({ on: ["enter" as const], who: "any" as const, floor: true, resets: "never" as const, stops: true, foundOnSpring: true, hits: "trigger" as const, actions: [], find: [], notice: false });

/** Each token's place, height and holder after the op. */
const poses = (s: RoomState, ids: readonly string[]) => ids.map((id) => [s.tokens[id]!.x, s.tokens[id]!.y, s.tokens[id]!.elevation, s.tokens[id]!.attached?.to]);

/** Every player's copy of the scene. */
const copies = (s: RoomState) => [P1, P2].map((v) => stableStringify(projectState(s, v, { sceneId: "s1" })));

/** Dispatch puts each token where the trap step left it. */
function landsAsPlanned(s: RoomState, op: Op, after: RoomState, who = P1, opVersion?: number): void {
  for (const [id, pose] of trapLandings(op, s, who, opVersion === undefined ? {} : { opVersion })) {
    const t = after.tokens[id]!;
    assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `op ${opVersion}: ${id} where the trap step left it`);
  }
}

/**
 * The hidden horse of traps.hiddenLead.test.ts, Large, dragging a goblin
 * every player sees east along row 6, a trap across x 8. Fog off, or on
 * with columns 0 to `revealed - 1` revealed by hand.
 */
function hiddenLead(revealed?: number): RoomState {
  const fog = revealed !== undefined;
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off", fogEnabled: fog }) } });
  s.buildChunks = {};
  if (fog && revealed > 0) lift(s, "dm", { x: 0, y: 0, w: revealed, h: 20 });
  s.tokens.horse = token("horse", { size: "large", x: 2, y: 5, name: "Horse", kind: "npc", ownerIds: [], visibility: "dm" });
  s.tokens.gob = token("gob", { size: "small", x: 1, y: 6, name: "Gob", kind: "npc", ownerIds: [], attached: { to: "horse", kind: "drag" } });
  s.tokens.pc = token("pc", { x: 20, y: 15, name: "Pc", kind: "pc", ownerIds: ["p1"] });
  s.traps.t1 = trap("t1", { zone: { cells: [{ x: 8, y: 4, w: 1, h: 5 }] }, rig: net() });
  return s;
}

const east: Op = { t: "token.move", tokenId: "horse", x: 14, y: 5, squeeze: true, route: [[3, 6, 1, 0], [15, 6, 1, 0]] };

/**
 * Pat's warhorse dragging a Small goblin east into a corridor one square
 * wide along row 6 from x 16, squeezing there, so the goblin follows in
 * single file on the horse's middle, half a square off its grid all the way
 * from the first corner. A net across x 8 on the open ground before it. An
 * owl may ride the goblin.
 */
function corridor(o: { owl?: boolean; low?: boolean; fog?: boolean } = {}): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 12 }, blockMovement: o.low !== true, autoWalls: "off", fogEnabled: o.fog === true }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [[[16, 0], [16, 6]], [[16, 7], [16, 12]], [[24, 0], [24, 6]], [[24, 7], [24, 12]], [[16, 6], [24, 6]], [[16, 7], [24, 7]]];
  runs.forEach(([a, b], i) => wall(s, `rc50cw${String(i).padStart(6, "0")}`, a, b));
  // Under fog the party sees its start, not the net.
  if (o.fog) lift(s, "dm", { x: 0, y: 0, w: 5, h: 12 });
  s.tokens.horse = token("horse", { size: "large", x: 2, y: 5, name: "Warhorse", kind: "npc", ownerIds: ["p1"] });
  s.tokens.gob = token("gob", { size: "small", x: 1, y: 6, name: "Gob", kind: "npc", attached: { to: "horse", kind: "drag" } });
  if (o.owl) s.tokens.owl = token("owl", { size: "tiny", x: 1.5, y: 6, name: "Owl", kind: "npc", attached: { to: "gob", kind: "carry" } });
  // Lower ground under where the goblin's snapped spot stands, on a scene where ledges stop no move.
  if (o.low) heights(s, { x: 6, y: 6, w: 1, h: 1 }, -5);
  s.traps.net = trap("net", { zone: { cells: [{ x: 8, y: 4, w: 1, h: 5 }] }, rig: net() });
  return s;
}

const intoCorridor: Op = { t: "token.move", tokenId: "horse", x: 19.5, y: 5.5, squeeze: true, route: [[3, 6, 1, 0], [14, 6, 1, 0], [14.5, 5.5, 1, 0], [19.5, 5.5, 2, 0]] };

/** The op as the server takes it, Pat's through his own check first. The DM's hidden horse squeezes on open ground, which the reducer takes as sent. */
function served(s: RoomState, op: Op, opVersion?: number, who = P1): RoomState {
  if (who.role === "player") {
    const allowed = canApply(op, who, s, deps);
    assert.ok(allowed.ok, allowed.ok ? "" : allowed.message);
  }
  const r = applyOp(structuredClone(s), op, who, versioned(opVersion));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.state;
}

describe("op version 52: a creature in single file off its grid can stop, on ground every player sees", () => {
  test("the op step is the identity, and ops stored at the current version take the new rule", () => {
    assert.ok(OP_VERSION >= 52);
    const ops: unknown[] = [intoCorridor, { t: "log.chat", text: "hi" }];
    for (const op of ops) assert.equal(runMigrations(op, 51, 52, opMigrations), op);
    assert.deepEqual([fileStandsSnapped(1), fileStandsSnapped(51), fileStandsSnapped(52), fileStandsSnapped(OP_VERSION), fileStandsSnapped(undefined)], [false, false, true, true, true]);
  });

  test("the hidden Large horse's goblin stops behind it on seen ground, walks on at op 51, and walks on under the fog", () => {
    const seen = hiddenLead();
    assert.equal(planWalks(east, seen, DM, {}).find((m) => m.tokenId === "gob")?.file, true, "in single file");
    const cut = planTrapMove(east, seen, DM, {});
    assert.notEqual(cut.op, east, "the trap cuts the move");
    assert.equal(planTrapMove(east, seen, DM, { opVersion: 51 }).op, east, "at op 51 it walked on");
    const after = served(seen, east, undefined, DM);
    // Its spot 7.5, 6.5 on the net's edge snaps back toward 1, 6 to 7, 6, and it steps back off the horse's box from there.
    assert.deepEqual(poses(after, ["horse", "gob"]), [[7, 6, 0, undefined], [6, 6, 0, "horse"]]);
    landsAsPlanned(seen, east, after, DM);
    assert.equal(after.traps.t1!.state, "sprung");
    // Under the fog with only its start seen, its spots on the way to the net are off that ground, snapped or not.
    for (const opVersion of [51, undefined]) assert.equal(planTrapMove(east, hiddenLead(5), DM, opVersion === undefined ? {} : { opVersion }).op, east, `op ${opVersion}: it walks on in the dark`);
    // Seen ground up to the net's column is enough, as for any walker beside the dark.
    assert.notEqual(planTrapMove(east, hiddenLead(8), DM, {}).op, east, "seen up to column 7");
  });

  test("over a pit the stop waits for the goblin's snapped spot to stand over it, not its spot on the horse's middle", () => {
    const s = hiddenLead();
    s.traps.t1 = trap("t1", { zone: { cells: [{ x: 7, y: 6, w: 2, h: 2 }] }, rig: { ...net(), pit: { floor: -10 } } });
    // Its spot 6.5, 6.5 lies over the pit, its snapped spot 6, 6 does not, and 7.5, 6.5 snaps to 7, 6, which does. There the
    // hidden horse stands wholly over the pit and falls, and the goblin steps back off it.
    const after = served(s, east, undefined, DM);
    assert.deepEqual(poses(after, ["horse", "gob"]), [[7, 6, -10, undefined], [6, 6, 0, "horse"]]);
    assert.equal(served(s, east, 51, DM).tokens.horse!.x, 14, "at op 51 it walked on");
  });

  test("Pat's warhorse stops at the net with its goblin right behind it, a cut his own check takes", () => {
    const s = corridor();
    for (const [opVersion, expected] of [
      // At op 51 the goblin stood nowhere between the walk's ends but the corner at the corridor's mouth.
      [51, [[14.5, 5.5, 0, undefined], [15, 6, 0, "horse"]]],
      [undefined, [[7, 6, 0, undefined], [6, 6, 0, "horse"]]],
    ] as const) {
      const plan = planTrapMove(intoCorridor, s, P1, opVersion === undefined ? {} : { opVersion });
      assert.notEqual(plan.op, intoCorridor, `op ${opVersion}: cut`);
      assert.ok(canApply(plan.op, P1, s, deps).ok, `op ${opVersion}: the cut is one Pat's check takes`);
      const after = served(s, intoCorridor, opVersion);
      assert.deepEqual(poses(after, ["horse", "gob"]), expected, `op ${opVersion}`);
      landsAsPlanned(s, intoCorridor, after, P1, opVersion);
      const [horse, gob] = [after.tokens.horse!, after.tokens.gob!];
      assert.ok(linkHolds(SQUARES, after.meta.settings, "drag", gob, horse), `op ${opVersion}: in the horse's reach`);
    }
  });

  test("an owl on the goblin comes with it to its snapped spot", () => {
    const s = corridor({ owl: true });
    const after = served(s, intoCorridor);
    assert.deepEqual(poses(after, ["gob", "owl"]), [[6, 6, 0, "horse"], [6.5, 6, 0, "gob"]]);
    landsAsPlanned(s, intoCorridor, after);
    const box = footprintRect(SQUARES, after.tokens.gob!);
    const owl = footprintRect(SQUARES, after.tokens.owl!);
    assert.ok(owl.x >= box.x && owl.x + owl.w <= box.x + box.w && owl.y >= box.y && owl.y + owl.h <= box.y + box.h, "in the goblin's arms, inside its square");
  });

  test("the goblin stands on the ground under its snapped spot, not under its spot on the horse's middle", () => {
    const s = corridor({ low: true });
    const after = served(s, intoCorridor);
    assert.deepEqual(poses(after, ["horse", "gob"]), [[7, 6, 0, undefined], [6, 6, -5, "horse"]]);
    landsAsPlanned(s, intoCorridor, after);
  });

  test("under the fog, with the net's ground dark, the group walks on into the corridor as at op 51", () => {
    const s = corridor({ fog: true });
    const [old, now] = [served(s, intoCorridor, 51), served(s, intoCorridor)];
    assert.deepEqual(poses(now, ["horse", "gob"]), poses(old, ["horse", "gob"]));
    assert.deepEqual(poses(now, ["horse", "gob"]), [[19.5, 5.5, 0, undefined], [19, 6, 0, "horse"]]);
    assert.equal(now.traps.net!.state, "sprung", "it goes off all the same");
    assert.deepEqual(copies(now), copies(old), "every player is sent the same");
  });
});

describe("the snap reads only what every player sees", () => {
  test("a wall the party has not seen through the goblin's snapped spot, under the fog, changes nothing", () => {
    // Columns 0 to 6 seen, so the snapped spot 7, 6 on the net's edge is dark, and a stub through its middle in the second room.
    const open = hiddenLead(7);
    const walled = structuredClone(open);
    wall(walled, "rc50fs000001", [7.25, 6.5], [7.75, 6.5]);
    assert.equal(sceneWalls(walled.scenes.s1!, walled.buildChunks).stored.xy.length, 4, "the wall is stored");
    assert.deepEqual(copies(walled), copies(open), "the players' copies start the same");
    const [a, b] = [open, walled].map((s) => {
      const r = applyOp(structuredClone(s), east, DM, versioned(undefined));
      assert.ok(r.ok);
      return r;
    });
    assert.deepEqual(poses(a!.state, ["gob"]), [[15, 7, 0, "horse"]], "it walks on in the dark");
    assert.deepEqual(copies(b!.state), copies(a!.state));
    assert.deepEqual([b!.trapped, b!.log], [a!.trapped, a!.log]);
  });

  test("where the goblin's snapped spot meets a wall on seen ground, it is no stand there and steps back to one that is", () => {
    const open = hiddenLead();
    const walled = structuredClone(open);
    // A stub inside 6, 6, through the goblin's snapped spot there, on ground every player sees.
    wall(walled, "rc50fs000002", [6.25, 6.5], [6.75, 6.5]);
    const r = applyOp(structuredClone(walled), east, DM, versioned(undefined));
    assert.ok(r.ok);
    const gob = r.state.tokens.gob as Token;
    assert.ok(gob.x !== 6 || gob.y !== 6, `not on the walled square: ${gob.x}, ${gob.y}`);
    assert.equal(gob.attached?.to, "horse");
    landsAsPlanned(walled, east, r.state, DM);
  });
});
