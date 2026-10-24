import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { DM, actor, character, customMonster, env, room, token } from "#shared/testutil.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Combat uses through an export and an import
 * (docs/design-v1-combat-controls.md 3.6): marks, class resources and the
 * saved turns' marks and pips come through, each holder under its new id.
 * Turn records, and the damage types only a record's start reads, are named
 * by seqs of the old room, so they go, as does the record each saved turn
 * replaced.
 */

function played(): RoomState {
  let state = room({
    monsters: { lurker: customMonster("lurker") },
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: actor({ hp: { cur: 200, max: 256, temp: 0 }, legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } }) } }),
      lurker: token("lurker", { name: "Cave Lurker", actor: { inline: actor({ monsterId: "lurker", legendary: { actionsMax: 1, actionsUsed: 0, resistMax: 0, resistUsed: 0 } }) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }),
      wolf: token("wolf", { kind: "npc", name: "Wolf", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor({ legendary: { actionsMax: 1, actionsUsed: 0, resistMax: 0, resistUsed: 0 } }) } }),
    },
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], resources: [{ id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne" }] }) },
  });
  const ops: Op[] = [
    { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "ed", tokenId: "dragon", value: 15 }, { id: "el", tokenId: "lurker", value: 10 }] },
    { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } },
    { t: "actor.use", target: { tokenId: "wolf" }, use: { kind: "legendary", cost: 1 } },
    { t: "actor.use", target: { tokenId: "lurker" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:lunge", name: "Lunge", once: true } },
    { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } },
    { t: "actor.use", target: { characterId: "thorn" }, use: { kind: "resource", id: "rage" } },
    { t: "actor.hp", target: { tokenId: "dragon" }, change: { kind: "damage", amount: 5, types: ["cold"] } },
    { t: "encounter.next" },
    { t: "actor.hp", target: { tokenId: "dragon" }, change: { kind: "damage", amount: 5, types: ["fire"] } },
    { t: "encounter.next" },
    { t: "encounter.next" },
    { t: "actor.hp", target: { tokenId: "dragon" }, change: { kind: "damage", amount: 2, types: ["acid"] } },
  ];
  ops.forEach((op, i) => {
    const r = applyOp(state, op, DM, env(i + 1));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    state = r.state;
  });
  return state;
}

const inline = (state: RoomState, id: string): Actor => {
  const t = state.tokens[id]!;
  assert.ok("inline" in t.actor);
  return t.actor.inline;
};

describe("combat uses through an import (docs/design-v1-combat-controls.md 3.6)", () => {
  test("the stored-state schema takes every new field, and the import drops records and damage types and keeps marks, resources and saved turns", () => {
    const before = played();
    assert.ok(Object.values(before.tokens).some((t) => "inline" in t.actor && t.actor.inline.turnRecord), "the fight has records");
    assert.ok(inline(before, "dragon").hurt, "and damage types");
    assert.ok(before.encounterHistory.some((s) => s.turnUses?.some((u) => u.record !== undefined)), "and saved turns");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(before)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    let n = 0;
    const out = remapState(parsed.state, { assets: new Map(), newId: () => `n${n++}` });
    const newId = (old: string) => Object.values(out.tokens).find((t) => t.name === before.tokens[old]!.name)!.id;
    for (const t of Object.values(out.tokens)) if ("inline" in t.actor) assert.equal(t.actor.inline.turnRecord ?? t.actor.inline.hurt, undefined, t.name);
    for (const c of Object.values(out.characters)) assert.equal(c.actor.turnRecord ?? c.actor.hurt, undefined);
    assert.deepEqual(inline(out, newId("dragon")).uses, inline(before, "dragon").uses);
    assert.deepEqual(Object.values(out.characters)[0]!.resources, before.characters.thorn!.resources);
    const saved = out.encounterHistory.flatMap((s) => s.turnUses ?? []);
    assert.ok(saved.length > 0);
    for (const u of saved) {
      assert.equal(u.record, undefined, "the record a start replaced goes");
      assert.ok(out.tokens[u.holderId] ?? out.characters[u.holderId], "its holder is under its new id");
    }
    const lurker = saved.find((u) => u.holderId === newId("lurker"));
    const newMonster = Object.keys(out.monsters)[0]!;
    assert.ok(lurker, "the lurker's turn was saved");
    assert.equal(lurker.link, `monster:${newMonster}`, "a room monster's link follows its new id");
    assert.ok(parseRoomState(JSON.parse(JSON.stringify(out))).ok, "the imported room is a valid room");
  });

  test("a new turn whose seq equals an imported record's id starts anew, and Previous over an imported step leaves records as they are", () => {
    const before = played();
    const oldIds = Object.values(before.tokens).flatMap((t) => ("inline" in t.actor && t.actor.inline.turnRecord ? [t.actor.inline.turnRecord.id] : []));
    const parsed = parseRoomState(JSON.parse(JSON.stringify(before)));
    assert.ok(parsed.ok);
    let n = 0;
    let state = remapState(parsed.state, { assets: new Map(), newId: () => `n${n++}` });
    const seq = oldIds[0]!;
    const next = applyOp(state, { t: "encounter.next" }, DM, env(seq));
    assert.ok(next.ok);
    state = next.state;
    const active = state.encounter!.entries.find((e) => e.id === state.encounter!.activeEntryId)!;
    const t = state.tokens[active.tokenId!]!;
    const record = "inline" in t.actor ? t.actor.inline.turnRecord : state.characters[t.actor.ref]!.actor.turnRecord;
    if (record) {
      assert.equal(record.id, seq);
      assert.equal(record.entryId, active.id, "the record is the new turn's, not an imported one");
    }
    const prev = applyOp(state, { t: "encounter.prev" }, DM, env(seq + 1));
    assert.ok(prev.ok);
    const back = applyOp(prev.state, { t: "encounter.prev" }, DM, env(seq + 2));
    assert.ok(back.ok, "an imported saved turn goes back with no record to put back");
  });
});
