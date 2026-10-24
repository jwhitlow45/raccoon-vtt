import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, LogEvent, RoomState, UseMark } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, actor, apply, character, env, refused, room, token } from "../testutil.ts";
import { NO_LEGENDARY_LEFT, NO_RESISTANCE, USES_FULL, noResourceRefusal, noUsesRefusal, onceRefusal, usedRefusal } from "./uses.ts";

const dragonActor = (overrides: Partial<Actor> = {}) => actor({ hp: { cur: 200, max: 256, temp: 0 }, legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 }, ...overrides });

function table(overrides: Partial<Actor> = {}): RoomState {
  return room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: dragonActor(overrides) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }),
    },
    characters: {
      thorn: character("thorn", {
        name: "Thorn",
        resources: [
          { id: "rage", name: "Rage", max: 3, used: 0, reset: "shortOne", preset: "rage", level: 3, atLevel: 3 },
          { id: "loh", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true },
        ],
      }),
    },
  });
}

const use = (u: Extract<Op, { t: "actor.use" }>["use"], more: { back?: true; quiet?: true; target?: { tokenId: string } | { characterId: string } } = {}): Op => ({
  t: "actor.use",
  target: more.target ?? { tokenId: "dragon" },
  use: u,
  ...(more.back ? { back: true } : {}),
  ...(more.quiet ? { quiet: true } : {}),
});

const fieryRays = { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } as const;
const breath = { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } as const;
const dominate = { kind: "ability", key: "actions:dominate-mind", name: "Dominate Mind", limit: "day", max: 2 } as const;

function dragon(state: RoomState): Actor {
  const t = state.tokens.dragon!;
  assert.ok("inline" in t.actor);
  return t.actor.inline;
}

/** The use lines an op wrote, as the DM's log holds them, the creature's mark left out. */
function useLines(state: RoomState, op: Op, who = DM, seq = 1): Omit<Extract<LogEvent, { type: "use" }>, "tokenId" | "characterId" | "seen">[] {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r.log.flatMap((e) => {
    if (e.data?.type !== "use") return [];
    const { tokenId: _t, characterId: _c, seen: _s, ...rest } = e.data;
    return [rest];
  });
}

describe("actor.use (docs/design-v1-combat-controls.md 3.1)", () => {
  test("a legendary action spends its cost in pips, and a once a turn one marks itself until its creature's next turn", () => {
    let state = apply(table(), use({ kind: "legendary", cost: 2, key: "legendaryActions:wing-attack", name: "Wing Attack" }));
    assert.equal(dragon(state).legendary!.actionsUsed, 2);
    assert.equal(dragon(state).uses, undefined, "an action that may repeat leaves no mark");
    state = apply(table(), use(fieryRays));
    assert.equal(dragon(state).legendary!.actionsUsed, 1);
    assert.deepEqual(dragon(state).uses, { "legendaryActions:fiery-rays": { kind: "turn", name: "Fiery Rays", used: 1, max: 1 } });
    assert.equal(refused(state, use(fieryRays)).message, onceRefusal("Fiery Rays"));
    assert.equal(refused(state, use({ ...fieryRays, once: undefined })).message, onceRefusal("Fiery Rays"), "the mark holds even a send that forgot it");
    assert.deepEqual(useLines(table(), use(fieryRays)), [{ type: "use", what: "legendary", name: "Fiery Rays", left: 2, max: 3 }]);
    assert.deepEqual(useLines(table(), use({ kind: "legendary", cost: 2, key: "legendaryActions:wing-attack", name: "Wing Attack" })), [{ type: "use", what: "legendary", name: "Wing Attack", cost: 2, left: 1, max: 3 }]);
    assert.deepEqual(useLines(table(), use({ kind: "legendary", cost: 1 })), [{ type: "use", what: "legendary", left: 2, max: 3 }], "Spend one for counts set by hand");
  });

  test("a legendary action past the pips left, or by a creature without them, is refused", () => {
    const spent = table({ legendary: { actionsMax: 3, actionsUsed: 2, resistMax: 3, resistUsed: 0 } });
    assert.equal(refused(spent, use({ kind: "legendary", cost: 2, key: "legendaryActions:wing-attack", name: "Wing Attack" })).message, NO_LEGENDARY_LEFT);
    assert.equal(dragon(apply(spent, use({ kind: "legendary", cost: 1 }))).legendary!.actionsUsed, 3);
    assert.equal(refused(table({ legendary: undefined }), use({ kind: "legendary", cost: 1 })).message, NO_LEGENDARY_LEFT);
  });

  test("giving a legendary action back returns its pips and its mark, and with nothing to give changes nothing", () => {
    const state = apply(table(), use(fieryRays));
    const back = apply(state, use(fieryRays, { back: true }), DM, 2);
    assert.equal(dragon(back).legendary!.actionsUsed, 0);
    assert.equal(dragon(back).uses, undefined);
    assert.deepEqual(useLines(state, use(fieryRays, { back: true }), DM, 2), [{ type: "use", what: "legendary", name: "Fiery Rays", back: true, left: 3, max: 3 }]);
    const none = applyOp(table(), use(fieryRays, { back: true }), DM, env(2));
    assert.ok(none.ok);
    assert.deepEqual(none.touched, [], "nothing to give back writes nothing, no line either");
    const partly = apply(table({ legendary: { actionsMax: 3, actionsUsed: 1, resistMax: 3, resistUsed: 0 } }), use({ kind: "legendary", cost: 2, key: "legendaryActions:wing-attack", name: "Wing Attack" }, { back: true }));
    assert.equal(dragon(partly).legendary!.actionsUsed, 0, "a give back takes at most the pips spent");
  });

  test("Legendary Resistance spends one and gives one back", () => {
    const state = apply(table(), use({ kind: "resist" }));
    assert.equal(dragon(state).legendary!.resistUsed, 1);
    assert.deepEqual(useLines(table(), use({ kind: "resist" })), [{ type: "use", what: "resist", left: 2, max: 3 }]);
    assert.equal(dragon(apply(state, use({ kind: "resist" }, { back: true }), DM, 2)).legendary!.resistUsed, 0);
    const out = table({ legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 3 } });
    assert.equal(refused(out, use({ kind: "resist" })).message, NO_RESISTANCE);
    const none = applyOp(table(), use({ kind: "resist" }, { back: true }), DM, env(1));
    assert.ok(none.ok);
    assert.deepEqual(none.touched, []);
  });

  test("a recharge or rest ability is used once, and the Dice panel's mark of a used one changes nothing", () => {
    const state = apply(table(), use(breath));
    assert.deepEqual(dragon(state).uses, { "actions:fire-breath": { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 } });
    assert.equal(refused(state, use(breath)).message, usedRefusal("Fire Breath"));
    const marked = applyOp(state, use({ ...breath, ifReady: true }), DM, env(2));
    assert.ok(marked.ok);
    assert.deepEqual(marked.touched, [], "ifReady on an ability already used refuses nothing and writes nothing");
    assert.deepEqual(useLines(table(), use(breath)), [{ type: "use", what: "ability", name: "Fire Breath" }]);
    const phantasms = apply(table(), use({ kind: "ability", key: "actions:phantasms", name: "Phantasms", limit: "rest", max: 1 }));
    assert.deepEqual(dragon(phantasms).uses, { "actions:phantasms": { kind: "rest", name: "Phantasms", used: 1, max: 1 } });
  });

  test("an X a day ability counts its uses, and a give back returns one", () => {
    let state = apply(table(), use(dominate));
    assert.deepEqual(useLines(table(), use(dominate)), [{ type: "use", what: "ability", name: "Dominate Mind", left: 1, max: 2 }]);
    state = apply(state, use(dominate), DM, 2);
    assert.deepEqual(dragon(state).uses!["actions:dominate-mind"], { kind: "day", name: "Dominate Mind", used: 2, max: 2 });
    assert.equal(refused(state, use(dominate), DM, 3).message, noUsesRefusal("Dominate Mind"));
    state = apply(state, use(dominate, { back: true }), DM, 3);
    assert.equal(dragon(state).uses!["actions:dominate-mind"]!.used, 1);
    assert.deepEqual(useLines(state, use(dominate, { back: true }), DM, 4), [{ type: "use", what: "ability", name: "Dominate Mind", back: true, left: 2, max: 2 }]);
    state = apply(state, use(dominate, { back: true }), DM, 4);
    assert.equal(dragon(state).uses, undefined, "the last use back takes the mark");
    const short = apply(table(), use({ ...dominate, short: true }));
    assert.equal(dragon(short).uses!["actions:dominate-mind"]!.short, true);
  });

  test("giving back a recharge is Mark ready, and a mark under a key is given back by its stored name", () => {
    const state = apply(table(), use(breath));
    const back = apply(state, use(breath, { back: true }), DM, 2);
    assert.equal(dragon(back).uses, undefined);
    // The block was edited since: the key's mark still reads by the name it stored (3.2).
    assert.deepEqual(useLines(state, use({ ...breath, name: "Renamed Breath" }, { back: true }), DM, 2), [{ type: "use", what: "ability", name: "Fire Breath", back: true }]);
  });

  test("a mark of another kind under the key is from a block edited since, and the use reads the block as it is", () => {
    const state = table({ uses: { "actions:fire-breath": { kind: "day", name: "Fire Breath", used: 1, max: 1 } } });
    const used = apply(state, use(breath));
    assert.deepEqual(dragon(used).uses!["actions:fire-breath"], { kind: "recharge", name: "Fire Breath", used: 1, max: 1, min: 5 });
  });

  test("a spend that would hold a seventeenth mark is refused, and one under a held key is not", () => {
    const uses: Record<string, UseMark> = {};
    for (let i = 0; i < 16; i++) uses[`actions:a${i}`] = { kind: "day", name: `A${i}`, used: 1, max: 3 };
    const state = table({ uses });
    assert.equal(refused(state, use(breath)).message, USES_FULL);
    assert.equal(refused(state, use(fieryRays)).message, USES_FULL);
    assert.equal(dragon(apply(state, use({ kind: "ability", key: "actions:a0", name: "A0", limit: "day", max: 3 }))).uses!["actions:a0"]!.used, 2);
  });

  test("a class resource spends one, a pool an amount, and each gives back", () => {
    let state = apply(table(), use({ kind: "resource", id: "rage" }, { target: { tokenId: "thorn" } }), P1);
    assert.equal(state.characters.thorn!.resources![0]!.used, 1);
    assert.deepEqual(useLines(table(), use({ kind: "resource", id: "rage" }, { target: { characterId: "thorn" } }), P1), [{ type: "use", what: "resource", name: "Rage", left: 2, max: 3 }]);
    state = apply(state, use({ kind: "resource", id: "loh", amount: 5 }, { target: { characterId: "thorn" } }), P1, 2);
    assert.equal(state.characters.thorn!.resources![1]!.used, 5);
    assert.deepEqual(useLines(table(), use({ kind: "resource", id: "loh", amount: 5 }, { target: { characterId: "thorn" } })), [{ type: "use", what: "resource", name: "Lay on Hands", left: 20, max: 25, cost: 5 }]);
    assert.equal(refused(state, use({ kind: "resource", id: "loh", amount: 21 }, { target: { characterId: "thorn" } }), P1, 3).message, noResourceRefusal("Lay on Hands", 20));
    assert.equal(refused(state, use({ kind: "resource", id: "rage", amount: 1 }, { target: { characterId: "thorn" } }), P1, 3).message, "Only a pool spends an amount.");
    state = apply(state, use({ kind: "resource", id: "loh", amount: 30 }, { target: { characterId: "thorn" }, back: true }), P1, 3);
    assert.equal(state.characters.thorn!.resources![1]!.used, 0, "a give back stops at none used");
    const full = { ...table() };
    full.characters = { thorn: { ...full.characters.thorn!, resources: [{ id: "rage", name: "Rage", max: 3, used: 3, reset: "shortOne" }] } };
    assert.equal(refused(full, use({ kind: "resource", id: "rage" }, { target: { characterId: "thorn" } })).message, "Rage has no uses left.");
    assert.equal(refused(table(), use({ kind: "resource", id: "rage" })).message, "Only a character has class resources.");
    assert.equal(refused(table(), use({ kind: "resource", id: "ki" }, { target: { characterId: "thorn" } })).code, "invalid");
  });

  test("a pool of units from a fixed cost of 2 (docs/design-v1-ddb-resources.md 1.1, ASTRA-7): Use spends 2 of 8, four spends empty it, a fifth is refused", () => {
    let state = table();
    state.characters = { thorn: { ...state.characters.thorn!, resources: [{ id: "grit", name: "Grit Points", max: 8, used: 0, reset: "short", pool: true }] } };
    for (let i = 1; i <= 4; i++) {
      state = apply(state, use({ kind: "resource", id: "grit", amount: 2 }, { target: { characterId: "thorn" } }), P1, i);
      assert.equal(state.characters.thorn!.resources![0]!.used, 2 * i);
    }
    assert.equal(refused(state, use({ kind: "resource", id: "grit", amount: 2 }, { target: { characterId: "thorn" } }), P1, 5).message, noResourceRefusal("Grit Points", 0));
  });

  test("a use after a secret roll writes a hidden line", () => {
    assert.deepEqual(useLines(table(), use({ ...breath, ifReady: true }, { quiet: true })), [{ type: "use", what: "ability", name: "Fire Breath", hidden: true }]);
    assert.deepEqual(useLines(table(), use({ kind: "resist" }, { quiet: true })), [{ type: "use", what: "resist", left: 2, max: 3, hidden: true }]);
  });

  test("a use line names a token with its seen mark, and a character's resource by the character", () => {
    const r = applyOp(table(), use(fieryRays), DM, env(1));
    assert.ok(r.ok);
    assert.equal(r.log[0]!.data?.type === "use" && r.log[0]!.data.tokenId, "dragon");
    assert.equal(r.log[0]!.data?.type === "use" && r.log[0]!.data.seen, true);
    const hidden = table();
    hidden.tokens.dragon = { ...hidden.tokens.dragon!, visibility: "dm" };
    const h = applyOp(hidden, use(fieryRays), DM, env(1));
    assert.ok(h.ok);
    assert.equal(h.log[0]!.data?.type === "use" && h.log[0]!.data.seen, undefined, "a hidden creature's use has no seen mark");
    const c = applyOp(table(), use({ kind: "resource", id: "rage" }, { target: { tokenId: "thorn" } }), P1, env(1));
    assert.ok(c.ok);
    assert.equal(c.log[0]!.data?.type === "use" && c.log[0]!.data.characterId, "thorn");
  });
});
