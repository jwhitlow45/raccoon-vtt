import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lift, wall } from "../discoveryTestutil.ts";
import type { LogEvent, RoomState } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, entry, env, member, P1, room, scene, template, token } from "../testutil.ts";

/**
 * A squeezing walker's own area line (live play LP25-A-AREA-1,
 * D-261029-59): a Large warhorse walked through a Stinking Cloud in a
 * corridor one square wide enters it squeezed, and from op version 30 the
 * rays its line is judged by end on the squares it squeezes onto there, so
 * the line reaches the players who watched it. Read full size, between the
 * walk's ends, the rays ran into the rock beside the corridor, which no
 * player's ground holds, and the line was kept to the DM. Ops stored
 * before version 30 replay with the line they wrote.
 */

/** Rock from x 8 to 16 but for a corridor along row 10, the hall, the corridor and the room past it revealed, a cloud in the corridor, on the warhorse's turn. */
function corridor(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, scenes: { s1: scene("s1", { bounds: { w: 30, h: 20 }, blockMovement: true, autoWalls: "off", fogEnabled: true }) } });
  s.buildChunks = {};
  const runs: [[number, number], [number, number]][] = [
    [[8, 0], [8, 10]],
    [[8, 11], [8, 20]],
    [[16, 0], [16, 10]],
    [[16, 11], [16, 20]],
    [[8, 10], [16, 10]],
    [[8, 11], [16, 11]],
  ];
  runs.forEach(([a, b], i) => wall(s, `fu36ar${String(i).padStart(6, "0")}`, a, b));
  lift(s, "dm", { x: 0, y: 0, w: 8, h: 20 });
  lift(s, "dm", { x: 8, y: 10, w: 8, h: 1 });
  lift(s, "dm", { x: 16, y: 0, w: 14, h: 20 });
  s.tokens.horse = token("horse", { size: "large", x: 3, y: 9, name: "Warhorse", kind: "npc", disposition: "ally", ownerIds: ["p1"] });
  s.templates.cloud = template("cloud", { size: 5, origin: { x: 12.5, y: 10.5, z: 0 }, spell: "Stinking Cloud", ownerId: "dm1", triggers: ["enter"] });
  s.encounter = { rev: 0, round: 1, activeEntryId: "e-horse", entries: [entry("e-horse", { tokenId: "horse", value: 15 })] };
  return s;
}

/** Along the hall's row in line with the corridor, through the corridor squeezed, and out into the room. */
const THROUGH: Op = { t: "token.move", tokenId: "horse", x: 18, y: 9, route: [[7.5, 9.5, 0, 0], [15.5, 9.5, 0, 0], [18, 9, 0, 0]] };

function walked(opVersion?: number): { line: Extract<LogEvent, { type: "area" }> | undefined; state: RoomState } {
  const r = applyOp(corridor(), THROUGH, DM, { ...env(5), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.message);
  const line = r.log.map((e) => e.data).find((d): d is Extract<LogEvent, { type: "area" }> => d?.type === "area" && d.tokenId === "horse");
  return { line, state: r.state };
}

describe("a squeezing walker's own area line (LP25-A-AREA-1)", () => {
  test("the warhorse squeezing through the cloud in the corridor: its line reaches Pat, who watched it walk", () => {
    for (const opVersion of [30, undefined]) {
      const { line, state } = walked(opVersion);
      assert.ok(line, "the warhorse entered the cloud");
      assert.equal(line.hidden, undefined, `op ${opVersion ?? "live"}: not kept to the DM`);
      assert.ok(projectState(state, P1, { sceneId: "s1" }).log.some((e) => e.data?.type === "area" && e.data.tokenId === "horse"), "Pat reads it");
    }
  });

  test("an op stored at version 29 replays with the line it wrote, kept to the DM", () => {
    const { line, state } = walked(29);
    assert.ok(line, "the warhorse entered the cloud");
    assert.equal(line.hidden, true);
    assert.equal(projectState(state, P1, { sceneId: "s1" }).log.some((e) => e.data?.type === "area" && e.data.tokenId === "horse"), false);
  });

  test("a creature dragged beside a walker never squeezes, so its line through the corridor still reads its full footprint, kept to the DM", () => {
    // The DM walks Thorn through the rock beside the corridor, the warhorse dragged along the corridor's line.
    const s = corridor();
    s.tokens.thorn = token("thorn", { x: 4, y: 11, name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"] });
    s.tokens.horse = { ...s.tokens.horse!, x: 3, y: 9.5, attached: { to: "thorn", kind: "drag" } };
    s.encounter = { rev: 0, round: 1, activeEntryId: "e-thorn", entries: [entry("e-thorn", { tokenId: "thorn", value: 15 })] };
    const r = applyOp(s, { t: "token.move", tokenId: "thorn", x: 19, y: 11, route: [[19, 11, 0, 0]] }, DM, env(5));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const line = r.log.map((e) => e.data).find((d) => d?.type === "area" && d.tokenId === "horse");
    assert.ok(line && line.type === "area", "the dragged warhorse entered the cloud");
    assert.equal(line.hidden, true);
  });

  test("a walker in open ground is read full size where it enters, half a square off the grid too: its line stays the DM's while the squares beside it are under fog", () => {
    // The cloud in the hall, the warhorse walking the hall's row in line with the corridor, the hall's row below it unrevealed.
    const s = corridor();
    lift(s, "dm", { x: 0, y: 11, w: 8, h: 1 }, "s1", false);
    s.templates.cloud = { ...s.templates.cloud!, origin: { x: 5.5, y: 10.5, z: 0 } };
    s.tokens.horse = { ...s.tokens.horse!, x: 1, y: 9.5 };
    const r = applyOp(s, { t: "token.move", tokenId: "horse", x: 7.5, y: 9.5, route: [[7.5, 9.5, 0, 0]] }, DM, env(5));
    assert.ok(r.ok, r.ok ? "" : r.message);
    const line = r.log.map((e) => e.data).find((d) => d?.type === "area" && d.tokenId === "horse");
    assert.ok(line && line.type === "area", "the warhorse entered the cloud");
    assert.equal(line.hidden, true, "its full footprint reaches the row under fog");
  });
});
