import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { RoomState, Token, Viewer } from "../model.ts";
import { hash128, projectState, stableStringify } from "../project.ts";
import { opSchema, type Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { derivedId } from "./duplicate.ts";
import { emanationFootprint } from "../rules/aoe.ts";
import { placedOnHex, type SizeCategory } from "../rules/footprint.ts";
import { gridOfShape } from "../rules/grid.ts";
import { cornerAt, hexCenter, type Hex, type HexGrid } from "../rules/hex.ts";
import { DM, P1, room, scene, template, token } from "../testutil.ts";

/**
 * Every op phase H1 accepts on a hex scene, replayed to the states it made
 * (docs/design-v1-hex-grids.md section 6). H1 refuses on hex scenes every
 * op whose rules are not hex yet, so no stored op on a hex scene needs a
 * later phase's rule gated (HX-D20). H2 and H3 replay this file unchanged:
 * a later phase that reads one of these ops another way breaks it, and must
 * keep the op on the rule it was applied under rather than record the file
 * again.
 *
 * Each step holds the op, who sent it, a hash of the state and log it
 * left, and a hash of what the player saw of the hex scene then, so the
 * footprint fog test and party vision on hexes are pinned too. The steps
 * make a room's new scenes start on hexes, a hex rows battle mat with
 * creatures of every size, plain and group moves, a resize each way, a
 * sphere on a hex corner, Spirit Guardians attached and a stationary
 * emanation moved across an odd row, a fight's turns, fog revealed live
 * and by a draft, lights, stamps, labels and Clear build, a map lined up,
 * a switch to hex columns and its undo, a duplicate, a creature sent from a
 * square scene and that move undone, and the way back to squares.
 *
 * HEX_H1=write records the file again from `script()`: only on the build
 * that adds an op H1 accepts, never to make a later phase pass.
 */

type Step = { who: "dm" | "player"; op: Op; after: string; seen: string };
type Fixture = { build: string; state: RoomState; steps: Step[] };

const FIXTURE = new URL("./hexH1.fixture.json", import.meta.url);
const ROWS = gridOfShape("hexRows") as HexGrid;
const COLUMNS = gridOfShape("hexColumns") as HexGrid;
const envelope = (i: number) => ({ seq: 1000 + i, at: new Date(Date.UTC(2026, 9, 28, 0, 0, i)).toISOString() });
const viewer = (who: Step["who"]): Viewer => (who === "dm" ? DM : P1);

function start(): RoomState {
  const state = room({ scenes: { s1: scene("s1"), s2: scene("s2") } });
  state.meta.playerSceneId = "hex";
  state.tokens.knight = token("knight", { sceneId: "s2", name: "Knight", x: 3, y: 3 });
  return state;
}

function at(size: SizeCategory, hex: Hex, g: HexGrid = ROWS): { x: number; y: number } {
  return placedOnHex(g, { size, x: 0, y: 0 }, hex);
}

function made(id: string, overrides: Partial<Token>): Omit<Token, "rev" | "fogExemptAuto"> {
  const { rev: _rev, fogExemptAuto: _auto, ...t } = token(id, { sceneId: "hex", ...overrides });
  return t;
}

/** The steps, as H1 makes and accepts them. A restore is built from the inverse of the step before, as the server's undo builds it. */
function script(): { who: Step["who"]; op: Op | ((prev: { inverse: unknown }) => Op) }[] {
  const pc = made("ayla", { kind: "pc", name: "Ayla", ownerIds: ["p1"], ...at("medium", { col: 3, row: 3 }) });
  const caster = { ...pc, x: pc.x, y: pc.y, size: "medium" as const };
  const { rev: _r1, ...sphere } = template("fireball", { sceneId: "hex", shape: "sphere", size: 20, origin: { ...cornerAt(ROWS, { hex: { col: 9, row: 6 }, k: 1 }), z: 0 }, ownerId: "dm1", spell: "Fireball" });
  const { rev: _r2, ...guardians } = template("guardians", { sceneId: "hex", shape: "emanation", size: 15, origin: { ...hexCenter(ROWS, { col: 3, row: 3 }), z: 0 }, attachedTo: "ayla", ownerId: "p1", spell: "Spirit Guardians" });
  const { rev: _r3, ...globe } = template("globe", { sceneId: "hex", shape: "emanation", size: 10, origin: { ...hexCenter(ROWS, { col: 14, row: 8 }), z: 0 }, footprint: emanationFootprint(ROWS, { ...caster, ...at("medium", { col: 14, row: 8 }) }, 5), ownerId: "dm1" });
  return [
    { who: "dm", op: { t: "room.update", settings: { newScenes: "hexRows" } } },
    { who: "dm", op: { t: "scene.create", scene: { id: "hex", name: "Hex mat", bounds: { w: 30, h: 20 }, gridShape: "hexRows" } } },
    { who: "dm", op: { t: "token.create", token: made("goblin", { name: "Goblin", ...at("medium", { col: 5, row: 5 }) }) } },
    { who: "dm", op: { t: "token.create", token: made("ogre", { name: "Ogre", size: "large", ...at("large", { col: 10, row: 6 }) }) } },
    { who: "dm", op: { t: "token.create", token: made("imp", { name: "Imp", size: "tiny", ...at("tiny", { col: 7, row: 2 }) }) } },
    { who: "dm", op: { t: "token.create", token: made("giant", { name: "Giant", size: "huge", ...at("huge", { col: 20, row: 10 }) }) } },
    { who: "dm", op: { t: "token.create", token: made("dragon", { name: "Dragon", size: "gargantuan", ...at("gargantuan", { col: 24, row: 4 }) }) } },
    { who: "dm", op: { t: "token.create", token: pc } },
    { who: "dm", op: { t: "token.move", tokenId: "goblin", ...at("medium", { col: 9, row: 5 }) } },
    { who: "dm", op: { t: "token.moveMany", moves: [{ tokenId: "goblin", ...at("medium", { col: 9, row: 4 }) }, { tokenId: "imp", ...at("tiny", { col: 8, row: 3 }) }] } },
    { who: "dm", op: { t: "token.update", tokenId: "goblin", patch: { size: "large" } } },
    { who: "dm", op: { t: "token.update", tokenId: "goblin", patch: { size: "medium" } } },
    { who: "dm", op: { t: "template.create", template: sphere } },
    { who: "player", op: { t: "template.create", template: guardians } },
    { who: "dm", op: { t: "template.create", template: globe } },
    { who: "dm", op: { t: "template.update", templateId: "globe", patch: { origin: { ...hexCenter(ROWS, { col: 14, row: 9 }), z: 0 } } } },
    { who: "dm", op: { t: "encounter.start", entries: [{ id: "e-goblin", tokenId: "goblin", value: 15 }, { id: "e-ayla", tokenId: "ayla", value: 10 }] } },
    { who: "dm", op: { t: "encounter.next" } },
    { who: "dm", op: { t: "token.move", tokenId: "goblin", ...at("medium", { col: 5, row: 4 }) } },
    { who: "dm", op: { t: "encounter.next" } },
    { who: "player", op: { t: "token.move", tokenId: "ayla", ...at("medium", { col: 6, row: 5 }) } },
    { who: "dm", op: { t: "template.delete", templateId: "fireball" } },
    { who: "dm", op: { t: "scene.update", sceneId: "hex", patch: { fogEnabled: true } } },
    { who: "dm", op: { t: "fog.live", sceneId: "hex", ops: [{ id: "f1", mode: "reveal", shape: { kind: "rect", x: 2, y: 2, w: 6, h: 5 } }] } },
    { who: "dm", op: { t: "fog.draft", sceneId: "hex", add: [{ id: "f2", mode: "reveal", shape: { kind: "stroke", points: [8, 3, 11, 5], width: 1 } }] } },
    { who: "dm", op: { t: "fog.publish", sceneId: "hex" } },
    { who: "dm", op: { t: "fog.draft", sceneId: "hex", add: [{ id: "f3", mode: "reveal", shape: { kind: "all" } }] } },
    { who: "dm", op: { t: "fog.discard", sceneId: "hex" } },
    { who: "dm", op: { t: "build.lights", sceneId: "hex", put: [{ id: "torch", x: 6, y: 4, bright: 20, dim: 20, on: true, walls: true }] } },
    { who: "dm", op: { t: "build.stamps", sceneId: "hex", put: [{ id: "tree", art: { key: "oak-tree" }, x: 12.5, y: 12.5, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" }] } },
    { who: "dm", op: { t: "build.label", sceneId: "hex", labelId: "sign", label: { x: 15, y: 2, text: "Camp", size: 1 } } },
    { who: "dm", op: { t: "scene.setMap", sceneId: "hex", map: { assetId: "art", widthPx: 2100, heightPx: 1400, cellPx: 70, originPx: { x: 0, y: 0 } } } },
    { who: "dm", op: { t: "scene.setGrid", sceneId: "hex", cellPx: 69.5, originPx: { x: 12.25, y: 30.5 } } },
    { who: "dm", op: { t: "scene.update", sceneId: "hex", patch: { gridShape: "hexColumns" } } },
    { who: "dm", op: ({ inverse }) => ({ t: "sys.restore", entries: inverse, from: "undo", deps: true }) as Op },
    { who: "dm", op: { t: "scene.duplicate", sceneId: "hex", newSceneId: "hex2", name: "Hex copy", include: { creatures: true, characters: false, fog: true, drawings: false } } },
    { who: "dm", op: { t: "token.update", tokenId: "knight", patch: { sceneId: "hex", ...at("medium", { col: 12, row: 7 }) } } },
    { who: "dm", op: ({ inverse }) => ({ t: "sys.restore", entries: inverse, from: "undo", deps: true }) as Op },
    { who: "dm", op: { t: "build.clear", sceneId: "hex" } },
    { who: "dm", op: { t: "encounter.end" } },
    { who: "dm", op: { t: "scene.update", sceneId: "hex2", patch: { gridShape: "hexColumns" } } },
    { who: "dm", op: { t: "token.move", tokenId: derivedId("hex2", "goblin"), ...at("medium", { col: 4, row: 4 }, COLUMNS) } },
    { who: "dm", op: { t: "scene.update", sceneId: "hex2", patch: { gridShape: "squares" } } },
    { who: "dm", op: { t: "room.update", settings: { newScenes: "squares" } } },
    { who: "dm", op: { t: "token.delete", tokenId: "ogre" } },
  ];
}

function hashes(state: RoomState, log: unknown): { after: string; seen: string } {
  return { after: hash128(stableStringify({ state, log })), seen: hash128(stableStringify(projectState(state, P1, { sceneId: "hex" }))) };
}

function record(): Fixture {
  let state = start();
  const first = state;
  const steps: Step[] = [];
  let inverse: unknown = null;
  for (const [i, s] of script().entries()) {
    const op = opSchema.parse(typeof s.op === "function" ? s.op({ inverse }) : s.op);
    const r = applyOp(state, op, viewer(s.who), envelope(i));
    assert.ok(r.ok, `step ${i} ${op.t}: ${r.ok ? "" : r.message}`);
    steps.push({ who: s.who, op, ...hashes(r.state, r.log) });
    inverse = r.inverse;
    state = r.state;
  }
  return { build: "hx4", state: first, steps };
}

describe("phase H1's ops on hex scenes (docs/design-v1-hex-grids.md section 6)", () => {
  test("replay to the states, logs and player views H1 made, every step accepted", () => {
    if (process.env.HEX_H1 === "write") {
      writeFileSync(FIXTURE, `${JSON.stringify(record())}\n`);
      return;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    let state = fixture.state;
    for (const [i, step] of fixture.steps.entries()) {
      const r = applyOp(state, step.op, viewer(step.who), envelope(i));
      assert.ok(r.ok, `step ${i} ${step.op.t}: ${r.ok ? "" : r.message}`);
      assert.deepEqual(hashes(r.state, r.log), { after: step.after, seen: step.seen }, `step ${i} ${step.op.t}`);
      state = r.state;
    }
  });

  test("the file covers the ops H1 accepts on hexes, a stored undo among them, and reaches hex rows, hex columns and back", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
    const kinds = new Set(fixture.steps.map((s) => s.op.t));
    for (const t of ["scene.create", "token.create", "token.move", "token.moveMany", "token.update", "template.create", "template.update", "template.delete", "encounter.next", "fog.live", "fog.publish", "fog.discard", "build.lights", "build.stamps", "build.label", "build.clear", "scene.setMap", "scene.setGrid", "scene.duplicate", "sys.restore", "room.update"] as const) {
      assert.ok(kinds.has(t), t);
    }
    const shapes = fixture.steps.flatMap((s) => (s.op.t === "scene.update" && s.op.patch.gridShape ? [s.op.patch.gridShape] : []));
    assert.deepEqual(shapes, ["hexColumns", "hexColumns", "squares"]);
    assert.ok(fixture.steps.some((s) => s.who === "player"));
  });
});
