import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { serializedBytes, LIMITS } from "../limits.ts";
import type { Actor, LogEntry, RoomState } from "../model.ts";
import { canApply } from "../permissions.ts";
import { OUTCOME_TOO_BIG, clientOpSchema, type EffectInput, type Op, type OpOf, type RestoreEntry } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, actor, character, effect, env, room, token } from "../testutil.ts";
import { NO_RESISTANCE_LEFT } from "./outcome.ts";

/** A group save's outcome as one op, whole or nothing (docs/design-v1-roll-options.md 5.5 and 8). */

type Ran = { state: RoomState; log: LogEntry[]; inverse: RestoreEntry[] | null };
let seq = 900;
function send(state: RoomState, op: Op): Ran | { code: string; message: string } {
  const r = applyOp(state, op, DM, env(++seq));
  return r.ok ? { state: r.state, log: r.log, inverse: r.inverse } : { code: r.code, message: r.message };
}
function ok(r: Ran | { code: string; message: string }): Ran {
  assert.ok("state" in r, "state" in r ? "" : `${r.code}: ${r.message}`);
  return r;
}

const inline = (state: RoomState, id: string): Actor => (state.tokens[id]!.actor as { inline: Actor }).inline;

/** Two goblins, a lich concentrating with 2 of 3 Legendary Resistances left, and Bree (p1) with a token. */
function table(): RoomState {
  return room({
    characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"], actor: actor({ hp: { cur: 20, max: 20, temp: 5 } }) }) },
    tokens: {
      g1: token("g1", { kind: "monster", name: "Goblin 1", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } }),
      g2: token("g2", { kind: "monster", name: "Goblin 2", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } }),
      lich: token("lich", {
        kind: "monster",
        name: "Lich",
        actor: { inline: actor({ hp: { cur: 100, max: 100, temp: 0 }, effects: [effect("c1", { key: "concentrating", spell: "Hold Person" }), effect("held", { key: "paralyzed" })], legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 1 } }) },
      }),
      breeTok: token("breeTok", { kind: "pc", name: "Bree", ownerIds: ["p1"], actor: { ref: "bree" } }),
    },
  });
}

const frightened = (id: string): EffectInput => ({ id, key: "frightened", duration: { mode: "turnEnd", of: { tokenId: "g1" } }, save: { ability: "wis", dc: 15 } });

function outcome(targets: OpOf<"actor.outcome">["targets"], plan = "plan-1"): OpOf<"actor.outcome"> {
  return { t: "actor.outcome", plan, label: "Fireball", targets };
}

describe("actor.outcome", () => {
  test("damage by actor.hp's rules, conditions added, effects removed and a Legendary Resistance spent, in one op", () => {
    const r = ok(
      send(
        table(),
        outcome([
          { target: { tokenId: "g1" }, amount: 3, effects: [frightened("f1")] },
          { target: { tokenId: "g2" }, amount: 9 },
          { target: { tokenId: "lich" }, amount: 22, remove: ["held"], resist: true },
          { target: { characterId: "bree" }, amount: 8 },
        ]),
      ),
    );
    assert.deepEqual(inline(r.state, "g1").hp, { cur: 4, max: 7, temp: 0 });
    assert.deepEqual(inline(r.state, "g1").effects.map((e) => [e.key, e.save]), [["frightened", { ability: "wis", dc: 15 }]]);
    assert.equal(inline(r.state, "g2").life, "dead", "a monster at 0 HP");
    assert.deepEqual(inline(r.state, "lich").legendary?.resistUsed, 2);
    assert.ok(!inline(r.state, "lich").effects.some((e) => e.id === "held"));
    assert.deepEqual(r.state.characters.bree!.actor.hp, { cur: 17, max: 20, temp: 0 }, "temporary HP first");
    assert.ok(r.log.some((e) => e.data?.type === "concentration" && e.data.tokenId === "lich" && e.data.dc === 11), "the concentration prompt follows the damage");
  });

  test("one refusal refuses the whole: no resistance left, a creature gone, a holder twice, an effect it lacks", () => {
    const spent = table();
    inline(spent, "lich").legendary!.resistUsed = 3;
    const cases: [string, RoomState, OpOf<"actor.outcome">["targets"], string | null][] = [
      ["no resistance left", spent, [{ target: { tokenId: "g1" }, amount: 3 }, { target: { tokenId: "lich" }, resist: true }], NO_RESISTANCE_LEFT],
      ["a creature gone", table(), [{ target: { tokenId: "g1" }, amount: 3 }, { target: { tokenId: "gone" }, amount: 3 }], null],
      ["a token and its character", table(), [{ target: { characterId: "bree" }, amount: 3 }, { target: { tokenId: "breeTok" }, amount: 3 }], "a creature is listed twice"],
      ["an effect it lacks", table(), [{ target: { tokenId: "g1" }, amount: 3 }, { target: { tokenId: "g2" }, remove: ["nope"] }], null],
    ];
    for (const [why, state, targets, message] of cases) {
      const r = send(state, outcome(targets));
      assert.ok(!("state" in r), why);
      if (message) assert.equal(r.message, message, why);
    }
  });

  test("one undo takes it all back", () => {
    const before = table();
    const r = ok(send(before, outcome([{ target: { tokenId: "g1" }, amount: 3, effects: [frightened("f1")] }, { target: { tokenId: "lich" }, resist: true, remove: ["held"] }])));
    const undone = ok(send(r.state, { t: "sys.restore", entries: r.inverse!, from: "undo", deps: true }));
    assert.deepEqual(inline(undone.state, "g1"), inline(before, "g1"));
    assert.deepEqual(inline(undone.state, "lich"), inline(before, "lich"));
  });

  test("the DM's alone", () => {
    assert.equal((canApply(outcome([{ target: { tokenId: "g1" }, amount: 3 }]), P1, table(), { canUseAsset: () => true }) as { code: string }).code, "forbidden");
    assert.ok(canApply(outcome([{ target: { tokenId: "g1" }, amount: 3 }]), DM, table(), { canUseAsset: () => true }).ok);
  });

  test("bounds: 100 creatures with an amount, two conditions with durations and saves, and a resistance fit, three on every one do not", () => {
    const big = (conditions: number) =>
      outcome(
        Array.from({ length: 100 }, (_, i) => ({
          target: { tokenId: `0192f0a8-6c1e-7a4b-9c3d-${String(i).padStart(12, "0")}` },
          amount: 99_999,
          effects: Array.from({ length: conditions }, (_, k) => ({
            id: `0192f0a8-6c1e-7a4b-9c3d-${String(i * 10 + k).padStart(12, "0")}`,
            key: "frightened" as const,
            duration: { mode: "turnEnd" as const, of: { tokenId: `0192f0a8-6c1e-7a4b-9c3d-${String(i).padStart(12, "0")}` } },
            save: { ability: "wis" as const, dc: 15, spell: true as const },
          })),
          resist: true as const,
        })),
        "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d",
      );
    const two = big(2);
    assert.ok(clientOpSchema.safeParse(two).success, `two conditions each: ${serializedBytes(two)} bytes`);
    assert.ok(serializedBytes(two) <= LIMITS.outcomeOpBytes);
    const three = clientOpSchema.safeParse(big(3));
    assert.equal(three.success, false);
    assert.match(JSON.stringify(three.error?.issues), new RegExp(OUTCOME_TOO_BIG.slice(0, 20)));
    assert.equal(clientOpSchema.safeParse(outcome(Array.from({ length: 101 }, (_, i) => ({ target: { tokenId: `t${i}` }, amount: 1 })))).success, false, "101 creatures");
    assert.equal(clientOpSchema.safeParse(outcome([{ target: { tokenId: "g1" }, effects: [1, 2, 3, 4].map((k) => frightened(`f${k}`)) }])).success, false, "four conditions");
  });
});
