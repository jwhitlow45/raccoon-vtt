import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { OP_VERSION } from "#shared/migrate.ts";
import type { LogEntry } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * Combat uses on the real server and Postgres
 * (docs/design/design-v1-combat-controls.md 2.3 and 3.1): a turn's prompt is
 * refused before any die is drawn once it is settled or no longer due, its
 * roll is drawn once, and the stored roll replays after a restart to the
 * same room.
 */
const stats = { draws: 0 };

type Ev = Extract<ServerMessage, { t: "ev" }>;

const inline = { hp: { cur: 170, max: 178, temp: 0 }, life: "alive", ac: 18, speeds: { walk: 40 }, initBonus: 0, passivePerception: 20, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };

async function send(socket: Socket, op: Op): Promise<{ ev: Ev; ok: boolean; message?: string }> {
  const n = socket.op(op);
  const ev = await socket.next("ev", (m) => (m.acks?.includes(n) ?? false) || (m.rejects?.some((r) => r.n === n) ?? false));
  const rejected = ev.rejects?.find((r) => r.n === n);
  return { ev, ok: rejected === undefined, ...(rejected ? { message: rejected.message } : {}) };
}

describe("combat uses on the server", () => {
  let t: Engine;
  before(async () => {
    // Fixture ids in this file are not version 7 ids made just now, so its rooms' id gate is off (server/rooms/createIds.ts).
    t = await startEngine({
      rooms: {
        actor: {
          idGate: false,
          draw: (sides) => {
            stats.draws++;
            return Math.min(sides, 5);
          },
        },
      },
    });
  });
  after(() => t.close());

  test("a recharge prompt's roll is drawn once, a second is refused before its die, and the stored roll replays after a restart", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Recharge");
    const dm = await t.connect(roomId, dmClient);
    const snap = await dm.snapshot(uuidv7());
    const sceneId = (snap.state as ProjectedState).meta.playerSceneId ?? "";
    const id = uuidv7();
    await dm.apply({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Young Red Dragon", size: "large", x: 2, y: 2, actor: { inline } } } as Op);
    await dm.apply({ t: "actor.use", target: { tokenId: id }, use: { kind: "ability", key: "actions:fire-breath", name: "Fire Breath", limit: "recharge", max: 1, min: 5 } });
    await dm.apply({ t: "encounter.start", entries: [{ id: "ed", tokenId: id, value: 20 }] });
    const next = await send(dm, { t: "encounter.next" });
    assert.ok(next.ok);
    const token = next.ev.changes.find((c) => c.key === `token:${id}`) as { value: { actor: { inline: { turnRecord?: { id: number; due?: string[] } } } } } | undefined;
    const record = token?.value.actor.inline.turnRecord;
    assert.ok(record && record.due?.includes("actions:fire-breath"), "the breath is due");
    const recordId = record.id;
    const op = (tag: string): Op => ({ t: "actor.rechargeRoll", tag, target: { tokenId: id }, key: "actions:fire-breath", name: "Fire Breath", min: 5, record: recordId });
    const before = stats.draws;
    const first = await send(dm, op(uuidv7()));
    assert.ok(first.ok, first.message);
    assert.equal(stats.draws - before, 1, "one d6");
    const line = first.ev.changes.flatMap((c) => ("value" in c && c.key.startsWith("log:") && (c.value as LogEntry | null)?.data?.type === "dice" ? [c.value as LogEntry] : []))[0];
    assert.ok(line);
    const second = await send(dm, op(uuidv7()));
    assert.deepEqual([second.ok, second.message], [false, "It was settled meanwhile."]);
    assert.equal(stats.draws - before, 1, "the refusal drew nothing");
    await t.restart();
    const drawsAfter = stats.draws;
    const again = await t.connect(roomId, dmClient);
    const reloaded = await again.snapshot(uuidv7());
    const state = reloaded.state as ProjectedState;
    const actor = (state.tokens[id]!.actor as { inline: { uses?: unknown; turnRecord?: { settled?: Record<string, unknown> } } }).inline;
    assert.equal(actor.uses, undefined, "a 5 readied it");
    assert.deepEqual(actor.turnRecord?.settled, { "recharge:actions:fire-breath": { state: "done", total: 5, outcome: "ready" } });
    assert.equal(stats.draws, drawsAfter, "replay draws nothing");
  });

  test("a player's death save sent after they were healed is refused before its die", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Death save");
    const pipClient = t.client();
    const pipId = await pipClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const snap = await dm.snapshot(uuidv7());
    const sceneId = (snap.state as ProjectedState).meta.playerSceneId ?? "";
    const pip = await t.connect(roomId, pipClient);
    await pip.snapshot(uuidv7());
    const id = uuidv7();
    await dm.apply({ t: "token.create", token: { id, sceneId, kind: "pc", name: "Thorn", size: "medium", x: 2, y: 2, ownerIds: [pipId], actor: { inline: { ...inline, hp: { cur: 0, max: 30, temp: 0 }, life: "dying" } } } } as Op);
    await dm.apply({ t: "encounter.start", entries: [{ id: "et", tokenId: id, value: 12 }] });
    const next = await send(dm, { t: "encounter.next" });
    const token = next.ev.changes.find((c) => c.key === `token:${id}`) as { value: { actor: { inline: { turnRecord?: { id: number } } } } } | undefined;
    const record = token?.value.actor.inline.turnRecord?.id;
    assert.ok(record !== undefined);
    await dm.apply({ t: "actor.hp", target: { tokenId: id }, change: { kind: "heal", amount: 4 } });
    const before = stats.draws;
    const sent = await send(pip, { t: "actor.deathRoll", tag: uuidv7(), target: { tokenId: id }, record });
    assert.deepEqual([sent.ok, sent.message], [false, "Thorn is no longer dying."]);
    assert.equal(stats.draws, before);
  });

  test("lair46: a token's lair tick stays the DM's, its row's In lair keeps it in step, and a restart replays it", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Lair tick");
    const pipClient = t.client();
    const pipId = await pipClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const snap = await dm.snapshot(uuidv7());
    const sceneId = (snap.state as ProjectedState).meta.playerSceneId ?? "";
    const pip = await t.connect(roomId, pipClient);
    await pip.snapshot(uuidv7());
    const id = uuidv7();
    const tick = (state: unknown) => ((state as ProjectedState).tokens[id]?.actor as { inline: { inLair?: true } } | undefined)?.inline.inLair;
    const touches = (m: Ev) => m.changes.some((c) => c.key === `token:${id}`);
    const tokenIn = (m: Ev): unknown => {
      const change = m.changes.find((c) => c.key === `token:${id}`);
      return change && "value" in change ? change.value : undefined;
    };
    // Pip plays the creature the DM placed in its lair, which Pip's copy never says.
    const placed = await dm.apply({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Crypt Keeper", size: "medium", x: 2, y: 2, ownerIds: [pipId], actor: { inline: { ...inline, inLair: true } } } } as Op);
    assert.ok(!placed.rejects?.length, placed.rejects?.[0]?.message);
    const seen = await pip.next("ev", touches);
    assert.ok(tokenIn(seen));
    assert.equal(tick({ tokens: { [id]: tokenIn(seen) } }), undefined, "the owner's copy holds no tick");
    const fight = (m: Ev) => m.changes.some((c) => c.key === "encounter");
    await dm.apply({ t: "encounter.start", entries: [{ id: "ek", tokenId: id, value: 12, inLair: true }] });
    await pip.next("ev", fight);

    const off = await send(dm, { t: "encounter.update", entryId: "ek", patch: { inLair: false } });
    assert.ok(off.ok, off.message);
    const written = tokenIn(off.ev);
    assert.ok(written, "the switch writes the token");
    assert.equal(tick({ tokens: { [id]: written } }), undefined, "out of its lair, the tick goes");
    // Pip sees the row's Lair tag go, and nothing of the token, whose copy is the same.
    const row = await pip.next("ev", fight);
    assert.equal(touches(row), false, "the owner's copy is the same, so Pip hears nothing of the token");
    await dm.apply({ t: "encounter.end" });
    const { rows } = await t.pool.query<{ op_version: number }>("select op_version from room_ops where room_id = $1 and op->>'t' = 'encounter.update'", [roomId]);
    assert.deepEqual(rows.map((r) => r.op_version), [OP_VERSION], "stored at today's version, which writes the tick on replay");

    await t.restart();
    const again = await t.connect(roomId, dmClient);
    const reloaded = await again.snapshot(uuidv7());
    assert.equal(tick(reloaded.state), undefined, "replay takes it off as the switch did");
    assert.equal((reloaded.state as ProjectedState).encounter, null);
    const back = await send(again, { t: "encounter.start", entries: [{ id: "ek2", tokenId: id, value: 12 }] });
    assert.ok(back.ok, back.message);
    const on = await send(again, { t: "encounter.update", entryId: "ek2", patch: { inLair: true } });
    assert.ok(on.ok, on.message);
    const pipAgain = await t.connect(roomId, pipClient);
    const pipSnap = await pipAgain.snapshot(uuidv7());
    assert.equal(tick(pipSnap.state), undefined, "Pip's snapshot holds no tick either");
    await t.restart();
    const third = await t.connect(roomId, dmClient);
    assert.equal(tick((await third.snapshot(uuidv7())).state), true, "replay puts it back on as the switch did");
  });
});
