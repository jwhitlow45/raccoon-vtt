import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry, LogEvent } from "#shared/model.ts";
import { AT, P1, character, member, room, token } from "#shared/testutil.ts";
import { batchOf, resolveDice } from "./dice.ts";
import { remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

const TAG = "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d";

describe("the server's dice (docs/design-v1-dice.md 4.2)", () => {
  test("a batch id is 16 characters of the roller and the tag, the same for every batch of one tag, and says nothing of the tag", () => {
    const id = batchOf("p1", TAG);
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(batchOf("p1", TAG), id);
    assert.notEqual(batchOf("p2", TAG), id, "another member's same tag is another batch");
    assert.notEqual(batchOf("p1", `${TAG}x`), id);
    assert.ok(!TAG.replaceAll("-", "").includes(id.slice(0, 8)));
  });

  test("the resolve draws each die in order, applies each mode and keeps cancelled", () => {
    const faces = [6, 5, 17, 3, 9];
    const resolved = resolveDice(
      {
        t: "dice.roll",
        tag: TAG,
        part: 1,
        to: "all",
        rolls: [
          { formula: "2d6+3", label: "Longsword" },
          { formula: "1d20+4", mode: "adv" },
          { formula: "1d20+1", cancelled: true },
        ],
      },
      room(),
      P1,
      { draw: () => faces.shift()! },
    );
    assert.ok(resolved.ok);
    assert.equal(resolved.op.batch, batchOf("p1", TAG));
    assert.deepEqual(resolved.op.results, [
      { formula: "2d6+3", faces: [6, 5], total: 14 },
      { formula: "2d20kh1+4", faces: [17, 3], total: 21, mode: "adv" },
      { formula: "1d20+1", faces: [9], total: 10, cancelled: true },
    ]);
    assert.equal(resolved.op.asked.t, "dice.roll");
  });
});

describe("dice lines in a room's export (5.3)", () => {
  function withLines(): ReturnType<typeof room> {
    const state = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") }, tokens: { g1: token("g1") }, characters: { bree: character("bree") } });
    const line: LogEvent = {
      type: "dice",
      tag: TAG,
      batch: batchOf("p1", TAG),
      by: "p1",
      to: "dm",
      ac: 15,
      rolls: [
        { formula: "2d20kh1+4", faces: [17, 3], total: 21, mode: "adv", label: "Scimitar", tokenId: "g1", seen: true, critOn: 19 },
        { formula: "1d20", faces: [4], total: 4, characterId: "bree", cancelled: true },
      ],
    };
    const bare: LogEvent = { type: "dice", by: "dm1", to: "dm", rolls: [] };
    const entries: LogEntry[] = [
      { id: "3:0", at: AT, kind: "event", data: line },
      { id: "4:0", at: AT, kind: "event", data: bare },
    ];
    return { ...state, log: entries };
  }

  test("the import schema takes a dice line, its rolls and a bare line", () => {
    const parsed = parseRoomState(JSON.parse(JSON.stringify(withLines())));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const tooLong = withLines();
    (tooLong.log[0]!.data as Extract<LogEvent, { type: "dice" }>).rolls[0]!.label = "x".repeat(61);
    assert.equal(parseRoomState(JSON.parse(JSON.stringify(tooLong))).ok, false);
  });

  test("remap moves the roller and every roll's creature to their new ids", () => {
    const out = remapState(withLines(), { assets: new Map() });
    const data = out.log[0]?.data as Extract<LogEvent, { type: "dice" }>;
    const p1 = Object.values(out.members).find((m) => m.name === "p1")!;
    assert.equal(data.by, p1.id);
    assert.equal(data.rolls[0]?.tokenId, Object.keys(out.tokens)[0]);
    assert.equal(data.rolls[1]?.characterId, Object.keys(out.characters)[0]);
    assert.notEqual(data.by, "p1");
    assert.deepEqual(data.rolls[0]?.faces, [17, 3]);
  });
});
