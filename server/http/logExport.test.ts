import assert from "node:assert/strict";
import { test } from "node:test";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import type { LogEntry, LogEvent } from "#shared/model.ts";
import { entriesBetween, ExportFormatter, exportFileName, exportLine, renderLogExport, sessionsOf, validTimeZone } from "./logExport.ts";
import { sliceSessions } from "../rooms/logHistory.ts";

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
    { firstId: "4:0", lastId: "5:0", from: at(10 * HOUR + 1), to: at(10 * HOUR + 60_000), lines: 2 },
    { firstId: "1:0", lastId: "3:0", from: at(0), to: at(6 * HOUR), lines: 3 },
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

test("sessions follow id order: equal times and a clock that steps back keep every line in its session", () => {
  // 10:00, then 16:00 (a new session), then 09:00 and 10:30 the next morning by a clock set back: still the second session.
  const entries = [chat(1, "2026-10-14T10:00:00.000Z"), chat(2, "2026-10-14T16:00:00.000Z"), chat(3, "2026-10-14T09:00:00.000Z"), chat(4, "2026-10-14T10:30:00.000Z"), chat(5, "2026-10-14T10:30:00.000Z")];
  assert.deepEqual(sessionsOf(entries), [
    { firstId: "2:0", lastId: "5:0", from: "2026-10-14T16:00:00.000Z", to: "2026-10-14T10:30:00.000Z", lines: 4 },
    { firstId: "1:0", lastId: "1:0", from: "2026-10-14T10:00:00.000Z", to: "2026-10-14T10:00:00.000Z", lines: 1 },
  ]);
});

test("a canonical session list pages by first id: the same sessions whatever the limit, and a cursor only when more are left", () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ firstId: `${i * 10 + 1}:0`, lastId: `${i * 10 + 5}:0`, from: "a", to: "b", lines: 5 }));
  const ids = (page: { sessions: { firstId: string }[] }) => page.sessions.map((s) => s.firstId);
  assert.deepEqual(ids(sliceSessions(list, undefined, 3)), ["61:0", "51:0", "41:0"]);
  assert.equal(sliceSessions(list, undefined, 3).nextSessionsBefore, "41:0");
  assert.deepEqual(ids(sliceSessions(list, "41:0", 3)), ["31:0", "21:0", "11:0"]);
  assert.equal(sliceSessions(list, "41:0", 3).nextSessionsBefore, "11:0");
  assert.deepEqual(ids(sliceSessions(list, "11:0", 3)), ["1:0"]);
  assert.equal(sliceSessions(list, "11:0", 3).nextSessionsBefore, null);
  assert.deepEqual(ids(sliceSessions(list, "1:0", 3)), []);
  // A boundary inside a session keeps the session it falls in, and numbers compare as numbers.
  assert.deepEqual(ids(sliceSessions(list, "43:0", 1)), ["41:0"]);
  assert.deepEqual(ids(sliceSessions(list, "9:0", 5)), ["1:0"]);
  assert.deepEqual(ids(sliceSessions(list, undefined, 50)), ["61:0", "51:0", "41:0", "31:0", "21:0", "11:0", "1:0"]);
  assert.equal(sliceSessions(list, undefined, 7).nextSessionsBefore, null);
});

test("a file written in pieces is the file written at once", () => {
  const entries = [
    chat(1, "2026-10-14T23:59:00.000Z", "late"),
    { id: "2:0", at: "2026-10-15T00:01:00.000Z", kind: "event", data: { type: "member", action: "join", memberId: "thorn" } } as LogEntry,
    { id: "3:0", at: "2026-10-15T00:02:00.000Z", kind: "event" } as LogEntry,
    chat(4, "2026-10-16T12:00:00.000Z", "days later\nsecond line"),
  ];
  const input = { roomName: "Crypt", names, me: "thorn", tz: "UTC" };
  const whole = renderLogExport({ ...input, entries });
  for (let cut = 0; cut <= entries.length; cut++) {
    const format = new ExportFormatter(input, { first: entries[0]!, last: entries[entries.length - 1]! });
    assert.equal(format.head() + format.lines(entries.slice(0, cut)) + format.lines(entries.slice(cut)), whole);
  }
  assert.equal(new ExportFormatter(input, null).head(), renderLogExport({ ...input, entries: [] }));
});
