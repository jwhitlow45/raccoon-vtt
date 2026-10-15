import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import type { LogEntry, LogEvent } from "#shared/model.ts";
import { entriesBetween, exportFileName, exportLine, renderLogExport, sessionsOf, validTimeZone } from "./logExport.ts";

const HOUR = 3_600_000;

function chat(i: number, at: string, text = `line ${i}`, from = "thorn"): LogEntry {
  return { id: `${i}:0`, at, kind: "chat", from, text };
}

const names = {
  members: {
    thorn: { id: "thorn", rev: 1, name: "Thorn", color: "#3e8ef7", kind: "player", createdAt: "2026-01-01T00:00:00Z" },
    dm: { id: "dm", rev: 1, name: "Dungeon *Master*", color: "#f7df00", kind: "dm", createdAt: "2026-01-01T00:00:00Z" },
  },
  tokens: {},
  characters: {},
  handouts: {},
  encounter: null,
} as unknown as LogNames;

test("a session is a run of lines with no gap over 4 hours, newest first", () => {
  const start = Date.parse("2026-10-14T23:00:00Z");
  const at = (ms: number) => new Date(start + ms).toISOString();
  const entries = [chat(1, at(0)), chat(2, at(2 * HOUR)), chat(3, at(6 * HOUR)), chat(4, at(10 * HOUR + 1)), chat(5, at(10 * HOUR + 60_000))];
  assert.deepEqual(sessionsOf(entries), [
    { from: at(10 * HOUR + 1), to: at(10 * HOUR + 60_000), lines: 2 },
    { from: at(0), to: at(6 * HOUR), lines: 3 },
  ]);
  assert.deepEqual(sessionsOf([]), []);
});

test("the export takes the lines between two instants, either bound open", () => {
  const entries = [chat(1, "2026-10-14T19:00:00.000Z"), chat(2, "2026-10-14T20:00:00.000Z"), chat(3, "2026-10-14T21:00:00.000Z")];
  assert.deepEqual(entriesBetween(entries, "2026-10-14T20:00:00.000Z", "2026-10-14T21:00:00.000Z").map((e) => e.id), ["2:0", "3:0"]);
  assert.deepEqual(entriesBetween(entries, undefined, "2026-10-14T19:30:00Z").map((e) => e.id), ["1:0"]);
  assert.equal(entriesBetween(entries, undefined, undefined).length, 3);
});

test("a time zone counts when a formatter constructs with it, UTC included", () => {
  assert.equal(validTimeZone("UTC"), true);
  assert.equal(validTimeZone("America/Chicago"), true);
  assert.equal(validTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(validTimeZone(""), false);
  assert.equal(validTimeZone(`Europe/${"x".repeat(60)}`), false);
});

test("lines read as the Log panel reads them, in the viewer's zone", () => {
  const hp: LogEvent = { type: "hp", tokenId: "gone", change: "damage", amount: 7 } as LogEvent;
  const event: LogEntry = { id: "3:0", at: "2026-10-15T00:43:00.000Z", kind: "event", data: hp };
  assert.equal(exportLine(event, names, "thorn", "7:43 PM"), `- 7:43 PM ${describeEvent(hp, names)}`);
  assert.equal(exportLine(chat(1, "2026-10-15T00:42:00Z", "Is the door locked?"), names, "thorn", "7:42 PM"), "- 7:42 PM **Thorn**: Is the door locked?");
  const whisper: LogEntry = { id: "2:0", at: "2026-10-15T00:42:30Z", kind: "whisper", from: "thorn", to: ["dm"], text: "psst\nover here <b>" };
  assert.equal(exportLine(whisper, names, "thorn", "7:42 PM"), "- 7:42 PM **Thorn** (whisper to the DM): psst\n  over here &lt;b>");

  const file = renderLogExport({ roomName: "Crypt Crawlers", entries: [chat(1, "2026-10-15T00:42:00.000Z", "Is the door locked?"), event], names, me: "thorn", tz: "America/Chicago" });
  assert.equal(file, `# Crypt Crawlers: log of October 14, 2026\n\n- 7:42 PM **Thorn**: Is the door locked?\n- 7:43 PM ${describeEvent(hp, names)}\n`);
  const utc = renderLogExport({ roomName: "Crypt Crawlers", entries: [chat(1, "2026-10-15T00:42:00.000Z", "Is the door locked?")], names, me: "thorn", tz: "UTC" });
  assert.match(utc, /^# Crypt Crawlers: log of October 15, 2026\n\n- 12:42 AM \*\*Thorn\*\*/);
});

test("a file over several days gets a heading per day, and an empty one says so", () => {
  const file = renderLogExport({
    roomName: "Crypt",
    entries: [chat(1, "2026-10-14T19:00:00Z", "first"), chat(2, "2026-10-21T19:00:00Z", "second", "dm")],
    names,
    me: "thorn",
    tz: "UTC",
  });
  assert.equal(
    file,
    "# Crypt: log of October 14, 2026 to October 21, 2026\n\n## Wednesday, October 14, 2026\n\n- 7:00 PM **Thorn**: first\n\n## Wednesday, October 21, 2026\n\n- 7:00 PM **Dungeon \\*Master\\***: second\n",
  );
  assert.equal(renderLogExport({ roomName: "Crypt", entries: [], names, me: "thorn", tz: "UTC" }), "# Crypt: log\n\nNo lines.\n");
});

test("the file is named for the room and the day in the viewer's zone", () => {
  assert.equal(exportFileName("Crypt Crawlers", "2026-10-15T00:42:00Z", "America/Chicago"), "crypt-crawlers-log-2026-10-14.md");
  assert.equal(exportFileName("Crypt Crawlers", "2026-10-15T00:42:00Z", "UTC"), "crypt-crawlers-log-2026-10-15.md");
  assert.equal(exportFileName("Ça & Là!", "2026-10-15T00:42:00Z", "UTC"), "ca-la-log-2026-10-15.md");
  assert.equal(exportFileName("???", "2026-10-15T00:42:00Z", "UTC"), "room-log-2026-10-15.md");
});
