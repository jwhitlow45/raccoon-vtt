import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Effect, InitEntry, RoomState } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, actor, character, effect, entry, env, room, token } from "../testutil.ts";
import type { Env } from "./tx.ts";

/**
 * Previous takes back only what Next did (design 9.4, op version 21,
 * LP20-REG-1 and LP20-CC-3): the round, the active row and its turn start,
 * and the row flags Next set, with the effects, pips, records and reveals
 * as before. The rows the DM added, removed or changed during the turn
 * stay as the DM left them. Ops stored before version 21 replay by the old
 * rule, which put back the step's whole encounter.
 */
const at = (seq: number, opVersion?: number): Env => ({ ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });

const NEXT: Op = { t: "encounter.next" };
const PREV: Op = { t: "encounter.prev" };
const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };

/** The dragon (19), Thorn (15) and the troll (10) in a fight before its first turn, and a goblin out of it. */
function fight(): RoomState {
  const state = room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: actor({ legendary, xp: 18000 }) } }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"] }),
      troll: token("troll", { name: "Troll" }),
      gob: token("gob", { name: "Goblin 1" }),
    },
  });
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: null,
    entries: [entry("ed", { tokenId: "dragon", value: 19 }), entry("et", { tokenId: "thorn", value: 15 }), entry("er", { tokenId: "troll", value: 10 })],
  };
  return state;
}

let seq = 1;
/** Applies each op as the DM at the given op version, live when none, and fails on a refusal. */
function play(state: RoomState, ops: readonly Op[], opVersion?: number): RoomState {
  let s = state;
  for (const op of ops) {
    const r = applyOp(s, op, DM, at(++seq, opVersion));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    s = r.state;
  }
  return s;
}

/** The fight's rows in order as `id:value`, with `lair` when In lair is on. */
function rows(state: RoomState): string[] {
  return state.encounter!.entries.map((e) => `${e.id}:${e.value}${e.inLair ? ":lair" : ""}`);
}
const row = (state: RoomState, id: string): InitEntry | undefined => state.encounter!.entries.find((e) => e.id === id);
const turn = (state: RoomState) => [state.encounter!.activeEntryId, state.encounter!.round];
const inline = (state: RoomState, id: string): Actor => {
  const a = state.tokens[id]!.actor;
  assert.ok("inline" in a);
  return a.inline;
};
const unrev = (tokens: RoomState["tokens"]) => Object.values(tokens).map(({ rev: _rev, ...t }) => t);
const stableJson = (value: unknown) => JSON.stringify(value);
/** The same fight in a fresh copy, so a test can play one state twice. */
const fight2 = (state: RoomState): RoomState => structuredClone(state);
const anchors = (effects: readonly Effect[]) => effects.map((e) => [e.id, e.duration?.remaining, e.duration?.anchor]);

describe("Previous takes back only the turn (design 9.4, op version 21)", () => {
  test("a row added during the turn stays in the fight, and the turn goes back", () => {
    const onThorn = play(fight(), [NEXT, NEXT]);
    assert.deepEqual(turn(onThorn), ["et", 1]);
    const back = play(onThorn, [{ t: "encounter.add", entries: [{ id: "eg", tokenId: "gob", value: 12 }] }, PREV]);
    assert.deepEqual(turn(back), ["ed", 1]);
    assert.deepEqual(rows(back), ["ed:19", "et:15", "eg:12", "er:10"]);
    assert.equal(back.encounter!.turnStart?.entryId, "ed", "the dragon's turn resumes where it began");
    assert.deepEqual(turn(play(back, [NEXT, NEXT])), ["eg", 1], "Next goes on through the row added");
  });

  test("a row removed during the turn stays out", () => {
    const back = play(fight(), [NEXT, NEXT, { t: "encounter.remove", entryIds: ["er"] }, PREV]);
    assert.deepEqual(turn(back), ["ed", 1]);
    assert.deepEqual(rows(back), ["ed:19", "et:15"]);
  });

  test("the acting row removed: the turn it passed on is taken back too, to the row before, and the row stays out", () => {
    const passed = play(fight(), [NEXT, NEXT, { t: "encounter.remove", entryIds: ["et"] }]);
    assert.deepEqual(turn(passed), ["er", 1], "the removal passed the turn on");
    assert.equal(row(passed, "er")!.hadTurn, true);
    const back = play(passed, [PREV]);
    assert.deepEqual(turn(back), ["ed", 1]);
    assert.deepEqual(rows(back), ["ed:19", "er:10"]);
    assert.equal(row(back, "er")!.hadTurn, undefined, "the turn it passed on never came");
    assert.equal(back.encounter!.turnStart?.entryId, "ed");
    assert.equal(back.encounterHistory.length, 1);
  });

  test("a value set during the turn stays, and Next follows the order it makes: Thorn, moved past the turn that resumes, waits for the next round", () => {
    const back = play(fight(), [NEXT, NEXT, { t: "encounter.setValue", entryId: "er", value: 8 }, { t: "encounter.setValue", entryId: "et", value: 20 }, PREV]);
    assert.deepEqual(turn(back), ["ed", 1]);
    assert.deepEqual(rows(back), ["et:20", "ed:19", "er:8"]);
    assert.deepEqual(turn(play(back, [NEXT])), ["er", 1]);
    assert.deepEqual(turn(play(back, [NEXT, NEXT])), ["et", 2]);
  });

  test("a controlled ride taken during the turn keeps the mount's row where the ride put it, so Bree, moved past the turn that resumes, waits for the next round (review FU26-OPUS-3)", () => {
    const state = room({
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4 }),
        bree: token("bree", { name: "Bree", kind: "pc", x: 5, y: 4, ownerIds: ["p2"] }),
        gob: token("gob", { name: "Goblin", x: 20, y: 20 }),
      },
    });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("eh", { tokenId: "horse", value: 20 }), entry("eb", { tokenId: "bree", value: 15, tieOrder: 1 }), entry("eg", { tokenId: "gob", value: 10, tieOrder: 2 })] };
    const onBree = play(state, [NEXT, NEXT, { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 }]);
    assert.deepEqual(rows(onBree), ["eb:15", "eh:15", "eg:10"], "the ride put the horse's row after Bree's");
    assert.equal(row(onBree, "eh")!.skipRound, 1, "and Next passes over it for the round, since it acted");
    const back = play(onBree, [PREV]);
    assert.deepEqual(turn(back), ["eh", 1]);
    assert.deepEqual(rows(back), ["eb:15", "eh:15", "eg:10"]);
    assert.deepEqual(turn(play(back, [NEXT])), ["eg", 1]);
    assert.deepEqual(turn(play(back, [NEXT, NEXT])), ["eb", 2]);
  });

  test("In lair turned on during the turn stays on, with the counts and XP it gave (LP20-CC-3)", () => {
    const lair: Op = { t: "encounter.update", entryId: "ed", patch: { inLair: true }, counts: { actionsMax: 4, resistMax: 4, xp: 20000 } };
    const back = play(fight(), [NEXT, NEXT, lair, PREV]);
    assert.deepEqual(rows(back), ["ed:19:lair", "et:15", "er:10"]);
    assert.equal(inline(back, "dragon").legendary?.actionsMax, 4);
    assert.equal(inline(back, "dragon").xp, 20000);
  });

  test("the round that wrapped goes back, and a row added on the new round's first turn stays", () => {
    const wrapped = play(fight(), [NEXT, NEXT, NEXT, NEXT]);
    assert.deepEqual(turn(wrapped), ["ed", 2]);
    const back = play(wrapped, [{ t: "encounter.add", entries: [{ id: "eg", tokenId: "gob", value: 12 }] }, PREV]);
    assert.deepEqual(turn(back), ["er", 1]);
    assert.deepEqual(rows(back), ["ed:19", "et:15", "eg:12", "er:10"]);
  });

  test("the flags Next set go back, and a Reaction spent during the turn stays spent", () => {
    // The troll's opportunity attack on Thorn's turn, then the troll's turn gives it back.
    const onTroll = play(fight(), [NEXT, NEXT, { t: "encounter.update", entryId: "er", patch: { reactionUsed: true } }, NEXT]);
    assert.equal(row(onTroll, "er")!.reactionUsed, false);
    assert.equal(row(onTroll, "er")!.hadTurn, true);
    assert.deepEqual(onTroll.encounterHistory.at(-1)!.turnFlags, [{ entryId: "er", flags: ["reactionUsed"] }]);
    // Thorn's own Reaction, on the troll's turn.
    const back = play(onTroll, [{ t: "encounter.update", entryId: "et", patch: { reactionUsed: true } }, PREV]);
    assert.deepEqual(turn(back), ["et", 1]);
    assert.equal(row(back, "er")!.reactionUsed, true, "the Reaction Next gave back is spent again");
    assert.equal(row(back, "er")!.hadTurn, undefined, "the troll's turn never came");
    assert.equal(row(back, "et")!.reactionUsed, true, "what happened in the turn stays");
  });

  test("a hidden row Next revealed is hidden again, row and token, and a row the DM hid during the turn stays hidden", () => {
    const state = fight();
    state.tokens.gob = { ...state.tokens.gob!, visibility: "dm" };
    state.encounter!.entries.push(entry("eg", { tokenId: "gob", value: 12, hidden: true }));
    const onGoblin = play(state, [NEXT, NEXT, NEXT]);
    assert.deepEqual(turn(onGoblin), ["eg", 1]);
    assert.equal(row(onGoblin, "eg")!.hidden, false);
    assert.equal(onGoblin.tokens.gob!.visibility, "all");
    const back = play(onGoblin, [{ t: "encounter.update", entryId: "er", patch: { hidden: true } }, PREV]);
    assert.equal(row(back, "eg")!.hidden, true);
    assert.equal(back.tokens.gob!.visibility, "dm");
    assert.equal(row(back, "er")!.hidden, true);
  });

  test("Next then Previous with nothing between puts back the encounter and every effect as they were, save-ends occurrences included", () => {
    const state = fight();
    state.tokens.gob = { ...state.tokens.gob!, visibility: "dm" };
    state.encounter!.entries.push(entry("eg", { tokenId: "gob", value: 12, hidden: true, reactionUsed: true }));
    state.tokens.troll = {
      ...state.tokens.troll!,
      actor: {
        inline: actor({
          effects: [
            effect("fr", { key: "frightened", duration: { remaining: 2, boundary: "turnEnd", anchor: { entryId: "er" } } }),
            effect("ps", { key: "poisoned", save: { ability: "con", dc: 13 } }),
            effect("bl", { duration: { remaining: 3, boundary: "turnStart", anchor: { entryId: "et" } } }),
          ],
        }),
      },
    };
    let s = play(state, [{ t: "encounter.update", entryId: "er", patch: { reactionUsed: true } }]);
    let changed = 0;
    for (let i = 0; i < 12; i++) {
      const next = play(s, [NEXT]);
      if (stableJson(next.tokens) !== stableJson(s.tokens)) changed++;
      const back = play(next, [PREV]);
      assert.deepEqual({ ...back.encounter!, rev: 0 }, { ...s.encounter!, rev: 0 }, `step ${i}`);
      assert.deepEqual(unrev(back.tokens), unrev(s.tokens), `step ${i}: the tokens, their effects included`);
      s = next;
    }
    assert.ok(changed >= 6, "the Nexts counted, ended and asked");
  });

  test("a turn that would resume on a row that left the fight is taken back too, to the turn before it", () => {
    const state = fight();
    // Until the end of the troll's next turn, which ends as the dragon's starts.
    state.tokens.troll = { ...state.tokens.troll!, actor: { inline: actor({ effects: [effect("fr", { key: "frightened", duration: { remaining: 3, boundary: "turnEnd", anchor: { entryId: "er" } } })] }) } };
    const onTroll = play(state, [NEXT, NEXT, NEXT]);
    assert.deepEqual(turn(onTroll), ["er", 1]);
    const onThorn = play(onTroll, [NEXT, NEXT, { t: "encounter.remove", entryIds: ["ed"] }]);
    assert.deepEqual(turn(onThorn), ["et", 2]);
    const back = play(onThorn, [PREV]);
    assert.deepEqual(turn(back), ["er", 1], "the dragon's turn went with it");
    assert.deepEqual(rows(back), ["et:15", "er:10"]);
    assert.equal(back.encounterHistory.length, onTroll.encounterHistory.length);
    assert.equal(inline(back, "troll").effects[0]!.duration?.remaining, inline(onTroll, "troll").effects[0]!.duration?.remaining, "the troll's turn end is not yet counted");
    assert.deepEqual(back.encounter!.turnStart, onTroll.encounter!.turnStart);
  });

  test("the history's first turn left the fight: no row acts, as before the fight's first turn", () => {
    const back = play(fight(), [NEXT, NEXT, { t: "encounter.remove", entryIds: ["ed"] }, PREV]);
    assert.deepEqual(turn(back), [null, 1]);
    assert.equal(back.encounter!.turnStart, undefined);
    assert.equal(back.encounterHistory.length, 0);
  });

  test("durations follow the rows that stay: a removed row's pause again with no line, an added row's bind again", () => {
    const state = fight();
    state.tokens.thorn = {
      ...state.tokens.thorn!,
      actor: {
        inline: actor({
          effects: [
            effect("bless", { duration: { remaining: 5, boundary: "turnStart", anchor: { entryId: "et" } } }),
            effect("fear", { key: "frightened", duration: { remaining: 1, boundary: "turnEnd", anchor: { tokenId: "gob" } } }),
            effect("mark", { key: "custom", label: "Hunted", duration: { remaining: 2, boundary: "turnEnd", anchor: { entryId: "er" } } }),
          ],
        }),
      },
    };
    const onThorn = play(state, [NEXT, NEXT]);
    assert.equal(inline(onThorn, "thorn").effects[0]!.duration?.remaining, 4, "Bless ticked as Thorn's turn started");
    const changed = play(onThorn, [{ t: "encounter.add", entries: [{ id: "eg", tokenId: "gob", value: 12 }] }, { t: "encounter.remove", entryIds: ["er"] }]);
    assert.deepEqual(anchors(inline(changed, "thorn").effects), [
      ["bless", 4, { entryId: "et" }],
      ["fear", 1, { entryId: "eg" }],
      ["mark", 2, { tokenId: "troll" }],
    ]);
    const r = applyOp(changed, PREV, DM, at(++seq));
    assert.ok(r.ok);
    assert.deepEqual(anchors(inline(r.state, "thorn").effects), [
      ["bless", 5, { entryId: "et" }],
      ["fear", 1, { entryId: "eg" }],
      ["mark", 2, { tokenId: "troll" }],
    ]);
    assert.deepEqual(r.log.map((e) => e.data?.type), ["turn"], "no line but the turn taken back");
  });

  test("an effect the DM adds during the turn to a creature whose durations counted stays, and one the DM removes stays removed (review FU26-OPUS-1)", () => {
    const state = fight();
    state.tokens.thorn = {
      ...state.tokens.thorn!,
      actor: {
        inline: actor({
          effects: [
            effect("bless", { duration: { remaining: 5, boundary: "turnStart", anchor: { entryId: "et" } } }),
            effect("hunted", { key: "custom", label: "Hunted", duration: { remaining: 3, boundary: "turnStart", anchor: { entryId: "et" } } }),
          ],
        }),
      },
    };
    const during: Op[] = [
      { t: "actor.effect.add", target: { tokenId: "thorn" }, effect: { id: "fr", key: "frightened" } },
      { t: "actor.effect.remove", target: { tokenId: "thorn" }, effectId: "hunted" },
    ];
    const now = play(fight2(state), [NEXT, NEXT, ...during, PREV]);
    assert.deepEqual(anchors(inline(now, "thorn").effects), [
      ["bless", 5, { entryId: "et" }],
      ["fr", undefined, undefined],
    ]);
    const old = play(fight2(state), [NEXT, NEXT, ...during, PREV], 20);
    assert.deepEqual(anchors(inline(old, "thorn").effects), [
      ["bless", 5, { entryId: "et" }],
      ["hunted", 3, { entryId: "et" }],
    ], "at version 20 the whole list went back");
  });

  test("an effect Next ended comes back at its place, and a count the DM set during the turn stays", () => {
    const state = fight();
    state.tokens.thorn = {
      ...state.tokens.thorn!,
      actor: {
        inline: actor({
          effects: [
            effect("short", { key: "custom", label: "Until Thorn's turn", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "et" } } }),
            effect("bless", { duration: { remaining: 5, boundary: "turnStart", anchor: { entryId: "et" } } }),
            effect("long", { key: "custom", label: "Ten rounds", duration: { remaining: 10, boundary: "turnStart", anchor: { entryId: "et" } } }),
          ],
        }),
      },
    };
    const onThorn = play(state, [NEXT, NEXT]);
    assert.deepEqual(anchors(inline(onThorn, "thorn").effects).map(([id, n]) => [id, n]), [
      ["bless", 4],
      ["long", 9],
    ]);
    const back = play(onThorn, [{ t: "actor.effect.update", target: { tokenId: "thorn" }, effectId: "long", patch: { duration: { mode: "rounds", rounds: 6, of: { entryId: "et" } } } }, PREV]);
    assert.deepEqual(anchors(inline(back, "thorn").effects).map(([id, n]) => [id, n]), [
      ["short", 1],
      ["bless", 5],
      ["long", 6],
    ]);
  });

  test("an ended effect goes back after the nearest effect that came before it, so the list reads as if the turn never came", () => {
    const state = fight();
    state.tokens.thorn = {
      ...state.tokens.thorn!,
      actor: {
        inline: actor({
          effects: [
            effect("prone", { key: "prone" }),
            effect("short", { key: "custom", label: "Until Thorn's turn", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "et" } } }),
            effect("bless", { duration: { remaining: 5, boundary: "turnStart", anchor: { entryId: "et" } } }),
          ],
        }),
      },
    };
    const during: Op[] = [
      { t: "actor.effect.remove", target: { tokenId: "thorn" }, effectId: "prone" },
      { t: "actor.effect.add", target: { tokenId: "thorn" }, effect: { id: "fr", key: "frightened" } },
    ];
    const back = play(state, [NEXT, NEXT, ...during, PREV]);
    const without = play(state, [NEXT, ...during]);
    assert.deepEqual(inline(back, "thorn").effects.map((e) => e.id), ["short", "bless", "fr"]);
    assert.deepEqual(inline(back, "thorn").effects.map((e) => e.id), inline(without, "thorn").effects.map((e) => e.id), "as the DM's changes leave it without Thorn's turn");
  });

  test("an ended effect put back that counts a row removed since pauses on its creature, and binds to that creature's row added since", () => {
    const state = fight();
    state.tokens.gob = { ...state.tokens.gob!, actor: { inline: actor() } };
    state.encounter!.entries.push(entry("eg", { tokenId: "gob", value: 12 }));
    // Until the start of the goblin's next turn, which the goblin's turn ends.
    state.tokens.thorn = { ...state.tokens.thorn!, actor: { inline: actor({ effects: [effect("dodge", { key: "custom", label: "Dodging", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "eg" } } })] }) } };
    const onGoblin = play(state, [NEXT, NEXT, NEXT]);
    assert.deepEqual(turn(onGoblin), ["eg", 1]);
    assert.deepEqual(inline(onGoblin, "thorn").effects, [], "the goblin's turn ended it");
    // The DM removes the acting goblin, whose turn passes on, then Previous resumes Thorn's turn.
    const paused = play(onGoblin, [{ t: "encounter.remove", entryIds: ["eg"] }, PREV]);
    assert.deepEqual(turn(paused), ["et", 1]);
    assert.deepEqual(anchors(inline(paused, "thorn").effects), [["dodge", 1, { tokenId: "gob" }]]);
    const bound = play(onGoblin, [{ t: "encounter.remove", entryIds: ["eg"] }, { t: "encounter.add", entries: [{ id: "eg2", tokenId: "gob", value: 12 }] }, PREV]);
    assert.deepEqual(anchors(inline(bound, "thorn").effects), [["dodge", 1, { entryId: "eg2" }]]);
    for (const s of [paused, bound]) {
      const inFight = new Set(s.encounter!.entries.map((e) => e.id));
      for (const t of Object.values(s.tokens)) {
        if (!("inline" in t.actor)) continue;
        for (const e of t.actor.inline.effects) {
          const a = e.duration?.anchor;
          if (a && "entryId" in a) assert.ok(inFight.has(a.entryId), `${t.id} ${e.id} counts a row outside the fight`);
        }
      }
    }
  });

  test("a row added during the turn that got the turn from a removal loses its mark with Previous (review FU26-OPUS-2)", () => {
    const state = fight();
    state.meta.settings.playersSeeOrder = "party";
    const onTroll = play(state, [NEXT, NEXT, NEXT]);
    const passed = play(onTroll, [{ t: "encounter.add", entries: [{ id: "eg", tokenId: "gob", value: 5 }] }, { t: "encounter.remove", entryIds: ["er"] }]);
    assert.deepEqual(turn(passed), ["eg", 1]);
    assert.equal(row(passed, "eg")!.hadTurn, true);
    const back = play(passed, [PREV]);
    assert.deepEqual(turn(back), ["et", 1]);
    assert.equal(row(back, "eg")!.hadTurn, undefined, "the turn that showed it was taken back");
  });

  test("Previous walks past the turn of a companion that left the fight, however it left (reviews FU26-ASTRA-2 and FU26-OPUS-7)", () => {
    const fightWith = (of: "hero" | "pal"): RoomState => {
      const s = room({
        characters: { hero: character("hero", { name: "Hero" }), pal: character("pal", { name: "Pal" }) },
        tokens: {
          a: token("a", { kind: "pc", name: "A", actor: { ref: "hero" } }),
          b: token("b", { kind: "npc", name: "B", companion: { of, turn: "own" } }),
          c: token("c", { name: "C" }),
        },
      });
      s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("ea", { tokenId: "a", value: 20 }), entry("eb", { tokenId: "b", value: 15, tieOrder: 1 }), entry("ec", { tokenId: "c", value: 10, tieOrder: 2 })] };
      return s;
    };
    const leaves: [string, Op, "hero" | "pal"][] = [
      ["comes to act on its character's turn", { t: "token.update", tokenId: "b", patch: { companion: { of: "hero", turn: "shared" } } }, "hero"],
      ["comes to act on no turn", { t: "token.update", tokenId: "b", patch: { companion: { of: "hero", turn: "none" } } }, "hero"],
      ["is dismissed", { t: "token.delete", tokenId: "b" }, "hero"],
      ["is deleted with other tokens", { t: "token.deleteMany", tokenIds: ["b"] }, "hero"],
      ["goes with its character", { t: "character.delete", characterId: "pal" }, "pal"],
    ];
    for (const [how, op, of] of leaves) {
      const onC = play(fightWith(of), [NEXT, NEXT, NEXT]);
      assert.deepEqual(turn(onC), ["ec", 1]);
      const left = play(onC, [op]);
      const saved = left.encounterHistory.at(-1)!;
      assert.equal(saved.resumesGone, true, `${how}: the step says its turn left`);
      assert.ok(!saved.encounter.entries.some((e) => e.id === "eb") && saved.encounter.activeEntryId === "ec", `${how}: its encounter is one an older build may put back whole`);
      const back = play(left, [PREV]);
      assert.deepEqual(turn(back), ["ea", 1], how);
      assert.equal(back.encounter!.turnStart?.entryId, "ea", how);
      assert.equal(back.encounterHistory.length, 1, how);
      // Stored at version 20, the step passed the turn on, and Previous moved nothing.
      const old = play(play(play(fightWith(of), [NEXT, NEXT, NEXT], 20), [op], 20), [PREV], 20);
      assert.deepEqual(turn(old), ["ec", 1], `${how} at version 20`);
      assert.equal(old.encounterHistory.length, 2, `${how} at version 20`);
    }
  });
});

describe("op version 21: stored Previous ops replay by the rule they were written under", () => {
  const during: Op[] = [
    { t: "encounter.add", entries: [{ id: "eg", tokenId: "gob", value: 12 }] },
    { t: "encounter.setValue", entryId: "er", value: 8 },
    { t: "encounter.update", entryId: "ed", patch: { inLair: true }, counts: { actionsMax: 4, resistMax: 4, xp: 20000 } },
  ];

  test("at version 20 Previous puts back the step's whole encounter, as it did, and at 21 only the turn", () => {
    const old = play(fight(), [NEXT, NEXT, ...during, PREV], 20);
    assert.equal(old.encounterHistory.length, 1);
    assert.deepEqual(rows(old), ["ed:19", "et:15", "er:10"], "the rows of the step: the goblin's gone, the troll's value and In lair go back");
    assert.equal(inline(old, "dragon").legendary?.actionsMax, 4, "and the lair's counts stay, as LP20-CC-3 found");
    const now = play(fight(), [NEXT, NEXT, ...during, PREV], 21);
    assert.deepEqual(rows(now), ["ed:19:lair", "et:15", "eg:12", "er:8"]);
    assert.deepEqual(turn(old), turn(now));
    const live = play(fight(), [NEXT, NEXT, ...during, PREV]);
    assert.deepEqual([rows(live), turn(live)], [rows(now), turn(now)], "a live op takes today's rule");
  });

  test("a version 20 Next saves no flags, so a version 21 Previous of its step puts back the whole encounter", () => {
    const saved = play(fight(), [NEXT, NEXT], 20);
    assert.equal(saved.encounterHistory.at(-1)!.turnFlags, undefined);
    const back = play(saved, [...during, PREV], 21);
    assert.deepEqual(rows(back), ["ed:19", "et:15", "er:10"]);
    assert.deepEqual(play(fight(), [NEXT, NEXT], 21).encounterHistory.at(-1)!.turnFlags, [], "a step from version 21 holds its flags, none here");
  });

  test("a version 20 Previous of a step a version 21 Next saved still puts back the whole encounter", () => {
    const back = play(play(fight(), [NEXT, NEXT, ...during], 21), [PREV], 20);
    assert.deepEqual(rows(back), ["ed:19", "et:15", "er:10"]);
  });

  test("a version 21 Previous never walks into a step a version 20 Next saved: no row acts", () => {
    const onTroll = play(play(fight(), [NEXT, NEXT], 20), [NEXT], 21);
    const gone = play(onTroll, [{ t: "encounter.remove", entryIds: ["et"] }], 21);
    assert.deepEqual(turn(gone), ["er", 1], "Thorn, whose turn the step would resume, left the fight");
    const back = play(gone, [PREV], 21);
    assert.deepEqual(turn(back), [null, 1]);
    assert.deepEqual(rows(back), ["ed:19", "er:10"]);
    assert.equal(back.encounterHistory.length, 2, "the older steps stay for the next Previous");
  });

  test("a version 20 Previous never walks past a turn that left the fight", () => {
    const old = play(fight(), [NEXT, NEXT, { t: "encounter.remove", entryIds: ["ed"] }, PREV], 20);
    assert.deepEqual(turn(old), ["ed", 1], "the dragon's row came back with its turn");
    assert.deepEqual(rows(old), ["ed:19", "et:15", "er:10"]);
  });
});
