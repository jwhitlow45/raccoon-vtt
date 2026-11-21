import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EXACT_WIDTH, FAR, farByteLine, farLimits, HARD, HISTORY_BYTES, KEPT_FOR_PLAYERS_FULL, LIMITS, SEAT, serializedBytes } from "#shared/limits.ts";
import type { RoomSettings, RoomState, Viewer } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { turnUnderWay } from "#shared/rules/path.ts";
import { exactCopies, farRoomBytes, growthBound, measuredStateBytes, ownHeldBytes, SizeGuard, turnWalks, walkPool, type ExactCopy } from "./sizeGuard.ts";
import { actor, apply, castAsk, character, env, room, scene, template, token } from "#shared/testutil.ts";
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
 * D-261121-019 and D-261116-016: once the DM's adds stop, each player keeps
 * more than 0.75 MiB, whatever Players move any token and Players apply
 * damage are set to and whether a fight runs. KEPT_FOR_PLAYERS holds the
 * widths those settings and sight put in a player's exact part at
 * EXACT_WIDTH a thing, each held here at or above what a thing of its kind
 * takes. The room fills to the DM's line with the settings on, as the DM's
 * change of one meets that line.
 */
describe("the room the DM's adds leave the players at the far lines", () => {
  const settings: ReadonlyArray<readonly [string, Partial<RoomSettings>]> = [
    ["neither", { playersMoveAny: "none", playersApplyDamage: false }],
    ["Players move any token", { playersMoveAny: "all", playersApplyDamage: false }],
    ["Players apply damage", { playersMoveAny: "none", playersApplyDamage: true }],
    ["both", { playersMoveAny: "all", playersApplyDamage: true }],
  ];
  const widthOf = (key: string, part: ExactCopy): keyof typeof EXACT_WIDTH | undefined => {
    if (key.startsWith("token:")) return "creature";
    if (key.startsWith("character:")) return "character";
    if (key.startsWith("template:")) return part.shownOn === "room" ? "unseenArea" : "area";
    return undefined;
  };
  /** Each kind's widest thing in a player's exact part into `most`, and how many creatures it holds. */
  const widest = (state: RoomState, player: string, most: Map<string, number>): number => {
    let creatures = 0;
    for (const [key, part] of exactCopies(state, player)) {
      const kind = widthOf(key, part);
      if (kind) most.set(kind, Math.max(most.get(kind) ?? 0, part.shown - part.sub));
      if (kind === "creature") creatures++;
    }
    return creatures;
  };
  const withinWidths = (most: ReadonlyMap<string, number>, what: string) => {
    for (const [kind, width] of most) assert.ok(width <= EXACT_WIDTH[kind as keyof typeof EXACT_WIDTH], `${what}: a ${kind} takes ${width} bytes`);
  };

  for (const fight of [true, false]) {
    for (const [what, set] of settings) {
      test(`with ${what} on and ${fight ? "a fight" : "no fight"}, each player keeps more than 0.75 MiB once the DM's adds stop`, () => {
        const players = farByteLine("meets", "room", "players")!;
        const dmLine = farByteLine("meets", "room", "dm")!;
        const full = fullRoom({ roomBytes: dmLine, fight, settings: set });
        // The DM's reading rounds its stepped part up, so their adds stop within a step of their line.
        const dm = farRoomBytes(full.state, true);
        assert.ok(dm <= dmLine && dm > dmLine - FAR.byteStep, `the DM's reading ${dm} against their line ${dmLine}`);
        const measured = measuredStateBytes(full.state);
        for (const player of full.players) {
          const keeps = players - farRoomBytes(full.state, true, measured, ownHeldBytes(full.state, player));
          assert.ok(keeps > 0.75 * MIB, `${player} keeps ${keeps} bytes`);
        }
        // Either setting puts every creature their copy holds in their exact part, far more than a seat's.
        const most = new Map<string, number>();
        for (const player of full.players.slice(0, 3)) {
          const creatures = widest(full.state, player, most);
          assert.equal(creatures > SEAT.tokens, set.playersMoveAny === "all" || set.playersApplyDamage === true, `${player}'s exact part holds ${creatures} creatures`);
        }
        withinWidths(most, what);
      });
    }
  }

  test("in a room full to the DM's line, the DM's change that turns Players apply damage on is refused in the words of the room kept for the players, and one that turns Players move any token on is taken", () => {
    const full = fullRoom({ roomBytes: farByteLine("meets", "room", "dm")!, fight: false });
    const dm: Viewer = { memberId: full.dms[0]!, role: "dm" };
    const guard = new SizeGuard({ stateLimit: 64 * MIB, sceneLimit: 64 * MIB });
    guard.stateMeasured(measuredStateBytes(full.state), full.state);
    const turnedOn = (settings: Partial<RoomSettings>) => {
      const r = applyOp(full.state, { t: "room.update", settings }, dm, env(9));
      assert.ok(r.ok);
      return guard.check(r.state, [full.sceneId], growthBound(full.state, r.state, r.touched), full.state, "dm", "dmAdd", false);
    };
    assert.deepEqual(turnedOn({ playersApplyDamage: true }), { ok: false, code: "quota", message: KEPT_FOR_PLAYERS_FULL });
    assert.deepEqual(turnedOn({ playersMoveAny: "all" }), { ok: true });
  });

  test("a creature, a character and an area take no more than their kind's width in a player's exact part, under any setting, however their HP shows", () => {
    const most = new Map<string, number>();
    const long = (prefix: string) => `${prefix}${"x".repeat(64 - prefix.length)}`;
    for (const [, set] of settings) {
      for (const hpVisibility of ["hidden", "label", "bar", "exact"] as const) {
        for (const ids of [(id: string) => id, long]) {
          const state = room();
          const [own, lent, other, hid, played, mine, otherCharacter] = ["own", "lent", "other", "hid", "played", "mine", "c"].map(ids);
          state.scenes.s2 = scene("s2", { order: 1 });
          state.meta.settings = { ...state.meta.settings, ...set };
          const creature = { hpVisibility, actor: { inline: actor({ dmNotes: "" }) } };
          state.tokens[other!] = token(other!, { x: 0, y: 0, ...creature });
          state.tokens[own!] = token(own!, { x: 3, y: 0, ownerIds: ["p1"], ...creature });
          state.characters[otherCharacter!] = character(otherCharacter!, { ownerIds: [], actor: actor({ dmNotes: "" }) });
          state.characters[mine!] = character(mine!, { ownerIds: ["p1"], actor: actor({ dmNotes: "" }) });
          state.tokens[lent!] = token(lent!, { x: 1, y: 0, kind: "pc", ownerIds: ["p1"], hpVisibility, actor: { ref: otherCharacter! } });
          state.tokens[played!] = token(played!, { x: 4, y: 0, kind: "pc", hpVisibility, actor: { ref: mine! } });
          state.tokens[hid!] = token(hid!, { x: 2, y: 0, visibility: "dm" });
          state.templates[ids("free")] = template(ids("free"), { ownerId: "p1" });
          state.templates[ids("riding")] = template(ids("riding"), { ownerId: "p1", attachedTo: hid! });
          state.templates[ids("away")] = template(ids("away"), { ownerId: "p1", sceneId: "s2" });
          widest(state, "p1", most);
        }
      }
    }
    assert.deepEqual([...most.keys()].sort(), ["area", "character", "creature", "unseenArea"]);
    withinWidths(most, "the least things");
  });
});
