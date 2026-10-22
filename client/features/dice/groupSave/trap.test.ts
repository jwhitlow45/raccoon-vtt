import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Trap } from "#shared/model.ts";
import { opSchema } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { SETTLED_MEANWHILE } from "#shared/reducer/traps.ts";
import { trapPreset } from "#shared/srd/traps.ts";
import { actor, character, customMonster, DM, env, room, token, trap as trapOf } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { apply, mark, newPage, roll, sourceIds, type Page } from "./chain.ts";
import { trapFill, UNFOUND_TRAP } from "./fills.ts";
import { buildPlan } from "./plan.ts";
import { groupRows, type RowBase } from "./rows.ts";

/** The group save from a trap (docs/design-v1-traps.md 4.4). */

function presetTrap(id: string, over: Partial<Trap> = {}): Trap {
  const p = trapPreset(id, "1-4")!;
  return trapOf(id, { name: p.name, rig: { ...p.rig, hits: "trigger", due: [{ id: "20:0", at: "", how: "cross", by: ["thorn"], hits: ["thorn", "gob"] }] }, ...over });
}

function world(t: Trap): RoomState {
  return room({
    monsters: { lurker: customMonster("lurker") },
    characters: { c1: character("c1", { name: "Thorn", ownerIds: ["p1"] }) },
    tokens: {
      thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], actor: { ref: "c1" } }),
      gob: token("gob", { kind: "monster", name: "Goblin", actor: { inline: actor({ monsterId: "lurker", hp: { cur: 30, max: 30, temp: 0 } }) } }),
    },
    traps: { [t.id]: t },
  });
}

function pageFor(t: Trap, secret: boolean): { page: Page; rows: RowBase[]; dice: DiceView } {
  const view = world(t);
  const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view, srd: { monsters: [], rolls: {} } };
  const filled = trapFill(t);
  const source = { kind: "trap" as const, trapId: t.id, due: "20:0", tokenIds: ["thorn", "gob"] };
  const page = newPage({ id: "p", sceneId: "s1", source, test: filled.test, dc: filled.dc, secret, spell: filled.spell, switches: { dcShown: false, resultShown: true }, fill: filled.fill, outcome: filled.outcome });
  return { page, rows: groupRows(dice, sourceIds(source, ["someone else"]), filled.test, false), dice };
}

describe("a trap's group save", () => {
  test("fills from the trap: its save or none, DC, damage, half or none, conditions, and the DM note under the line", () => {
    const roof = trapFill(presetTrap("collapsing-roof"));
    assert.deepEqual(roof.test, { kind: "save", ability: "dex" });
    assert.equal(roof.dc, 13);
    assert.equal(roof.spell, false, "Against a spell starts off");
    assert.equal(roof.fill.from, "From Collapsing Roof: Dexterity save, DC 13, 2d10 Bludgeoning, half on a pass.");
    assert.equal(roof.outcome.damage, "2d10 Bludgeoning");
    const pit = trapFill(presetTrap("hidden-pit"));
    assert.deepEqual(pit.test, { kind: "none" }, "a pit applies in one tap");
    assert.equal(pit.fill.from, "From Hidden Pit: No save, 1d6 Bludgeoning.");
    const net = trapFill(presetTrap("falling-net"));
    assert.deepEqual(net.outcome.conditions, ["restrained"]);
    assert.match(net.fill.note ?? "", /Huge or larger/);
  });

  test("players read Trap until it is found, and its name after", () => {
    assert.equal(trapFill(presetTrap("hidden-pit")).fill.publicName, UNFOUND_TRAP);
    assert.equal(trapFill(presetTrap("hidden-pit", { found: true })).fill.publicName, "Hidden Pit");
    assert.equal(trapFill(presetTrap("hidden-pit")).fill.name, "Hidden Pit", "the page keeps the real name");
  });

  test("its rows are the creatures it hits, frozen when it went off, whatever is selected", () => {
    assert.deepEqual(sourceIds({ kind: "trap", trapId: "t", due: "1:0", tokenIds: ["a", "b"] }, ["c"]), ["a", "b"]);
  });

  test("a request's note and a roll in the open name it as players may, a secret roll by its real name", () => {
    const open = pageFor(presetTrap("collapsing-roof"), false);
    const step = roll(open.page, { rows: open.rows, server: open.rows.filter((r) => r.bonus !== null).map((r) => ({ holder: r.holder, target: r.target, bonus: r.bonus!, sources: [], extra: [] })), tag: "tag-1", requestIds: () => "0192f0a8-6c1e-7a4b-9c3d-000000000001", openRequests: 0, taken: [], at: "2026-10-22T10:00:00.000Z" });
    const ask = step.send.find((c) => c.kind === "op" && c.op.t === "roll.ask");
    assert.ok(ask && ask.kind === "op" && ask.op.t === "roll.ask");
    assert.equal(ask.op.request.note, "Trap");
    const dice = step.send.find((c) => c.kind === "dice");
    assert.ok(dice && dice.kind === "dice");
    assert.match(dice.rolls[0]!.label ?? "", /^Trap, /);
    const secret = pageFor(presetTrap("collapsing-roof"), true);
    const hidden = roll(secret.page, { rows: secret.rows, server: secret.rows.filter((r) => r.bonus !== null).map((r) => ({ holder: r.holder, target: r.target, bonus: r.bonus!, sources: [], extra: [] })), tag: "tag-2", requestIds: () => "0192f0a8-6c1e-7a4b-9c3d-000000000002", openRequests: 0, taken: [], at: "2026-10-22T10:00:00.000Z" });
    const rolled = hidden.send.find((c) => c.kind === "dice");
    assert.ok(rolled && rolled.kind === "dice" && rolled.to === "dm");
    assert.match(rolled.rolls[0]!.label ?? "", /^Collapsing Roof, /);
    const askedSecret = hidden.send.find((c) => c.kind === "op" && c.op.t === "roll.ask");
    assert.ok(askedSecret && askedSecret.kind === "op" && askedSecret.op.t === "roll.ask" && askedSecret.op.request.note === "Trap", "a request reaches a player whatever the page's rolls do");
  });

  test("Apply settles the springing in the same op, and a second Apply is refused: it was settled meanwhile", () => {
    const t = presetTrap("hidden-pit");
    const { page, rows, dice } = pageFor(t, true);
    let rolled: Page = { ...page, phase: "rolled", rows };
    for (const r of rows) rolled = mark(rolled, r.holder, "fail");
    const plan = buildPlan(rolled, dice, [{ amount: 4 }], { plan: "0192f0a8-6c1e-7a4b-9c3d-00000000000a", newId: () => "0192f0a8-6c1e-7a4b-9c3d-00000000000b" })!;
    assert.deepEqual(plan.trap, { trapId: t.id, due: "20:0" });
    const state = world(t);
    const first = applyOp(state, plan, DM, env(30));
    assert.ok(first.ok);
    assert.equal(first.state.traps[t.id]!.rig!.due, undefined, "the occurrence is settled");
    assert.equal(first.state.tokens.gob!.actor && "inline" in first.state.tokens.gob!.actor ? first.state.tokens.gob!.actor.inline.hp.cur : null, 26);
    const again = applyOp(first.state, { ...plan, plan: "0192f0a8-6c1e-7a4b-9c3d-00000000000c" }, DM, env(31));
    assert.ok(!again.ok && again.message === SETTLED_MEANWHILE);
  });

  test("when everyone passes against Falling Net, Apply still settles the springing with no creature, and a second device's is refused", () => {
    const t = presetTrap("falling-net");
    const { page, rows, dice } = pageFor(t, true);
    let rolled: Page = { ...page, phase: "rolled", rows };
    for (const r of rows) rolled = mark(rolled, r.holder, "pass");
    const plan = buildPlan(rolled, dice, null, { plan: "0192f0a8-6c1e-7a4b-9c3d-00000000000d", newId: () => "0192f0a8-6c1e-7a4b-9c3d-00000000000e" })!;
    assert.deepEqual([plan.targets, plan.trap], [[], { trapId: t.id, due: "20:0" }]);
    assert.ok(opSchema.safeParse(plan).success, "the server takes an outcome that only settles a springing");
    assert.equal(opSchema.safeParse({ ...plan, trap: undefined }).success, false, "one that settles nothing names a creature");
    const first = applyOp(world(t), plan, DM, env(30));
    assert.ok(first.ok);
    assert.equal(first.state.traps[t.id]!.rig!.due, undefined, "the occurrence is settled");
    const again = applyOp(first.state, { ...plan, plan: "0192f0a8-6c1e-7a4b-9c3d-00000000000f" }, DM, env(31));
    assert.ok(!again.ok && again.message === SETTLED_MEANWHILE);
    // The page's open requests close with it, as with any Apply.
    const asked: Page = { ...rolled, requests: [{ rollId: "r1", holders: ["character:c1"], state: "open" }] };
    assert.deepEqual(apply(asked, plan).send.map((c) => (c.kind === "op" ? c.op.t : c.kind)), ["roll.close", "outcome"]);
    const area: Page = { ...rolled, source: { kind: "area", templateId: "a1" } };
    assert.equal(buildPlan(area, dice, null, { plan: "0192f0a8-6c1e-7a4b-9c3d-000000000010", newId: () => "x" }), null, "any other page that changes nothing has no plan");
  });
});
