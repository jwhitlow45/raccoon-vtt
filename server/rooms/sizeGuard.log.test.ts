import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lineAudience } from "#shared/logRings.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { entry, P1, room, template, token } from "#shared/testutil.ts";
import { growthBound, measuredFromStored, measuredStateBytes, roomLevelBytes, SizeGuard, touchedScenes } from "./sizeGuard.ts";
import { serializedBytes } from "#shared/limits.ts";

/**
 * The log's lines only some viewers or none read ride outside the size
 * measures (shared/logRings.ts, server/rooms/sizeGuard.ts): DM lines, party
 * lines' copies and whispers. So a player's move near a limit gets the
 * same answer whether or not it walks into an area hidden from them, and
 * whatever lines between others the room holds. The paired rooms differ
 * only in where the area stands, on the hero's way in one and far off in
 * the other, with the same digits, so each room's bytes are the same before
 * the move.
 */
function fightWithGlyph(x: number): RoomState {
  const state = room();
  state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", x: 2, y: 5, ownerIds: ["p1"], disposition: "ally" });
  state.templates.glyph = template("glyph", { shape: "sphere", size: 10, origin: { x, y: 5.5, z: 0 }, spell: "Glyph of Warding", visibility: "dm", ownerId: "dm1", triggers: ["enter"] });
  // The hero's turn is under way, so the move records its leg on the hero's path and grows the room.
  state.encounter = {
    rev: 0,
    round: 1,
    activeEntryId: "e-hero",
    entries: [entry("e-hero", { tokenId: "hero", value: 15 })],
    turnStart: { entryId: "e-hero", tokenId: "hero", sceneId: "s1", x: 2, y: 5, elevation: 0, seen: true, seq: 3 },
  };
  return state;
}

const MOVE: Op = { t: "token.move", tokenId: "hero", x: 6, y: 5 };
const SEQ = 40;

function moved(state: RoomState) {
  const result = applyOp(state, MOVE, P1, { seq: SEQ, at: "2026-10-23T20:00:00.000Z" });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return { before: state, after: result.state, touched: result.touched, log: result.log };
}

/** Whether the guard passes the move at these limits, measuring the room from scratch as a loaded room's first op does. */
function passes(m: ReturnType<typeof moved>, limits: { stateLimit?: number; sceneLimit?: number }): boolean {
  const guard = new SizeGuard({ stateLimit: limits.stateLimit ?? 1 << 30, sceneLimit: limits.sceneLimit ?? 1 << 30 });
  return guard.check(m.after, touchedScenes(m.before, m.after, m.touched), growthBound(m.before, m.after, m.touched), m.before).ok;
}

/** The smallest limit at which the move passes. */
function threshold(m: ReturnType<typeof moved>, which: "stateLimit" | "sceneLimit"): number {
  let lo = 0;
  let hi = 1 << 24;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (passes(m, { [which]: mid })) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe("a hidden line never changes whether a player's op passes (design 10.5, Log)", () => {
  test("a player's move near either limit gets the same answer with and without a hidden area's reminder", () => {
    const away = moved(fightWithGlyph(9.5));
    const into = moved(fightWithGlyph(6.5));
    assert.equal(serializedBytes(away.before), serializedBytes(into.before), "the rooms weigh the same before the move");
    assert.deepEqual(away.log.map((e) => e.data?.type), []);
    assert.deepEqual(
      into.log.map((e) => [e.data?.type, lineAudience(e)]),
      [["area", "dm"]],
      "the move into the glyph writes a reminder only the DM gets",
    );
    assert.ok(into.after.log.length === 1, "and the room holds it");
    for (const which of ["stateLimit", "sceneLimit"] as const) {
      const limit = threshold(away, which);
      assert.ok(limit > 1_000, `${which} ${limit}`);
      for (let at = limit - 3; at <= limit + 3; at++) {
        assert.equal(passes(into, { [which]: at }), passes(away, { [which]: at }), `${which} ${at}, the move passes at ${limit}`);
      }
    }
    assert.equal(measuredStateBytes(into.after), measuredStateBytes(away.after));
    assert.equal(roomLevelBytes(into.after), roomLevelBytes(away.after));
    assert.equal(measuredFromStored(serializedBytes(into.after), into.after), measuredStateBytes(into.after));
  });

  test("a player's move near either limit gets the same answer with and without another player's area they cannot see", () => {
    // P2's Spirit Guardians, which players who do not own it never see: the move into it writes P2's line, and the DM's.
    const aura = (x: number) => {
      const state = fightWithGlyph(30);
      state.meta = { ...state.meta, settings: { ...state.meta.settings, playersSeeAoeOfOthers: false } };
      state.templates.glyph = { ...state.templates.glyph!, visibility: "all", ownerId: "p2", spell: "Spirit Guardians", origin: { x, y: 5.5, z: 0 } };
      return state;
    };
    const away = moved(aura(9.5));
    const into = moved(aura(6.5));
    assert.equal(serializedBytes(away.before), serializedBytes(into.before));
    assert.deepEqual(
      into.log.map((e) => [e.data?.type, lineAudience(e)]),
      [
        ["area", "dm"],
        ["area", "party"],
      ],
    );
    for (const which of ["stateLimit", "sceneLimit"] as const) {
      const limit = threshold(away, which);
      for (let at = limit - 3; at <= limit + 3; at++) assert.equal(passes(into, { [which]: at }), passes(away, { [which]: at }), `${which} ${at}, the move passes at ${limit}`);
    }
    assert.equal(measuredStateBytes(into.after), measuredStateBytes(away.after));
  });

  test("a player's move near either limit gets the same answer whatever whispers and party lines between others the room holds", () => {
    const quiet = fightWithGlyph(9.5);
    // A whisper between the DM and P2, and a line about P2's hidden familiar, the DM's with P2's copy.
    const busy = structuredClone(quiet);
    busy.tokens.owl = token("owl", { name: "Owl", visibility: "dm", ownerIds: ["p2"] });
    quiet.tokens.owl = busy.tokens.owl;
    let next = applyOp(busy, { t: "log.whisper", to: ["dm1"], text: "\u4e00".repeat(1_000) }, { memberId: "p2", role: "player" }, { seq: 10, at: "2026-10-23T20:00:00.000Z" });
    assert.ok(next.ok);
    next = applyOp(next.state, { t: "actor.damageMany", hits: [{ target: { tokenId: "owl" }, amount: 1 }] }, { memberId: "dm1", role: "dm" }, { seq: 11, at: "2026-10-23T20:00:00.000Z" });
    assert.ok(next.ok);
    assert.deepEqual(next.state.log.map((e) => lineAudience(e)).sort(), ["dm", "party", "whisper"]);
    const plain = moved(quiet);
    const loud = moved(next.state);
    for (const which of ["stateLimit", "sceneLimit"] as const) {
      const limit = threshold(plain, which);
      for (let at = limit - 3; at <= limit + 3; at++) assert.equal(passes(loud, { [which]: at }), passes(plain, { [which]: at }), `${which} ${at}, the move passes at ${limit}`);
    }
    assert.equal(measuredStateBytes(loud.after), measuredStateBytes(plain.after));
    assert.equal(roomLevelBytes(loud.after), roomLevelBytes(plain.after));
    assert.equal(measuredFromStored(serializedBytes(loud.after), loud.after), measuredStateBytes(loud.after));
  });

  test("the DM lines the measures leave out are bounded on their own, and a room without any measures exactly", () => {
    const quiet = fightWithGlyph(9.5);
    assert.equal(measuredStateBytes(quiet), serializedBytes(quiet));
    assert.equal(measuredFromStored(serializedBytes(quiet), quiet), serializedBytes(quiet));
    // Shared lines count as before.
    const chat = applyOp(quiet, { t: "log.chat", text: "Onward." }, P1, { seq: SEQ, at: "2026-10-23T20:00:00.000Z" });
    assert.ok(chat.ok);
    assert.equal(measuredStateBytes(chat.state), serializedBytes(chat.state));
    assert.ok(growthBound(quiet, chat.state, chat.touched) > 0);
  });
});
