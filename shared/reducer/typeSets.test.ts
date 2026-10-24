import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveDiceOp } from "../dice/resolve.ts";
import type { Actor, RoomState, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, actor, env, room, token } from "../testutil.ts";
import { hpUndoRestore } from "./hpUndo.ts";

/**
 * The two sets of damage types (docs/design-v1-combat-controls.md 3.4):
 * `hurt`, what a creature took since its record's start, and the record's
 * `took`, what the window that start closed held. The note they feed is
 * advisory, so the sets only add types, Previous unions them back, and
 * nothing a take back or an error does stops Apply and Skip.
 */

const legendary = { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 };

/** Rows: Troll 20, Goblin 12, Dragon 8. */
function fight(state?: RoomState) {
  const f = {
    state:
      state ??
      room({
        tokens: {
          troll: token("troll", { name: "Troll", actor: { inline: actor({ hp: { cur: 84, max: 94, temp: 0 } }) } }),
          gob: token("gob", { name: "Goblin", x: 20, y: 20 }),
          dragon: token("dragon", { name: "Adult Red Dragon", x: 25, y: 5, actor: { inline: actor({ hp: { cur: 256, max: 256, temp: 10 }, legendary }) } }),
        },
      }),
    seq: 0,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      const r = applyOp(f.state, op, who, env(f.seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      f.state = r.state;
      return f;
    },
    of(id: string): Actor {
      const t = f.state.tokens[id]!;
      assert.ok("inline" in t.actor);
      return t.actor.inline;
    },
    hit(id: string, amount: number, types: Extract<Op, { t: "actor.hp" }> extends { change: infer C } ? (C extends { types?: infer T } ? T : never) : never) {
      return f.run({ t: "actor.hp", target: { tokenId: id }, change: { kind: "damage", amount, ...(types ? { types } : {}) } });
    },
    start() {
      return f.run({ t: "encounter.start", entries: [{ id: "er", tokenId: "troll", value: 20 }, { id: "eg", tokenId: "gob", value: 12 }, { id: "ed", tokenId: "dragon", value: 8 }] });
    },
  };
  return f;
}

describe("damage types taken (docs/design-v1-combat-controls.md 3.4)", () => {
  test("a hit of at least 1 adds its types once each, in the rules' order, and the next start closes them into its record", () => {
    const f = fight().start().run({ t: "encounter.next" }).run({ t: "encounter.next" });
    f.hit("troll", 7, ["slashing", "fire"]).hit("troll", 3, ["fire", "acid"]);
    assert.deepEqual(f.of("troll").hurt, ["acid", "fire", "slashing"]);
    f.run({ t: "encounter.next" }).run({ t: "encounter.next" });
    assert.equal(f.state.encounter!.activeEntryId, "er");
    assert.deepEqual(f.of("troll").turnRecord!.took, ["acid", "fire", "slashing"]);
    assert.equal(f.of("troll").hurt, undefined, "the start empties hurt");
  });

  test("damage of 0, damage with no types and healing add nothing, and a hit of 1 does", () => {
    const f = fight().start();
    f.hit("troll", 0, ["fire"]);
    f.run({ t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 4 } });
    f.run({ t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "heal", amount: 2 } });
    assert.equal(f.of("troll").hurt, undefined);
    f.hit("troll", 1, ["cold"]);
    assert.deepEqual(f.of("troll").hurt, ["cold"]);
  });

  test("temporary HP that took the whole hit still count its types", () => {
    const f = fight().start().hit("dragon", 6, ["fire"]);
    assert.equal(f.of("dragon").hp.cur, 256);
    assert.deepEqual(f.of("dragon").hurt, ["fire"]);
  });

  test("a group save's damage and an area's carry their types", () => {
    const f = fight().start();
    f.run({ t: "actor.outcome", plan: "pl1", label: "Fireball", targets: [{ target: { tokenId: "troll" }, amount: 14, types: ["fire"] }, { target: { tokenId: "gob" }, amount: 3, types: ["fire"] }] });
    f.run({ t: "actor.damageMany", hits: [{ target: { tokenId: "dragon" }, amount: 12, types: ["acid"] }] });
    assert.deepEqual([f.of("troll").hurt, f.of("gob").hurt, f.of("dragon").hurt], [["fire"], ["fire"], ["acid"]]);
  });

  test("Fire during a turn, then Previous, unions it into hurt, and the next start notes it", () => {
    const f = fight().start().run({ t: "encounter.next" });
    assert.equal(f.state.encounter!.activeEntryId, "er");
    f.hit("troll", 5, ["fire"]);
    f.run({ t: "encounter.next" });
    f.hit("troll", 2, ["acid"]);
    f.run({ t: "encounter.prev" });
    assert.deepEqual(f.of("troll").hurt, ["acid", "fire"], "the removed window's took and the hurt since, together");
    f.run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    assert.equal(f.state.encounter!.activeEntryId, "er");
    assert.deepEqual(f.of("troll").turnRecord!.took, ["acid", "fire"]);
  });

  test("a take back of Fire leaves the note", () => {
    const f = fight().start().hit("troll", 5, ["fire"]);
    const line = f.state.log.find((e) => e.data?.type === "hp")!;
    const undo = hpUndoRestore(f.state, line.id);
    assert.ok(undo.ok);
    f.run({ t: "sys.restore", entries: undo.entries, from: "undo", deps: true, undid: line.id });
    assert.equal(f.of("troll").hp.cur, 84);
    assert.deepEqual(f.of("troll").hurt, ["fire"]);
  });

  test("a fight's end clears both sets", () => {
    const f = fight().start().run({ t: "encounter.next" }).hit("troll", 5, ["fire"]).run({ t: "encounter.next" }).run({ t: "encounter.next" }).run({ t: "encounter.next" });
    f.hit("troll", 1, ["cold"]);
    assert.ok(f.of("troll").turnRecord!.took && f.of("troll").hurt);
    f.run({ t: "encounter.end" });
    assert.equal(f.of("troll").hurt, undefined);
    assert.equal(f.of("troll").turnRecord, undefined);
  });

  test("damage before a first turn, the row removed and added back, a removal start, then Previous and Next: no error and the turn's prompts open", () => {
    const f = fight().start();
    f.hit("troll", 5, ["fire"]);
    f.run({ t: "encounter.remove", entryIds: ["er"] });
    f.run({ t: "encounter.add", entries: [{ id: "er2", tokenId: "troll", value: 20 }] });
    f.run({ t: "encounter.next" });
    assert.equal(f.state.encounter!.activeEntryId, "er2");
    f.run({ t: "encounter.remove", entryIds: ["er2"] });
    assert.equal(f.state.encounter!.activeEntryId, "eg");
    f.run({ t: "encounter.prev" }).run({ t: "encounter.next" });
    assert.equal(f.state.encounter!.activeEntryId, "er2");
    const record = f.of("troll").turnRecord!;
    assert.equal(record.entryId, "er2");
    const regen = applyOp(f.state, { t: "actor.use", target: { tokenId: "troll" }, use: { kind: "regenerate", key: "traits:regeneration", amount: 10, record: record.id } }, DM, env(f.seq + 1));
    assert.ok(regen.ok, "Apply is offered");
    const skip = applyOp(f.state, { t: "actor.prompt", target: { tokenId: "troll" }, record: record.id, what: "regeneration", state: "skipped" }, DM, env(f.seq + 1));
    assert.ok(skip.ok, "and Skip");
  });

  test("a dragon that takes Fire and uses Fiery Rays off its turn, then is removed and added back before its first turn, keeps both", () => {
    const f = fight().start().run({ t: "encounter.next" });
    f.hit("dragon", 9, ["fire"]);
    f.run({ t: "actor.use", target: { tokenId: "dragon" }, use: { kind: "legendary", cost: 1, key: "legendaryActions:fiery-rays", name: "Fiery Rays", once: true } });
    f.run({ t: "encounter.remove", entryIds: ["ed"] });
    f.run({ t: "encounter.add", entries: [{ id: "ed2", tokenId: "dragon", value: 8 }] });
    assert.deepEqual(f.of("dragon").hurt, ["fire"]);
    assert.ok(f.of("dragon").uses?.["legendaryActions:fiery-rays"]);
  });

  test("a damage roll's line keeps its type", () => {
    const f = fight();
    const resolved = resolveDiceOp({ t: "dice.roll", tag: "t1", to: "all", rolls: [{ formula: "2d6", label: "Fire Breath, Fire", creature: { tokenId: "troll" }, type: "fire" }] }, f.state, { draw: () => 3, batch: "AbCdEfGhIjKlMnOp" });
    assert.ok(resolved.ok);
    const r = applyOp(f.state, resolved.op, DM, env(1));
    assert.ok(r.ok);
    const line = r.log[0]!.data;
    assert.ok(line?.type === "dice");
    assert.equal(line.rolls[0]!.type, "fire");
  });

  test("before op version 20 a hit records no types", () => {
    const f = fight();
    const r = applyOp(f.state, { t: "actor.hp", target: { tokenId: "troll" }, change: { kind: "damage", amount: 5, types: ["fire"] } }, DM, { ...env(1), opVersion: 19 });
    assert.ok(r.ok);
    const t = r.state.tokens.troll!;
    assert.ok("inline" in t.actor && t.actor.inline.hurt === undefined);
  });
});
