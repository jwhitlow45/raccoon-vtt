import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEvent } from "../logText.ts";
import type { Effect, LogEntry, RoomState, Viewer } from "../model.ts";
import { SAVE_IS_DMS, canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { pendingSaves } from "../rules/saveEnds.ts";
import { DM, P1, actor, character, effect, entry, env, room, token } from "../testutil.ts";
import { SAVE_ASKED, SAVE_SETTLED } from "./rolls.ts";

/**
 * A save at the end of each turn ends an effect (docs/design-v1-roll-options.md
 * 6.1): the turn end's line and occurrence, the DM's settling op, who may
 * set a save, and what players read.
 */

type Ran = { state: RoomState; log: LogEntry[] };
let seq = 500;
function send(state: RoomState, op: Op, who: Viewer = DM): Ran | { code: string; message: string } {
  const decision = canApply(op, who, state, { canUseAsset: () => true });
  if (!decision.ok) return decision;
  const r = applyOp(state, op, who, env(++seq));
  return r.ok ? { state: r.state, log: r.log } : r;
}
function ok(r: Ran | { code: string; message: string }): Ran {
  assert.ok("state" in r, "state" in r ? "" : `${r.code}: ${r.message}`);
  return r;
}

const FRIGHTENED = (overrides: Partial<Effect> = {}): Effect => effect("fx", { key: "frightened", save: { ability: "wis", dc: 15 }, ...overrides });

/**
 * A fight: Goblin 2 (gob) acts first, Bree (p1's character) second, and
 * Bree's shared owl acts on her turn. Goblin 2 and Bree are Frightened with
 * a Wisdom save that ends it, the owl Charmed with one.
 */
function fight(active = "e-gob"): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ effects: [FRIGHTENED({ id: "bfx" })] }) }) },
    tokens: {
      gob: token("gob", { kind: "monster", name: "Goblin 2", actor: { inline: actor({ effects: [FRIGHTENED(), effect("plain", { key: "poisoned" })] }) } }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
      owl: token("owl", { kind: "npc", name: "Owl", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, actor: { inline: actor({ effects: [effect("ofx", { key: "charmed", save: { ability: "wis", dc: 12, spell: true } })] }) } }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: active, started: true, entries: [entry("e-gob", { tokenId: "gob", value: 20, tieOrder: 0 }), entry("e-bree", { characterId: "bree", value: 10, tieOrder: 1 })] },
  });
}

const effectOf = (state: RoomState, holder: "gob" | "bree" | "owl", id: string): Effect | undefined =>
  (holder === "bree" ? state.characters.bree!.actor : (state.tokens[holder]!.actor as { inline: { effects: Effect[] } }).inline).effects.find((e) => e.id === id);
const saveLines = (log: LogEntry[]) => log.filter((e) => e.data?.type === "saveEnds");

function askFor(state: RoomState, occurrence: string, id = "r1"): Op {
  return {
    t: "roll.ask",
    request: { id, test: { kind: "save", choices: [{ ability: "wis" }] }, dc: 15, dcShown: false, resultShown: true, cause: "saveEnds", ends: { effect: "bfx", occurrence }, targets: [{ characterId: "bree" }] },
  };
}

describe("a turn end asks the saves that end its creature's effects", () => {
  test("one line per effect with a save on the ended row's creature, and the line's id is its pending occurrence", () => {
    const r = ok(send(fight(), { t: "encounter.next" }));
    const lines = saveLines(r.log);
    assert.deepEqual(
      lines.map((l) => l.data),
      [{ type: "saveEnds", tokenId: "gob", effectId: "fx", key: "frightened", ability: "wis", dc: 15 }],
    );
    assert.deepEqual(effectOf(r.state, "gob", "fx")?.due, { id: lines[0]!.id, state: "pending" });
    assert.equal(effectOf(r.state, "gob", "plain")?.due, undefined, "an effect no save ends");
    assert.equal(effectOf(r.state, "bree", "bfx")?.due, undefined, "Bree's turn starts, it has not ended");
    assert.equal(describeEvent(lines[0]!.data!, r.state), "Goblin 2 ended its turn Frightened: a DC 15 Wisdom save ends it.");
  });

  test("a character's row stands for its companion acting on its turn too, and the first Next of a fight ends no turn", () => {
    const r = ok(send(fight("e-bree"), { t: "encounter.next" }));
    assert.deepEqual(
      saveLines(r.log).map((l) => [l.data!.type === "saveEnds" && (l.data.tokenId ?? l.data.characterId), l.data!.type === "saveEnds" && l.data.effectId]),
      [
        ["bree", "bfx"],
        ["owl", "ofx"],
      ],
    );
    const fresh = { ...fight(), encounter: { ...fight().encounter!, activeEntryId: null, started: false } };
    assert.deepEqual(saveLines(ok(send(fresh, { t: "encounter.next" })).log), []);
  });

  test("an effect expiring at the same turn end asks nothing, and a skipped row asks nothing", () => {
    const s = fight();
    s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ effects: [FRIGHTENED({ duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-gob" } } })] }) } };
    const r = ok(send(s, { t: "encounter.next" }));
    assert.deepEqual(saveLines(r.log), []);
    assert.equal(effectOf(r.state, "gob", "fx"), undefined);
    const skipping = fight();
    skipping.encounter!.entries.push(entry("e-third", { tokenId: "gob", value: 5, tieOrder: 2 }));
    skipping.tokens.gob = { ...skipping.tokens.gob!, actor: { inline: actor({ effects: [FRIGHTENED(), effect("dead", { key: "custom", label: "x" })], life: "alive" }) } };
    assert.equal(saveLines(ok(send(skipping, { t: "encounter.next" })).log).length, 1, "only the row whose turn ended");
  });

  test("the next turn end replaces the occurrence and closes the request linked to the one before, in the same op", () => {
    let s = ok(send(fight("e-bree"), { t: "encounter.next" })).state;
    const first = effectOf(s, "bree", "bfx")!.due!;
    s = ok(send(s, askFor(s, first.id))).state;
    assert.ok(s.rolls.r1);
    s = ok(send(s, { t: "encounter.next" })).state;
    s = ok(send(s, { t: "encounter.next" })).state;
    const second = effectOf(s, "bree", "bfx")!.due!;
    assert.notEqual(second.id, first.id);
    assert.equal(second.state, "pending");
    assert.equal(s.rolls.r1, undefined, "the old request closed");
  });

  test("Previous takes the occurrence back with the turn, and a request for it closes", () => {
    let s = ok(send(fight("e-bree"), { t: "encounter.next" })).state;
    const due = effectOf(s, "bree", "bfx")!.due!;
    s = ok(send(s, askFor(s, due.id))).state;
    s = ok(send(s, { t: "encounter.prev" })).state;
    assert.equal(effectOf(s, "bree", "bfx")!.due, undefined);
    assert.equal(s.rolls.r1, undefined);
  });
});

describe("settling an occurrence", () => {
  const asked = () => {
    const r = ok(send(fight(), { t: "encounter.next" }));
    return { state: r.state, due: effectOf(r.state, "gob", "fx")!.due!.id };
  };

  test("Accept failure and Dismiss settle the pending occurrence the card named, once", () => {
    const { state, due } = asked();
    const accepted = ok(send(state, { t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due, state: "resolved" })).state;
    assert.deepEqual(effectOf(accepted, "gob", "fx")?.due, { id: due, state: "resolved" });
    assert.deepEqual(pendingSaves(accepted), []);
    assert.deepEqual(send(accepted, { t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due, state: "dismissed" }), { ok: false, code: "invalid", message: SAVE_SETTLED });
    const dismissed = ok(send(state, { t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due, state: "dismissed" })).state;
    assert.deepEqual(effectOf(dismissed, "gob", "fx")?.due, { id: due, state: "dismissed" });
  });

  test("a stale card, a linked request and a player are refused", () => {
    const { state, due } = asked();
    assert.deepEqual(send(state, { t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due: "1:0", state: "resolved" }), { ok: false, code: "invalid", message: SAVE_SETTLED });
    let bree = ok(send(fight("e-bree"), { t: "encounter.next" })).state;
    const bdue = effectOf(bree, "bree", "bfx")!.due!.id;
    bree = ok(send(bree, askFor(bree, bdue))).state;
    assert.deepEqual(send(bree, { t: "actor.saveDue", target: { characterId: "bree" }, effectId: "bfx", due: bdue, state: "resolved" }), { ok: false, code: "invalid", message: SAVE_ASKED });
    assert.equal((send(state, { t: "actor.saveDue", target: { tokenId: "gob" }, effectId: "fx", due, state: "resolved" }, P1) as { code: string }).code, "forbidden");
  });

  test("the pending ones are what a reload rebuilds, each with its linked request", () => {
    let s = ok(send(fight("e-bree"), { t: "encounter.next" })).state;
    const bdue = effectOf(s, "bree", "bfx")!.due!.id;
    s = ok(send(s, askFor(s, bdue))).state;
    assert.deepEqual(
      pendingSaves(s).map((p) => [p.effect.id, p.request?.id]),
      [
        ["bfx", "r1"],
        ["ofx", undefined],
      ],
    );
  });

  test("taking the save off an effect ends its occurrence and closes its request", () => {
    let s = ok(send(fight("e-bree"), { t: "encounter.next" })).state;
    s = ok(send(s, askFor(s, effectOf(s, "bree", "bfx")!.due!.id))).state;
    s = ok(send(s, { t: "actor.effect.update", target: { characterId: "bree" }, effectId: "bfx", patch: { save: null } })).state;
    assert.deepEqual([effectOf(s, "bree", "bfx")?.save, effectOf(s, "bree", "bfx")?.due, s.rolls.r1], [undefined, undefined, undefined]);
  });
});

describe("who sets a save, and what players read", () => {
  test("only the DM sets or changes a save, on every op that carries effects", () => {
    const s = fight();
    const forbidden = { ok: false, code: "forbidden", message: SAVE_IS_DMS };
    const save = { ability: "wis" as const, dc: 15 };
    assert.deepEqual(canApply({ t: "actor.effect.add", target: { characterId: "bree" }, effect: { id: "n1", key: "prone", save } }, P1, s, { canUseAsset: () => true }), forbidden);
    assert.deepEqual(canApply({ t: "actor.effect.update", target: { characterId: "bree" }, effectId: "bfx", patch: { save: null } }, P1, s, { canUseAsset: () => true }), forbidden);
    assert.deepEqual(canApply({ t: "actor.effects", add: [{ target: { characterId: "bree" }, effect: { id: "n2", key: "prone", save } }] }, P1, s, { canUseAsset: () => true }), forbidden);
    assert.ok(canApply({ t: "actor.effect.add", target: { characterId: "bree" }, effect: { id: "n3", key: "prone" } }, P1, s, { canUseAsset: () => true }).ok);
    assert.ok(canApply({ t: "actor.effect.update", target: { tokenId: "gob" }, effectId: "fx", patch: { save: { ability: "con", dc: 12 } } }, DM, s, { canUseAsset: () => true }).ok);
  });

  test("players, owners included, keep which save ends it and lose its DC, its occurrence and the line", () => {
    const r = ok(send(fight("e-bree"), { t: "encounter.next" }));
    const mine = projectState(r.state, P1, { sceneId: "s1" });
    const bfx = mine.characters.bree!.actor.effects.find((e) => e.id === "bfx")!;
    assert.deepEqual([bfx.save, bfx.due], [{ ability: "wis" }, undefined]);
    const owl = mine.tokens.owl!.actor as { inline: { effects: Effect[] } };
    assert.deepEqual(owl.inline.effects[0]!.save, { ability: "wis", spell: true });
    assert.deepEqual(
      mine.log.filter((e) => e.data?.type === "saveEnds"),
      [],
    );
    const dm = projectState(r.state, DM, { sceneId: "s1" });
    assert.equal(dm.characters.bree!.actor.effects.find((e) => e.id === "bfx")!.due?.state, "pending");
    assert.equal(dm.log.filter((e) => e.data?.type === "saveEnds").length, 2);
  });
});
