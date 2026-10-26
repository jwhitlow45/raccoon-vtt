import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AreaTemplate, Token } from "#shared/model.ts";
import { clientOpSchema, ephEventSchema } from "#shared/protocol.ts";
import { castFromToken, computeCoverage, creaturesInArea, hexEdgeOrigin, type AreaContext, type AreaToken } from "#shared/rules/aoe.ts";
import { hexAnchor, occupiedHexes, placedOnHex, tokenRefHex } from "#shared/rules/footprint.ts";
import { cornerAt, HEX_R, hexAt, hexCenter, hexCorners, hexDistance, hexNeighbors, snapAnchor, type HexGrid } from "#shared/rules/hex.ts";
import { rng } from "#shared/testutil.ts";
import { AREA_SPELLS } from "#shared/srd/area-spells.ts";
import { inAreaEntries, inAreaText } from "./coverage.ts";
import {
  aimText,
  aoeFrame,
  areaGrips,
  areaContains,
  areaOutline,
  cubeCenter,
  draftFromTemplate,
  draftTemplate,
  frameTemplate,
  newDraft,
  freePointHeight,
  originFromToken,
  pointGround,
  movePatch,
  rotatePatch,
  snapCubeCenter,
  snapFootprintCenter,
  snapPoint,
  snapYaw,
  templateInput,
  templatePivot,
  triggerSummary,
  wideSnapLabel,
  withShape,
  withSlows,
  yawToward,
  type AreaDraft,
  type AreaTokens,
} from "./placement.ts";
import { placementHint, presetDraft, rangeFeet, searchAreaSpells } from "./presets.ts";
import { apply, room } from "#shared/testutil.ts";
import { SQUARES } from "#shared/rules/grid.ts";

function tok(id: string, over: Partial<AreaToken> = {}): AreaToken {
  return { id, rev: 1, sceneId: "s", size: "medium", x: 0, y: 0, elevation: 0, ...over };
}

function ctx(tokens: AreaTokens): AreaContext {
  return { settings: { feetPerCell: 5, aoeCoverage: "half", aoeInclusion: "anyCell" }, bounds: { w: 40, h: 40 }, grid: SQUARES, tokens: tokens as Record<string, AreaToken> };
}

function draft(over: Partial<AreaDraft> = {}): AreaDraft {
  return { ...newDraft("a1", over.shape ?? "cone", "#f38400"), ...over };
}

function caught(d: AreaDraft, tokens: AreaTokens): string[] {
  const t = draftTemplate(SQUARES, d, tokens, 5);
  assert.ok(t, "the draft has somewhere to be");
  return creaturesInArea({ ...t, sceneId: "s" }, Object.values(tokens) as AreaToken[], ctx(tokens));
}

const spell = (name: string) => AREA_SPELLS.find((s) => s.name === name)!;

describe("origins from a token", () => {
  const thorn = tok("thorn", { x: 5, y: 5 });

  test("cones and lines start on the caster's edge at its middle height, in whole feet", () => {
    assert.deepEqual(originFromToken(SQUARES, { shape: "cone", size: 15, yaw: 0, anchor: "bottom", faceU: 0 }, thorn, 5).origin, { x: 6, y: 5.5, z: 3 });
    assert.deepEqual(originFromToken(SQUARES, { shape: "line", size: 30, yaw: 90, anchor: "bottom", faceU: 0 }, thorn, 5).origin, { x: 5.5, y: 6, z: 3 });
    // At 45 degrees the edge point snaps to the corner.
    assert.deepEqual(originFromToken(SQUARES, { shape: "cone", size: 15, yaw: 45, anchor: "bottom", faceU: 0 }, thorn, 5).origin, { x: 6, y: 6, z: 3 });
  });

  test("a cube's face is on the caster's edge with its bottom at the caster's elevation", () => {
    const flier = tok("vex", { x: 5, y: 5, elevation: 30 });
    const { origin, faceOffset } = originFromToken(SQUARES, { shape: "cube", size: 15, yaw: 0, anchor: "bottom", faceU: 0 }, flier, 5);
    assert.equal(origin.x, 6);
    assert.ok(Number.isInteger(origin.z));
    // The cube's center height is origin.z - v * size: 30 ft bottom, 15 ft side.
    assert.equal(origin.z - faceOffset!.v * 15, 37.5);
  });

  test("the rounded cube covers what the rules' own cast-from-token cube covers", () => {
    const caster = tok("c", { x: 10, y: 10 });
    const tokens = { c: caster };
    for (const yaw of [0, 30, 90, 135, 270]) {
      const mine = draftTemplate(SQUARES, draft({ shape: "cube", size: 15, yaw, fromId: "c" }), tokens, 5)!;
      const rules = { ...mine, ...castFromToken(SQUARES, { shape: "cube", size: 15, yaw }, caster, 5) };
      const cells = (t: typeof mine) => computeCoverage(t, ctx(tokens)).cells.map((c) => `${c.x},${c.y}`).join(" ");
      assert.equal(cells(mine), cells(rules), `yaw ${yaw}`);
    }
  });

  test("an emanation from a token surrounds its footprint", () => {
    const tokens = { thorn };
    const t = draftTemplate(SQUARES, draft({ shape: "emanation", size: 10, fromId: "thorn", attached: true }), tokens, 5)!;
    assert.equal(t.attachedTo, "thorn");
    assert.equal(t.casterId, "thorn");
    assert.deepEqual(areaOutline(t, ctx(tokens)), { kind: "roundRect", x: 3, y: 3, w: 5, h: 5, r: 2 });
  });
});

describe("areas on raised ground", () => {
  test("a point dropped on a platform takes its height, on its rim too, and open floor stays at 0", () => {
    // A 10 ft platform over (4, 3) and (5, 3).
    const { buildChunks } = apply(room(), { t: "build.height", sceneId: "s1", cells: ["4,3", "5,3"], height: 10 });
    assert.equal(pointGround(buildChunks, "s1", { x: 4.5, y: 3.5 }), 10);
    assert.equal(pointGround(buildChunks, "s1", { x: 4, y: 3 }), 10, "a corner of the platform");
    assert.equal(pointGround(buildChunks, "s1", { x: 6, y: 4 }), 10, "the platform's far corner");
    assert.equal(pointGround(buildChunks, "s1", { x: 6.5, y: 3.5 }), 0);
    assert.equal(pointGround(buildChunks, "s1", { x: 4.5, y: 3.5 + 1 }), 0);
    assert.equal(pointGround(buildChunks, "s2", { x: 4.5, y: 3.5 }), 0, "another scene's ground");
  });

  test("a point tapped again or dragged before Place keeps its height above the ground", () => {
    const { buildChunks: c } = apply(room(), { t: "build.height", sceneId: "s1", cells: ["4,3", "5,3"], height: 10 });
    const floor = { x: 2.5, y: 3.5 };
    const platform = { x: 4.5, y: 3.5 };
    assert.equal(freePointHeight(c, "s1", platform, null), 10, "a new point stands on the platform");
    assert.equal(freePointHeight(c, "s1", platform, { ...floor, z: 0 }), 10, "from the floor up onto the platform");
    assert.equal(freePointHeight(c, "s1", floor, { ...platform, z: 10 }), 0, "from the platform down to the floor");
    assert.equal(freePointHeight(c, "s1", floor, { ...platform, z: 25 }), 15, "raised 15 ft with the stepper, it keeps the lift");
    assert.equal(freePointHeight(c, "s1", { x: 5.5, y: 3.5 }, { ...platform, z: 20 }), 20, "across the platform it keeps its height");
  });
});

describe("aiming", () => {
  test("rotation snaps to 15 degrees, 45 degrees, or not at all", () => {
    assert.equal(snapYaw(SQUARES, 37, "15"), 30);
    assert.equal(snapYaw(SQUARES, 38, "15"), 45);
    assert.equal(snapYaw(SQUARES, 37, "45"), 45);
    assert.equal(snapYaw(SQUARES, 22, "45"), 0);
    assert.equal(snapYaw(SQUARES, 37.26, "free"), 37.3);
    assert.equal(snapYaw(SQUARES, -30, "15"), 330);
    assert.equal(snapYaw(SQUARES, 359, "15"), 0);
  });

  test("the aim points from the pivot to the finger, clockwise from east", () => {
    assert.equal(yawToward({ x: 0, y: 0 }, { x: 1, y: 0 }), 0);
    assert.equal(yawToward({ x: 0, y: 0 }, { x: 0, y: 2 }), 90);
    assert.equal(yawToward({ x: 0, y: 0 }, { x: -1, y: -1 }), 225);
    assert.equal(yawToward({ x: 1, y: 1 }, { x: 1, y: 1 }), null);
  });

  test("free points snap to an intersection or a cell center", () => {
    assert.deepEqual(snapPoint(SQUARES, { x: 4.1, y: 6.9 }), { x: 4, y: 7 });
    assert.deepEqual(snapPoint(SQUARES, { x: 4.4, y: 6.6 }), { x: 4.5, y: 6.5 });
    assert.deepEqual(snapCubeCenter(SQUARES, { x: 4.4, y: 6.6 }, 20, 5), { x: 4, y: 7 });
    assert.deepEqual(snapCubeCenter(SQUARES, { x: 4.1, y: 6.9 }, 15, 5), { x: 4.5, y: 6.5 });
  });

  test("a cone from a player token at an angle shows who it hits", () => {
    // Thorn faces a pack down and to the right. A 15 ft cone at 45 degrees
    // starts on Thorn's corner and reaches the goblins on the diagonal, not
    // the one straight east. Aimed east, it is the other way round.
    const tokens: AreaTokens = {
      thorn: tok("thorn", { x: 5, y: 5, disposition: "ally" } as Partial<AreaToken>),
      g1: tok("g1", { x: 7, y: 7 }),
      g2: tok("g2", { x: 8, y: 7 }),
      g3: tok("g3", { x: 8, y: 5 }),
      g4: tok("g4", { x: 3, y: 3 }),
    };
    const at45 = caught(draft({ shape: "cone", size: 15, yaw: 45, fromId: "thorn" }), tokens);
    assert.deepEqual(at45.sort(), ["g1", "g2"]);
    const east = caught(draft({ shape: "cone", size: 15, yaw: 0, fromId: "thorn" }), tokens);
    assert.ok(east.includes("g3") && !east.includes("g1"));
    assert.ok(!at45.includes("thorn") && !east.includes("thorn"), "the caster is left out");
  });

  test("the caster is caught only when included", () => {
    const tokens: AreaTokens = { thorn: tok("thorn", { x: 5, y: 5 }), g: tok("g", { x: 6, y: 5 }) };
    const base = draft({ shape: "emanation", size: 10, fromId: "thorn", attached: true });
    assert.deepEqual(caught(base, tokens), ["g"]);
    assert.deepEqual(caught({ ...base, includeOrigin: true }, tokens).sort(), ["g", "thorn"]);
  });
});

describe("attached emanations", () => {
  test("an emanation attached to a token follows it, and the caught list follows", () => {
    const d = presetDraft(spell("Conjure Minor Elementals"), newDraft("cme", "sphere", "#3e8ef7"), "cleric");
    const at = (x: number, y: number): AreaTokens => ({
      cleric: tok("cleric", { x, y }),
      goblin: tok("goblin", { x: 18, y: 10 }),
      wolf: tok("wolf", { x: 8, y: 10 }),
    });
    const template = draftTemplate(SQUARES, d, at(5, 10), 5)!;
    assert.equal(template.attachedTo, "cleric");
    // The stored template never changes as the cleric walks: its origin is read from the token.
    const inArea = (tokens: AreaTokens) => creaturesInArea({ ...template, sceneId: "s" }, Object.values(tokens) as AreaToken[], ctx(tokens));
    assert.deepEqual(inArea(at(5, 10)), ["wolf"]);
    assert.deepEqual(inArea(at(15, 10)), ["goblin"], "the cleric walked up to the goblin and away from the wolf");
    assert.deepEqual(inArea(at(30, 30)), []);
  });
});

describe("preview to template", () => {
  const tokens: AreaTokens = { thorn: tok("thorn", { x: 5, y: 5 }) };

  test("an emanation left where it was cast keeps its caster's footprint", () => {
    const t = draftTemplate(SQUARES, draft({ shape: "emanation", size: 10, fromId: "thorn", attached: false }), tokens, 5)!;
    assert.equal(t.attachedTo, undefined);
    assert.equal(t.casterId, "thorn");
    assert.deepEqual(t.footprint, { w: 1, h: 1, elevation: 0, height: 5 });
    const input = templateInput(t, { sceneId: "s", ownerId: "m1", color: "#f38400", spell: "Tiny Hut", visibility: "all" });
    assert.deepEqual(input.footprint, t.footprint);
    const parsed = clientOpSchema.safeParse({ t: "template.create", template: input });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    // Thorn walks off: the outline still rounds the square Thorn stood on.
    const walked: AreaTokens = { thorn: tok("thorn", { x: 20, y: 20, rev: 2 }) };
    assert.deepEqual(areaOutline(t, ctx(walked)), { kind: "roundRect", x: 3, y: 3, w: 5, h: 5, r: 2 });
    // An attached one has no footprint of its own: it follows its token.
    assert.equal(draftTemplate(SQUARES, draft({ shape: "emanation", size: 10, fromId: "thorn", attached: true }), tokens, 5)!.footprint, undefined);
  });

  test("how a spell slows movement goes from its preset to the template and back to a copy (docs/design-v1-movement.md 3.5)", () => {
    const guardians = presetDraft(spell("Spirit Guardians"), draft(), "thorn");
    assert.deepEqual(guardians.slows, { kind: "halfSpeed", foes: true });
    const t = draftTemplate(SQUARES, guardians, tokens, 5)!;
    const input = templateInput(t, { sceneId: "s", ownerId: "m1", color: "#f38400", spell: "Spirit Guardians", visibility: "all" });
    assert.deepEqual(input.slows, { kind: "halfSpeed", foes: true });
    assert.ok(clientOpSchema.safeParse({ t: "template.create", template: input }).success);
    const placed = { ...input, rev: 1, origin: input.origin } as AreaTemplate;
    assert.deepEqual(draftFromTemplate(SQUARES, placed, "copy", tokens, 5).slows, { kind: "halfSpeed", foes: true });
    assert.deepEqual(withShape(guardians, "sphere").slows, guardians.slows, "a new shape keeps it, as it keeps the reminders");
    assert.equal(presetDraft(spell("Fireball"), guardians, "thorn").slows, undefined, "another spell sets its own");
    const normal = withSlows(guardians, null);
    assert.equal("slows" in normal, false);
    assert.equal("slows" in templateInput(draftTemplate(SQUARES, normal, tokens, 5)!, { sceneId: "s", ownerId: "m1", color: "#f38400", visibility: "all" }), false);
  });

  test("a placed draft becomes a valid template.create with the caster recorded", () => {
    const t = draftTemplate(SQUARES, draft({ shape: "cone", size: 15, yaw: 30, fromId: "thorn" }), tokens, 5)!;
    const input = templateInput(t, { sceneId: "s", ownerId: "m1", color: "#f38400", spell: "Burning Hands", visibility: "all" });
    assert.equal(input.casterId, "thorn");
    assert.equal(input.spell, "Burning Hands");
    assert.equal("attachedTo" in input, false);
    const parsed = clientOpSchema.safeParse({ t: "template.create", template: input });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  test("every preset with a caster makes a valid template", () => {
    const caster = tok("thorn", { x: 50, y: 50, elevation: 10 });
    for (const s of AREA_SPELLS) {
      let d = presetDraft(s, newDraft("a", "sphere", "#f38400"), "thorn");
      if (!draftTemplate(SQUARES, d, { thorn: caster }, 5)) d = d.targetsOther ? { ...d, fromId: "thorn" } : { ...d, point: { x: 60, y: 60, z: 0 } };
      const t = draftTemplate(SQUARES, d, { thorn: caster }, 5);
      assert.ok(t, s.name);
      const input = templateInput(t, { sceneId: "s", ownerId: "m1", color: "#f38400", spell: s.name, visibility: "all" });
      const parsed = clientOpSchema.safeParse({ t: "template.create", template: input });
      assert.ok(parsed.success, `${s.name}: ${JSON.stringify(parsed.error?.issues)}`);
    }
  });

  test("a shared preview carries geometry only", () => {
    const t = draftTemplate(SQUARES, draft({ shape: "emanation", size: 15, fromId: "thorn", attached: true }), tokens, 5)!;
    const e = aoeFrame(t);
    assert.deepEqual(Object.keys(e).sort(), ["id", "k", "origin", "shape", "shared", "size", "yaw"]);
    assert.ok(ephEventSchema.safeParse(e).success);
    // A receiver shades it as a plain template.
    assert.equal(frameTemplate(e).shape, "emanation");
  });

  test("a draft with nowhere to be is not a template yet", () => {
    assert.equal(draftTemplate(SQUARES, draft({ shape: "sphere" }), tokens, 5), null);
    assert.equal(draftTemplate(SQUARES, draft({ shape: "cone", fromId: "gone" }), tokens, 5), null);
  });

  test("copying a placed template gives back the same template", () => {
    const cases: AreaDraft[] = [
      draft({ shape: "cone", size: 30, yaw: 60, fromId: "thorn" }),
      draft({ shape: "cube", size: 20, yaw: 0, point: { x: 12, y: 8, z: 0 } }),
      draft({ shape: "sphere", size: 20, point: { x: 12, y: 8, z: 10 }, casterId: "thorn" }),
      draft({ shape: "emanation", size: 15, fromId: "thorn", attached: true }),
      draft({ shape: "emanation", size: 10, fromId: "thorn", attached: false }),
    ];
    for (const d of cases) {
      const t = draftTemplate(SQUARES, d, tokens, 5)!;
      const stored = { ...templateInput(t, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), rev: 3 } as AreaTemplate;
      const again = draftTemplate(SQUARES, draftFromTemplate(SQUARES, stored, t.id, tokens, 5), tokens, 5)!;
      assert.deepEqual(again, t, d.shape);
    }
  });

  test("a copy of a stationary emanation keeps its footprint after the caster walks away", () => {
    const ogre = tok("ogre", { x: 10, y: 10, size: "large" });
    const before: AreaTokens = { ogre, target: tok("target", { x: 12, y: 10 }) };
    const t = draftTemplate(SQUARES, draft({ shape: "emanation", size: 5, fromId: "ogre", attached: false }), before, 5)!;
    const stored = { ...templateInput(t, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), rev: 1 } as AreaTemplate;
    const after: AreaTokens = { ogre: tok("ogre", { x: 30, y: 30, size: "large", rev: 2 }), target: before.target };
    assert.deepEqual(creaturesInArea(stored, Object.values(after) as AreaToken[], ctx(after)), ["target"]);
    const copy = draftTemplate(SQUARES, draftFromTemplate(SQUARES, stored, "copy", after, 5), after, 5)!;
    assert.deepEqual(copy.footprint, stored.footprint);
    assert.deepEqual(copy.origin, stored.origin);
    assert.deepEqual(creaturesInArea({ ...copy, sceneId: "s" }, Object.values(after) as AreaToken[], ctx(after)), ["target"]);
    const parsed = clientOpSchema.safeParse({
      t: "template.create",
      template: templateInput(copy, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }),
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  test("a copy of a stationary emanation stays where it was cast while its moved caster still covers that spot", () => {
    const ogre = tok("ogre", { x: 10, y: 10, size: "large" });
    const before: AreaTokens = { ogre, target: tok("target", { x: 9, y: 10 }) };
    const t = draftTemplate(SQUARES, draft({ shape: "emanation", size: 5, fromId: "ogre", attached: false }), before, 5)!;
    const stored = { ...templateInput(t, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), rev: 1 } as AreaTemplate;
    assert.deepEqual(stored.origin, { x: 11, y: 11, z: 5 });
    // One square east: the old origin is still on the ogre's footprint.
    const after: AreaTokens = { ogre: tok("ogre", { x: 11, y: 10, size: "large", rev: 2 }), target: before.target };
    assert.ok(creaturesInArea(stored, Object.values(after) as AreaToken[], ctx(after)).includes("target"));
    const copy = draftTemplate(SQUARES, draftFromTemplate(SQUARES, stored, "copy", after, 5), after, 5)!;
    assert.deepEqual(copy.origin, stored.origin);
    assert.deepEqual(copy.footprint, stored.footprint);
    assert.ok(creaturesInArea({ ...copy, sceneId: "s" }, Object.values(after) as AreaToken[], ctx(after)).includes("target"));
  });

  test("a footprint copy moves in steps that keep its square on the grid", () => {
    // Two cells across centers on a grid line, one cell on a cell's middle.
    assert.deepEqual(snapFootprintCenter(SQUARES, { x: 7.4, y: 3.6 }, { w: 2, h: 2 }), { x: 7, y: 4 });
    assert.deepEqual(snapFootprintCenter(SQUARES, { x: 7.4, y: 3.6 }, { w: 1, h: 3 }), { x: 7.5, y: 3.5 });
    // Part of a cell snaps like a plain point.
    assert.deepEqual(snapFootprintCenter(SQUARES, { x: 7.4, y: 3.6 }, { w: 0.5, h: 0.5 }), snapPoint(SQUARES, { x: 7.4, y: 3.6 }));
  });

  test("a cone aimed up reaches a flier, through the template, the shared preview and a copy", () => {
    const caster = tok("thorn", { x: 10, y: 10 });
    const flier = tok("flier", { x: 13, y: 10, elevation: 20 });
    const all: AreaTokens = { thorn: caster, flier };
    const level = draft({ shape: "cone", size: 30, yaw: 0, fromId: "thorn" });
    assert.deepEqual(caught(level, all), []);
    const up = { ...level, pitch: 45 };
    assert.deepEqual(caught(up, all), ["flier"]);

    const t = draftTemplate(SQUARES, up, all, 5)!;
    const input = templateInput(t, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" });
    assert.equal(input.pitch, 45);
    assert.ok(clientOpSchema.safeParse({ t: "template.create", template: input }).success);
    // Level leaves the field out, so a level area is stored as before.
    assert.equal("pitch" in templateInput(draftTemplate(SQUARES, level, all, 5)!, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), false);

    const frame = aoeFrame(t);
    assert.equal(frame.pitch, 45);
    assert.ok(ephEventSchema.safeParse(frame).success);
    assert.equal(frameTemplate(frame).pitch, 45);

    const copy = draftFromTemplate(SQUARES, { ...input, rev: 1 } as AreaTemplate, "a2", all, 5);
    assert.equal(copy.pitch, 45);
  });

  test("an aimed cone's outline is what it covers seen from above, and a tap inside it picks it", () => {
    const tokens: AreaTokens = {};
    const t = draftTemplate(SQUARES, draft({ shape: "cone", size: 30, yaw: 0, pitch: 60, point: { x: 10, y: 10, z: 0 } }), tokens, 5)!;
    const outline = areaOutline(t, ctx(tokens));
    assert.equal(outline?.kind, "poly");
    // Level, the cone's slice is a triangle 6 cells long. Aimed 60 degrees up, the base seen from above starts 3 cells out.
    assert.ok(areaContains(t, ctx(tokens), { x: 14.5, y: 10 }));
    assert.ok(!areaContains(t, ctx(tokens), { x: 9.5, y: 10 }));
  });

  test("aim reads in words, and only cones and lines keep it", () => {
    assert.equal(aimText(0), "Level");
    assert.equal(aimText(30), "30° up");
    assert.equal(aimText(-15), "15° down");
    assert.equal(withShape(draft({ shape: "cone", pitch: 30 }), "line").pitch, 30);
    assert.equal(withShape(draft({ shape: "cone", pitch: 30 }), "sphere").pitch, 0);
    assert.equal("pitch" in draftTemplate(SQUARES, draft({ shape: "sphere", pitch: 30, point: { x: 1, y: 1, z: 0 } }), {}, 5)!, false);
  });

  test("a shape change keeps the caster and the aim", () => {
    const d = withShape(draft({ shape: "sphere", casterId: "thorn", yaw: 90 }), "cone");
    assert.equal(d.fromId, "thorn");
    assert.equal(d.yaw, 90);
    assert.equal(d.includeOrigin, false);
  });

  test("off, a shape change, then on comes back from the same creature (docs/design-v1-area-from-character.md 3.4)", () => {
    // From off: no caster, but the creature to turn on again.
    const off = draft({ shape: "cone", point: { x: 4, y: 4, z: 0 }, lastCaster: "thorn" });
    const line = withShape(off, "line");
    assert.equal(line.lastCaster, "thorn");
    assert.equal(line.casterId, undefined);
    assert.equal(withShape(line, "sphere").lastCaster, "thorn");
    assert.equal(withShape(draft({ shape: "cone" }), "line").lastCaster, undefined);
  });

  test("a shape change from a target emanation starts from its caster, not the target", () => {
    const d = withShape(draft({ shape: "emanation", targetsOther: true, fromId: "goblin", casterId: "thorn" }), "cone");
    assert.equal(d.fromId, "thorn");
    assert.equal(d.casterId, "thorn");
  });

  test("a copy keeps the original's caster as the one to cast from again", () => {
    const t = { id: "a", rev: 1, sceneId: "s", shape: "sphere", size: 20, origin: { x: 5, y: 5, z: 0 }, yaw: 0, includeOrigin: true, color: "#fff", ownerId: "m", visibility: "all", casterId: "goblin" } as AreaTemplate;
    assert.equal(draftFromTemplate(SQUARES, t, "b", { goblin: tok("goblin") }, 5).lastCaster, "goblin");
  });
});

describe("editing placed templates", () => {
  const caster = tok("thorn", { x: 5, y: 5 });
  const tokens: AreaTokens = { thorn: caster };
  const placed = (d: AreaDraft) =>
    ({ ...templateInput(draftTemplate(SQUARES, d, tokens, 5)!, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), rev: 1 }) as AreaTemplate;

  test("a cone turned on its caster keeps starting at the caster's edge", () => {
    const cone = placed(draft({ shape: "cone", size: 15, yaw: 0, fromId: "thorn" }));
    const patch = rotatePatch(SQUARES, cone, 90, tokens, 5);
    assert.deepEqual(patch, { yaw: 90, origin: { x: 5.5, y: 6, z: cone.origin.z } });
  });

  test("a free cube turns around its center", () => {
    const cube = placed(draft({ shape: "cube", size: 20, point: { x: 10, y: 10, z: 0 } }));
    const before = cubeCenter(cube, 5);
    const turned = { ...cube, ...rotatePatch(SQUARES, cube, 90, tokens, 5) } as AreaTemplate;
    const after = cubeCenter(turned, 5);
    assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
    assert.deepEqual(before, { x: 10, y: 10 });
  });
});

describe("spell presets", () => {
  test("a preset reminds when its spell says it hits again, and the template keeps it", () => {
    const caster = tok("cleric", { x: 5, y: 5 });
    const d = presetDraft(spell("Spirit Guardians"), newDraft("a", "sphere", "#f38400"), "cleric");
    assert.deepEqual(d.triggers, ["enter", "turnEnd"]);
    const t = draftTemplate(SQUARES, d, { cleric: caster }, 5)!;
    const input = templateInput(t, { sceneId: "s", ownerId: "m", color: "#ffffff", spell: "Spirit Guardians", visibility: "all" });
    assert.deepEqual(input.triggers, ["enter", "turnEnd"]);
    assert.ok(clientOpSchema.safeParse({ t: "template.create", template: input }).success);
    assert.deepEqual(draftFromTemplate(SQUARES, { ...input, rev: 1 } as AreaTemplate, "b", { cleric: caster }, 5).triggers, ["enter", "turnEnd"]);
    // It hits "only once per turn", Grease on each trigger.
    assert.equal(input.oncePerTurn, true);
    assert.equal(draftFromTemplate(SQUARES, { ...input, rev: 1 } as AreaTemplate, "b", { cleric: caster }, 5).oncePerTurn, true);
    const grease = presetDraft(spell("Grease"), { ...newDraft("g", "sphere", "#f38400"), point: { x: 9, y: 9, z: 0 } }, undefined);
    assert.equal("oncePerTurn" in templateInput(draftTemplate(SQUARES, grease, {}, 5)!, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), false);
    // Fireball hits once, so its area has no reminders and stores none.
    const fireball = presetDraft(spell("Fireball"), { ...newDraft("c", "sphere", "#f38400"), point: { x: 9, y: 9, z: 0 } }, undefined);
    assert.equal("triggers" in templateInput(draftTemplate(SQUARES, fireball, {}, 5)!, { sceneId: "s", ownerId: "m", color: "#ffffff", visibility: "all" }), false);
  });

  test("the reminders read as a sentence", () => {
    assert.equal(triggerSummary(["turnEnd", "enter"]), "Reminds when a creature enters or ends its turn there.");
    assert.equal(triggerSummary(["turnStart"]), "Reminds when a creature starts its turn there.");
    assert.equal(triggerSummary(["enter"]), "Reminds when a creature enters it.");
    assert.equal(triggerSummary(undefined), null);
  });

  test("search finds names by prefix first, ignoring case and apostrophes", () => {
    assert.equal(searchAreaSpells("fireball")[0]?.name, "Fireball");
    assert.deepEqual(
      searchAreaSpells("fire").map((s) => s.name).slice(0, 3),
      ["Fire Storm", "Fireball", "Delayed Blast Fireball"],
    );
    assert.equal(searchAreaSpells("dragons")[0]?.name, "Dragon’s Breath");
    assert.equal(searchAreaSpells("SPIRIT")[0]?.name, "Spirit Guardians");
    assert.deepEqual(searchAreaSpells("  "), []);
  });

  test("ranges", () => {
    assert.equal(rangeFeet("150 feet"), 150);
    assert.equal(rangeFeet("1 mile"), 5280);
    assert.equal(rangeFeet("Self"), undefined);
    assert.equal(rangeFeet("Touch"), undefined);
  });

  const base = newDraft("a", "sphere", "#f38400");

  test("Fireball is a 20 ft sphere that waits for a tap", () => {
    const d = presetDraft(spell("Fireball"), base, "thorn");
    assert.equal(d.shape, "sphere");
    assert.equal(d.size, 20);
    assert.equal(d.rangeFt, 150);
    assert.equal(d.casterId, "thorn");
    assert.equal(draftTemplate(SQUARES, d, { thorn: tok("thorn") }, 5), null);
    assert.equal(placementHint(d), "Tap where it goes.");
  });

  test("Burning Hands casts from the caster's edge, Thunderwave too", () => {
    const tokens = { thorn: tok("thorn", { x: 5, y: 5 }) };
    const bh = draftTemplate(SQUARES, presetDraft(spell("Burning Hands"), base, "thorn"), tokens, 5)!;
    assert.equal(bh.shape, "cone");
    assert.equal(bh.casterId, "thorn");
    const tw = draftTemplate(SQUARES, presetDraft(spell("Thunderwave"), base, "thorn"), tokens, 5)!;
    assert.equal(tw.shape, "cube");
    assert.equal(tw.origin.x, 6);
  });

  test("Spirit Guardians attaches to the caster, Tiny Hut stays where it was cast", () => {
    const tokens = { cleric: tok("cleric", { x: 5, y: 5 }) };
    const sg = draftTemplate(SQUARES, presetDraft(spell("Spirit Guardians"), base, "cleric"), tokens, 5)!;
    assert.equal(sg.attachedTo, "cleric");
    assert.equal(sg.includeOrigin, false);
    const hut = draftTemplate(SQUARES, presetDraft(spell("Tiny Hut"), base, "cleric"), tokens, 5)!;
    assert.equal(hut.attachedTo, undefined);
    assert.equal(hut.casterId, "cleric");
    assert.deepEqual([hut.origin.x, hut.origin.y], [5.5, 5.5]);
  });

  test("Ice Knife surrounds its target and catches it, keeping the caster", () => {
    const d = presetDraft(spell("Ice Knife"), base, "wizard");
    assert.equal(d.targetsOther, true);
    assert.equal(placementHint(d), "Tap the target.");
    const tokens: AreaTokens = { wizard: tok("wizard", { x: 0, y: 0 }), orc: tok("orc", { x: 10, y: 10 }), imp: tok("imp", { x: 11, y: 10 }) };
    const withTarget = { ...d, fromId: "orc" };
    const t = draftTemplate(SQUARES, withTarget, tokens, 5)!;
    assert.equal(t.attachedTo, "orc");
    assert.equal(t.casterId, "wizard");
    assert.deepEqual(caught(withTarget, tokens).sort(), ["imp", "orc"]);
  });

  test("Conjure Animals surrounds its pack and follows it, but leaves the pack out of what it catches", () => {
    const d = presetDraft(spell("Conjure Animals"), base, "druid");
    assert.equal(d.targetsOther, true);
    assert.equal(d.includeOrigin, false);
    assert.equal(placementHint(d), "Tap the pack.");
    const tokens: AreaTokens = { druid: tok("druid", { x: 0, y: 0 }), pack: tok("pack", { size: "large", x: 10, y: 10 }), wolf: tok("wolf", { x: 12, y: 10 }) };
    const withPack = { ...d, fromId: "pack" };
    const t = draftTemplate(SQUARES, withPack, tokens, 5)!;
    assert.equal(t.attachedTo, "pack");
    assert.equal(t.casterId, "druid");
    assert.deepEqual(caught(withPack, tokens), ["wolf"]);
  });

  test("Black Tentacles is a square on the ground placed by its center", () => {
    const d = presetDraft(spell("Black Tentacles"), base, "thorn");
    assert.equal(d.fromId, undefined);
    assert.equal(d.note, "A 20-foot square on the ground.");
    const t = draftTemplate(SQUARES, { ...d, point: { x: 10, y: 10, z: 0 } }, { thorn: tok("thorn") }, 5)!;
    const cells = computeCoverage(t, ctx({})).cells;
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [8, 11, 8, 11]);
  });
});

describe("the In area list", () => {
  test("names as the viewer sees them, allies marked, the living first", () => {
    const token = (id: string, over: Partial<Token>): Token =>
      ({ id, rev: 1, sceneId: "s", name: id, size: "medium", x: 0, y: 0, elevation: 0, disposition: "hostile", actor: { inline: { life: "alive" } }, ...over }) as Token;
    const tokens = {
      g2: token("g2", { name: "Goblin", number: 2 }),
      g10: token("g10", { name: "Goblin", number: 10 }),
      thorn: token("thorn", { name: "Thorn", disposition: "ally", actor: { ref: "c1" } }),
      g1: token("g1", { name: "Goblin", number: 1, actor: { inline: { life: "dead" } } as Token["actor"] }),
    };
    const entries = inAreaEntries(["thorn", "g10", "g2", "g1", "missing"], tokens, {});
    assert.equal(inAreaText(entries), "Goblin 2, Goblin 10, Thorn (ally), Goblin 1 (dead)");
    assert.equal(inAreaText([]), "Nobody");
  });
});

describe("the grips on an area", () => {
  test("an area the viewer may change shows where to move it and, if it aims, where to turn it", () => {
    assert.deepEqual(areaGrips("cone", true), { origin: true, handle: true });
    assert.deepEqual(areaGrips("cube", true), { origin: true, handle: true });
    assert.deepEqual(areaGrips("sphere", true), { origin: true, handle: false });
  });

  test("another's placed area shows neither, whatever its shape", () => {
    for (const shape of ["cone", "line", "cube", "sphere", "cylinder", "emanation"] as const) {
      assert.deepEqual(areaGrips(shape, false), { origin: false, handle: false }, shape);
    }
  });
});

describe("placing areas on a hex scene (docs/design-v1-hex-grids.md HX-D11)", () => {
  for (const orient of ["rows", "columns"] as const) {
    const g: HexGrid = { shape: "hex", orient };
    const on = (id: string, size: AreaToken["size"], hex: { col: number; row: number }) => tok(id, { size, ...placedOnHex(g, { size, x: 0, y: 0 }, hex) });
    const hexCtx = (tokens: AreaTokens): AreaContext => ({ ...ctx(tokens), grid: g });

    test(`${orient}: a free point snaps to the nearest hex corner or center`, () => {
      const random = rng(26119);
      for (let i = 0; i < 500; i++) {
        const p = { x: 2 + random() * 20, y: 2 + random() * 20 };
        const snapped = snapPoint(g, p);
        const h = hexAt(g, p);
        const candidates = [hexCenter(g, h), ...hexCorners(g, h).map((c) => cornerAt(g, c))];
        assert.ok(candidates.some((c) => c.x === snapped.x && c.y === snapped.y), "a corner or the center");
        const best = Math.min(...candidates.map((c) => Math.hypot(c.x - p.x, c.y - p.y)));
        assert.ok(Math.abs(Math.hypot(snapped.x - p.x, snapped.y - p.y) - best) < 1e-12, "the nearest");
        // A cube's square never lines up with hexes, so it snaps as a point does.
        assert.deepEqual(snapCubeCenter(g, p, 15, 5), snapped);
      }
    });

    test(`${orient}: a cone cast from a token starts where the aim leaves its hexes' outline, and the wide snap is 30 degrees`, () => {
      const goblin = on("g", "medium", { col: 6, row: 6 });
      const c = hexCenter(g, { col: 6, row: 6 });
      // Cast east from a Medium on hex rows: the east side's midpoint, half a cell out. On hex columns east is a corner's way, HEX_R out.
      const east = originFromToken(g, { shape: "cone", size: 15, yaw: 0, anchor: "bottom", faceU: 0 }, goblin, 5).origin;
      assert.ok(Math.abs(east.y - c.y) < 1 / 64, "origins keep 1/64 of a cell");
      assert.ok(Math.abs(east.x - c.x - (orient === "rows" ? 0.5 : HEX_R)) < 1 / 64);
      assert.deepEqual(originFromToken(g, { shape: "cone", size: 15, yaw: 0, anchor: "bottom", faceU: 0 }, goblin, 5).origin, { ...castFromToken(g, { shape: "cone", size: 15, yaw: 0 }, goblin, 5).origin, z: Math.round(castFromToken(g, { shape: "cone", size: 15, yaw: 0 }, goblin, 5).origin.z) });
      // A cube's face starts on the outline too.
      const cube = originFromToken(g, { shape: "cube", size: 15, yaw: 90, anchor: "bottom", faceU: 0 }, goblin, 5).origin;
      assert.ok(Math.hypot(cube.x - c.x, cube.y - c.y) <= HEX_R + 1 / 64 && Math.hypot(cube.x - c.x, cube.y - c.y) >= 0.5 - 1 / 64, "on the hex's outline");
      assert.equal(snapYaw(g, 40, "45"), 30);
      assert.equal(snapYaw(g, 50, "45"), 60);
      assert.equal(snapYaw(SQUARES, 40, "45"), 45);
      assert.equal(snapYaw(g, 40, "15"), 45);
      assert.equal(wideSnapLabel(g), "30°");
      assert.equal(wideSnapLabel(SQUARES), "45°");
    });

    test(`${orient}: a placed cone turns about its caster's anchor and keeps starting on its outline`, () => {
      const ogre = on("o", "large", { col: 8, row: 8 });
      const tokens = { o: ogre };
      const t = { ...placed(draft({ shape: "cone", fromId: "o", casterId: "o", yaw: 0 }), tokens), casterId: "o" } as AreaTemplate;
      const pivot = templatePivot(g, t, tokens, 5);
      assert.equal(pivot.onCaster, true);
      assert.deepEqual(pivot.point, hexAnchor(g, ogre));
      const turned = rotatePatch(g, t, 120, tokens, 5);
      assert.deepEqual({ x: turned.origin!.x, y: turned.origin!.y }, hexEdgeOrigin(g, occupiedHexes(g, ogre), hexAnchor(g, ogre), 120));
    });

    test(`${orient}: a placed area moves by whole steps of the hex lattice`, () => {
      const random = rng(26120);
      const center = hexCenter(g, { col: 5, row: 5 });
      const corner = cornerAt(g, { hex: { col: 5, row: 5 }, k: 0 });
      for (let i = 0; i < 200; i++) {
        const dx = random() * 10 - 5;
        const dy = random() * 10 - 5;
        const moved = movePatch(g, { origin: { ...center, z: 0 } }, dx, dy).origin!;
        const lands = hexCenter(g, hexAt(g, moved));
        assert.ok(Math.hypot(lands.x - moved.x, lands.y - moved.y) < 1e-9, "a center lands on a center");
        const fromCorner = movePatch(g, { origin: { ...corner, z: 0 } }, dx, dy).origin!;
        const h = hexAt(g, fromCorner);
        const corners = [h, ...hexNeighbors(g, h)].flatMap((n) => hexCorners(g, n).map((c) => cornerAt(g, c)));
        assert.ok(corners.some((c) => Math.hypot(c.x - fromCorner.x, c.y - fromCorner.y) < 1 / 64), "a corner lands on a corner");
        // Exactly the stored corner a fresh placement there takes, not a hair off it (HX3-OPUS-08).
        assert.ok(corners.some((c) => c.x === fromCorner.x && c.y === fromCorner.y), `exactly a corner: ${fromCorner.x},${fromCorner.y}`);
      }
    });

    test(`${orient}: a tap picks a hex emanation only on the hexes its outline draws round (HX3-OPUS-04)`, () => {
      const cleric = on("c", "medium", { col: 10, row: 10 });
      const tokens = { c: cleric };
      const aura = { ...placed(draft({ shape: "emanation", size: 10, fromId: "c", casterId: "c", attached: true }), tokens), sceneId: "s" };
      const ctx = hexCtx(tokens);
      const ref = tokenRefHex(g, cleric);
      let outside = 0;
      for (let row = 5; row < 16; row++) {
        for (let col = 5; col < 16; col++) {
          const h = { col, row };
          const c = hexCenter(g, h);
          const within = hexDistance(g, ref, h) <= 2;
          // Its middle and a point near a corner, inside the hex.
          for (const p of [c, { x: c.x + 0.3, y: c.y + 0.15 }]) assert.equal(areaContains(aura, ctx, p), within, `${col},${row} at ${p.x},${p.y}`);
          if (!within && hexDistance(g, ref, h) === 3) outside++;
        }
      }
      assert.ok(outside > 0);
    });

    test(`${orient}: an emanation's outline runs round the hexes it covers, and a stationary one keeps its size`, () => {
      const cleric = on("c", "medium", { col: 10, row: 10 });
      const tokens = { c: cleric };
      const aura = placed(draft({ shape: "emanation", size: 10, fromId: "c", casterId: "c", attached: true }), tokens);
      const outline = areaOutline({ ...aura, sceneId: "s" }, hexCtx(tokens));
      assert.equal(outline?.kind, "poly");
      const points = outline!.kind === "poly" ? outline!.points : [];
      assert.equal(points.length / 2, 30, "6 (2 r + 1) turns round a 2-step ball of one hex");
      const inside = (p: { x: number; y: number }) => {
        let c = false;
        for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
          const [xi, yi, xj, yj] = [points[i]!, points[i + 1]!, points[j]!, points[j + 1]!];
          if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) c = !c;
        }
        return c;
      };
      const ref = tokenRefHex(g, cleric);
      for (let row = 4; row < 17; row++) {
        for (let col = 4; col < 17; col++) {
          const h = { col, row };
          assert.equal(inside(hexCenter(g, h)), hexDistance(g, ref, h) <= 2, `${col},${row}`);
        }
      }
      // Cast to stay put, it keeps the creature's size, which reads on any grid.
      const stays = placed(draft({ shape: "emanation", size: 10, fromId: "c", casterId: "c", attached: false }), tokens);
      assert.equal(stays.footprint?.size, "medium");
      assert.deepEqual(snapFootprintCenter(g, { x: 3.3, y: 4.1 }, { w: 2, h: 2, size: "large" }), snapAnchor(g, "large", { x: 3.3, y: 4.1 }));
    });

    function placed(d: AreaDraft, tokens: AreaTokens): AreaTemplate {
      const t = draftTemplate(g, d, tokens, 5);
      assert.ok(t);
      return { ...t, sceneId: "s", color: "#f38400", ownerId: "dm1", visibility: "all" } as AreaTemplate;
    }
  }
});
