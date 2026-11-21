import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEvent } from "#shared/logText.ts";
import type { Effect, LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { CHANGED_SINCE } from "#shared/permissions.ts";
import { projectState } from "#shared/project.ts";
import { opSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { pendingSaves } from "#shared/rules/saveEnds.ts";
import { DM, P1, P2, actor, character, effect, entry, env, member, room, token } from "#shared/testutil.ts";
import { UndoTable } from "./undoTesting.ts";

/*
 * A condition hidden from players reads to them as its removal, and one shown
 * again as its add (shared/migrate.ts classChangesWriteLines): the removal's
 * line and, for a save-ends condition, its open save request closed as a
 * removal closes it, its occurrence left pending for the DM. The DM reads
 * that it is hidden or shown. Twins: a hide in A against a removal in B,
 * and a show in A against an add in B.
 *
 * Bree (p1's character) is Frightened (bfx) with a Wisdom save that ends it,
 * its occurrence 5:0 pending; Goblin 2 is Poisoned; Bree's owl is Charmed
 * under the same effect id as Bree's fear.
 */

const DM2: Viewer = { memberId: "dm2", role: "dm" };
const OCCURRENCE = "5:0";

function fear(over: Partial<Effect> = {}): Effect {
  return effect("bfx", { key: "frightened", save: { ability: "wis", dc: 15 }, due: { id: OCCURRENCE, state: "pending" }, ...over });
}

function fight(): RoomState {
  const state = room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ effects: [fear()] }) }) },
    tokens: {
      gob: token("gob", { kind: "monster", name: "Goblin 2", actor: { inline: actor({ effects: [effect("gp", { key: "poisoned" })] }) } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      owl: token("owl", { kind: "npc", name: "Owl", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor({ effects: [effect("bfx", { key: "charmed", save: { ability: "wis", dc: 12 }, due: { id: "5:1", state: "pending" } })] }) } }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: "e-gob", started: true, entries: [entry("e-gob", { tokenId: "gob", value: 20, tieOrder: 0 }), entry("e-bree", { characterId: "bree", value: 10, tieOrder: 1 })] },
  });
  state.members.dm2 = member("dm2", "dm");
  return state;
}

function ask(id = "r1", effectId = "bfx", occurrence = OCCURRENCE, target: { characterId: string } | { tokenId: string } = { characterId: "bree" }): Op {
  return {
    t: "roll.ask",
    request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dc: 15, dcShown: false, resultShown: true, cause: "saveEnds", ends: { effect: effectId, occurrence }, targets: [target] },
  };
}

const hide = (target: { characterId: string } | { tokenId: string } = { characterId: "bree" }, effectId = "bfx", hidden = true): Op => ({ t: "actor.effect.update", target, effectId, patch: { hiddenFromPlayers: hidden } });
const remove = (target: { characterId: string } | { tokenId: string } = { characterId: "bree" }, effectId = "bfx"): Op => ({ t: "actor.effect.remove", target, effectId });

let seq = 700;
function play(state: RoomState, op: Op, who: Viewer = DM, opVersion?: number, at = seq++): RoomState {
  const r = applyOp(state, opSchema.parse(op), who, { ...env(at), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r.state;
}

/** Twin ops at one seq, so their line ids can match. */
function both(a: RoomState, b: RoomState, opA: Op, opB: Op = opA, who: Viewer = DM): [RoomState, RoomState] {
  const at = seq++;
  return [play(a, opA, who, undefined, at), play(b, opB, who, undefined, at)];
}

const copy = (state: RoomState, viewer: Viewer) => projectState(state, viewer, { sceneId: "s1" });
const said = (state: RoomState, viewer: Viewer) =>
  copy(state, viewer).log.map((l: LogEntry) => [l.id, l.data ? describeEvent(l.data, { tokens: state.tokens, characters: state.characters, members: state.members } as never) : l.text]);
const effectLines = (state: RoomState) => state.log.filter((l) => l.data?.type === "effect");

describe("a hide reads to players as the removal (7)", () => {
  for (const asked of [true, false]) {
    test(`${asked ? "with" : "without"} an open save request: every player's copy and log equal the removal's, and the DM may ask again`, () => {
      let [a, b] = [fight(), fight()];
      if (asked) [a, b] = both(a, b, ask());
      [a, b] = both(a, b, hide(), remove());
      for (const viewer of [P1, P2]) {
        assert.deepEqual(copy(a, viewer), copy(b, viewer), `${viewer.memberId}: the copy`);
        assert.deepEqual(said(a, viewer), said(b, viewer), `${viewer.memberId}: the log`);
      }
      assert.deepEqual(said(a, P1).at(-1)?.[1], "Bree loses Frightened.");
      assert.equal(a.rolls.r1, undefined, "the request is closed");
      const dmLine = effectLines(a).at(-1)!;
      assert.equal(describeEvent(dmLine.data!, { tokens: a.tokens, characters: a.characters, members: a.members } as never, true), "Frightened on Bree is hidden from players.");
      // The occurrence stays pending, so the DM's card offers Ask again (client/features/encounter/saveCards.test.ts).
      const pending = pendingSaves(a).find((p) => "characterId" in p.target && p.effect.id === "bfx");
      assert.ok(pending, "the save is still pending for the DM");
      assert.equal(pending.request, undefined);
      assert.equal(pending.effect.due.state, "pending");
    });
  }

  test("only the request of the hidden condition's own creature closes, where another creature's condition shares its id", () => {
    let s = play(fight(), ask("r1"));
    s = play(s, ask("r2", "bfx", "5:1", { tokenId: "owl" }));
    s = play(s, hide());
    assert.equal(s.rolls.r1, undefined);
    assert.ok(s.rolls.r2, "the owl's request stays open");
  });

  test("on one occurrence named by two creatures' requests, as only a stored room holds, the hide closes its own creature's alone", () => {
    let s = fight();
    s.tokens.owl = { ...s.tokens.owl!, actor: { inline: actor({ effects: [effect("bfx", { key: "charmed", save: { ability: "wis", dc: 12 }, due: { id: OCCURRENCE, state: "pending" } })] }) } };
    s = play(s, ask("r1"));
    const r2 = { ...s.rolls.r1!, id: "r2", targets: [{ tokenId: "owl" }] };
    s = { ...s, rolls: { ...s.rolls, r2 } };
    s = play(s, hide());
    assert.deepEqual(Object.keys(s.rolls).sort(), ["r2"]);
  });

  test("the DM asks again after a hide: Bree's player gets the request, the DM's choice", () => {
    let s = play(fight(), ask("r1"));
    s = play(s, hide());
    s = play(s, ask("r2"));
    assert.ok(copy(s, P1).rolls.r2, "the request reaches Bree's player");
  });

  test("the automatic Unconscious hidden reads to players as Bree losing Unconscious", () => {
    const s = fight();
    s.characters.bree = { ...s.characters.bree!, actor: actor({ hp: { cur: 0, max: 10, temp: 0 }, life: "dying", effects: [{ id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" }] }) };
    const after = play(s, { t: "actor.effect.update", target: { characterId: "bree" }, effectId: ZERO_HP_UNCONSCIOUS_ID, as: "u1", patch: { hiddenFromPlayers: true } });
    assert.equal(said(after, P1).at(-1)?.[1], "Bree loses Unconscious.");
  });

  test("an op stored at 64 replays with no line and the request open", () => {
    let s = play(fight(), ask("r1"));
    const lines = s.log.length;
    s = play(s, hide(), DM, 64);
    assert.equal(s.log.length, lines);
    assert.ok(s.rolls.r1);
  });
});

describe("a show reads to players as the add (7)", () => {
  test("show in A, add in B: Bree's player reads the same lines, and the DM reads it is shown", () => {
    let a = fight();
    a.characters.bree = { ...a.characters.bree!, actor: actor({ effects: [fear({ hiddenFromPlayers: true, save: undefined, due: undefined })] }) };
    let b = fight();
    b.characters.bree = { ...b.characters.bree!, actor: actor({ effects: [] }) };
    [a, b] = both(a, b, hide({ characterId: "bree" }, "bfx", false), { t: "actor.effect.add", target: { characterId: "bree" }, effect: { id: "bfx", key: "frightened" } } as Op);
    for (const viewer of [P1, P2]) assert.deepEqual(said(a, viewer), said(b, viewer), viewer.memberId);
    assert.equal(said(a, P1).at(-1)?.[1], "Bree gains Frightened.");
    assert.equal(describeEvent(effectLines(a).at(-1)!.data!, { tokens: a.tokens, characters: a.characters, members: a.members } as never, true), "Frightened on Bree is shown to players.");
  });

  test("concentration hidden and shown reads as stopping and starting to the players, and in the DM's words", () => {
    let s = fight();
    s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ effects: [effect("c1", { key: "concentrating", spell: "Bless" })] }) } };
    s = play(s, hide({ tokenId: "gob" }, "c1"));
    const dm = (state: RoomState) => describeEvent(effectLines(state).at(-1)!.data!, { tokens: state.tokens, characters: state.characters, members: state.members } as never, true);
    assert.equal(dm(s), "Goblin 2's Concentration on Bless is hidden from players.");
    assert.equal(said(s, P1).at(-1)?.[1], "Goblin 2 stops concentrating on Bless.");
    s = play(s, hide({ tokenId: "gob" }, "c1", false));
    assert.equal(dm(s), "Goblin 2's Concentration on Bless is shown to players.");
    assert.equal(said(s, P1).at(-1)?.[1], "Goblin 2 is concentrating on Bless.");
  });
});

describe("the undo of a hide (7, D-261121-131)", () => {
  test("the undo of a hide and of a removal each bring the request back", () => {
    for (const op of [hide(), remove()]) {
      const t = new UndoTable(fight());
      assert.equal(t.play(DM, ask("r1")), "ok");
      assert.equal(t.play(DM, op), "ok");
      assert.equal(t.state.rolls.r1, undefined);
      assert.equal(t.undo(DM), "ok", op.t);
      assert.ok(t.state.rolls.r1, `${op.t}: the request is back`);
    }
  });

  test("a hide, another DM's new ask on its occurrence, then the hide's undo: changed since, and one request stays", () => {
    const t = new UndoTable(fight());
    assert.equal(t.play(DM, ask("r1")), "ok");
    assert.equal(t.play(DM, hide()), "ok");
    assert.equal(t.play(DM2, ask("r2")), "ok");
    assert.equal(t.undo(DM), CHANGED_SINCE);
    assert.deepEqual(Object.keys(t.state.rolls), ["r2"]);
  });

  test("with the new ask taken back by its own undo, the hide's undo goes", () => {
    const t = new UndoTable(fight());
    assert.equal(t.play(DM, ask("r1")), "ok");
    assert.equal(t.play(DM, hide()), "ok");
    assert.equal(t.play(DM2, ask("r2")), "ok");
    assert.equal(t.undo(DM2), "ok");
    assert.equal(t.undo(DM), "ok");
    assert.deepEqual(Object.keys(t.state.rolls), ["r1"]);
  });
});

/** A small seeded generator, so a failing run names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe("classLines.random: twin B maps each hide to a removal, and Bree's player reads the same until a reveal or a new ask", () => {
  for (let seed = 1; seed <= 60; seed++) {
    test(`seed ${seed}`, () => {
      const next = rng(seed);
      const [a, b] = [new UndoTable(fight()), new UndoTable(fight())];
      // Both tables share every seq by playing the same count of ops.
      let hidden = false;
      let asks = 0;
      const steps: string[] = [];
      const twin = (who: Viewer, opA: Op, opB: Op = opA) => {
        const [x, y] = [a.play(who, opA), b.play(who, opB)];
        assert.equal(x, y, `seed ${seed}: ${steps.join(", ")}`);
        return x;
      };
      for (let i = 0; i < 30; i++) {
        const roll = next();
        const open = a.state.rolls[`r${asks}`] !== undefined;
        const due = (a.state.characters.bree!.actor.effects.find((e) => e.id === "bfx")?.due?.state ?? "none") === "pending";
        if (roll < 0.15 && !hidden && due && !open) {
          asks++;
          steps.push("ask");
          twin(DM, ask(`r${asks}`));
        } else if (roll < 0.3 && open) {
          const total = 5 + Math.floor(next() * 15);
          steps.push(`answer ${total}`);
          twin(P1, { t: "roll.answer", rollId: `r${asks}`, target: { characterId: "bree" }, total, tag: `t${seq++}` } as Op);
        } else if (roll < 0.4 && open) {
          const result = next() < 0.5 ? "pass" : "fail";
          steps.push(`mark ${result}`);
          twin(DM, { t: "roll.answer", rollId: `r${asks}`, target: { characterId: "bree" }, result, tag: `m${seq++}` } as Op);
        } else if (roll < 0.55 && !hidden && a.state.characters.bree!.actor.effects.some((e) => e.id === "bfx")) {
          hidden = true;
          steps.push("hide in A, remove in B");
          twin(DM, hide(), remove());
        } else if (roll < 0.7) {
          steps.push("next");
          twin(DM, { t: "encounter.next" });
        } else if (roll < 0.8) {
          const on = next() < 0.5;
          steps.push(`goblin ${on ? "poisoned" : "unpoisoned"}`);
          twin(DM, on ? ({ t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: `g${seq}`, key: "poisoned" } } as Op) : remove({ tokenId: "gob" }, "gp"));
        } else if (roll < 0.9 && hidden) {
          // The DM's undo of the hide in A and of the removal in B each put the condition back as players had it.
          steps.push("dm undo");
          const [x, y] = [a.undo(DM), b.undo(DM)];
          assert.equal(x, y, `seed ${seed}: ${steps.join(", ")}`);
          if (x === "ok" && a.state.characters.bree!.actor.effects.some((e) => e.id === "bfx" && e.hiddenFromPlayers !== true)) hidden = false;
        } else {
          steps.push("chat");
          twin(P2, { t: "log.chat", text: "hello" } as Op);
        }
        for (const viewer of [P1, P2]) {
          assert.deepEqual(copy(a.state, viewer), copy(b.state, viewer), `seed ${seed} ${viewer.memberId}: ${steps.join(", ")}`);
        }
      }
    });
  }
});
