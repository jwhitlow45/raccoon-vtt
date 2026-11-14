import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "#shared/keys.ts";
import { PLAYER_LIMITS_OP_VERSION, PLAYER_LIMITS_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { Effect, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { CONVERTED_EFFECT_ID, convertedEffectId } from "#shared/rules/effects.ts";
import { actor, character, room, token } from "#shared/testutil.ts";
import { automaticUpgrade, loadRoom, type Pool } from "./persistence.ts";

/*
 * The automatic Unconscious upgrade at a room's load (persistence.ts
 * automaticUpgrade): over a snapshot from before player limits, every
 * automatic Unconscious that is hidden or not bare goes on under its
 * converted id, once the stored ops from before replay, which may name its
 * old id, and the same on every load.
 */

const AUTO = ZERO_HP_UNCONSCIOUS_ID;
const hidden: Effect = { id: AUTO, key: "unconscious", hiddenFromPlayers: true };
const bare: Effect = { id: AUTO, key: "unconscious" };

function before(): RoomState {
  return room({
    tokens: {
      a: token("a", { actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, effects: [hidden, { id: "bless", key: "blessed" }] }) } }),
      b: token("b", { x: 5, actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, effects: [{ ...hidden }] }) } }),
      c: token("c", { x: 7, actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, effects: [bare] }) } }),
    },
    characters: { k: character("k", { actor: actor({ hp: { cur: 0, max: 9, temp: 0 }, effects: [{ id: AUTO, key: "unconscious", label: "Out cold" }] }) }) },
  });
}

type Row = { op: Op; version: number };

function pool(snapshot: { state: unknown; version: number }, rows: Row[]): Pool {
  const snap = { seq: "0", state: JSON.parse(JSON.stringify(snapshot.state)), schema_version: snapshot.version };
  const ops = rows.map((r, i) => ({ seq: String(i + 1), at: new Date(Date.UTC(2026, 10, 10, 12, 0, i)), actor_member_id: "dm1", actor_role: "dm", op: r.op, op_version: r.version, pub: i + 1 }));
  const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [snap] : sql.includes("room_log") ? [{ held: true }] : ops });
  return { query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool;
}

async function load(snapshot: { state: unknown; version: number }, rows: Row[]): Promise<RoomState> {
  const reasons: string[] = [];
  const loaded = await loadRoom(pool(snapshot, rows), "R", (_seq, reason) => reasons.push(reason));
  assert.deepEqual(reasons, []);
  assert.ok(loaded && !loaded.replayFailed);
  return loaded.state;
}

const ids = (effects: readonly Effect[]) => effects.map((e) => e.id);
const OLD = PLAYER_LIMITS_SNAPSHOT_VERSION - 1;

describe("the automatic Unconscious upgrade at a room's load", () => {
  test("a hidden or edited automatic effect takes its converted id, a bare one keeps its own, and two loads agree", async () => {
    const first = await load({ state: before(), version: OLD }, []);
    const second = await load({ state: before(), version: OLD }, []);
    const a = (first.tokens.a!.actor as { inline: { effects: Effect[] } }).inline.effects;
    assert.deepEqual(ids(a), [convertedEffectId(keys.token("a"), AUTO), "bless"]);
    assert.match(a[0]!.id, CONVERTED_EFFECT_ID);
    assert.equal(a[0]!.id.length, 81);
    assert.deepEqual(ids((first.tokens.b!.actor as { inline: { effects: Effect[] } }).inline.effects), [convertedEffectId(keys.token("b"), AUTO)]);
    assert.notEqual(convertedEffectId(keys.token("a"), AUTO), convertedEffectId(keys.token("b"), AUTO), "ids differ by creature");
    assert.deepEqual(ids((first.tokens.c!.actor as { inline: { effects: Effect[] } }).inline.effects), [AUTO], "the bare one stays automatic");
    assert.deepEqual(ids(first.characters.k!.actor.effects), [convertedEffectId(keys.character("k"), AUTO)]);
    assert.deepEqual(first, second, "the same on every load before the room is saved again");
    // Today's format holds the result, and no load converts again.
    const saved = await load({ state: first, version: PLAYER_LIMITS_SNAPSHOT_VERSION }, []);
    assert.deepEqual(saved, first);
  });

  test("the stored ops from before replay as they ran, naming the old id, and the conversion follows them", async () => {
    const rows: Row[] = [
      { op: { t: "actor.effect.update", target: { tokenId: "a" }, effectId: AUTO, patch: { label: "Knocked out" } } as Op, version: PLAYER_LIMITS_OP_VERSION - 1 },
      { op: { t: "actor.effect.remove", target: { tokenId: "b" }, effectId: AUTO } as Op, version: PLAYER_LIMITS_OP_VERSION - 1 },
    ];
    const state = await load({ state: before(), version: OLD }, rows);
    const a = (state.tokens.a!.actor as { inline: { effects: Effect[] } }).inline.effects;
    assert.equal(a[0]!.label, "Knocked out", "the old op found the effect by its old id");
    assert.equal(a[0]!.id, convertedEffectId(keys.token("a"), AUTO));
    assert.deepEqual(ids((state.tokens.b!.actor as { inline: { effects: Effect[] } }).inline.effects), [], "the old removal ran");
  });

  test("a stored op of today's version runs after the conversion, at the boundary", async () => {
    const converted = convertedEffectId(keys.token("a"), AUTO);
    const rows: Row[] = [{ op: { t: "actor.effect.update", target: { tokenId: "a" }, effectId: converted, patch: { label: "Later" } } as Op, version: PLAYER_LIMITS_OP_VERSION }];
    const state = await load({ state: before(), version: OLD }, rows);
    const a = (state.tokens.a!.actor as { inline: { effects: Effect[] } }).inline.effects;
    assert.deepEqual([a[0]!.id, a[0]!.label], [converted, "Later"]);
  });

  test("history steps, the effects a Next ended and the counts it moved, and an HP line's effects are converted alike", () => {
    const state = before();
    state.encounterHistory = [
      {
        encounter: { rev: 0, round: 1, activeEntryId: null, entries: [] } as never,
        effects: { a: [hidden], c: [bare] },
        revealed: [],
        effectChanges: [{ holderId: "a", ended: [{ at: 0, effect: hidden }], counted: [{ id: AUTO, from: 2, to: 1 }] }],
        at: new Date(0).toISOString(),
      },
    ];
    state.log = [{ id: "1:0", at: new Date(0).toISOString(), kind: "hp", data: { type: "hp", tokenId: "a", revert: { before: {} as never, after: {} as never, removed: [hidden] } } } as never];
    const out = automaticUpgrade(state);
    const converted = convertedEffectId(keys.token("a"), AUTO);
    const step = out.encounterHistory[0]!;
    assert.deepEqual(ids(step.effects.a!), [converted]);
    assert.deepEqual(ids(step.effects.c!), [AUTO]);
    assert.equal(step.effectChanges![0]!.ended![0]!.effect.id, converted);
    assert.equal(step.effectChanges![0]!.counted![0]!.id, converted);
    assert.equal((out.log[0]!.data as { revert: { removed: Effect[] } }).revert.removed[0]!.id, converted);
    assert.deepEqual(automaticUpgrade(out), out, "converting again changes nothing");
  });
});
