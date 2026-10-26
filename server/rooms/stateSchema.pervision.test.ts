import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey } from "#shared/keys.ts";
import { LIMITS } from "#shared/limits.ts";
import { migrateSnapshot } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import { withCellVision, perPlayerOp, perPlayerState, playersOf } from "#shared/perPlayerTestutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { DM, entry, env, member, pick, rng, room, scene, token } from "#shared/testutil.ts";
import { parseRoomState } from "./stateSchema.ts";

/**
 * Per-player vision's stored fields (docs/design-v1-per-player-vision.md
 * 6.7, lane PV1): the Sight row's flag, the holder lists, each holder's
 * layer and the lists of who saw, each bounded as the reducer writes it.
 */
function perPlayer(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  s.holders.s1 = { sceneId: "s1", rev: 2, entries: [{ memberId: "p2", on: true }, { memberId: "p1", on: false }] };
  const tile = Object.values(rasterizeFogOps({}, "s1", s.scenes.s1!.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 3, h: 3 } }]))[0]!;
  s.exploredBy[holderTileKey("s1", "p2", 0, 0)] = { ...tile, memberId: "p2" };
  s.tokens.gob = token("gob", { path: { turn: 1, stops: [{ x: 1, y: 1, elevation: 0, seenBy: [] }, { x: 2, y: 1, elevation: 0, seenBy: ["p1", "p2"] }] } });
  s.encounter = {
    rev: 1,
    round: 1,
    activeEntryId: "e1",
    entries: [entry("e1", { tokenId: "gob", value: 10 })],
    turnStart: { entryId: "e1", tokenId: "gob", sceneId: "s1", x: 1, y: 1, elevation: 0, seq: 1, seenBy: ["p2"] },
  };
  s.log = [
    // The DM's lines and a reader's copy, as settled: no list of who saw (Tx.settleLog).
    { id: "1:900000", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 1 } },
    { id: "1:900001", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "turn", entryId: "e1", round: 1, back: true, to: "e1" } },
    { id: "1:900002", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "area", templateId: "a", tokenId: "gob", trigger: "enter", area: "Spirit Guardians" } },
    { id: "1:500000", at: "2026-10-12T20:00:00.000Z", kind: "event", to: ["p2"], copyOf: "1:900000", data: { type: "hp", tokenId: "gob", seen: true, change: "damage", amount: 1 } },
  ];
  return s;
}

describe("roomStateSchema, per-player vision (docs/design-v1-per-player-vision.md 6.7)", () => {
  test("a per-player room parses, with its lists, its layers and who saw", () => {
    const parsed = parseRoomState(perPlayer());
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual(parsed.state.holders.s1!.entries, [{ memberId: "p2", on: true }, { memberId: "p1", on: false }]);
    assert.equal(parsed.state.scenes.s1!.vision?.perPlayer, true);
  });

  test("refuses what the reducer never writes", () => {
    const refused = (change: (s: RoomState) => void): string => {
      const s = perPlayer();
      change(s);
      const parsed = parseRoomState(s);
      assert.equal(parsed.ok, false);
      return parsed.ok ? "" : parsed.message;
    };
    refused((s) => (s.scenes.s1!.vision = { on: true, light: "dark", perPlayer: false as never }));
    assert.match(refused((s) => (s.holders.s1!.entries = [{ memberId: "p1", on: true }, { memberId: "p1", on: false }])), /listed twice/);
    assert.match(refused((s) => (s.holders.s1!.entries = Array.from({ length: LIMITS.sightHoldersPerScene + 1 }, (_, i) => ({ memberId: `p${i}`, on: true })))), /at most 6/);
    refused((s) => delete (s.exploredBy[holderTileKey("s1", "p2", 0, 0)] as Partial<RoomState["exploredBy"][string]>).memberId);
    assert.match(refused((s) => (s.tokens.gob!.path!.stops[1]!.seenBy = ["p2", "p1"])), /not sorted/);
    assert.match(refused((s) => (s.encounter!.turnStart!.seenBy = ["p1", "p1"])), /listed twice/);
    refused((s) => (s.tokens.gob!.path!.stops[1]!.seenBy = Array.from({ length: LIMITS.sightHoldersPerScene + 1 }, (_, i) => `p${i}`)));
    // A stored line holds no list of who saw (PV1-O12).
    for (const [i, field] of [[0, "seenBy"], [1, "seenBy"], [1, "toSeenBy"], [2, "seenBy"], [3, "seenBy"]] as const) {
      refused((s) => ((s.log[i]!.data as Record<string, unknown>)[field] = ["p2"]));
    }
    refused((s) => (s.exploredBy[`${"k".repeat(141)}`] = s.exploredBy[holderTileKey("s1", "p2", 0, 0)]!));
  });

  test("a lower cap in force refuses no room stored under the design's most (SEC-PV1-4, PV1-O4)", async () => {
    const limits = LIMITS as { sightHoldersPerScene: number };
    const cap = limits.sightHoldersPerScene;
    limits.sightHoldersPerScene = 5;
    try {
      // The schema is built as the module loads, so a copy loaded under the lower cap is the one to ask.
      const { parseRoomState } = (await import(new URL("./stateSchema.ts?cap=5", import.meta.url).href)) as typeof import("./stateSchema.ts");
      const s = perPlayer();
      for (const id of ["p3", "p4", "p5", "p6"]) s.members[id] = member(id);
      const six = ["p1", "p2", "p3", "p4", "p5", "p6"];
      s.holders.s1 = { sceneId: "s1", rev: 3, entries: six.map((memberId) => ({ memberId, on: true })) };
      s.tokens.gob!.path!.stops[1]!.seenBy = six;
      const parsed = parseRoomState(s);
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    } finally {
      limits.sightHoldersPerScene = cap;
    }
  });

  test("a backup from before per-player vision migrates to empty lists and layers that parse", () => {
    const old = room() as Partial<RoomState>;
    delete old.holders;
    delete old.exploredBy;
    const parsed = parseRoomState(migrateSnapshot(old, 23));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    assert.deepEqual([parsed.state.holders, parsed.state.exploredBy], [{}, {}]);
  });

  test("every room the reducer leaves after random per-player ops parses", () => {
    withCellVision(() => {
      for (let seed = 1; seed <= 12; seed++) {
        const r = rng(seed * 104729);
        let state = perPlayerState(r);
        let parsed = parseRoomState(state);
        assert.ok(parsed.ok, `seed ${seed} start: ${parsed.ok ? "" : parsed.message}`);
        for (let i = 0; i < 40; i++) {
          const who = pick(r, [DM, DM, ...playersOf(state)]);
          const result = applyOp(state, perPlayerOp(r, state, who), who, env(10 + i));
          if (!result.ok) continue;
          state = result.state;
        }
        parsed = parseRoomState(JSON.parse(JSON.stringify(state)));
        assert.ok(parsed.ok, `seed ${seed}: ${parsed.ok ? "" : parsed.message}`);
      }
    });
  });
});
