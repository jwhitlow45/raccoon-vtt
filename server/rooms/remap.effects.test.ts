import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Effect, LogEntry, RoomState } from "#shared/model.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { actor, character, effect, entry, room, token } from "#shared/testutil.ts";
import { remapState } from "./remap.ts";
import { uuidv7 } from "#shared/ids.ts";

/*
 * An import gives every condition but the bare automatic Unconscious a
 * fresh id (docs/design/design-v1-player-limits.md 3.4, 8), so an imported
 * room shares no recent condition id with the room it came from. Each new
 * id is the same wherever the room names that condition: its creature's
 * list, the fight's saved steps and a save's line.
 */

const AUTO: Effect = { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" };

/** 32 shown and 32 hidden conditions, then the automatic one: a creature at both classes' caps. */
function full(prefix: string): Effect[] {
  const shown = Array.from({ length: 32 }, (_, i) => effect(`${prefix}-s${i}`, { key: "custom", label: `Shown ${i}` }));
  const hidden = Array.from({ length: 32 }, (_, i) => effect(`${prefix}-h${i}`, { key: "custom", label: `Hidden ${i}`, hiddenFromPlayers: true }));
  return [...shown, ...hidden, AUTO];
}

const saveLine: LogEntry = { id: "40:900000", at: "2026-11-10T20:00:00.000Z", kind: "event", data: { type: "saveEnds", tokenId: "g1", effectId: "web", key: "restrained", ability: "str", dc: 12 } };

function source(): RoomState {
  const web = effect("web", { key: "restrained", save: { ability: "str", dc: 12 }, duration: { remaining: 3, boundary: "turnEnd", anchor: { entryId: "e1" } } });
  return room({
    characters: { "thorn-c": character("thorn-c", { actor: actor({ effects: full("thorn") }) }) },
    tokens: {
      thorn: token("thorn", { kind: "pc", actor: { ref: "thorn-c" } }),
      g1: token("g1", { actor: { inline: actor({ effects: [web, effect("bless", { key: "blessed" })] }) } }),
      // The same id on another creature is that creature's own condition.
      g2: token("g2", { actor: { inline: actor({ effects: [effect("bless", { key: "blessed" }), { ...AUTO, hiddenFromPlayers: true }] }) } }),
    },
    encounter: { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "g1" }), entry("e2", { tokenId: "g2" })] },
    encounterHistory: [
      {
        encounter: { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "g1" })] },
        effects: { g1: [web], "thorn-c": full("thorn") },
        revealed: [],
        effectChanges: [{ holderId: "g1", ended: [{ at: 1, effect: effect("bane", { key: "custom", label: "Bane" }) }], counted: [{ id: "web", from: 4, to: 3 }] }],
        at: "2026-11-10T20:00:00.000Z",
      },
    ],
    log: [saveLine],
  });
}

const effectsOf = (state: RoomState, name: (a: Actor) => boolean): Effect[] => {
  for (const t of Object.values(state.tokens)) if ("inline" in t.actor && name(t.actor.inline)) return t.actor.inline.effects;
  for (const c of Object.values(state.characters)) if (name(c.actor)) return c.actor.effects;
  return [];
};

describe("an import's condition ids", () => {
  const before = source();
  const after = remapState(before, { assets: new Map(), newId: () => uuidv7() });
  const tokenNamed = (state: RoomState, effectLabel: string) => Object.values(state.tokens).find((t) => "inline" in t.actor && t.actor.inline.effects.some((e) => e.key === effectLabel))!;
  const g1 = tokenNamed(after, "restrained");
  const g1Effects = "inline" in g1.actor ? g1.actor.inline.effects : [];

  test("are fresh for every condition, shown and hidden, and the bare automatic one keeps its id", () => {
    const lists = (state: RoomState) => [...Object.values(state.tokens).flatMap((t) => ("inline" in t.actor ? [t.actor.inline.effects] : [])), ...Object.values(state.characters).map((c) => c.actor.effects)];
    const sourceIds = new Set(lists(before).flat().map((e) => e.id));
    const thorn = Object.values(after.characters)[0]!.actor.effects;
    assert.equal(thorn.length, 65);
    assert.deepEqual(thorn.filter((e) => sourceIds.has(e.id)), [AUTO]);
    assert.deepEqual(thorn.map((e) => e.label), before.characters["thorn-c"]!.actor.effects.map((e) => e.label));
    assert.ok(g1Effects.every((e) => !sourceIds.has(e.id)));
  });

  test("give a hidden automatic Unconscious, which is not bare, a fresh id like any other condition", () => {
    const g2 = effectsOf(after, (a) => a.effects.some((e) => e.key === "unconscious"));
    const hidden = g2.find((e) => e.key === "unconscious")!;
    assert.notEqual(hidden.id, ZERO_HP_UNCONSCIOUS_ID);
    assert.equal(hidden.hiddenFromPlayers, true);
  });

  test("give the same id on two creatures two new ids, one each", () => {
    const blessIds = Object.values(after.tokens).flatMap((t) => ("inline" in t.actor ? t.actor.inline.effects : [])).filter((e) => e.key === "blessed").map((e) => e.id);
    assert.equal(new Set(blessIds).size, 2);
  });

  test("are the same new id in the creature's list, the saved step, its counted change and the save's line", () => {
    const web = g1Effects.find((e) => e.key === "restrained")!;
    const step = after.encounterHistory[0]!;
    assert.deepEqual(step.effects[g1.id]!.map((e) => e.id), [web.id]);
    assert.deepEqual(step.effectChanges?.[0]?.counted?.map((c) => c.id), [web.id]);
    const line = after.log.find((l) => l.data?.type === "saveEnds");
    assert.equal(line?.data?.type === "saveEnds" ? line.data.effectId : undefined, web.id);
    // The saved step's copy of the character's list takes the character's new ids too.
    const thornId = Object.keys(after.characters)[0]!;
    assert.deepEqual(step.effects[thornId]!.map((e) => e.id), Object.values(after.characters)[0]!.actor.effects.map((e) => e.id));
  });

  test("give an ended condition in a saved step a fresh id of its own", () => {
    const ended = after.encounterHistory[0]!.effectChanges![0]!.ended![0]!.effect;
    assert.equal(ended.label, "Bane");
    assert.notEqual(ended.id, "bane");
  });
});
