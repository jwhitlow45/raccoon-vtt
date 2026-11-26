import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Fall, RoomState, Trap } from "#shared/model.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { actor, castAsk, character, customMonster, room, scene, template, token, trap as trapOf } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { holdsPageScene, mark, markGone, stateOf, newPage, sourceIds, type Page, type Source } from "./chain.ts";
import { fallFill, trapFill } from "./fills.ts";
import { applyWaits, buildPlan, OFF_SCENE_WORDS } from "./plan.ts";
import { groupRows } from "./rows.ts";
import { sourceScene } from "./start.ts";

/** The plan's ids: the plan's own and the next one a condition takes. */
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
    const withArea: RoomState = { ...view, templates: { a1: template("a1", { sceneId: "cellar" }) } };
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
    assert.deepEqual(plan.trap, { trapId: "pit", due: "20:0", tokenIds: ["gob", "thorn"] });
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), null);
  });

  test("a creature the trap hit that climbed to another floor of the scene still takes it, and one on another scene drops (FLR4INT-ASTRA-05)", () => {
    const climbed: RoomState = { ...view, tokens: { ...view.tokens, gob: { ...view.tokens.gob!, sceneId: "up" } } };
    const { page, dice } = rolledPage("cellar", climbed, trap);
    assert.deepEqual(buildPlan(page, dice, [{ amount: 4 }], IDS)?.targets.map((t) => t.damage?.parts[0]?.amount), [4, 4]);
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), null);
    const away: RoomState = { ...view, tokens: { ...view.tokens, gob: { ...view.tokens.gob!, sceneId: "far" } } };
    const apart = rolledPage("cellar", away, trap);
    assert.deepEqual(buildPlan(apart.page, apart.dice, [{ amount: 4 }], IDS)?.targets.map((t) => t.target), [{ tokenId: "thorn" }]);
  });

  test("a trap page whose creatures are all on another scene refuses, never settling with no one hit", () => {
    const gone: RoomState = { ...view, tokens: Object.fromEntries(Object.entries(view.tokens).map(([id, t]) => [id, { ...t, sceneId: "far" }])) };
    const stamped = rolledPage("cellar", gone, trap);
    assert.equal(buildPlan(stamped.page, stamped.dice, [{ amount: 4 }], IDS), null);
    assert.equal(buildPlan(stamped.page, stamped.dice, null, IDS), null);
    assert.equal(applyWaits(stamped.page, stamped.dice, [{ amount: 4 }]), OFF_SCENE_WORDS);
  });

  test("a player's ask page is never stopped by the words, so Close the ask stays reachable", () => {
    const away: RoomState = { ...view, tokens: Object.fromEntries(Object.entries(view.tokens).map(([id, t]) => [id, { ...t, sceneId: "far" }])) };
    const stamped = rolledPage("up", away, trap);
    const asking: Page = { ...stamped.page, cast: { ask: castAsk("ask1", { sceneId: "up" }), who: "Thorn" } };
    assert.equal(applyWaits(asking, stamped.dice, [{ amount: 4 }]), null);
    assert.equal(buildPlan(asking, stamped.dice, [{ amount: 4 }], IDS)?.targets.length ?? 0, 0);
  });

  test("a creature deleted from every floor reads as gone, not as elsewhere", () => {
    const { page, dice } = rolledPage("up", { ...view, tokens: {} }, trap);
    assert.equal(applyWaits(page, dice, [{ amount: 4 }]), null);
  });
});

describe("a selection across the floors of one scene", () => {
  const { view, trap } = tower();
  const spread: RoomState = { ...view, tokens: { ...view.tokens, gob: { ...view.tokens.gob!, sceneId: "up" } } };
  const selected = (sceneId: string, state: RoomState) => {
    const { page, dice } = rolledPage(sceneId, state, trap);
    return { page: { ...page, source: { kind: "selection" as const, tokenIds: ["thorn", "gob"] } }, dice };
  };

  test("takes every creature, whichever floor the first one stands on", () => {
    for (const first of ["cellar", "up"]) {
      const { page, dice } = selected(first, spread);
      assert.deepEqual(buildPlan(page, dice, [{ amount: 4 }], IDS)?.targets.map((t) => t.damage?.parts[0]?.amount), [4, 4], `page on ${first}`);
    }
  });

  test("drops only a creature on another scene, and refuses when all are", () => {
    const apart: RoomState = { ...view, tokens: { ...view.tokens, gob: { ...view.tokens.gob!, sceneId: "far" } } };
    const some = selected("cellar", apart);
    assert.equal(buildPlan(some.page, some.dice, [{ amount: 4 }], IDS)?.targets.length, 1);
    const none = selected("far", view);
    assert.equal(applyWaits(none.page, none.dice, [{ amount: 4 }]), OFF_SCENE_WORDS);
    assert.equal(buildPlan(none.page, none.dice, [{ amount: 4 }], IDS), null);
  });
});

describe("a page on another floor of the shown scene", () => {
  const { view, trap } = tower();

  test("keeps its rows while the creatures are held, and marks a deleted one gone", () => {
    const { page } = rolledPage("cellar", view, trap);
    const row = page.rows[0]!;
    const held = holdsPageScene(view, "up", page);
    assert.equal(stateOf(markGone(page, held, () => true), row).gone ?? false, false);
    assert.equal(stateOf(markGone(page, held, () => false), row).gone, true, "held floor: a missing creature was deleted");
    assert.equal(stateOf(markGone(page, holdsPageScene(view, "far", page), () => false), row).gone ?? false, false, "another scene: nothing is known");
  });
});

describe("a fall card's page with riders (D-261120-007, FLR4INT-ASTRA-05)", () => {
  const { view } = tower();
  const card: Fall = { id: "30:0", rev: 0, tokenId: "gob", riders: ["thorn"], sceneId: "cellar", from: "up", ft: 10, made: 30 };

  function fallPage(state: RoomState, tokenIds: string[]): { page: Page; dice: DiceView } {
    const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view: state, srd: { monsters: [], rolls: {} } };
    const filled = fallFill(card);
    const source: Source = { kind: "fall", fallId: card.id, tokenIds };
    const rows = groupRows(dice, sourceIds(source, []), filled.test, false, new Map());
    let page: Page = { ...newPage({ id: "p", sceneId: sourceScene({ source }, state, "cellar"), source, test: filled.test, dc: filled.dc, secret: true, spell: filled.spell, switches: { dcShown: false, resultShown: true }, fill: filled.fill, outcome: filled.outcome }), phase: "rolled", rows };
    for (const r of rows) page = mark(page, r.holder, "fail");
    return { page, dice };
  }

  test("a rider who climbed to another floor of the scene takes the fall with the mount, and both leave the card", () => {
    const climbed: RoomState = { ...view, tokens: { ...view.tokens, thorn: { ...view.tokens.thorn!, sceneId: "up" } } };
    const { page, dice } = fallPage(climbed, ["gob", "thorn"]);
    const plan = buildPlan(page, dice, [{ amount: 6 }], IDS);
    assert.deepEqual(plan?.targets.map((t) => [t.target, t.damage?.parts[0]?.amount]), [[{ tokenId: "gob" }, 6], [{ tokenId: "thorn" }, 6]]);
    assert.deepEqual(plan?.fall, { fallId: "30:0", tokenIds: ["gob", "thorn"] });
  });

  test("a rider the page no longer reaches stays on the card, and a skipped one leaves it", () => {
    const { page, dice } = fallPage(view, ["gob", "thorn"]);
    const gone = markGone(page, true, (row) => row.tokenId !== "thorn");
    assert.deepEqual(buildPlan(gone, dice, [{ amount: 6 }], IDS)?.fall, { fallId: "30:0", tokenIds: ["gob"] }, "Thorn's fall stays for him");
    const thorn = page.rows.find((r) => r.tokenId === "thorn")!;
    const skipped = mark(page, thorn.holder, "skip");
    const plan = buildPlan(skipped, dice, [{ amount: 6 }], IDS);
    assert.deepEqual([plan?.targets.length, plan?.fall], [1, { fallId: "30:0", tokenIds: ["gob", "thorn"] }], "the DM chose no fall for Thorn");
  });
});
