import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ShellToSupervisor, SupervisorStatus } from "../contract.ts";
import { sampleStatus } from "./fixture.ts";
import { SupervisorLink, failureReason, type ExitInfo, type SupervisorChannel } from "./supervisor.ts";

class FakeChannel extends EventEmitter implements SupervisorChannel {
  onMessage(listener: (message: unknown) => void): void {
    this.on("message", listener);
  }
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.on("exit", listener);
  }
  sent: ShellToSupervisor[] = [];
  connected = true;
  sendWorks = true;
  send(message: ShellToSupervisor): boolean {
    if (!this.sendWorks) return false;
    this.sent.push(message);
    return true;
  }
  disconnect(): void {
    this.connected = false;
  }
  /** What the supervisor would send. */
  reply(message: unknown): void {
    this.emit("message", message);
  }
  exit(code: number | null, signal: string | null = null): void {
    this.connected = false;
    this.emit("exit", code, signal);
  }
}

function link() {
  const channel = new FakeChannel();
  const statuses: SupervisorStatus[] = [];
  const exits: ExitInfo[] = [];
  const logs: string[] = [];
  const l = new SupervisorLink(channel, {
    onStatus: (s) => statuses.push(s),
    onExit: (e) => exits.push(e),
    log: (m) => logs.push(m),
  });
  return { channel, link: l, statuses, exits, logs };
}

test("statuses pass through only when they match the contract", () => {
  const { channel, link: l, statuses, logs } = link();
  channel.reply({ type: "status", status: sampleStatus() });
  channel.reply({ type: "status", status: { ...sampleStatus(), state: "dancing" } });
  channel.reply({ type: "status" });
  channel.reply("hello");
  assert.equal(statuses.length, 1);
  assert.equal(l.status?.state, "running");
  assert.equal(logs.length, 3);
});

test("each command's answer reaches its own caller, by id", { timeout: 5000 }, async () => {
  const { channel, link: l } = link();
  const rooms = l.command({ type: "listRooms" });
  const backup = l.command({ type: "backupNow" });
  assert.deepEqual(
    channel.sent.map((m) => [m.id, m.command.type]),
    [
      [1, "listRooms"],
      [2, "backupNow"],
    ],
  );
  channel.reply({ type: "result", id: 2, outcome: { ok: false, failure: { error: "restoring" } } });
  channel.reply({ type: "result", id: 99, outcome: { ok: true, value: {} } });
  channel.reply({ type: "result", id: 1, outcome: { ok: true, value: { rooms: [] } } });
  assert.deepEqual(await rooms, { ok: true, value: { rooms: [] } });
  assert.deepEqual(await backup, { ok: false, failure: { error: "restoring" } });
});

test("a supervisor that exits answers every waiting command as not running, and later ones at once", { timeout: 5000 }, async () => {
  const { channel, link: l, exits } = link();
  channel.reply({ type: "status", status: sampleStatus() });
  const waiting = l.command({ type: "backupNow" });
  channel.exit(1);
  assert.deepEqual(await waiting, { ok: false, failure: { error: "notRunning" } });
  assert.deepEqual(await l.command({ type: "listRooms" }), { ok: false, failure: { error: "notRunning" } });
  assert.deepEqual(exits, [{ code: 1, signal: null, hadStatus: true }]);
  channel.exit(1);
  assert.equal(exits.length, 1, "one exit, reported once");
});

test("a channel that will not take the message answers not running instead of waiting forever", { timeout: 5000 }, async () => {
  const { channel, link: l } = link();
  channel.sendWorks = false;
  assert.deepEqual(await l.command({ type: "listRooms" }), { ok: false, failure: { error: "notRunning" } });
});

test("stop counts as stopped on the stop command's answer or on the process ending, and gives up after its timeout", { timeout: 5000 }, async () => {
  {
    const { channel, link: l } = link();
    const stopping = l.stop(1000);
    assert.equal(channel.sent.at(-1)?.command.type, "stop");
    channel.reply({ type: "result", id: channel.sent.at(-1)!.id, outcome: { ok: true, value: {} } });
    assert.deepEqual(await stopping, { ok: true });
  }
  {
    const { channel, link: l } = link();
    const stopping = l.stop(1000);
    channel.exit(0);
    assert.deepEqual(await stopping, { ok: true });
  }
  {
    const { link: l } = link();
    assert.deepEqual(await l.stop(20), { ok: false, reason: "RaccoonVTT did not stop in time" });
  }
  {
    const { channel, link: l } = link();
    const stopping = l.stop(1000);
    channel.reply({ type: "result", id: channel.sent.at(-1)!.id, outcome: { ok: false, failure: { error: "failed", reason: "the database would not shut down" } } });
    assert.deepEqual(await stopping, { ok: false, reason: "the database would not shut down" });
  }
  {
    const { channel, link: l } = link();
    channel.exit(0);
    assert.deepEqual(await l.stop(1000), { ok: true }, "already gone counts as stopped");
  }
});

test("every failure reads as a clause", () => {
  assert.equal(failureReason({ error: "failed", reason: "the disk is full" }), "the disk is full");
  assert.equal(failureReason({ error: "restoring" }), "a restore is running");
  assert.equal(failureReason({ error: "noSpace", bytes: 5 }), "there is not enough free disk space");
});
