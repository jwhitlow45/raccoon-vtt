import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { useText } from "./logText.ts";
import { lineAudience } from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, env, member, room, token } from "./testutil.ts";

/**
 * Who reads a creature's use line, and which parts of it
 * (docs/design-v1-combat-controls.md 8): the DM and the creature's owners
 * the counts, other players a public use by name alone, and none of them a
 * give back or a use after a secret roll. The readers of the counts are
 * fixed when the line is written.
 */

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };

function table(): RoomState {
  return room({
    tokens: {
      dragon: token("dragon", { name: "Adult Red Dragon", actor: { inline: actor({ legendary }) } }),
      hidden: token("hidden", { name: "Lurker", visibility: "dm", actor: { inline: actor({ legendary }) } }),
      bree: token("bree", { kind: "pc", name: "Bree", actor: { ref: "bree" } }),
    },
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], resources: [{ id: "loh", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true }] }) },
  });
}

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 2): { state: RoomState; log: LogEntry[] } {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, r.ok ? "" : r.message);
  return r;
}

/** The viewer's live copy of the line the op wrote, as one event, or null when they hold none. */
function read(state: RoomState, viewer: Viewer, ids: readonly string[]): LogEvent | null {
  const held = projectState(state, viewer, { sceneId: "s1" }).log.filter((e) => ids.includes(e.id) || (e.copyOf !== undefined && ids.includes(e.copyOf)));
  assert.ok(held.length <= 1, "one line each");
  return held[0]?.data ?? null;
}

const lend = (state: RoomState, tokenId: string, ownerIds: string[], seq: number) => run(state, { t: "token.update", tokenId, patch: { ownerIds } }, DM, seq).state;
const fieryRays: Op = { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 2, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } };

describe("use lines' readers (docs/design-v1-combat-controls.md 8)", () => {
  test("the DM and the owners read the whole event with its cost and counts, and other players its name", () => {
    const lent = lend(table(), "dragon", ["p1"], 2);
    const used = run(lent, fieryRays, DM, 3);
    const ids = used.log.map((e) => e.id);
    const whole = { type: "use", what: "legendary", name: "Fiery Rays", cost: 2, left: 1, max: 3, tokenId: "dragon", seen: true };
    assert.deepEqual(read(used.state, DM, ids), whole);
    assert.deepEqual(read(used.state, P1, ids), whole);
    assert.deepEqual(read(used.state, P2, ids), { type: "use", what: "legendary", name: "Fiery Rays", tokenId: "dragon", seen: true });
    assert.equal(useText(read(used.state, P1, ids) as Extract<LogEvent, { type: "use" }>, "Adult Red Dragon"), "Adult Red Dragon used Fiery Rays (2 actions, 1 of 3 left).");
    assert.equal(useText(read(used.state, P2, ids) as Extract<LogEvent, { type: "use" }>, "Adult Red Dragon"), "Adult Red Dragon used Fiery Rays, a legendary action.");
    const line = used.state.log.find((e) => e.data?.type === "use")!;
    assert.equal(lineAudience(line), "shared");
    assert.deepEqual(line.parts, { exact: ["p1"] }, "the counts' readers when written");
  });

  test("ownership gained after a public line gives no counts from before it, and ownership lost takes them away", () => {
    const used = run(table(), fieryRays, DM, 2);
    const ids = used.log.map((e) => e.id);
    const gained = lend(used.state, "dragon", ["p1"], 3);
    assert.deepEqual(read(gained, P1, ids), { type: "use", what: "legendary", name: "Fiery Rays", tokenId: "dragon", seen: true }, "P1 was no reader of the counts then");
    const owned = run(lend(table(), "dragon", ["p1"], 2), fieryRays, DM, 3);
    const later = owned.log.map((e) => e.id);
    assert.equal((read(owned.state, P1, later) as { left?: number }).left, 1);
    const lost = lend(owned.state, "dragon", [], 4);
    assert.deepEqual(read(lost, P1, later), { type: "use", what: "legendary", name: "Fiery Rays", tokenId: "dragon", seen: true }, "a former owner keeps only what other players read");
  });

  test("a member who joins later reads a public use by name alone", () => {
    const used = run(lend(table(), "dragon", ["p1"], 2), fieryRays, DM, 3);
    const ids = used.log.map((e) => e.id);
    const joined = { ...used.state, members: { ...used.state.members, p3: member("p3") } };
    assert.deepEqual(read(joined, { memberId: "p3", role: "player" }, ids), { type: "use", what: "legendary", name: "Fiery Rays", tokenId: "dragon", seen: true });
  });

  test("a give back and a use after a secret roll reach only the DM and the owners", () => {
    const lent = lend(table(), "dragon", ["p1"], 2);
    const spent = run(lent, fieryRays, DM, 3).state;
    for (const op of [{ ...fieryRays, back: true } as Op, { t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "resist" }, quiet: true } as Op]) {
      const r = run(spent, op, DM, 4);
      const ids = r.log.map((e) => e.id);
      assert.equal(read(r.state, P2, ids), null, op.t);
      const own = read(r.state, P1, ids) as Extract<LogEvent, { type: "use" }>;
      assert.ok(own, "the owner reads it");
      assert.equal(own.hidden, undefined, "the owner's copy reads plainly, without the DM's mark");
      assert.equal(read(r.state, DM, ids)?.type, "use");
    }
  });

  test("a hidden creature's use reaches no player but its owners", () => {
    const r = run(table(), { t: "actor.use", target: { tokenId: "hidden" }, use: { kind: "resist" } }, DM, 2);
    const ids = r.log.map((e) => e.id);
    assert.equal(read(r.state, P1, ids), null);
    assert.equal(read(r.state, P2, ids), null);
    assert.equal(lineAudience(r.state.log.find((e) => e.data?.type === "use")!), "dm");
    const lent = run(lend(table(), "hidden", ["p1"], 2), { t: "actor.use", target: { tokenId: "hidden" }, use: { kind: "resist" } }, DM, 3);
    assert.deepEqual(read(lent.state, P1, lent.log.map((e) => e.id)), { type: "use", what: "resist", left: 2, max: 3, tokenId: "hidden" });
    assert.equal(read(lent.state, P2, lent.log.map((e) => e.id)), null);
  });

  test("a character's resource use reads its amount for its players and its name for the rest", () => {
    const r = run(table(), { t: "actor.use", target: { tokenId: "bree" }, use: { kind: "resource", id: "loh", amount: 5 } }, P1, 2);
    const ids = r.log.map((e) => e.id);
    const own = read(r.state, P1, ids) as Extract<LogEvent, { type: "use" }>;
    assert.equal(useText(own, "Bree"), "Bree used 5 of Lay on Hands (20 of 25 left).");
    assert.equal(useText(read(r.state, P2, ids) as Extract<LogEvent, { type: "use" }>, "Bree"), "Bree used Lay on Hands.");
  });
});

describe("use lines' words (docs/design-v1-combat-controls.md 8)", () => {
  const line = (more: Partial<Extract<LogEvent, { type: "use" }>>): Extract<LogEvent, { type: "use" }> => ({ type: "use", what: "ability", ...more });
  test("read each kind with and without its counts, and a give back", () => {
    assert.equal(useText(line({ what: "resist", left: 2, max: 3 }), "Lich"), "Lich used Legendary Resistance (2 of 3 left).");
    assert.equal(useText(line({ what: "resist" }), "Lich"), "Lich used Legendary Resistance.");
    assert.equal(useText(line({ name: "Dominate Mind", left: 1, max: 2 }), "Aboleth"), "Aboleth used Dominate Mind (1 of 2 left).");
    assert.equal(useText(line({ name: "Dominate Mind" }), "Aboleth"), "Aboleth used Dominate Mind.");
    assert.equal(useText(line({ what: "legendary", name: "Fiery Rays", left: 2, max: 3 }), "Adult Red Dragon"), "Adult Red Dragon used Fiery Rays (legendary action, 2 of 3 left).");
    assert.equal(useText(line({ what: "legendary", left: 2, max: 3 }), "Adult Red Dragon"), "Adult Red Dragon used a legendary action (2 of 3 left).");
    assert.equal(useText(line({ what: "legendary" }), "Adult Red Dragon"), "Adult Red Dragon used a legendary action.");
    assert.equal(useText(line({ name: "Fire Breath", back: true }), "Young Red Dragon"), "Young Red Dragon: Fire Breath is ready again.");
    assert.equal(useText(line({ name: "Dominate Mind", back: true, left: 2, max: 2 }), "Aboleth"), "Aboleth: a use of Dominate Mind given back (2 of 2 left).");
    assert.equal(useText(line({ what: "resource", name: "Rage", left: 2, max: 3 }), "Thorn"), "Thorn used Rage (2 of 3 left).");
    assert.equal(useText(line({ what: "resource", name: "Lay on Hands", cost: 5, back: true, left: 25, max: 25 }), "Bree"), "Bree: 5 of Lay on Hands given back (25 of 25 left).");
  });
});

describe("combat uses on the actor reach only its owners (docs/design-v1-combat-controls.md 2.2)", () => {
  const held = () => {
    const state = table();
    const marks = { "actions:fire-breath": { kind: "recharge" as const, name: "Fire Breath", used: 1, max: 1, min: 5 } };
    const record = { id: 3, entryId: "e1", round: 1, hp: 20, life: "alive" as const, took: ["fire" as const] };
    state.tokens.dragon = token("dragon", { ownerIds: ["p1"], actor: { inline: actor({ legendary, uses: marks, hurt: ["fire"], turnRecord: record }) } });
    state.characters.bree = { ...state.characters.bree!, actor: actor({ uses: marks, hurt: ["acid"], turnRecord: record }) };
    return state;
  };

  test("non-owners get none of the marks, the damage types, the record or the resources, and owners get them all", () => {
    const state = held();
    const p2 = projectState(state, P2, { sceneId: "s1" });
    const dragon = p2.tokens.dragon!.actor as { inline: Record<string, unknown> };
    for (const field of ["uses", "hurt", "turnRecord", "legendary"]) assert.equal(dragon.inline[field], undefined, field);
    for (const field of ["uses", "hurt", "turnRecord"]) assert.equal((p2.characters.bree!.actor as Record<string, unknown>)[field], undefined, field);
    assert.equal((p2.characters.bree as Record<string, unknown>).resources, undefined);
    const p1 = projectState(state, P1, { sceneId: "s1" });
    const own = p1.tokens.dragon!.actor as { inline: Record<string, unknown> };
    const whole = state.tokens.dragon!.actor;
    assert.ok("inline" in whole);
    assert.deepEqual([own.inline.uses, own.inline.hurt, own.inline.turnRecord], [whole.inline.uses, ["fire"], whole.inline.turnRecord], "an owner gets the whole actor");
    assert.deepEqual(p1.characters.bree!.resources, state.characters.bree!.resources);
    assert.deepEqual((p1.characters.bree!.actor as Record<string, unknown>).turnRecord, state.characters.bree!.actor.turnRecord);
  });
});

describe("no log numbering reaches an owner's actor (docs/design-v1-combat-controls.md 8)", () => {
  /** Thorn's wolf, P1's, shares his turn. With `hidden`, a creature only the DM sees loses an effect at the same Next. */
  function turn(hidden: boolean): RoomState {
    const state = room({
      tokens: {
        thorn: token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }),
        wolf: token("wolf", { kind: "npc", name: "Wolf", ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, actor: { inline: actor({ hp: { cur: 5, max: 11, temp: 0 }, hurt: ["fire"], uses: { "actions:howl": { kind: "rest", name: "Howl", used: 1, max: 1 } } }) } }),
        ghost: token("ghost", { name: "Ghost", visibility: "dm", actor: { inline: actor({ effects: hidden ? [{ id: "fx", key: "invisible", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "et" } } }] : [] }) } }),
      },
      characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }) },
    });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [{ id: "et", tokenId: "thorn", value: 15, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false }] };
    return run(state, { t: "encounter.next" }, DM, 7).state;
  }

  test("an owner's view of a creature's record, marks and damage types is the same with and without hidden lines in the same op", () => {
    const plain = turn(false);
    const busy = turn(true);
    assert.ok(busy.log.length > plain.log.length, "the busy turn wrote more lines");
    const wolf = (s: RoomState) => (projectState(s, P1, { sceneId: "s1" }).tokens.wolf!.actor as { inline: Record<string, unknown> }).inline;
    const fields = (a: Record<string, unknown>) => ({ uses: a.uses, hurt: a.hurt, turnRecord: a.turnRecord });
    assert.deepEqual(fields(wolf(busy)), fields(wolf(plain)));
    assert.deepEqual(wolf(plain).turnRecord, { id: 7, entryId: "et", round: 1, hp: 5, life: "alive", took: ["fire"] });
    assert.doesNotMatch(JSON.stringify(fields(wolf(busy))), /"\d+:\d+"/, "no log line id among them");
  });
});
