import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Trap } from "#shared/model.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { actor, castAsk, character, customMonster, room, scene, token, trap as trapOf } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { holdsPageScene, mark, newPage, sourceIds, type Page, type Source } from "./chain.ts";
import { trapFill } from "./fills.ts";
import { applyWaits, buildPlan, OFF_FLOOR_WORDS } from "./plan.ts";
import { groupRows } from "./rows.ts";
import { sourceScene } from "./start.ts";

/** A trap card from another floor than the one on screen (the DM holds every floor of the scene on screen). */

const IDS = { plan: "0192f0a8-6c1e-7a4b-9c3d-00000000000a", newId: () => "0192f0a8-6c1e-7a4b-9c3d-00000000000b" };

/** A scene of two floors, the DM looking at "up" while the trap and its creatures are on "cellar". */
function tower(): { view: RoomState; trap: Trap } {
  const p = trapPreset("hidden-pit", "1-4")!;
  const trap = trapOf("pit", { sceneId: "cellar", name: p.name, rig: { ...p.rig, hits: "trigger", due: [{ id: "20:0", at: "", how: "cross", by: ["thorn"], hits: ["thorn", "gob"] }] } });
  const view = room({
    scenes: {
      up: scene("up", { floor: { of: "up", level: 1, name: "Hall" } }),
      cellar: scene("cellar", { order: 1, floor: { of: "up", level: 0, name: "Cellar" } }),
      far: scene("far", { order: 2 }),
    },
    monsters: { lurker: customMonster("lurker") },
    characters: { c1: character("c1", { name: "Thorn", ownerIds: ["p1"] }) },
    tokens: {
      thorn: token("thorn", { sceneId: "cellar", kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      gob: token("gob", { sceneId: "cellar", kind: "monster", name: "Goblin", actor: { inline: actor({ monsterId: "lurker", hp: { cur: 30, max: 30, temp: 0 } }) } }),
    },
    traps: { pit: trap },
  });
  return { view, trap };
}

function rolledPage(sceneId: string, view: RoomState, trap: Trap): { page: Page; dice: DiceView } {
  const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view, srd: { monsters: [], rolls: {} } };
  const filled = trapFill(trap);
  const source: Source = { kind: "trap", trapId: trap.id, due: "20:0", tokenIds: ["thorn", "gob"] };
  const rows = groupRows(dice, sourceIds(source, []), filled.test, false, new Map());
  let page: Page = { ...newPage({ id: "p", sceneId, source, test: filled.test, dc: filled.dc, secret: true, spell: filled.spell, switches: { dcShown: false, resultShown: true }, fill: filled.fill, outcome: filled.outcome }), phase: "rolled", rows };
  for (const r of rows) page = mark(page, r.holder, "fail");
  return { page, dice };
}

describe("the scene a group save page takes", () => {
  const { view, trap } = tower();
  const source = { kind: "trap" as const, trapId: trap.id, due: "20:0", tokenIds: ["thorn", "gob"] };

  test("a trap's page takes the trap's floor, not the floor on screen", () => {
    assert.equal(sourceScene({ source }, view, "up"), "cellar");
  });

  test("an area's page takes the area's floor", () => {
    const withArea: RoomState = { ...view, templates: { a1: { ...Object.values(view.templates)[0], id: "a1", sceneId: "cellar" } as RoomState["templates"][string] } };
    assert.equal(sourceScene({ source: { kind: "area", templateId: "a1" } }, withArea, "up"), "cellar");
  });

  test("a player's ask takes the floor it was made on", () => {
    const ask = castAsk("ask1", { sceneId: "cellar" });
    assert.equal(sourceScene({ source: { kind: "selection", tokenIds: [] }, cast: { ask, who: "Thorn" } }, view, "up"), "cellar");
  });

  test("a selection takes its creatures' floor, and a source the view lost falls back to the floor on screen", () => {
    assert.equal(sourceScene({ source: { kind: "selection", tokenIds: ["gob"] } }, view, "up"), "cellar");
    assert.equal(sourceScene({ source: { kind: "selection", tokenIds: [] } }, view, "up"), "up");
    assert.equal(sourceScene({ source: { ...source, trapId: "gone" } }, view, "up"), "up");
    assert.equal(sourceScene({ source }, null, null), "");
  });

  test("the DM holds the page's floor while on another floor of its scene, never on another scene", () => {
    assert.equal(holdsPageScene(view, "up", { sceneId: "cellar" }), true);
    assert.equal(holdsPageScene(view, "far", { sceneId: "cellar" }), false);
    assert.equal(holdsPageScene(view, "up", { sceneId: "up" }), true);
    assert.equal(holdsPageScene(view, null, { sceneId: "up" }), false);
  });
});

describe("a trap card from another floor applies", () => {
  const { view, trap } = tower();

  test("its damage reaches the creatures on the trap's floor", () => {
    const { page, dice } = rolledPage("cellar", view, trap);
    const plan = buildPlan(page, dice, [{ amount: 4 }], IDS);
    assert.ok(plan);
    assert.deepEqual(plan.targets.map((t) => t.damage?.parts[0]?.amount), [4, 4]);
    assert.deepEqual(plan.trap, { trapId: "pit", due: "20:0" });
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), null);
  });

  test("a page stamped with the floor on screen is refused with words, never settled with no one hit", () => {
    const { page, dice } = rolledPage("up", view, trap);
    assert.equal(buildPlan(page, dice, [{ amount: 4 }], IDS), null);
    assert.equal(buildPlan(page, dice, null, IDS), null);
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), OFF_FLOOR_WORDS);
  });

  test("one creature that left the floor is left out and the other still takes it, so only a page with every creature elsewhere is refused", () => {
    const moved: RoomState = { ...view, tokens: { ...view.tokens, gob: { ...view.tokens.gob!, sceneId: "up" } } };
    const { page, dice } = rolledPage("cellar", moved, trap);
    const plan = buildPlan(page, dice, [{ amount: 4 }], IDS);
    assert.deepEqual(plan?.targets.map((t) => t.damage?.parts[0]?.amount), [4]);
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), null);
  });

  test("a creature deleted from every floor reads as gone, not as elsewhere", () => {
    const { page, dice } = rolledPage("up", { ...view, tokens: {} }, trap);
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), null);
  });
});
