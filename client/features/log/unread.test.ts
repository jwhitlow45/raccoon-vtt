import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry, Member } from "#shared/model.ts";
import { badgeText, latestLogId, newWhispersTo, unreadCount, whisperToastText } from "./unread.ts";

const at = "2026-10-13T19:00:00.000Z";
const log: LogEntry[] = [
  { id: "10:0", at, kind: "chat", from: "dm", text: "Welcome" },
  { id: "11:0", at, kind: "event", data: { k: "join", memberId: "pia" } as never },
  { id: "12:0", at, kind: "chat", from: "pia", text: "Hi" },
  { id: "12:1", at, kind: "whisper", from: "dm", to: ["pia"], text: "You hear a  noise\nbehind the door." },
  { id: "13:0", at, kind: "whisper", from: "dm", to: ["quin"], text: "Not for Pia" },
];
const members = { dm: { id: "dm", name: "Dana" } as Member };

describe("unread messages in the Log", () => {
  test("count chat and whispers from others since the last one seen, never events or your own", () => {
    assert.equal(unreadCount(log, null, "pia"), 3);
    assert.equal(unreadCount(log, "11:0", "pia"), 2);
    assert.equal(unreadCount(log, latestLogId(log), "pia"), 0);
  });

  test("a whisper to you is new once, and only yours", () => {
    assert.deepEqual(newWhispersTo(log, "12:0", "pia").map((e) => e.id), ["12:1"]);
    assert.deepEqual(newWhispersTo(log, "12:1", "pia"), []);
    assert.deepEqual(newWhispersTo(log, null, "dm"), []);
  });

  test("the toast names the sender and shows the start of the message", () => {
    assert.equal(whisperToastText(log[3]!, members), "Dana whispers: You hear a noise behind the door.");
    const long = { ...log[3]!, text: "x".repeat(200) };
    assert.equal(whisperToastText(long, members).length, "Dana whispers: ".length + 80);
  });

  test("the badge is a small count", () => {
    assert.equal(badgeText(0), null);
    assert.equal(badgeText(3), "3");
    assert.equal(badgeText(12), "9+");
  });
});
