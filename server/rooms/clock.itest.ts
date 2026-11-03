import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { formatDisplayCode } from "../auth/displaySessions.ts";
import { startEngine, type Engine, type Socket } from "./testing.ts";

/**
 * The room's clock over the real socket and Postgres
 * (docs/design/design-v1-calendar.md 6.4): while the DM hides it, no frame a
 * player or a table display receives holds the clock, its calendar or a line
 * about it, nor while a blackout is up, and what reached a player while it
 * was shown is still theirs after a restart.
 */
const MONTHS = { kind: "months" as const, months: [{ name: "Deepwinter", days: 30 }, { name: "Frostmoot", days: 1 }], week: ["Moonday", "Starday"], era: "Ashen Age" };
const SECRETS = ["Deepwinter", "Frostmoot", "Moonday", "Starday", "Ashen Age", "\"clock\"", "clock:", "longRest"];

/** Every frame the socket receives from now on, as the text that crossed the wire. */
function wire(socket: Socket): string[] {
  const frames: string[] = [];
  socket.ws.on("message", (data) => frames.push(data.toString()));
  return frames;
}

function leaks(frames: readonly string[]): string[] {
  return SECRETS.filter((secret) => frames.some((frame) => frame.includes(secret)));
}

describe("the room's clock on the server", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("a hidden clock, its steps and its lines never cross a player's or a display's socket, and a shown one does", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Clock");
    const playerClient = t.client();
    const pip = await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const player = await t.connect(roomId, playerClient);
    await dm.snapshot("dm");
    await player.snapshot("p");
    const tv = t.client();
    const code = (await dmClient.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code) })).statusCode, 200);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");
    const playerFrames = wire(player);
    const displayFrames = wire(display);

    const characterId = uuidv7();
    await dm.apply({ t: "character.create", character: { id: characterId, name: "Bree", size: "medium", ownerIds: [pip], actor: { hp: { cur: 5, max: 20, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } } as Op);
    const started = await dm.apply({ t: "clock.start", id: uuidv7(), at: 8 * 3_600, shown: false, calendar: MONTHS });
    assert.ok(started.changes.some((c) => c.key === "clock"), "the DM gets the clock");
    await dm.apply({ t: "clock.advance", by: 3 * 86_400 });
    await dm.apply({ t: "clock.set", at: 30 * 86_400 });
    // The player's own character, whose stamp is still the DM's alone.
    await dm.apply({ t: "actor.rest", target: { characterId }, kind: "long" });
    await dm.apply({ t: "clock.update", calendar: { ...MONTHS, era: "Ashen Age" } });
    // A chat line after them, so every frame the clock's ops sent has arrived before the check.
    await dm.apply({ t: "log.chat", text: "fence" });
    await player.next("ev", (m) => m.changes.some((c) => "value" in c && (c.value as LogEntry | null)?.text === "fence"));
    assert.ok(playerFrames.length > 0);
    assert.deepEqual(leaks(playerFrames), [], "nothing of a hidden clock reaches a player");
    assert.deepEqual(leaks(displayFrames), [], "nor a table display");
    const hiddenSnap = await t.connect(roomId, playerClient);
    const snap = await hiddenSnap.snapshot("p2");
    assert.ok(!("clock" in (snap.state as ProjectedState)), "a reload holds no clock either");
    assert.deepEqual(leaks([JSON.stringify(snap)]), []);

    // Shown, the next step reaches the player with its line, and stays theirs after a restart and sharing off.
    await dm.apply({ t: "clock.update", shown: true });
    const step = await dm.apply({ t: "clock.advance", by: 3_600 });
    const line = step.changes.find((c) => c.key.startsWith("log:") && "value" in c && (c.value as LogEntry | null)?.data?.type === "clock");
    assert.ok(line, "the DM's own line");
    const ev = await player.next("ev", (m) => m.changes.some((c) => c.key === line.key));
    assert.ok(ev.changes.some((c) => c.key === "clock"), "the player gets the clock as it is now");
    await dm.apply({ t: "clock.update", shown: false });
    await t.restart();
    const again = await t.connect(roomId, playerClient);
    const reloaded = (await again.snapshot("p3")).state as ProjectedState;
    assert.ok(!("clock" in reloaded));
    const lines = reloaded.log.filter((l) => l.data?.type === "clock");
    assert.deepEqual(lines.map((l) => l.id), [line.key.slice("log:".length)], "the one line written while shown, and none of the hidden ones");
  });

  test("behind a blackout a shown clock and its lines never cross a player's or a display's socket, and come back when it ends (ASTRA-06)", async () => {
    const dmClient = t.client();
    const { roomId } = await dmClient.createRoom("Blackout clock");
    const playerClient = t.client();
    await playerClient.join(roomId, "Pip");
    const dm = await t.connect(roomId, dmClient);
    const player = await t.connect(roomId, playerClient);
    await dm.snapshot("dm");
    await player.snapshot("p");
    const tv = t.client();
    const code = (await dmClient.post(`/api/rooms/${roomId}/display/code`)).json<{ code: string }>().code;
    assert.equal((await tv.post("/api/display/redeem", { code: formatDisplayCode(code) })).statusCode, 200);
    const display = await t.connectDisplay(roomId, tv);
    await display.snapshot("tv");

    await dm.apply({ t: "view.blackout", blackout: true });
    const playerFrames = wire(player);
    const displayFrames = wire(display);
    await dm.apply({ t: "clock.start", id: uuidv7(), at: 8 * 3_600, shown: true, calendar: MONTHS });
    await dm.apply({ t: "clock.advance", by: 3 * 86_400 });
    await dm.apply({ t: "log.chat", text: "fence" });
    await player.next("ev", (m) => m.changes.some((c) => "value" in c && (c.value as LogEntry | null)?.text === "fence"));
    assert.deepEqual(leaks(playerFrames), [], "nothing of the clock reaches a player behind a blackout");
    assert.deepEqual(leaks(displayFrames), [], "nor a table display");
    const paused = (await (await t.connect(roomId, playerClient)).snapshot("p2")).state as ProjectedState;
    assert.ok(!("clock" in paused), "a reload behind the blackout holds no clock");
    assert.deepEqual(paused.log.filter((l) => l.data?.type === "clock"), []);

    await dm.apply({ t: "view.blackout", blackout: false });
    const back = await player.next("ev", (m) => m.changes.some((c) => c.key === "clock"));
    const clock = back.changes.find((c) => c.key === "clock");
    assert.equal(clock && "value" in clock ? (clock.value as { t: number }).t : null, 8 * 3_600 + 3 * 86_400, "the clock comes back as it is now");
    const lines = back.changes.filter((c) => c.key.startsWith("log:") && "value" in c && (c.value as LogEntry | null)?.data?.type === "clock");
    assert.equal(lines.length, 2, "with the start line and the step's");
  });
});
