import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { normalizeCompanionState } from "#shared/reducer/companions.ts";
import { DM, actor, character, companionBlock, customMonster, effect, entry, env, room, token } from "#shared/testutil.ts";
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

describe("a saved step's row flags through an import (design 9.4, op version 21)", () => {
  test("they come through under the rows' new ids, a row that did not come through is left out, and an empty list stays", () => {
    const before = played();
    assert.equal(before.encounterHistory.length, 3);
    before.encounterHistory[0]!.turnFlags = [
      { entryId: "et", flags: ["reactionUsed", "hidden"] },
      { entryId: "gone", flags: ["hidden"] },
    ];
    assert.deepEqual(before.encounterHistory[1]!.turnFlags, [], "a Next saves its flags, none here");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(before)));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    let n = 0;
    const out = remapState(parsed.state, { assets: new Map(), newId: () => `n${n++}` });
    const thorn = Object.values(out.tokens).find((t) => t.name === "Thorn")!.id;
    const row = out.encounter!.entries.find((e) => e.tokenId === thorn)!.id;
    assert.deepEqual(out.encounterHistory[0]!.turnFlags, [{ entryId: row, flags: ["reactionUsed", "hidden"] }]);
    assert.deepEqual(out.encounterHistory[1]!.turnFlags, [], "so Previous still takes back only the turn");
    const bad = JSON.parse(JSON.stringify(before));
    bad.encounterHistory[0].turnFlags[0].flags = ["value"];
    assert.equal(parseRoomState(bad).ok, false, "a row's value is never a flag Previous puts back");
  });
});

describe("a saved step through an import keeps the turns that left the fight (design 9.4, reviews FU26-ASTRA-1 and FU26-OPUS-7)", () => {
  let seq = 0;
  const play = (state: RoomState, ops: readonly Op[], opVersion?: number): RoomState => {
    for (const op of ops) {
      const r = applyOp(state, op, DM, { ...env(++seq), ...(opVersion === undefined ? {} : { opVersion }) });
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
    }
    return state;
  };
  const imported = (state: RoomState, edit: (file: RoomState) => void = () => {}): RoomState => {
    const file = JSON.parse(JSON.stringify(state)) as RoomState;
    edit(file);
    const parsed = parseRoomState(file);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    let n = 0;
    return remapState(parsed.state, { assets: new Map(), newId: () => `n${n++}` });
  };
  const acting = (state: RoomState) => {
    const row = state.encounter!.entries.find((e) => e.id === state.encounter!.activeEntryId);
    return row ? state.tokens[row.tokenId!]!.name : null;
  };
  /** Every duration of the room's creatures that counts a row outside the fight. */
  const strays = (state: RoomState) => {
    const inFight = new Set(state.encounter?.entries.map((e) => e.id) ?? []);
    const actors = [...Object.values(state.tokens).flatMap((t) => ("inline" in t.actor ? [t.actor.inline] : [])), ...Object.values(state.characters).map((c) => c.actor)];
    return actors.flatMap((a) => a.effects.filter((e) => e.duration && "entryId" in e.duration.anchor && !inFight.has(e.duration.anchor.entryId)).map((e) => e.id));
  };
  const NEXT: Op = { t: "encounter.next" };
  const PREV: Op = { t: "encounter.prev" };
  /** A, B and C, with C Marked until the start of B's turn three times. */
  function abc(): RoomState {
    const state = room({
      tokens: {
        a: token("a", { name: "A" }),
        b: token("b", { name: "B" }),
        c: token("c", { name: "C", actor: { inline: actor({ effects: [effect("mk", { key: "custom", label: "Marked", duration: { remaining: 3, boundary: "turnStart", anchor: { entryId: "eb" } } })] }) } }),
      },
    });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("ea", { tokenId: "a", value: 20 }), entry("eb", { tokenId: "b", value: 15, tieOrder: 1 }), entry("ec", { tokenId: "c", value: 10, tieOrder: 2 })] };
    return state;
  }

  test("B removed on C's turn: after an import Previous resumes A, as without one, and no duration ever counts a row outside the fight", () => {
    const removed = play(abc(), [NEXT, NEXT, NEXT, { t: "encounter.remove", entryIds: ["eb"] }]);
    const plain = play(removed, [PREV]);
    assert.equal(acting(plain), "A");
    const room1 = imported(removed);
    assert.ok(room1.encounterHistory.every((step) => step.encounter.entries.some((e) => room1.tokens[e.tokenId!]?.name === "B")), "the saved steps keep B's row");
    const back = play(room1, [PREV]);
    assert.equal(acting(back), "A");
    assert.equal(back.encounterHistory.length, plain.encounterHistory.length);
    assert.deepEqual(strays(back), []);
    const marked = (s: RoomState) => Object.values(s.tokens).find((t) => t.name === "C")!.actor;
    const count = (s: RoomState) => {
      const a = marked(s);
      return "inline" in a ? a.inline.effects.map((e) => e.duration?.remaining) : [];
    };
    assert.deepEqual(count(back), count(plain), "the count B's turn lowered goes back, as without the import");
    assert.deepEqual(count(plain), [3]);
    const first = play(back, [PREV]);
    assert.equal(acting(first), null);
    assert.deepEqual(strays(first), []);
  });

  test("steps a version 20 Next saved come through with B's row, so Previous puts back the whole encounter with every duration counting a row of it", () => {
    const removed = play(abc(), [NEXT, NEXT, NEXT, { t: "encounter.remove", entryIds: ["eb"] }], 20);
    const back = play(imported(removed), [PREV]);
    assert.equal(acting(back), "B");
    assert.deepEqual(strays(back), []);
    assert.deepEqual(strays(play(back, [PREV])), []);
  });

  test("a step whose turn was a row that did not come through says that turn left, and its encounter passes it to no row", () => {
    const removed = play(abc(), [NEXT, NEXT, NEXT, { t: "encounter.remove", entryIds: ["eb"] }]);
    const room1 = imported(removed, (file) => {
      delete file.tokens.b;
    });
    const top = room1.encounterHistory.at(-1)!;
    assert.equal(top.resumesGone, true);
    assert.equal(top.encounter.activeEntryId, null);
    assert.ok(!top.encounter.entries.some((e) => e.tokenId === "b"));
    const back = play(room1, [PREV]);
    assert.equal(acting(back), "A");
    assert.deepEqual(strays(back), []);
  });

  test("an effect B's turn ended comes back through an import counting B's row, paused on B once B left, and bound to B's row added again (review FU26-ASTRA, expired effects)", () => {
    const shortened = (): RoomState => {
      const state = abc();
      // Until the start of B's next turn, which B's turn ends.
      state.tokens.c = { ...state.tokens.c!, actor: { inline: actor({ effects: [effect("short", { key: "custom", label: "Until B's turn", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "eb" } } })] }) } };
      // A save at the end of A's turns, whose occurrence names a line of the old room's log.
      state.tokens.a = { ...state.tokens.a!, actor: { inline: actor({ effects: [effect("ps", { key: "poisoned", save: { ability: "con", dc: 12 }, duration: { remaining: 5, boundary: "turnEnd", anchor: { entryId: "ea" } } })] }) } };
      return state;
    };
    const cEffects = (s: RoomState) => {
      const a = Object.values(s.tokens).find((t) => t.name === "C")!.actor;
      return "inline" in a ? a.inline.effects : [];
    };
    const bRow = (s: RoomState) => s.encounter!.entries.find((e) => s.tokens[e.tokenId!]?.name === "B")?.id;
    const bToken = (s: RoomState) => Object.values(s.tokens).find((t) => t.name === "B")!.id;
    const onC = play(shortened(), [NEXT, NEXT, NEXT]);
    assert.deepEqual(cEffects(onC), [], "B's turn ended it");
    assert.ok(onC.encounterHistory.some((h) => h.effectChanges?.some((c) => c.asked)), "A's turn end opened an occurrence");
    const through = imported(onC).encounterHistory;
    assert.ok(through.some((h) => h.effectChanges?.some((c) => c.ended)), "the step that ended it comes through with its change");
    assert.ok(through.every((h) => (h.effectChanges ?? []).every((c) => c.asked === undefined)), "and no occurrence of the old room's log");

    const kept = play(imported(onC), [PREV, PREV]);
    assert.equal(acting(kept), "A");
    assert.deepEqual(cEffects(kept).map((e) => [e.id, e.duration?.anchor]), [["short", { entryId: bRow(kept) }]]);

    const removed = play(onC, [{ t: "encounter.remove", entryIds: ["eb"] }]);
    const paused = play(imported(removed), [PREV]);
    assert.equal(acting(paused), "A");
    assert.deepEqual(cEffects(paused).map((e) => [e.id, e.duration?.anchor]), [["short", { tokenId: bToken(paused) }]]);
    assert.deepEqual(strays(paused), []);

    const room2 = imported(removed);
    const readded = play(room2, [{ t: "encounter.add", entries: [{ id: "eb2", tokenId: bToken(room2), value: 15 }] }, PREV]);
    assert.deepEqual(cEffects(readded).map((e) => [e.id, e.duration?.anchor]), [["short", { entryId: "eb2" }]]);
    assert.deepEqual(strays(readded), []);
  });

  test("a duration a saved step counts on a row that did not come through pauses on its creature, so Previous puts back none counting a row outside the fight", () => {
    const removed = play(abc(), [NEXT, NEXT, NEXT, { t: "encounter.remove", entryIds: ["eb"] }], 20);
    const room1 = imported(removed, (file) => {
      delete file.tokens.b;
    });
    const back = play(room1, [PREV, PREV]);
    assert.deepEqual(strays(back), []);
    const c = Object.values(back.tokens).find((t) => t.name === "C")!.actor;
    assert.ok("inline" in c);
    assert.deepEqual(c.inline.effects[0]!.duration?.anchor, { tokenId: "b" }, "paused on B, whom the import did not bring");
  });

  test("a companion whose rows the import takes out, as one acting on its character's turn, is walked past too", () => {
    const state = room({
      characters: { hero: character("hero", { name: "Hero" }) },
      tokens: {
        a: token("a", { kind: "pc", name: "A", actor: { ref: "hero" } }),
        b: token("b", { kind: "npc", name: "B", companion: { of: "hero", turn: "own" } }),
        c: token("c", { name: "C" }),
      },
    });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("ea", { tokenId: "a", value: 20 }), entry("eb", { tokenId: "b", value: 15, tieOrder: 1 }), entry("ec", { tokenId: "c", value: 10, tieOrder: 2 })] };
    const onC = play(state, [NEXT, NEXT, NEXT]);
    const room1 = imported(onC, (file) => {
      file.tokens.b!.companion = { of: "hero", turn: "shared" };
    });
    const top = room1.encounterHistory.at(-1)!;
    assert.equal(top.resumesGone, true);
    assert.ok(!top.encounter.entries.some((e) => e.tokenId !== undefined && room1.tokens[e.tokenId]?.name === "B"));
    const back = play(room1, [PREV]);
    assert.equal(acting(back), "A");
  });
});

describe("marks through an import that changes a link (docs/design-v1-combat-controls.md 2.4 and 3.6)", () => {
  /** The fight with the lurker's own turn begun, Lunge saved by its start, and Acid Spit spent since. */
  function file(): RoomState {
    let state = played();
    const r = applyOp(state, { t: "actor.use", target: { tokenId: "lurker" }, use: { kind: "ability", key: "actions:acid-spit", name: "Acid Spit", limit: "recharge", max: 1, min: 5 } }, DM, env(50));
    assert.ok(r.ok);
    state = r.state;
    const active = state.encounter!.entries.find((e) => e.id === state.encounter!.activeEntryId);
    assert.equal(active?.tokenId, "lurker");
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok);
    return parsed.state;
  }
  const imported = (state: RoomState) => {
    let n = 0;
    const out = remapState(state, { assets: new Map(), newId: () => `n${n++}` });
    const lurker = Object.values(out.tokens).find((t) => t.name === "Cave Lurker")!.id;
    const prev = applyOp(out, { t: "encounter.prev" }, DM, env(1));
    assert.ok(prev.ok);
    return { out, lurker, back: prev.state };
  };

  test("a room monster that did not come through takes the marks keyed by it, and Previous brings none back", () => {
    const state = file();
    delete state.monsters.lurker;
    const { out, lurker, back } = imported(state);
    assert.equal(inline(out, lurker).monsterId, undefined);
    assert.equal(inline(out, lurker).uses, undefined);
    assert.ok(!out.encounterHistory.some((s) => s.turnUses?.some((u) => u.holderId === lurker && u.marks)), "no saved mark keyed by the old block");
    assert.equal(inline(back, lurker).uses, undefined);
    assert.equal(inline(back, lurker).legendary!.actionsUsed, 1, "its pips come back, since it keeps its legendary actions");
  });

  test("a room monster under its new id keeps its marks, and Previous brings back the ones its start took", () => {
    const { out, lurker, back } = imported(file());
    assert.deepEqual(Object.keys(inline(out, lurker).uses ?? {}), ["actions:acid-spit"]);
    assert.deepEqual(Object.keys(inline(back, lurker).uses ?? {}).sort(), ["actions:acid-spit", "legendaryActions:lunge"]);
    assert.equal(inline(back, lurker).legendary!.actionsUsed, 1);
  });

  test("a landing creature's saved link comes through, so one relinked after the import gets no pips back from Previous", () => {
    let state = room({
      tokens: {
        dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: actor({ srdId: "adult-red-dragon", legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } }) } }),
        gob: token("gob", { name: "Goblin" }),
      },
    });
    const ops: Op[] = [
      { t: "encounter.start", entries: [{ id: "eg", tokenId: "gob", value: 20 }, { id: "ed", tokenId: "dragon", value: 10 }] },
      { t: "encounter.next" },
      { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 2 } },
      { t: "encounter.next" },
    ];
    ops.forEach((op, i) => {
      const r = applyOp(state, op, DM, env(i + 1));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
    });
    const parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
    assert.ok(parsed.ok);
    let n = 0;
    const out = remapState(parsed.state, { assets: new Map(), newId: () => `n${n++}` });
    const dragon = Object.values(out.tokens).find((t) => t.name === "Adult Red Dragon")!.id;
    assert.equal(inline(out, dragon).legendary!.actionsUsed, 0);
    const kept = applyOp(out, { t: "encounter.prev" }, DM, env(1));
    assert.ok(kept.ok);
    assert.equal(inline(kept.state, dragon).legendary!.actionsUsed, 2, "the same block gets its pips back");
    const relinked = applyOp(out, { t: "token.update", tokenId: dragon, patch: { actor: { srdId: "ancient-red-dragon" } } }, DM, env(1));
    assert.ok(relinked.ok);
    const back = applyOp(relinked.state, { t: "encounter.prev" }, DM, env(2));
    assert.ok(back.ok);
    assert.equal(inline(back.state, dragon).legendary!.actionsUsed, 0, "a new block does not");
  });

  test("the companion rules dropping a block link take its marks, and an SRD link keeps them", () => {
    const gust = { kind: "day", name: "Gust", used: 1, max: 1 } as const;
    const state = room({
      characters: { c1: character("c1", { name: "Bree", ownerIds: ["p1"], actor: actor({ blockId: "cb0", uses: { "actions:gust": gust } }) }) },
      tokens: {
        stray: token("stray", { kind: "npc", name: "Stray", actor: { inline: actor({ blockId: "cb0", uses: { "actions:gust": gust } }) } }),
        owl: token("owl", { kind: "npc", name: "Owl", actor: { inline: actor({ srdId: "owl", uses: { "actions:talons": gust } }) } }),
        moth: token("moth", { kind: "npc", name: "Moth", ownerIds: ["p1"], companion: { of: "c1", turn: "shared" }, actor: { inline: actor({ srdId: "owl", blockId: "cb0", uses: { "actions:talons": gust } }) } }),
      },
    });
    state.companionBlocks.cb0 = companionBlock("cb0", "c1");
    const out = normalizeCompanionState(state);
    assert.equal(inline(out, "stray").blockId, undefined);
    assert.equal(inline(out, "stray").uses, undefined);
    assert.equal(out.characters.c1!.actor.uses, undefined);
    assert.deepEqual(inline(out, "owl").uses, { "actions:talons": gust });
    assert.deepEqual([inline(out, "moth").srdId, inline(out, "moth").blockId], [undefined, "cb0"], "a companion's own block wins over its other links");
    assert.equal(inline(out, "moth").uses, undefined, "and the marks keyed by the SRD creature go");
  });
});
