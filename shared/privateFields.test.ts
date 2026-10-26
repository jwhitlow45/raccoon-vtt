import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { privateFieldsIn } from "./privateFields.ts";

describe("privateFieldsIn (what a player's copy never holds, docs/design-v1-per-player-vision.md 9.3)", () => {
  const stop = (seen: unknown) => ({ x: 1, y: 2, seen });

  test("finds each private field in a snapshot: the holder list, the layers and every list of who saw", () => {
    const cases: [string, unknown, string][] = [
      ["holders", { t: "snapshot", state: { holders: { s1: { entries: [] } } } }, "$.state.holders"],
      ["exploredAny", { t: "snapshot", state: { exploredAny: {} } }, "$.state.exploredAny"],
      ["exploredBy", { t: "snapshot", state: { exploredBy: {} } }, "$.state.exploredBy"],
      ["a path stop's list", { t: "snapshot", state: { paths: { t1: { stops: [stop(["p2"])] } } } }, "$.state.paths.t1.stops[0].seen, a list"],
      ["a turn start's list", { t: "snapshot", state: { encounter: { turnStart: { seen: [] } } } }, "$.state.encounter.turnStart.seen, a list"],
      ["seenBy on a line", { t: "snapshot", state: { log: [{ data: { seenBy: ["p2"] } }] } }, "$.state.log[0].data.seenBy"],
      ["toSeenBy on a turn line", { t: "snapshot", state: { log: [{ data: { type: "turn", toSeenBy: [] } }] } }, "$.state.log[0].data.toSeenBy"],
    ];
    for (const [what, frame, at] of cases) assert.deepEqual(privateFieldsIn(frame), [at], what);
  });

  test("finds them in an event, by entity key or in a value", () => {
    const ev = (changes: unknown[]) => ({ t: "ev", seq: 4, changes });
    assert.deepEqual(privateFieldsIn(ev([{ key: "holders:s1", value: { entries: [] } }])), ["$.changes[0].key holders:s1"]);
    assert.deepEqual(privateFieldsIn(ev([{ key: "exploredAny:s1:0,0", deleted: true }])), ["$.changes[0].key exploredAny:s1:0,0"]);
    assert.deepEqual(privateFieldsIn(ev([{ key: "exploredBy:s1:p1:0,0", value: {} }])), ["$.changes[0].key exploredBy:s1:p1:0,0"]);
    assert.deepEqual(privateFieldsIn(ev([{ key: "log:7:0", value: { data: { toSeenBy: ["p1"] } } }])), ["$.changes[0].value.data.toSeenBy"]);
    assert.deepEqual(privateFieldsIn(ev([{ key: "path:t1", value: { stops: [stop([])] } }])), ["$.changes[0].value.stops[0].seen, a list"]);
  });

  test("finds them in an ephemeral frame", () => {
    assert.deepEqual(privateFieldsIn({ t: "eph", from: "dm1", e: { k: "dragMove", tokenId: "t1", x: 1, y: 1, seenBy: ["p1"] } }), ["$.e.seenBy"]);
    assert.deepEqual(privateFieldsIn({ t: "eph", from: "dm1", e: { k: "ruler", points: [{ x: 1, y: 1, seen: ["p1"] }] } }), ["$.e.points[0].seen, a list"]);
  });

  test("passes what a player's copy holds by right: a reader's seen mark, the shared maps, and words that only read like a key", () => {
    const frame = {
      t: "snapshot",
      state: {
        sightAll: { "s1:0,0": { f: 1 } },
        fogAll: { "s1:0,0": { bits: "" } },
        paths: { t1: { stops: [stop(true)] } },
        encounter: { turnStart: { seen: true } },
        log: [{ kind: "chat", text: "holders: Ana and Ben", data: { seen: true } }],
      },
    };
    assert.deepEqual(privateFieldsIn(frame), []);
    assert.deepEqual(privateFieldsIn({ t: "ev", changes: [{ key: "sightAll:s1:0,0", value: { f: 2 } }, { key: "fog:s1:0,0", deleted: true }] }), []);
  });
});
