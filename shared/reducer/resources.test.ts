import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, ClassResource, RoomState, UseMark } from "../model.ts";
import { canApply } from "../permissions.ts";
import type { Op } from "../protocol.ts";
import { DM, P1, P2, actor, apply, character, room, token } from "../testutil.ts";

/**
 * Class resources on the character (docs/design-v1-combat-controls.md 3.1
 * and 7), and what each rest brings back of them and of a creature's spent
 * abilities (2.4).
 */

const rage: ClassResource = { id: "rage", name: "Rage", max: 3, used: 2, reset: "shortOne", preset: "rage", level: 3, atLevel: 3 };
const focus: ClassResource = { id: "focus", name: "Focus Points", max: 5, used: 4, reset: "short", pool: true, preset: "focus-points", level: 5, atLevel: 5 };
const loh: ClassResource = { id: "loh", name: "Lay on Hands", max: 25, used: 20, reset: "long", pool: true };

function table(resources: ClassResource[] = [rage, focus, loh], over: Partial<Actor> = {}): RoomState {
  return room({
    tokens: { thorn: token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }) },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], resources, actor: actor({ hp: { cur: 10, max: 30, temp: 0 }, ...over }) }) },
  });
}

const update = (resources: Omit<ClassResource, "used">[]): Op => ({ t: "character.update", characterId: "thorn", patch: { resources } });
const sent = ({ used: _used, ...r }: ClassResource) => r;

describe("class resources (docs/design-v1-combat-controls.md 3.1)", () => {
  test("an update keeps each count spent by id, at most its new count, and a new one starts at none", () => {
    const state = apply(table(), update([sent(loh), { ...sent(rage), max: 1, edited: true }, { id: "surge", name: "Action Surge", max: 1, reset: "short" }]));
    assert.deepEqual(state.characters.thorn!.resources, [
      { ...loh, used: 20 },
      { ...rage, max: 1, used: 1, edited: true },
      { id: "surge", name: "Action Surge", max: 1, used: 0, reset: "short" },
    ]);
  });

  test("an empty list removes them, so none and absent are one state", () => {
    const state = apply(table(), update([]));
    assert.equal("resources" in state.characters.thorn!, false);
  });

  test("the character's players and the DM send them, another player never", () => {
    const op = update([sent(rage)]);
    assert.deepEqual(canApply(op, P1, table(), { canUseAsset: () => true }), { ok: true });
    assert.deepEqual(canApply(op, DM, table(), { canUseAsset: () => true }), { ok: true });
    assert.equal(canApply(op, P2, table(), { canUseAsset: () => true }).ok, false);
  });
});

describe("what a rest brings back (docs/design-v1-combat-controls.md 2.4)", () => {
  const marks: Record<string, UseMark> = {
    "actions:fire-breath": { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 },
    "actions:phantasms": { kind: "rest", name: "Phantasms", used: 1, max: 1 },
    "actions:dominate-mind": { kind: "day", name: "Dominate Mind", used: 2, max: 3 },
    "actions:misty-step": { kind: "day", name: "Misty Step", used: 1, max: 2, short: true },
    "legendaryActions:fiery-rays": { kind: "turn", name: "Fiery Rays", used: 1, max: 1 },
  };
  const record = { id: 4, entryId: "e1", round: 2, hp: 10, life: "alive" as const, took: ["fire" as const] };

  test("a Short Rest gives a short resource all back and a short, one resource one, and a Long Rest gives every one", () => {
    const short = apply(table(), { t: "actor.rest", target: { characterId: "thorn" }, kind: "short", heal: 0 }, P1);
    assert.deepEqual(short.characters.thorn!.resources!.map((r) => r.used), [1, 0, 20]);
    const long = apply(table(), { t: "actor.rest", target: { tokenId: "thorn" }, kind: "long" }, P1);
    assert.deepEqual(long.characters.thorn!.resources!.map((r) => r.used), [0, 0, 0]);
  });

  test("a rest with nothing to bring back leaves the resources as they were", () => {
    const fresh = table([{ ...loh, used: 0 }]);
    const state = apply(fresh, { t: "actor.rest", target: { characterId: "thorn" }, kind: "short", heal: 0 });
    assert.equal(state.characters.thorn!.resources, fresh.characters.thorn!.resources);
  });

  test("a Short Rest brings back recharges, rest uses and X a day uses a Short Rest names, and a Long Rest every mark with the damage types", () => {
    const state = table([], { uses: marks, hurt: ["acid"], turnRecord: record });
    const short = apply(state, { t: "actor.rest", target: { characterId: "thorn" }, kind: "short", heal: 0 });
    const s = short.characters.thorn!.actor;
    assert.deepEqual(Object.keys(s.uses!).sort(), ["actions:dominate-mind", "legendaryActions:fiery-rays"]);
    assert.deepEqual([s.hurt, s.turnRecord?.took], [["acid"], ["fire"]], "a Short Rest keeps the damage types");
    const long = apply(state, { t: "actor.rest", target: { characterId: "thorn" }, kind: "long" });
    const l = long.characters.thorn!.actor;
    assert.equal(l.uses, undefined);
    assert.equal(l.hurt, undefined);
    assert.deepEqual(l.turnRecord, { id: 4, entryId: "e1", round: 2, hp: 10, life: "alive" }, "the record stays, without its took");
  });

  test("a refused rest brings back nothing", () => {
    const state = table([rage], { hp: { cur: 0, max: 30, temp: 0 }, life: "dying" });
    const r = canApply({ t: "actor.rest", target: { characterId: "thorn" }, kind: "long" }, DM, state, { canUseAsset: () => true });
    assert.ok(r.ok);
    assert.throws(() => apply(state, { t: "actor.rest", target: { characterId: "thorn" }, kind: "long" }));
  });
});
