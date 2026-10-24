import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * Combat uses on the real server and Postgres
 * (docs/design-v1-combat-controls.md 2.3 and 3.1): a turn's prompt is
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
    t = await startEngine({
      rooms: {
        actor: {
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
});
