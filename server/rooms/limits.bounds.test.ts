import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR, farByteLine, farLimits, HARD, HISTORY_BYTES, KEPT_FOR_PLAYERS, LIMITS, serializedBytes } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { turnUnderWay } from "#shared/rules/path.ts";
import { farRoomBytes, measuredStateBytes, ownHeldBytes, turnWalks, walkPool } from "./sizeGuard.ts";
import { apply, castAsk } from "#shared/testutil.ts";
import { DEFAULT_BUFFERED_LIMIT } from "./ws.ts";
import { fullRoom, markedRoom, measureBounds, roomMeasure } from "./limitsTesting.ts";

const MIB = 1024 * 1024;

/*
 * The derived bounds of design section 8, measured on the full fixture:
 * a room at the far lines with every ring outside the measures full and a
 * full roster. Each part outside the measures must come within a few
 * percent of its own bound, so the stored size is the most a room at the
 * line holds and not an accident of a small fixture.
 */
describe("a room at the far lines", () => {
  const full = fullRoom();
  const bounds = measureBounds(full);
  const { state } = full;

  test("holds the far counts on one scene, and its measures are at the room and scene lines", () => {
    assert.equal(Object.keys(state.tokens).length, FAR.tokens);
    assert.equal(state.encounter?.entries.length, FAR.rows);
    // Asks stop where the far line's count does: the DM's part in steps of 50 beside the players' held ones.
    assert.deepEqual([farLimits(state, null).ok, farLimits(state, full.sceneId).ok], [true, true]);
    assert.ok(Object.keys(state.casts).length > FAR.asks - FAR.countStep, `${Object.keys(state.casts).length} asks`);
    state.casts.more = castAsk("more", { by: full.dms[0]!, caster: Object.keys(state.tokens)[0]!, sceneId: full.sceneId, area: undefined, targets: [Object.keys(state.tokens)[0]!] });
    assert.equal(farLimits(state, null).ok, false, "one more ask passes the line");
    delete state.casts.more;
    assert.equal(Object.keys(state.rolls).length, LIMITS.openRollsPerRoom);
    assert.equal(Object.keys(state.members).length, LIMITS.membersPerRoom);
    // One more block or drawing would pass the line, so each measure is within one of them, the room's far reading
    // within one of its steps too.
    assert.ok(bounds.room <= FAR.roomBytes && bounds.room > FAR.roomBytes - FAR.byteStep - 16 * 1024, `room ${bounds.room}`);
    assert.ok(bounds.scene <= FAR.sceneBytes && bounds.scene > FAR.sceneBytes - 16 * 1024, `scene ${bounds.scene}`);
  });

  test("fills every part outside the measures to within 5 percent of its own bound", () => {
    const ring = LIMITS.dmLogLines * LIMITS.apartLineBytes + LIMITS.whisperBytesPerRoom + LIMITS.partyLineBytesPerRoom;
    const reminders = LIMITS.remindedSharedBytes + LIMITS.remindedDmBytes + full.players.length * LIMITS.remindedPerPlayerBytes;
    for (const [part, measured, bound] of [
      ["private lines", bounds.privateLines, ring],
      ["reminders", bounds.reminded, reminders],
      ["save outcomes", bounds.saveOutcomes, 100 * 1024],
    ] as const) {
      assert.ok(measured > 0.95 * bound && measured < 1.02 * bound, `${part}: ${measured} of ${bound}`);
    }
  });

  test("holds the fight's history at its bound and nine walks at their widest on its turn, which the room's reading counts as empty and in its walk pool", () => {
    assert.ok(bounds.history > 0.95 * HISTORY_BYTES && bounds.history <= HISTORY_BYTES + 64 * 1024, `history ${bounds.history}`);
    const seq = turnUnderWay(state.encounter)?.seq;
    const walks = Object.values(state.tokens).filter((t) => t.path !== undefined && t.path.turn === seq);
    assert.equal(walks.length, 1 + LIMITS.turnMounts);
    assert.ok(turnWalks(state).bytes <= walkPool(state) && turnWalks(state).bytes > 0.9 * walkPool(state), `walks ${turnWalks(state).bytes} of ${walkPool(state)}`);
  });

  for (const [what, full, bounds] of [["with a fight", fullRoom(), measureBounds(fullRoom())], ["with no fight", fullRoom({ fight: false }), measureBounds(fullRoom({ fight: false }))]] as const) {
    test(`${what}: stores within HARD.storedBytes, and its export within the import's room file cap`, () => {
      assert.ok(bounds.room <= FAR.roomBytes && bounds.room > FAR.roomBytes - FAR.byteStep - 16 * 1024, `room ${bounds.room}`);
      assert.ok(bounds.stored <= HARD.storedBytes, `stored ${bounds.stored}`);
      assert.ok(bounds.exportJson <= HARD.roomJsonBytes, `room.json ${bounds.exportJson}`);
      assert.ok(bounds.remapped <= bounds.stored, `remapped ${bounds.remapped}`);
      assert.equal(full.state.encounter === null, what === "with no fight");
    });

    test(`${what}: sends a DM a snapshot that a socket's send buffer holds with 1 MiB to spare, and no larger than the stored bound`, () => {
      assert.ok(bounds.snapshot + MIB <= HARD.sendBufferBytes, `snapshot ${bounds.snapshot}`);
      assert.ok(bounds.snapshot <= HARD.storedBytes, `snapshot ${bounds.snapshot}`);
      assert.ok(bounds.snapshot + MIB <= DEFAULT_BUFFERED_LIMIT || DEFAULT_BUFFERED_LIMIT < HARD.sendBufferBytes, `buffer ${DEFAULT_BUFFERED_LIMIT}`);
    });
  }

  test("stays within HARD.storedBytes after a group delete of 100 creatures in the fight and a character's delete", () => {
    const tokens = Object.keys(state.tokens);
    let after = apply(state, { t: "token.deleteMany", tokenIds: tokens.slice(LIMITS.charactersPerRoom, LIMITS.charactersPerRoom + 100) });
    after = apply(after, { t: "character.delete", characterId: Object.keys(state.characters)[0]! });
    const stored = serializedBytes(after);
    assert.ok(stored <= HARD.storedBytes, `stored ${stored}`);
    assert.ok(roomMeasure(after) <= roomMeasure(state), "a deletion's bookkeeping grows no measure past what it freed");
  });
});

/*
 * Astra's marked room of design 6.4: 20 marked per-player scenes with two
 * players, measured at 7,832,678 bytes. A player's far check reads the
 * marked pool and the walk pool whole and every per-player reserve at six
 * players, so whether the room is under the line turns on its scenes'
 * size. The walk pool every room's reading counts since change format 65
 * (D-261121-120) moved the turn from scenes of 80 squares a side to 72.
 */
describe("the marked room of 20 per-player scenes", () => {
  test("is under the far line with scenes of 64 squares a side, and past it from 72", () => {
    const small = markedRoom(64);
    assert.ok(Math.abs(small.measured - 7_832_678) < 1024, `64 squares: ${small.measured}`);
    assert.ok(small.under, `64 squares: ${small.far}`);
    for (const cells of [72, 96]) {
      const large = markedRoom(cells);
      assert.ok(Math.abs(large.measured - 7_832_678) < 1024, `${cells} squares: ${large.measured}`);
      assert.ok(!large.under, `${cells} squares: ${large.far}`);
    }
  });
});

/*
 * D-261121-130 and D-261116-016: a player's exact part counts every
 * creature their copy holds at its widths under Players move any token,
 * a floor id at ID_BYTES among them. Once the DM's adds stop, each player
 * keeps KEPT_FOR_PLAYERS less one step of their own play, less what their
 * own things count past what they store (their widths, as LP43R2-1 reads
 * it). On the full fixture a player's own asks and shared lines hold most
 * of those widths, and the creatures move any adds hold under 0.25 MiB of
 * them, where floor ids at their widest would take about 0.7 MiB.
 */
describe("the room the DM's adds leave the players at the far lines", () => {
  test("with Players move any token on or off, each player keeps more than KEPT_FOR_PLAYERS less a step and their widths once the DM's adds stop, and move any's creatures take under 0.25 MiB of it", () => {
    const players = farByteLine("meets", "room", "players")!;
    for (const fight of [true, false]) {
      const full = fullRoom({ roomBytes: farByteLine("meets", "room", "dm")!, fight });
      const anyOf = (any: boolean): RoomState => ({ ...full.state, meta: { ...full.state.meta, settings: { ...full.state.meta.settings, playersMoveAny: any ? "all" : "none" } } });
      for (const player of full.players.slice(0, 3)) {
        const parts = (state: RoomState) => {
          const own = ownHeldBytes(state, player);
          return { keeps: players - farRoomBytes(state, true, measuredStateBytes(state), own), widths: own.shown - own.sub };
        };
        const [off, any] = [parts(anyOf(false)), parts(anyOf(true))];
        for (const [what, at] of [["off", off], ["on", any]] as const) {
          assert.ok(at.keeps > KEPT_FOR_PLAYERS - FAR.byteStep - at.widths, `${fight ? "a fight" : "no fight"}, move any ${what}: ${player} keeps ${at.keeps} bytes, their widths ${at.widths}`);
        }
        assert.ok(any.widths - off.widths < 0.25 * MIB, `move any's creatures count ${any.widths - off.widths} bytes past what they store`);
      }
    }
  });
});
