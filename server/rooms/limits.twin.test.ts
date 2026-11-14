import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { FAR, LIMITS, SEAT, SEAT_FULL } from "#shared/limits.ts";
import { ROLL_ASKED_ALREADY } from "#shared/permissions.ts";
import type { Effect, RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { APART, apartId, AYLA, BREE, dmAreas, dmDrawings, dmTokens, limitsRoom, OGRE, ROOM_R, seated, STAIRS_UP, withUpper } from "#shared/privTestutil.ts";
import { lift, remember } from "#shared/discoveryTestutil.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { actor, castAsk, character, companionBlock, drawing, effect, entry, member, template, token } from "#shared/testutil.ts";
import { bothAnswer, joinOp, marks, Mint, openTwins, same, sameSince, together, type Answer, type Twins } from "./limitsTwinTesting.ts";
import { each, type Room, type Who } from "./numberingTesting.ts";

/**
 * Player limits in rooms P1 cannot tell apart: room A and room B differ
 * only in what P1's copy never holds, take the same members' ops at the
 * same clock times, and answer P1 alike with the same frames, each room's
 * frames scanned raw first for the ids only it holds.
 */

type Built = { a: RoomState; b: RoomState; hidden: { a: string[]; b: string[] } };

/** Both rooms from the limits room, with what each holds apart added. Each adder returns the ids no frame of its room may name. */
function rooms(a: (s: RoomState) => string[], b: (s: RoomState) => string[] = () => []): Built {
  const sa = limitsRoom();
  const sb = limitsRoom();
  return { a: sa, b: sb, hidden: { a: a(sa), b: b(sb) } };
}

/** Both rooms alike, each with `both` added. */
function alike(both: (s: RoomState) => void): Built {
  return rooms((s) => (both(s), []), (s) => (both(s), []));
}

function open(t: TestContext, built: Built): Promise<Twins> {
  return openTwins(t, built.a, built.b, built.hidden);
}

const mint = new Mint();

/** P1's area at a cell of room R, or riding a creature. */
function areaOp(room: Room, over: Record<string, unknown> = {}): Op {
  const { rev: _rev, ...made } = template(mint.next(room), { ownerId: "p1", origin: { x: 4.5, y: 4.5, z: 0 }, size: 5, ...over });
  return { t: "template.create", template: made } as Op;
}

/** P1's line in room R, of `points` point values. */
function lineOp(room: Room, points = 4): Op {
  const { rev: _rev, ...made } = drawing(mint.next(room), { ownerId: "p1", points: Array.from({ length: points }, (_, i) => 3 + (i % 4)) });
  return { t: "drawing.create", drawing: made } as Op;
}

/** P1's wolf beside Ayla, a companion of hers. */
function wolfOp(room: Room): Op {
  return {
    t: "token.create",
    token: { id: mint.next(room), sceneId: "s1", kind: "npc", name: "Wolf", size: "medium", layer: "token", x: 4, y: 3, actor: { inline: actor({ dmNotes: "" }) }, companion: { of: AYLA, turn: "shared" } },
  } as Op;
}

/** Takes four point values off the first drawing only the DM sees, so the scene is four short of its cap. */
function trimmed(s: RoomState): string[] {
  const first = Object.values(s.drawings).find((d) => d.visibility === "dm")!;
  s.drawings[first.id] = { ...first, points: first.points.slice(0, -4) };
  return [];
}

describe("a room's caps answer P1 alike whatever the DM holds there", () => {
  test("L1: a scene one short of its cap in A and at it in B takes P1's area, companion, line and point values in both", async (t) => {
    const perDrawing = LIMITS.drawingPointValues;
    const cases: Array<[string, (s: RoomState, full: boolean) => string[], (room: Room) => Op]> = [
      ["areas", (s, full) => dmAreas(s, LIMITS.templatesPerScene - (full ? 0 : 1)), (room) => areaOp(room)],
      // Ayla, Bree and the ogre stand there too.
      ["tokens", (s, full) => dmTokens(s, LIMITS.tokensPerScene - 3 - (full ? 0 : 1)), wolfOp],
      ["drawings", (s, full) => dmDrawings(s, LIMITS.drawingsPerScene - (full ? 0 : 1)), (room) => lineOp(room)],
      ["point values", (s, full) => [...dmDrawings(s, LIMITS.drawingPointValuesPerScene / perDrawing, perDrawing), ...(full ? [] : trimmed(s))], (room) => lineOp(room)],
    ];
    for (const [what, fill, op] of cases) {
      await t.test(what, async (t) => {
        const pair = await open(t, rooms((s) => fill(s, false), (s) => fill(s, true)));
        assert.equal(await bothAnswer(pair, "p1", op, what), "taken");
        same(pair, what);
      });
    }
  });

  test("L2: a fight one row short of its cap in A and at it in B takes P1's row for Ayla in both", async (t) => {
    const rows = (s: RoomState, n: number) => {
      const ids = Array.from({ length: n }, (_, i) => apartId("row", i));
      s.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("0199f0a0-0000-7000-8000-00000000e001", { tokenId: BREE }), ...ids.map((id) => entry(id, { label: id, hidden: true }))] };
      return ids;
    };
    const pair = await open(t, rooms((s) => rows(s, LIMITS.encounterRows - 2), (s) => rows(s, LIMITS.encounterRows - 1)));
    assert.equal(await bothAnswer(pair, "p1", (room) => ({ t: "encounter.add", entries: [{ id: mint.next(room), tokenId: AYLA }] }) as Op, "P1's row"), "taken");
    same(pair, "P1's row");
  });

  test("L4: other characters' stat blocks one short of the room's count and bytes in A and at them in B take P1's block for Ayla in both", async (t) => {
    /** Characters played by P2, whose blocks P1's copy never holds. */
    const blocks = (s: RoomState, n: number, pad: number, filler = 0) => {
      for (let c = 0; c < 7; c++) s.characters[`other${c}`] = character(`other${c}`, { name: `Other ${c}`, ownerIds: ["p2"] });
      const ids = Array.from({ length: n + (filler > 0 ? 1 : 0) }, (_, i) => apartId("blk", i));
      for (const [i, id] of ids.entries()) {
        const text = i < n ? pad : filler;
        s.companionBlocks[id] = companionBlock(id, i < n ? `other${i % 6}` : "other6", { name: id, ...(text > 0 ? { traits: [{ name: "Pad", text: "w".repeat(text) }] } : {}) });
      }
      return ids;
    };
    const save = (room: Room): Op => {
      const { rev: _rev, ...block } = companionBlock(mint.next(room), AYLA);
      return { t: "companionBlock.create", block } as Op;
    };
    await t.test("count", async (t) => {
      const pair = await open(t, rooms((s) => blocks(s, LIMITS.companionBlocksPerRoom - 1, 0), (s) => blocks(s, LIMITS.companionBlocksPerRoom, 0)));
      assert.equal(await bothAnswer(pair, "p1", save, "P1's block"), "taken");
      same(pair, "P1's block");
    });
    await t.test("bytes", async (t) => {
      // 192 blocks of 16,348 bytes leave 6,912 bytes of the room's 3 MiB, and a block of 6,500 more leaves less than P1's.
      const pair = await open(t, rooms((s) => blocks(s, 192, 15_500), (s) => blocks(s, 192, 15_500, 5_652)));
      assert.equal(await bothAnswer(pair, "p1", save, "P1's block"), "taken");
      same(pair, "P1's block");
    });
  });

  test("L5: a room over its byte line in A alone, then a scene over its own, takes P1's area in both", async (t) => {
    for (const limit of ["stateLimit", "sceneLimit"] as const) {
      await t.test(limit, async (t) => {
        // Long notes on creatures only the DM sees, past a lowered line, in room A alone.
        const notes = (s: RoomState) => dmTokens(s, 40).map((id) => ((s.tokens[id] = { ...s.tokens[id]!, notes: "x".repeat(4_000) }), id));
        const built = rooms(notes);
        const pair = await openTwins(t, built.a, built.b, built.hidden, { sizeLimits: { [limit]: 140_000 } });
        assert.equal(await bothAnswer(pair, "p1", (room) => areaOp(room), limit), "taken");
        same(pair, limit);
      });
    }
  });
});

/** `n` asks of P2's for Bree, which P1's copy never holds. */
function othersAsks(s: RoomState, n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("ask", i));
  for (const id of ids) s.casts[id] = castAsk(id, { by: "p2", caster: BREE, sceneId: "s1", spell: "Fireball", area: undefined, targets: [OGRE] });
  return ids;
}

/** Cade, P1's second character, with a token in room R. */
const CADE = "cade";
function withCade(s: RoomState): void {
  s.characters[CADE] = character(CADE, { name: "Cade", ownerIds: ["p1"] });
  s.tokens[CADE] = token(CADE, { kind: "pc", name: "Cade", disposition: "ally", x: 5, y: 3, actor: { ref: CADE } });
}

describe("asks answer P1 alike whatever else is asked", () => {
  test("L3: 19 asks of others in A and 20 in B take P1's ask in both", async (t) => {
    const pair = await open(t, rooms((s) => othersAsks(s, LIMITS.openCastsPerRoom - 1), (s) => othersAsks(s, LIMITS.openCastsPerRoom)));
    const ask = (room: Room): Op => ({ t: "cast.ask", cast: { id: mint.next(room), caster: AYLA, sceneId: "s1", spell: "Moonbeam", targets: [OGRE] } }) as Op;
    assert.equal(await bothAnswer(pair, "p1", ask, "P1's ask"), "taken");
    same(pair, "P1's ask");
  });

  test("L3: P1's ask whose caster was handed on in A, and handed on and closed in B, locks nothing, and its tag still goes with it alone", async (t) => {
    const area = "0199f0a0-0000-7000-8000-00000000c201";
    const pair = await open(
      t,
      alike((s) => {
        withCade(s);
        othersAsks(s, LIMITS.openCastsPerRoom - 1);
        s.templates[area] = template(area, { ownerId: "p1", origin: { x: 8.5, y: 4.5, z: 0 }, size: 10 });
      }),
    );
    const tags: string[] = [];
    const asks: string[] = [];
    for (const room of pair) {
      const tag = mint.next(room);
      tags.push(tag);
      await room.apply("p1", { t: "dice.roll", tag, to: "all", rolls: [{ formula: "8d6", label: "Fireball damage, Fire", creature: { tokenId: AYLA } }] } as Op);
      asks.push(mint.next(room));
      await room.apply("p1", { t: "cast.ask", cast: { id: asks.at(-1)!, caster: AYLA, sceneId: "s1", spell: "Fireball", area, damage: { tag, parts: 1 } } } as Op);
    }
    for (const [i, room] of pair.entries()) {
      await room.apply("dm", { t: "character.update", characterId: AYLA, patch: { ownerIds: ["p2"] } } as Op);
      if (room.name === "B") await room.apply("dm", { t: "cast.close", castId: asks[i]!, end: "dismissed" } as Op);
      else room.clock.now += 1_000;
    }
    same(pair, "the caster handed on");
    const again = (room: Room): Op => ({ t: "cast.ask", cast: { id: mint.next(room), caster: CADE, sceneId: "s1", spell: "Fireball", area } }) as Op;
    assert.equal(await bothAnswer(pair, "p1", again, "P1 asks again"), "taken");
    assert.equal(await bothAnswer(pair, "p1", { t: "template.update", templateId: area, patch: { size: 15 } } as Op, "P1 edits the area"), "taken");
    const reuse = (room: Room): Op => ({ t: "cast.ask", cast: { id: mint.next(room), caster: CADE, sceneId: "s1", spell: "Fireball", targets: [OGRE], damage: { tag: tags[pair.indexOf(room as never)]!, parts: 1 } } }) as Op;
    const answer = await bothAnswer(pair, "p1", reuse, "P1 reuses the tag");
    assert.deepEqual(answer, { code: "invalid", message: ROLL_ASKED_ALREADY });
    same(pair, "after the ask, the edit and the tag");
  });
});

/** A DM-only area riding Ayla, room A's alone. */
function dmRider(s: RoomState): string[] {
  const id = apartId("area", 0);
  s.templates[id] = template(id, { ownerId: "dm1", visibility: "dm", attachedTo: AYLA, origin: { x: 3.5, y: 3.5, z: 0 }, size: 5 });
  return [id];
}

describe("moves answer P1 alike", () => {
  test("L6: a DM-only area riding Ayla and her scene over its byte line in A alone take P1's walk, climb, and each one's undo and redo in both", async (t) => {
    const notes = (s: RoomState) => [...dmRider(s), ...dmTokens(s, 40).map((id) => ((s.tokens[id] = { ...s.tokens[id]!, notes: "x".repeat(4_000) }), id))];
    const built = rooms((s) => (withUpper(s), notes(s)), (s) => (withUpper(s), []));
    const pair = await openTwins(t, built.a, built.b, built.hidden, { sizeLimits: { sceneLimit: 140_000 } });
    const steps: Array<[string, Op | null]> = [
      ["the walk", { t: "token.move", tokenId: AYLA, x: 4, y: 4 } as Op],
      ["the walk's undo", null],
      ["the walk's redo", null],
      ["back to the stairs", { t: "token.move", tokenId: AYLA, x: 3, y: 3 } as Op],
      ["the climb", { t: "token.climb", tokenId: AYLA, linkId: STAIRS_UP } as Op],
      ["the climb's undo", null],
      ["the climb's redo", null],
    ];
    for (const [what, op] of steps) {
      if (op) assert.equal(await bothAnswer(pair, "p1", op, what), "taken");
      else await each(pair, (room) => room.restore(what.endsWith("undo") ? "undo" : "redo", "play", "p1"));
      same(pair, what);
    }
  });
});

describe("the op rate answers P1 alike", () => {
  test("L8: the DM's work on a creature only room A holds empties the room's rate there, and P1's next op is taken at once in both", async (t) => {
    const built = rooms((s) => (withDms(s), dmTokens(s, 1)), (s) => (withDms(s), []));
    const pair = await open(t, built);
    const hidden = built.hidden.a[0]!;
    const renames = (who: Who, from: number): Array<[Who, Op]> => Array.from({ length: 60 }, (_, i) => [who, { t: "token.update", tokenId: hidden, patch: { name: `${APART}name${from + i}` } } as Op]);
    await together(pair[0], [...renames("dm", 0), ...renames("dm2", 60)], false);
    const answers: Answer[] = [];
    for (const room of pair) answers.push((await together(room, [["p1", { t: "log.chat", text: "now" }]], false))[0]!);
    assert.deepEqual(answers, ["taken", "taken"]);
    same(pair, "P1's chat");
  });
});

/** Two more DMs, alike in both rooms, so the DM's work can pass one device's rate. */
function withDms(s: RoomState): void {
  for (const id of ["dm2", "dm3"]) s.members[id] = member(id, "dm");
}

describe("remembered maps answer P1 alike", () => {
  test("L12: on a marked scene with bytes only the DM sees in A, P1's remembered room R is the same in both through a walk and a join, and so with a party mark", async (t) => {
    for (const party of [false, true]) {
      await t.test(party ? "a party mark" : "a mark", async (t) => {
        // Ayla in room F, and the party's memory of room R as wood where it is stone now.
        const remembered = (s: RoomState) => {
          s.memoryShared = { s1: { sceneId: "s1", rev: 0, ...(party ? { party: true as const } : {}) } };
          s.tokens[AYLA] = { ...s.tokens[AYLA]!, x: 26, y: 4 };
          const cells: Record<string, "wood"> = {};
          for (let y = 2; y < 10; y++) for (let x = 2; x < 12; x++) cells[`${x},${y}`] = "wood";
          remember(s, null, 0, 0, { cells });
          lift(s, "party", ROOM_R);
        };
        const notes = (s: RoomState) => dmTokens(s, 80).map((id) => ((s.tokens[id] = { ...s.tokens[id]!, notes: "x".repeat(4_000) }), id));
        const built = rooms((s) => (remembered(s), notes(s)), (s) => (remembered(s), []));
        // A room line low enough that the DM's notes in A leave it no free space to share, and B a whole cap.
        const pair = await openTwins(t, built.a, built.b, built.hidden, { sizeLimits: { stateLimit: 400_000 } });
        same(pair, "opened");
        assert.equal(await bothAnswer(pair, "p1", { t: "token.move", tokenId: AYLA, x: 28, y: 6 } as Op, "a walk in room F"), "taken");
        same(pair, "a walk in room F");
        for (const room of pair) {
          await room.actor.sys(joinOp(mint.next(room), "Wren"));
          await room.settle();
          assert.ok(Object.values(room.state.members).some((m) => m.name === "Wren"), `${room.name}: the join is taken`);
        }
        same(pair, "a join");
        for (const room of pair) assert.ok(Object.keys(room.state.memory ?? {}).length > 0, `${room.name}: the party still remembers room R`);
      });
    }
  });
});

describe("the far line answers P1 alike inside one step of the DM's part", () => {
  test("601 and 650 of the DM's creatures beside 46 players' full seats refuse P1's companion alike at the far line", async (t) => {
    // 46 players' 33 tokens each, Ayla and Bree: 1,520 held by seats, 1,521 with P1's companion.
    const fill = (s: RoomState, rest: number) => {
      seated(s, 46, 0, 3);
      // The ogre is the DM's too.
      return dmTokens(s, rest - 1);
    };
    const pair = await open(t, rooms((s) => fill(s, 601), (s) => fill(s, 650)));
    assert.deepEqual(await bothAnswer(pair, "p1", wolfOp, "P1's companion"), { code: "quota", message: `this scene can hold at most ${FAR.tokens.toLocaleString("en-US")} tokens` });
    same(pair, "P1's companion");
  });
});

/** Conditions on Ayla: shown ones alike in both rooms, hidden ones with ids only their room holds. */
function withEffects(s: RoomState, shown: number, hidden: number): string[] {
  const ayla = s.characters[AYLA]!;
  const hiddenIds = Array.from({ length: hidden }, (_, i) => apartId("eff", i));
  const effects: Effect[] = [
    ...Array.from({ length: shown }, (_, i) => effect(`0199f0a0-0000-7000-8000-0000000f${String(i).padStart(4, "0")}`, { key: "blessed" })),
    ...hiddenIds.map((id) => effect(id, { key: "poisoned", hiddenFromPlayers: true })),
  ];
  s.characters[AYLA] = { ...ayla, actor: { ...ayla.actor, effects } };
  return hiddenIds;
}

const hit = { t: "actor.hp", target: { characterId: AYLA }, change: { kind: "damage", amount: 20 } } as Op;
const heal = { t: "actor.hp", target: { characterId: AYLA }, change: { kind: "heal", amount: 5 } } as Op;

describe("conditions answer P1 alike whatever the DM hid", () => {
  test("L7: 31 shown on Ayla and one hidden in A alone take P1's 32nd shown in both", async (t) => {
    const pair = await open(t, rooms((s) => withEffects(s, 31, 1), (s) => withEffects(s, 31, 0)));
    const add = (room: Room): Op => ({ t: "actor.effect.add", target: { characterId: AYLA }, effect: { id: mint.next(room), key: "blessed" } }) as Op;
    assert.equal(await bothAnswer(pair, "p1", add, "P1's 32nd shown"), "taken");
    same(pair, "P1's 32nd shown");
  });

  test("L7: 32 shown and 32 hidden in A, 32 shown alone in B, take damage to 0 HP in both, and A stores 65", async (t) => {
    const pair = await open(t, rooms((s) => withEffects(s, 32, 32), (s) => withEffects(s, 32, 0)));
    assert.equal(await bothAnswer(pair, "dm", hit, "the hit"), "taken");
    same(pair, "the hit");
    const held = pair[0].state.characters[AYLA]!.actor.effects;
    assert.equal(held.length, 65, "32 shown, 32 hidden and the automatic Unconscious");
    assert.equal(held.at(-1)!.id, ZERO_HP_UNCONSCIOUS_ID, "the automatic one is last");
  });

  test("L7b: the automatic Unconscious hidden in A and removed in B reads as one bare automatic effect at the end of both at 0 HP again", async (t) => {
    const pair = await open(t, alike((s) => void withEffects(s, 1, 0)));
    await each(pair, (room) => room.apply("dm", hit));
    for (const room of pair) {
      // Both rooms mint the fresh id, so their sources stay alike.
      const as = mint.next(room);
      const op =
        room.name === "A"
          ? ({ t: "actor.effect.update", target: { characterId: AYLA }, effectId: ZERO_HP_UNCONSCIOUS_ID, patch: { hiddenFromPlayers: true }, as } as Op)
          : ({ t: "actor.effect.remove", target: { characterId: AYLA }, effectId: ZERO_HP_UNCONSCIOUS_ID } as Op);
      await room.apply("dm", op);
    }
    // The fresh id the hidden one took is A's alone.
    pair.hidden[0].ids.push(...pair[0].state.characters[AYLA]!.actor.effects.filter((e) => e.hiddenFromPlayers && e.id !== ZERO_HP_UNCONSCIOUS_ID).map((e) => e.id));
    // The DM's two ops differ: a removal writes its line, a hide none. From here on both rooms answer alike.
    const since = marks(pair);
    await each(pair, (room) => room.apply("dm", heal));
    await each(pair, (room) => room.apply("dm", hit));
    sameSince(pair, since, "0 HP again");
    for (const room of pair) {
      const effects = room.state.characters[AYLA]!.actor.effects;
      const auto = effects.filter((e) => e.id === ZERO_HP_UNCONSCIOUS_ID);
      assert.equal(auto.length, 1, `${room.name}: one automatic Unconscious`);
      assert.equal(effects.at(-1)!.id, ZERO_HP_UNCONSCIOUS_ID, `${room.name}: at the end`);
      assert.deepEqual(Object.keys(auto[0]!).sort(), ["id", "key"], `${room.name}: bare`);
    }
    await each(pair, (room) => room.apply("p1", { t: "actor.effect.remove", target: { characterId: AYLA }, effectId: ZERO_HP_UNCONSCIOUS_ID }));
    sameSince(pair, since, "P1 removes the shown one");
  });
});

/** P1's area riding the ogre, P1's kept ruler from Ayla to the ogre, and P1's line, laid out alike in both rooms. */
const RIDE = "0199f0a0-0000-7000-8000-00000000c001";
const RULER = "0199f0a0-0000-7000-8000-00000000c002";
const LINE = "0199f0a0-0000-7000-8000-00000000c003";

function withRiders(s: RoomState, onAyla = 0): void {
  s.templates[RIDE] = template(RIDE, { ownerId: "p1", attachedTo: OGRE, origin: { x: 8.5, y: 4.5, z: 0 }, size: 5 });
  for (let i = 0; i < onAyla; i++) {
    const id = `0199f0a0-0000-7000-8000-0000000d${String(i).padStart(4, "0")}`;
    s.templates[id] = template(id, { ownerId: "p1", attachedTo: AYLA, origin: { x: 3.5, y: 3.5, z: 0 }, size: 5 });
  }
  s.drawings[RULER] = drawing(RULER, { kind: "ruler", ownerId: "p1", points: [3.5, 3.5, 8.5, 4.5], anchors: [AYLA, OGRE] });
  s.drawings[LINE] = drawing(LINE, { ownerId: "p1", points: [3, 5, 5, 5] });
}

const hideOgre = { t: "token.update", tokenId: OGRE, patch: { visibility: "dm" } } as Op;
const deleteOgre: Op = { t: "token.delete", tokenId: OGRE };
const clear: Op = { t: "drawing.clear", sceneId: "s1", scope: "own" };
/** The DM renames room A's own creature, the first dmTokens gives it. */
const renameShade = { t: "token.update", tokenId: apartId("tok", 0), patch: { name: `${APART}renamed` } } as Op;
/** The ogre leaves P1's copy: hidden in A, deleted in B. */
const ogreGoes = (room: Room): Op => (room.name === "A" ? hideOgre : deleteOgre);

describe("riders and clears act on P1's copy, alike whether the DM hid or deleted what they stand on", () => {
  test("K1: the ogre hidden in A and deleted in B in the batch where P1 fills the riding seat and clears answers alike, with the same undo step", async (t) => {
    const pair = await open(t, alike((s) => withRiders(s, SEAT.ridingAreas - 1)));
    const answers: Answer[][] = [];
    for (const room of pair) {
      const onAyla = (size: number) => areaOp(room, { attachedTo: AYLA, origin: { x: 3.5, y: 3.5, z: 0 }, size });
      answers.push(await together(room, [["dm", ogreGoes(room)], ["p1", onAyla(5)], ["p1", onAyla(10)], ["p1", clear]]));
    }
    assert.deepEqual(answers[0], answers[1], "the same answers in both rooms");
    assert.deepEqual(answers[0], ["taken", "taken", { code: "quota", message: SEAT_FULL.ridingAreas }, "taken"]);
    same(pair, "the batch");
    for (const room of pair) {
      assert.equal(room.state.templates[RIDE], undefined, `${room.name}: the area on the ogre is gone`);
      assert.equal(room.state.drawings[RULER], undefined, `${room.name}: the ruler to the ogre is gone`);
    }
    await each(pair, (room) => room.restore("undo", "play", "p1"));
    same(pair, "P1 undoes the clear");
    for (const room of pair) assert.deepEqual(Object.keys(room.state.drawings), [LINE], `${room.name}: the undo brings back the line alone`);
  });

  test("K1b: an ask on the area stays without its area in both rooms, with no new line", async (t) => {
    const pair = await open(t, alike((s) => withRiders(s)));
    const asks: string[] = [];
    for (const room of pair) {
      asks.push(mint.next(room));
      await room.apply("p1", { t: "cast.ask", cast: { id: asks.at(-1)!, caster: AYLA, sceneId: "s1", spell: "Moonbeam", area: RIDE } } as Op);
    }
    const lines = pair.map((room) => room.state.log.length);
    for (const room of pair) await together(room, [["dm", ogreGoes(room)]]);
    same(pair, "the ogre goes");
    for (const [i, room] of pair.entries()) {
      assert.ok(room.state.casts[asks[i]!], `${room.name}: the ask stays`);
      assert.equal(room.state.templates[RIDE], undefined, `${room.name}: its area is gone`);
      assert.equal(room.state.log.length, lines[i], `${room.name}: no line is written`);
    }
  });

  test("K3: the party leaves the map, the ogre is hidden in A and deleted in B, and the party comes back to no area in either", async (t) => {
    const pair = await open(t, alike((s) => withRiders(s)));
    await each(pair, (room) => room.apply("dm", { t: "room.setPlayerScene", sceneId: "s2" }));
    await each(pair, (room) => room.apply("dm", ogreGoes(room)));
    same(pair, "while the party is away");
    await each(pair, (room) => room.apply("dm", { t: "room.setPlayerScene", sceneId: "s1" }));
    same(pair, "the party is back");
    for (const room of pair) assert.equal(room.state.templates[RIDE], undefined, `${room.name}: no area on the ogre`);
  });

  test("K4: P1 clears in the batch where the DM hides the ogre in A, and hides it and deletes the ruler in B, and the clear's undo brings back the line alone", async (t) => {
    const pair = await open(t, rooms((s) => (withRiders(s), dmTokens(s, 1)), (s) => (withRiders(s), [])));
    for (const room of pair) {
      // Each room's batch holds two ops of the DM's, so the room's numbers match: A's second is on its own creature.
      const dm: Array<[Who, Op]> = room.name === "A" ? [["dm", hideOgre], ["dm", renameShade]] : [["dm", hideOgre], ["dm", { t: "drawing.delete", drawingId: RULER }]];
      const answers = await together(room, [...dm, ["p1", clear]]);
      assert.equal(answers.at(-1), "taken", `${room.name}: the clear is taken`);
    }
    same(pair, "the clear");
    await each(pair, (room) => room.restore("undo", "play", "p1"));
    same(pair, "the clear's undo");
    for (const room of pair) assert.deepEqual(Object.keys(room.state.drawings), [LINE], `${room.name}: the line alone is back`);
  });

  test("K4b: P1's undo of the ruler's own create in the batch where the DM hides it in A and deletes it in B answers the same in both", async (t) => {
    const pair = await open(t, rooms((s) => dmTokens(s, 1), () => []));
    for (const room of pair) {
      const ruler = { id: mint.next(room), sceneId: "s1", kind: "ruler", points: [3.5, 3.5, 8.5, 4.5], anchors: [AYLA, OGRE], style: { stroke: "#ffffff", width: 3, opacity: 1 }, ownerId: "p1", visibility: "all" };
      await room.apply("p1", { t: "drawing.create", drawing: ruler } as Op);
    }
    const answers: Answer[] = [];
    for (const room of pair) {
      const head = room.clients.p1.head("play", "undo").id;
      const ruler = Object.values(room.state.drawings).find((d) => d.kind === "ruler")!.id;
      const dm: Array<[Who, Op]> = room.name === "A" ? [["dm", hideOgre], ["dm", renameShade]] : [["dm", hideOgre], ["dm", { t: "drawing.delete", drawingId: ruler }]];
      answers.push((await together(room, [...dm, ["p1", { t: "undo", scope: "play", head } as Op]])).at(-1)!);
    }
    assert.deepEqual(answers[0], answers[1], "P1's undo answers the same in both rooms");
    assert.equal((answers[0] as { code: string }).code, "invalid");
    same(pair, "the undo");
  });

  test("K7: a kept ruler to the ogre is removed when the ogre is deleted in B and hidden in A", async (t) => {
    const pair = await open(t, alike((s) => withRiders(s)));
    await each(pair, (room) => room.apply("dm", ogreGoes(room)));
    same(pair, "the ogre goes");
    for (const room of pair) assert.equal(room.state.drawings[RULER], undefined, `${room.name}: the ruler is removed`);
  });
});
