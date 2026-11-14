import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { BOOKKEEPING_RESERVE, FAR, LIMITS, NO_ROOM_TO_EXPLORE, roundUp, SEAT, serializedBytes } from "#shared/limits.ts";
import type { Drawing, RoomState } from "#shared/model.ts";
import { MOVE_PLAYERS_FIRST } from "#shared/permissions.ts";
import { MAX_NOTES, type Op } from "#shared/protocol.ts";
import { idAt, seated, type Seated } from "#shared/privTestutil.ts";
import { actor, castAsk, character, companionBlock, drawing, entry, member, rng, room, scene, template, token } from "#shared/testutil.ts";
import { PLAYER_LIMITS_SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { markedRoom } from "./limitsTesting.ts";
import { answer, joinOp, Mint, type Answer } from "./limitsTwinTesting.ts";
import type { Who } from "./numberingTesting.ts";
import { Room } from "./numberingTesting.ts";
import { farRoomBytes, heldBytes, MEMORY_FULL, PER_PLAYER_FULL, projectedSceneBytes } from "./sizeGuard.ts";
import { ScopeClient, StoredRoomDb, storedActor } from "./undoScopeTesting.ts";

/**
 * The DM's side of the player limits: the room caps count only what no
 * player's seat holds, a cap refuses the DM only an op that adds to its
 * total, and deletions and ops that add nothing are never refused, at
 * the caps, at the byte lines and at the far line.
 */

const mint = new Mint();
const PLAYERS = 48;

async function opened(t: TestContext, state: RoomState, name = "R", options = {}, version?: number): Promise<Room> {
  const r = new Room(t, name, state, { idGate: true, ...options }, version);
  await r.load();
  return r;
}

/** The DM's own things on s1, none of them any seat's: tokens, areas, lines, rows and P2's asks for the DM's creature. */
type Rest = { tokens: number; areas: number; drawings: number; rows: number; asks: number };

function withRest(state: RoomState, rest: Rest): void {
  state.encounter ??= { rev: 0, round: 1, activeEntryId: null, entries: [] };
  for (let i = 0; i < rest.tokens; i++) state.tokens[`dmt${i}`] = token(`dmt${i}`, { name: "Goblin", visibility: "dm", x: 30, y: 20 });
  for (let i = 0; i < rest.areas; i++) state.templates[`dma${i}`] = template(`dma${i}`, { ownerId: "dm1", visibility: "dm", origin: { x: 30.5, y: 20.5, z: 0 }, size: 5 });
  for (let i = 0; i < rest.drawings; i++) state.drawings[`dmd${i}`] = drawing(`dmd${i}`, { ownerId: "dm1", visibility: "dm", points: [30, 20, 31, 21] });
  for (let i = 0; i < rest.rows; i++) state.encounter.entries.push(entry(`dme${i}`, { label: "Goblin", hidden: true }));
  for (let i = 0; i < rest.asks; i++) state.casts[`dmk${i}`] = castAsk(`dmk${i}`, { by: "dm1", caster: "dmt0", sceneId: "s1", area: undefined, targets: ["dmt0"] });
}

const AT_CAP: Rest = { tokens: LIMITS.tokensPerScene, areas: LIMITS.templatesPerScene, drawings: LIMITS.drawingsPerScene, rows: LIMITS.encounterRows, asks: LIMITS.openCastsPerRoom };
const ONE_SHORT: Rest = { tokens: AT_CAP.tokens - 1, areas: AT_CAP.areas - 1, drawings: AT_CAP.drawings - 1, rows: AT_CAP.rows - 1, asks: AT_CAP.asks - 1 };

/**
 * Full drawing seats for 12 players and 50 drawings for the rest: every
 * player's 400 drawings would take the scene past its far byte line by
 * themselves, and that line binds before the drawings' count does.
 */
const FULL_DRAWINGS = 12;

/** A room with the DM's rest and, when `players` is more than 0, that many players with full seats on s1 but for drawings. */
function dmRoom(rest: Rest, players: number): { state: RoomState; seats: Seated | null } {
  const state = room();
  for (let p = 3; p <= PLAYERS; p++) state.members[`p${p}`] = member(`p${p}`);
  state.members.dm2 = member("dm2", "dm");
  let seats: Seated | null = null;
  if (players > 0) {
    const full = seated(state, Math.min(players, FULL_DRAWINGS));
    const fewer = players > FULL_DRAWINGS ? seated(state, players - FULL_DRAWINGS, 50, FULL_DRAWINGS + 1) : full;
    seats = fewer === full ? full : (Object.fromEntries(Object.entries(full).map(([k, ids]) => [k, [...ids, ...fewer[k as keyof Seated]]])) as Seated);
  }
  withRest(state, rest);
  return { state, seats };
}

/** The DM's creates and edits that each answer by the room caps: two of each kind, the second one past the cap. */
function dmSteps(r: Room): Array<[string, () => Op]> {
  const goblin = () => ({ t: "token.create", token: { id: mint.next(r), sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 31, y: 20, visibility: "dm", actor: { inline: actor() } } }) as Op;
  const area = () => ({ t: "template.create", template: { id: mint.next(r), sceneId: "s1", shape: "sphere", size: 5, origin: { x: 31.5, y: 20.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "dm1", visibility: "dm" } }) as Op;
  const line = () => ({ t: "drawing.create", drawing: { id: mint.next(r), sceneId: "s1", kind: "line", points: [31, 20, 32, 21], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "dm1", visibility: "dm" } }) as Op;
  const row = () => ({ t: "encounter.add", entries: [{ id: mint.next(r), label: "Goblin", hidden: true }] }) as Op;
  return [
    ["a goblin", goblin],
    ["another goblin", goblin],
    ["an area", area],
    ["another area", area],
    ["a line", line],
    ["another line", line],
    ["a row", row],
    ["another row", row],
    ["an edit", () => ({ t: "token.update", tokenId: "dmt0", patch: { name: "Hobgoblin" } }) as Op],
    ["a delete", () => ({ t: "token.delete", tokenId: "dmt1" })],
    ["a clear", () => ({ t: "drawing.clear", sceneId: "s1", scope: "all" })],
    ["a duplicate", () => ({ t: "scene.duplicate", sceneId: "s1", newSceneId: mint.next(r), name: "Copy", include: { creatures: true, characters: true, fog: false, drawings: false } }) as Op],
  ];
}

/** The DM's device starts again on a new socket, as it does when the server tells it to. */
async function reopenDm(r: Room): Promise<void> {
  r.actor.detach(r.clients.dm.conn);
  r.clients.dm = await ScopeClient.open(r.actor, r.member("dm"), "dm");
}

/** The DM's undo of their newest step, in whichever history holds it, and its answer. */
async function undoAnswer(r: Room): Promise<Answer> {
  const history = r.clients.dm.history();
  const scope = history.setup?.undo.head ? "setup" : "play";
  return answer(r, "dm", { t: "undo", scope, head: r.clients.dm.head(scope, "undo").id } as Op);
}

describe("the DM's caps count what no seat holds", () => {
  test("D1: with 48 players' seats on the scene, 12 with every drawing, the DM's creates, edits, deletes, undo, clear and duplicate answer as in the room without them", async (t) => {
    const answers: Array<Array<[string, Answer]>> = [];
    for (const players of [PLAYERS, 0]) {
      const r = await opened(t, dmRoom(ONE_SHORT, players).state, players > 0 ? "seated" : "bare");
      const got: Array<[string, Answer]> = [];
      for (const [what, op] of dmSteps(r)) {
        got.push([what, await answer(r, "dm", op())]);
        if (what === "a delete") got.push(["the delete's undo", await undoAnswer(r)]);
      }
      answers.push(got);
    }
    assert.deepEqual(answers[0], answers[1], "the same answers with the seats full as without them");
    const refused = answers[0]!.filter(([, a]) => a !== "taken").map(([what]) => what);
    assert.deepEqual(refused, ["another goblin", "another area", "another line", "another row"], "the second of each is past the cap");
  });

  test("D2: at each cap and at the far line, hiding a player's area, handing a character on, a scene change, a roster change, a join and every deletion are taken", async (t) => {
    const held = PLAYERS * SEAT.tokens;
    // The DM's tokens as far as the far line reads them: rounded up to its step, with the seats' exactly, at the line.
    const far: Rest = { ...AT_CAP, tokens: FAR.tokens - held - ((FAR.tokens - held) % FAR.countStep) };
    assert.ok(roundUp(far.tokens, FAR.countStep) + held <= FAR.tokens && roundUp(far.tokens + 1, FAR.countStep) + held > FAR.tokens, "the fixture sits at the far line");
    for (const [what, rest] of [["at each cap", AT_CAP], ["at the far line", far]] as const) {
      await t.test(what, async (t) => {
        const { state, seats } = dmRoom(rest, PLAYERS);
        state.scenes.s3 = scene("s3", { order: 2 });
        state.encounter = { ...state.encounter!, activeEntryId: "dme0", started: true };
        const r = await opened(t, state);
        const ops: Array<[string, Op]> = [
          ["hide a player's area", { t: "template.update", templateId: seats!.areas[0]!, patch: { visibility: "dm" } } as Op],
          ["hand a character on", { t: "character.update", characterId: seats!.characters[0]!, patch: { ownerIds: ["p2"] } } as Op],
          ["a scene change", { t: "room.setPlayerScene", sceneId: "s2" }],
          ["the scene change back", { t: "room.setPlayerScene", sceneId: "s1" }],
          ["the active row's removal", { t: "encounter.remove", entryIds: ["dme0"] }],
          ["a token's delete", { t: "token.delete", tokenId: "dmt2" }],
          ["a group delete", { t: "token.deleteMany", tokenIds: ["dmt3", "dmt4"] } as Op],
          ["an area's delete", { t: "template.delete", templateId: "dma0" }],
          ["a line's delete", { t: "drawing.delete", drawingId: "dmd0" }],
          ["an ask's close", { t: "cast.close", castId: "dmk0", end: "dismissed" } as Op],
          ["a clear", { t: "drawing.clear", sceneId: "s1", scope: "all" }],
          ["a character's delete", { t: "character.delete", characterId: seats!.characters[1]! }],
          ["a scene's delete", { t: "scene.delete", sceneId: "s3" } as Op],
          ["the fight's end", { t: "encounter.end" } as Op],
        ];
        for (const [step, op] of ops) assert.equal(await answer(r, "dm", op), "taken", `${what}: ${step}`);
        await r.actor.sys({ t: "sys.memberRemove", memberId: "p48" });
        await r.actor.sys(joinOp(mint.next(r), "Wren"));
        await r.settle();
        assert.equal(r.state.members.p48, undefined, `${what}: the member is removed`);
        assert.equal(Object.values(r.state.members).some((m) => m.name === "Wren"), true, `${what}: the join is taken`);
      });
    }
  });
});

describe("deletions meet no cap", () => {
  test("D2: a room over a cap it holds as a whole, open rolls and a character's stat blocks, takes the DM's and a player's deletions, and refuses their creates", async (t) => {
    const state = room();
    state.characters.hero = character("hero", { name: "Hero", ownerIds: ["p1"] });
    state.tokens.dmt0 = token("dmt0", { name: "Goblin", visibility: "dm", x: 30, y: 20 });
    state.drawings.pd0 = drawing("pd0", { ownerId: "p1", points: [5, 5, 6, 6] });
    for (let i = 0; i <= LIMITS.openRollsPerRoom; i++) {
      state.rolls[`roll${i}`] = { id: `roll${i}`, rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 15, dcShown: false, resultShown: false, note: "Dodge", at: "2026-11-10T20:00:00.000Z", targets: [] };
    }
    // The hero's blocks past their 512 KiB together, about 15 KiB each.
    const pad = { traits: [0, 1, 2, 3].map((i) => ({ name: `Pad ${i}`, text: "w".repeat(3_700) })) };
    for (let i = 0; serializedBytes(state.companionBlocks) <= LIMITS.companionBlockBytesPerCharacter; i++) state.companionBlocks[`blk${i}`] = companionBlock(`blk${i}`, "hero", pad);
    const r = await opened(t, state);
    assert.equal(await answer(r, "dm", { t: "token.delete", tokenId: "dmt0" }), "taken", "the DM's delete");
    assert.equal(await answer(r, "p1", { t: "drawing.delete", drawingId: "pd0" }), "taken", "the player's delete");
    const goblin = { t: "token.create", token: { id: mint.next(r), sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 3, y: 3, actor: { inline: actor() } } } as Op;
    assert.equal(typeof (await answer(r, "dm", goblin)), "object", "the DM's create meets the rolls' cap");
    const line = { t: "drawing.create", drawing: { id: mint.next(r), sceneId: "s1", kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } } as Op;
    assert.equal(typeof (await answer(r, "p1", line)), "object", "the player's create meets the blocks' cap");
  });
});

describe("the players' scene can be deleted with the DM's yes", () => {
  test("D13: deleting the players' scene is refused without the confirm, taken with it leaving them on no scene, and its undo puts them back, each across a restart", async (t) => {
    const r = await opened(t, room());
    assert.deepEqual(await answer(r, "dm", { t: "scene.delete", sceneId: "s1" } as Op), { code: "invalid", message: MOVE_PLAYERS_FIRST });
    await r.restart(false);
    assert.equal(await answer(r, "dm", { t: "scene.delete", sceneId: "s1", leavePlayers: true } as Op), "taken");
    assert.equal(r.state.meta.playerSceneId, null, "the players are on no scene");
    assert.equal(r.state.scenes.s1, undefined, "the scene is gone");
    // The DM's device was on that map and is told to start again, as on any scene's delete.
    assert.ok(r.clients.dm.sent.some((m) => m.t === "resync"), "the DM's device is told the scene went");
    await reopenDm(r);
    // Undo stacks live in memory, so the undo comes before the next restart.
    assert.equal(await undoAnswer(r), "taken");
    assert.ok(r.state.scenes.s1, "the undo brings the scene back");
    assert.equal(r.state.meta.playerSceneId, "s1", "and the players with it");
    await r.restart(false);
    assert.equal(r.state.meta.playerSceneId, "s1", "after a restart too");
    await reopenDm(r);
    assert.equal(await answer(r, "dm", { t: "scene.delete", sceneId: "s1", leavePlayers: true } as Op), "taken");
    await r.restart(false);
    assert.equal(r.state.meta.playerSceneId, null, "on no scene after a restart");
  });
});

/** The players' scene as its far line reads it: the DM's part, which the line rounds up to its step, and what seats hold. */
function farScene(state: RoomState): { dm: number; held: number } {
  const held = heldBytes(state, ["s1"]);
  return { dm: projectedSceneBytes(state, "s1") - held, held };
}

/**
 * Lines added to or taken out of the room. The measures keep each object's
 * bytes by its identity, so a change makes a new collection, as an op does.
 */
function withLines(state: RoomState, add: Drawing[], remove: readonly string[] = []): void {
  const drawings = { ...state.drawings };
  for (const id of remove) delete drawings[id];
  for (const line of add) drawings[line.id] = line;
  state.drawings = drawings;
}

/** One more line's bytes in `part`, measured by adding it and taking it back out. */
function lineCost(state: RoomState, part: "dm" | "held", line: Drawing): number {
  const before = farScene(state)[part];
  withLines(state, [line]);
  const after = farScene(state)[part];
  withLines(state, [], [line.id]);
  return after - before;
}

/** Pads a token's notes until `part` reads exactly `target`: a note's every character is one byte. */
function padTo(state: RoomState, tokenId: string, part: "dm" | "held", target: number): void {
  const noted = (notes: string) => (state.tokens = { ...state.tokens, [tokenId]: { ...state.tokens[tokenId]!, notes } });
  noted("x");
  for (let i = 0; i < 3 && farScene(state)[part] !== target; i++) noted("x".repeat((state.tokens[tokenId]!.notes ?? "").length + target - farScene(state)[part]));
  assert.equal(farScene(state)[part], target, `${tokenId}'s notes pad the ${part} part to ${target}`);
  assert.ok((state.tokens[tokenId]!.notes ?? "").length <= MAX_NOTES, "the pad fits a note");
}

/**
 * A room valid today whose players' scene reads `reading` against its far
 * line: 48 players' token and area seats, their lines, and the DM's things
 * filling the DM's part to the top of its step, or to just past the bottom
 * of one, where the DM's bookkeeping grows it without reading another
 * step. The fight holds only the DM's rows, so a Next's step is small.
 */
function farRoom(reading: number, dmAt: "top" | "bottom"): { state: RoomState; seats: Seated } {
  const state = room();
  for (let p = 3; p <= PLAYERS; p++) state.members[`p${p}`] = member(`p${p}`);
  const seats = seated(state, PLAYERS, 0);
  withRest(state, { tokens: 100, areas: 20, drawings: 1_999, rows: 20, asks: 0 });
  state.encounter = { ...state.encounter!, entries: state.encounter!.entries.filter((e) => e.id.startsWith("dme")), activeEntryId: "dme0", started: true };
  // The DM's part to its place in a step: lines out until it is under it, then a note.
  const dmLine = lineCost(state, "dm", drawing("dmd9999", { ownerId: "dm1", visibility: "dm", points: [30, 20, 31, 21] }));
  const dm = farScene(state).dm;
  const floor = Math.floor(dm / FAR.byteStep) * FAR.byteStep;
  const [target, step] = dmAt === "top" ? [floor, floor] : dm - floor > 200 ? [floor + 1, floor + FAR.byteStep] : [floor - FAR.byteStep + 1, floor];
  let next = 1_998;
  for (let i = 0; i < 5 && farScene(state).dm > target - 100; i++) {
    const out = Math.ceil((farScene(state).dm - target + 100) / dmLine);
    assert.ok(next - out >= 0, "the DM's lines reach the place");
    withLines(state, [], Array.from({ length: out }, () => `dmd${next--}`));
  }
  padTo(state, "dmt99", "dm", target);
  // The seats' part to the reading: players' lines, then a note on a companion's token.
  const held = reading - step;
  const line = (p: number, i: number) => `pl${String(p).padStart(2, "0")}x${String(i).padStart(3, "0")}`;
  // Lines of 100 values each, so 46 players' seats hold the part in their counts. A two-digit owner's line is the largest.
  const points = Array.from({ length: 25 }, () => [10, 1, 11, 2]).flat();
  const seatLine = lineCost(state, "held", drawing(line(10, 999), { ownerId: "p10", points }));
  const lines = Math.floor((held - farScene(state).held - 100) / seatLine);
  assert.ok(lines <= (PLAYERS - 2) * SEAT.drawings, "the lines fit the seats");
  withLines(
    state,
    Array.from({ length: lines }, (_, k) => {
      const p = 3 + (k % (PLAYERS - 2));
      return drawing(line(p, Math.floor(k / (PLAYERS - 2))), { ownerId: `p${p}`, points });
    }),
  );
  padTo(state, seats.tokens[SEAT.tokens * 3 + 1]!, "held", held);
  assert.equal(roundUp(farScene(state).dm, FAR.byteStep) + farScene(state).held, reading, "the scene reads where it should against its far line");
  return { state, seats };
}

/** Each answer as taken or its refusal's code, so a case reads which ops pass without the words of each line. */
function codes(got: ReadonlyArray<readonly [string, Answer]>): Array<[string, string]> {
  return got.map(([what, a]) => [what, typeof a === "string" ? a : a.code]);
}

/** The ops of D9 on a far room, a player's and the DM's, each made when it is sent. */
function farSteps(r: Room, seats: Seated): Record<string, [Who, () => Op]> {
  const character = seats.characters[0]!;
  const own = r.state.tokens[seats.tokens[0]!]!;
  return {
    "a create": ["dm", () => ({ t: "token.create", token: { id: mint.next(r), sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: actor() } } }) as Op],
    "a creature's notes": ["dm", () => ({ t: "token.update", tokenId: "dmt1", patch: { notes: "A long note" } }) as Op],
    "a player's line": ["p2", () => ({ t: "drawing.create", drawing: { id: mint.next(r), sceneId: "s1", kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p2", visibility: "all" } }) as Op],
    "a character's notes": ["p1", () => ({ t: "character.update", characterId: character, patch: { actor: { notes: "A long note" } } }) as Op],
    "a move": ["p1", () => ({ t: "token.move", tokenId: own.id, x: own.x, y: own.y + 1 }) as Op],
    "the move's undo": ["p1", () => ({ t: "undo", scope: "play", head: r.clients.p1.head("play", "undo").id }) as Op],
    Next: ["dm", () => ({ t: "encounter.next" }) as Op],
    Previous: ["dm", () => ({ t: "encounter.prev" }) as Op],
    HP: ["dm", () => ({ t: "actor.hp", target: { tokenId: "dmt2" }, change: { kind: "damage", amount: 3 } }) as Op],
    "bulk damage": ["dm", () => ({ t: "actor.damageMany", hits: ["dmt3", "dmt4", "dmt5"].map((id) => ({ target: { tokenId: id }, amount: 2 })) }) as Op],
    "down to 0": ["dm", () => ({ t: "actor.hp", target: { characterId: character }, change: { kind: "damage", amount: r.state.characters[character]!.actor.hp.cur } }) as Op],
    "a death save": ["p1", () => ({ t: "actor.deathSave", target: { characterId: character }, ok: 1, fail: 0 }) as Op],
    "a Revive": ["dm", () => ({ t: "actor.life", target: { characterId: character }, life: "alive" }) as Op],
    "a condition": ["dm", () => ({ t: "actor.effect.add", target: { tokenId: "dmt6" }, effect: { id: mint.next(r), key: "prone" } }) as Op],
    "an AC edit": ["p1", () => ({ t: "character.update", characterId: character, patch: { actor: { ac: 17 } } }) as Op],
    "a roll": ["p1", () => ({ t: "dice.roll", tag: mint.next(r), to: "all", rolls: [{ formula: "1d20+5", label: "Check" }] }) as Op],
    "a chat line": ["p1", () => ({ t: "log.chat", text: "Onward" })],
    "a whisper": ["p1", () => ({ t: "log.whisper", to: ["dm1"], text: "A secret" }) as Op],
    "a group delete": ["dm", () => ({ t: "token.deleteMany", tokenIds: ["dmt7", "dmt8"] }) as Op],
    "the active row's removal": ["dm", () => ({ t: "encounter.remove", entryIds: [r.state.encounter!.activeEntryId!] }) as Op],
  };
}

async function sendAll(r: Room, steps: Record<string, [Who, () => Op]>, names: readonly string[]): Promise<Array<[string, Answer]>> {
  const got: Array<[string, Answer]> = [];
  for (const what of names) {
    const [who, op] = steps[what]!;
    got.push([what, await answer(r, who, op())]);
  }
  return got;
}

/*
 * D9, as amended by D-261113-073: ops that meet the far line stop short of
 * it by the bookkeeping reserve, bookkeeping may fill the reserve, and past
 * the line itself every op that grows the scene is refused, bookkeeping
 * too. Deletions meet no line. The rooms are ones a backup valid today can
 * be: the players' scene there on seats, the DM's part inside today's lines.
 */
describe("a scene at its far line goes on with play", () => {
  test("D9: inside the bookkeeping reserve, creates, notes and a player's line are refused, and moves, turns, HP, life, conditions, an AC edit, rolls, talk, an undo and a group delete taken", async (t) => {
    const { state, seats } = farRoom(FAR.sceneBytes - BOOKKEEPING_RESERVE.scene + 1, "bottom");
    const r = await opened(t, state, "reserve");
    const steps = farSteps(r, seats);
    const refused = ["a create", "a creature's notes", "a player's line", "a character's notes"];
    const got = codes(await sendAll(r, steps, Object.keys(steps)));
    assert.deepEqual(got, Object.keys(steps).map((what) => [what, refused.includes(what) ? "quota" : "taken"]));
  });

  test("D9: past the line, creates, notes, a player's line, a condition, a chat line and a Next are refused, and a whisper, a group delete and the active row's removal taken", async (t) => {
    const { state, seats } = farRoom(FAR.sceneBytes + 1, "top");
    const r = await opened(t, state, "past");
    const steps = farSteps(r, seats);
    const names = ["a create", "a creature's notes", "a player's line", "a character's notes", "a condition", "a chat line", "Next", "a whisper", "a group delete", "the active row's removal"];
    const taken = ["a whisper", "a group delete", "the active row's removal"];
    const got = codes(await sendAll(r, steps, names));
    assert.deepEqual(got, names.map((what) => [what, taken.includes(what) ? "taken" : "quota"]));
  });

  test("the scene's far line reads the DM's part by its step: two rooms whose DM parts differ inside one step answer a player's line alike", async (t) => {
    const answers: Answer[] = [];
    const steps: number[] = [];
    for (const less of [0, 40]) {
      const { state, seats } = farRoom(FAR.sceneBytes, "top");
      // Fewer of the DM's creatures in the second room: its DM part is lower, in the same step.
      const tokens = { ...state.tokens };
      for (let i = 0; i < less; i++) delete tokens[`dmt${50 + i}`];
      state.tokens = tokens;
      steps.push(roundUp(farScene(state).dm, FAR.byteStep));
      const r = await opened(t, state, `less ${less}`);
      answers.push(await answer(r, "p2", farSteps(r, seats)["a player's line"]![1]()));
    }
    assert.equal(steps[1], steps[0], "both DM parts read one step");
    assert.equal(typeof answers[0], "object", "the line passes the line");
    assert.deepEqual(answers[1], answers[0], "the second room answers as the first");
  });
});

/** A room whose only bulk is `scenes` empty per-player scenes of the widest size, with P1's hero on s1. */
function perPlayerRoom(scenes: number): RoomState {
  const state = room();
  state.characters.hero = character("hero", { name: "Hero", ownerIds: ["p1"] });
  state.tokens.hero = token("hero", { kind: "pc", name: "Hero", x: 5, y: 5, actor: { ref: "hero" } });
  for (let i = 0; i < scenes; i++) {
    state.scenes[`pp${i}`] = scene(`pp${i}`, { order: 10 + i, bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells }, fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true } });
  }
  return state;
}

/*
 * D9 on the room's line: a room past it, or inside its bookkeeping reserve,
 * on per-player sight's reserves alone, which a player's op reads at the
 * widest and the DM's at today's roster. A join changes neither reading.
 */
describe("a room past the far line on per-player sight alone", () => {
  const player = (r: Room): Record<string, [Who, () => Op]> => ({
    "a line": ["p1", () => ({ t: "drawing.create", drawing: { id: mint.next(r), sceneId: "s1", kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } }) as Op],
    "character notes": ["p1", () => ({ t: "character.update", characterId: "hero", patch: { actor: { notes: "A long note" } } }) as Op],
    "a move": ["p1", () => ({ t: "token.move", tokenId: "hero", x: 6, y: 5 }) as Op],
    "a roll": ["p1", () => ({ t: "dice.roll", tag: mint.next(r), to: "all", rolls: [{ formula: "1d20+5", label: "Check" }] }) as Op],
    "a chat line": ["p1", () => ({ t: "log.chat", text: "Onward" })],
    "a whisper": ["p1", () => ({ t: "log.whisper", to: ["dm1"], text: "A secret" }) as Op],
  });
  const goblin = (r: Room): Op => ({ t: "token.create", token: { id: mint.next(r), sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: actor() } } }) as Op;

  /** The room with `scenes` per-player scenes, opened, and the player's answers to `names`, before six joins and after them unless `joins` is false. */
  async function beforeAndAfter(t: TestContext, scenes: number, names: readonly string[], joins = true): Promise<{ r: Room; rounds: Array<Array<[string, string]>> }> {
    const state = perPlayerRoom(scenes);
    assert.ok(farRoomBytes(state, false) <= FAR.roomBytes - BOOKKEEPING_RESERVE.room, "today's roster reads under the line ops meet");
    const r = await opened(t, state, `${scenes} scenes`);
    const rounds: Array<Array<[string, string]>> = [];
    for (const round of joins ? ["before the joins", "after them"] : ["without joins"]) {
      if (round === "after them") {
        for (let i = 0; i < 6; i++) await r.actor.sys(joinOp(mint.next(r), `Wren ${i}`));
        await r.settle();
      }
      rounds.push(codes(await sendAll(r, player(r), names)));
    }
    return { r, rounds };
  }

  test("D9: past the line at the widest, a player's line and character notes are refused and their move and whisper taken, and the DM's create, read at today's roster, taken", async (t) => {
    assert.ok(farRoomBytes(perPlayerRoom(13), true) > FAR.roomBytes, "13 scenes read past the line at the widest");
    const { r, rounds } = await beforeAndAfter(t, 13, ["a line", "character notes", "a move", "a whisper"], false);
    assert.deepEqual(rounds[0], [["a line", "quota"], ["character notes", "quota"], ["a move", "taken"], ["a whisper", "taken"]]);
    assert.equal(await answer(r, "dm", goblin(r)), "taken", "the DM's create reads today's roster");
  });

  test("D9: past the line, a player's roll and chat line, which grow the room, are refused", async (t) => {
    const { rounds } = await beforeAndAfter(t, 13, ["a roll", "a chat line"], false);
    assert.deepEqual(rounds[0], [["a roll", "quota"], ["a chat line", "quota"]]);
  });

  test("D9: inside the room's bookkeeping reserve, a player's line and character notes are refused and their move, roll, chat line and whisper taken", async (t) => {
    const reading = farRoomBytes(perPlayerRoom(11), true);
    assert.ok(reading > FAR.roomBytes - BOOKKEEPING_RESERVE.room && reading <= FAR.roomBytes, `11 scenes read inside the reserve at the widest: ${reading}`);
    const names = ["a line", "character notes", "a move", "a roll", "a chat line", "a whisper"];
    const { rounds } = await beforeAndAfter(t, 11, names, false);
    assert.deepEqual(rounds[0], names.map((what) => [what, what === "a line" || what === "character notes" ? "quota" : "taken"]));
  });

  test("D9: inside the room's reserve and past the line, six joins change no answer of a player's", async (t) => {
    for (const scenes of [11, 13]) {
      const { rounds } = await beforeAndAfter(t, scenes, ["a line", "character notes", "a move", "a roll", "a chat line", "a whisper"]);
      assert.deepEqual(rounds[1], rounds[0], `${scenes} scenes: alike after six joins`);
    }
  });
});

describe("scene changes and per-player scenes", () => {
  test("D10: a lone DM adding per-player scenes is refused in the per-player words where the widest reserves would pass the far line", async (t) => {
    const r = await opened(t, room());
    const answers: Answer[] = [];
    for (let i = 0; i < LIMITS.scenesPerRoom - 2; i++) {
      const scene = { id: mint.next(r), name: `Crypt ${i}`, bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells }, fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true } };
      const got = await answer(r, "dm", { t: "scene.create", scene } as Op);
      answers.push(got);
      if (got !== "taken") break;
    }
    const refused = answers.at(-1);
    assert.deepEqual(refused, { code: "quota", message: PER_PLAYER_FULL }, `refused after ${answers.length - 1} scenes`);
    // Six players' widest layers on every such scene, not the two on the roster: the roster's two take 19 such scenes to the
    // 8 MiB line, and six at the 11 MiB line about 9.
    assert.ok(answers.length - 1 < 15, `the far line at the widest refuses early: ${answers.length - 1} scenes taken`);
  });

  test("D11, D13: near its line a move that raises the reserves answers as today, the smaller unplayed scene included, and past it a move that does not is still taken, a restart between each", async (t) => {
    /** Explore on s1 (the players' scene) and three more: a large and a small unplayed one and a played one, with the DM's notes filling the room. */
    const scenes = (notes: number) => {
      const state = room();
      const vision = { on: true, light: "bright" as const };
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision };
      state.scenes.s2 = { ...state.scenes.s2!, fogEnabled: true, vision, bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells } };
      state.scenes.s3 = scene("s3", { order: 2, fogEnabled: true, vision, bounds: { w: 20, h: 20 } });
      state.scenes.s4 = scene("s4", { order: 3, fogEnabled: true, vision, bounds: { w: 40, h: 30 } });
      state.playedScenes = { s1: { sceneId: "s1", rev: 0 }, s4: { sceneId: "s4", rev: 0 } };
      for (let i = 0; i < notes; i++) state.tokens[`dmt${i}`] = token(`dmt${i}`, { name: "Goblin", visibility: "dm", notes: "x".repeat(4_000) });
      return state;
    };
    const cases: Array<[string, number, Array<[string, Answer | "refused"]>]> = [
      [
        "at its line",
        50,
        [
          ["s2", { code: "quota", message: NO_ROOM_TO_EXPLORE }],
          ["s3", { code: "quota", message: MEMORY_FULL }],
          ["s4", "taken"],
          ["s1", "taken"],
        ],
      ],
      // Past the lowered line the DM's notes alone fill the room: only moves that add no reserve are taken.
      ["past its line", 80, [["s2", "refused"], ["s3", "refused"], ["s4", "taken"], ["s1", "taken"]]],
    ];
    for (const [what, notes, moves] of cases) {
      const r = await opened(t, scenes(notes), what, { sizeLimits: { stateLimit: 400_000 } });
      for (const [to, expected] of moves) {
        const got = await answer(r, "dm", { t: "room.setPlayerScene", sceneId: to });
        if (expected === "refused") assert.equal(typeof got === "object" && got.code, "quota", `${what}: to ${to}`);
        else assert.deepEqual(got, expected, `${what}: to ${to}`);
        await r.restart(false);
      }
    }
  });
});

describe("rooms from before the update", () => {
  test("D8: the marked room with 20 per-player scenes takes a growing DM edit, a player's create and a remembering walk, and writes each scene's share once", async (t) => {
    const marked = markedRoom(48);
    assert.ok(marked.under, "the fixture's room is under the far line at the widest");
    const state = marked.state;
    const [dmId, playerId] = Object.keys(state.members).sort();
    const sceneIds = Object.keys(state.scenes).sort();
    const first = sceneIds[0]!;
    state.meta = { ...state.meta, playerSceneId: first };
    state.characters.hero = character("hero", { name: "Hero", ownerIds: [playerId!] });
    state.tokens.hero = token("hero", { kind: "pc", name: "Hero", sceneId: first, x: 5, y: 5, actor: { ref: "hero" } });
    const clock = { now: Date.parse("2026-11-10T20:00:00.000Z") };
    const { actor: r } = await storedActor(t, new StoredRoomDb(state, { version: PLAYER_LIMITS_SNAPSHOT_VERSION - 1 }), { idGate: true, now: () => clock.now });
    const dm = await ScopeClient.open(r, state.members[dmId!]!, "dm");
    const player = await ScopeClient.open(r, state.members[playerId!]!, "player");
    const shares = () => sceneIds.map((id) => r.committed.state.memoryShared?.[id]?.share);
    const ids = rng(808);
    const steps: Array<[string, ScopeClient, () => Op]> = [
      ["a growing DM edit", dm, () => ({ t: "token.update", tokenId: Object.keys(r.committed.state.tokens).find((id) => id.startsWith("note-"))!, patch: { name: "Wight" } }) as Op],
      ["a player's create", player, () => ({ t: "drawing.create", drawing: { id: idAt(ids, clock.now), sceneId: first, kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: playerId!, visibility: "all" } }) as Op],
      ["a remembering walk", player, () => ({ t: "token.move", tokenId: "hero", x: 20, y: 20 }) as Op],
    ];
    let written: Array<number | undefined> | null = null;
    for (const [what, client, op] of steps) {
      clock.now += 1_000;
      await client.apply(op());
      if (written === null) {
        written = shares();
        assert.ok(written.every((share) => typeof share === "number" && share > 0), `${what}: every marked scene has its share`);
      }
      assert.deepEqual(shares(), written, `${what}: the shares never move`);
    }
    // Deleting a marked scene the players cannot see moves no other scene's share.
    clock.now += 1_000;
    await dm.apply({ t: "scene.delete", sceneId: sceneIds.at(-1)! });
    assert.deepEqual(shares().slice(0, -1), written!.slice(0, -1), "a marked scene's delete moves no other share");
  });
});

describe("joins, blocks and old caps", () => {
  test("D4: a room filled to the far line with per-player scenes takes six joins, and a player's create answers the same before and after them", async (t) => {
    const state = room();
    state.characters.hero = character("hero", { name: "Hero", ownerIds: ["p1"] });
    state.tokens.hero = token("hero", { kind: "pc", name: "Hero", x: 5, y: 5, actor: { ref: "hero" } });
    const r = await opened(t, state);
    for (let i = 0; i < LIMITS.scenesPerRoom - 2; i++) {
      const scene = { id: mint.next(r), name: `Crypt ${i}`, bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells }, fogEnabled: true, vision: { on: true, light: "bright", perPlayer: true } };
      if ((await answer(r, "dm", { t: "scene.create", scene } as Op)) !== "taken") break;
    }
    const line = (): Op => ({ t: "drawing.create", drawing: { id: mint.next(r), sceneId: "s1", kind: "line", points: [5, 5, 6, 6], style: { stroke: "#ffffff", width: 2, opacity: 1 }, ownerId: "p1", visibility: "all" } }) as Op;
    const before = await answer(r, "p1", line());
    for (let i = 0; i < 6; i++) {
      await r.actor.sys(joinOp(mint.next(r), `Wren ${i}`));
      await r.settle();
    }
    assert.equal(Object.values(r.state.members).filter((m) => m.name.startsWith("Wren")).length, 6, "the six joins are taken");
    assert.deepEqual(await answer(r, "p1", line()), before, "the player's create answers as before the joins");
  });

  test("D5: seven players' stat blocks at the far line refuse a player's block save in its step, and the DM's adds are still taken", async (t) => {
    const state = room();
    for (let p = 3; p <= 7; p++) state.members[`p${p}`] = member(`p${p}`);
    // Blocks of 21 characters, each about 16 KiB, until one more passes the far line's step.
    const pad = { traits: [0, 1, 2, 3].map((i) => ({ name: `Pad ${i}`, text: "w".repeat(3_700) })) };
    const heroes: string[] = [];
    for (let p = 1; p <= 7; p++) {
      for (let c = 0; c < 3; c++) {
        const id = `hero${p}x${c}`;
        state.characters[id] = character(id, { name: id, ownerIds: [`p${p}`] });
        heroes.push(id);
      }
    }
    const one = serializedBytes(companionBlock("blk00000", heroes[0]!, pad));
    let bytes = 0;
    for (let n = 0; bytes + one <= FAR.blockBytes; n++) {
      const id = `blk${String(n).padStart(5, "0")}`;
      state.companionBlocks[id] = companionBlock(id, heroes[n % heroes.length]!, pad);
      bytes += serializedBytes(state.companionBlocks[id]);
    }
    const r = await opened(t, state);
    const { rev: _rev, ...block } = companionBlock(mint.next(r), "hero1x0", pad);
    assert.deepEqual(await answer(r, "p1", { t: "companionBlock.create", block } as Op), { code: "quota", message: `The room can hold at most ${FAR.blockBytes / (1024 * 1024)} MiB of companion stat blocks. Delete one first.` });
    const goblin = { t: "token.create", token: { id: mint.next(r), sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 3, y: 3, actor: { inline: actor() } } } as Op;
    assert.equal(await answer(r, "dm", goblin), "taken", "the DM's add is taken");
  });

  test("D6: an old room at each old cap loads, takes the DM's edits and refuses only what passes a cap, as before", async (t) => {
    const { state } = dmRoom(AT_CAP, 0);
    const r = await opened(t, state, "R", {}, PLAYER_LIMITS_SNAPSHOT_VERSION - 1);
    assert.equal(await answer(r, "dm", { t: "token.update", tokenId: "dmt0", patch: { name: "Hobgoblin" } } as Op), "taken", "an edit");
    assert.equal(await answer(r, "dm", { t: "token.move", tokenId: "dmt1", x: 10, y: 10 } as Op), "taken", "a move");
    const goblin = { t: "token.create", token: { id: mint.next(r), sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 3, y: 3, actor: { inline: actor() } } } as Op;
    assert.deepEqual(await answer(r, "dm", goblin), { code: "quota", message: `this scene can hold at most ${LIMITS.tokensPerScene} tokens` }, "a create past the cap");
    assert.equal(await answer(r, "dm", { t: "token.delete", tokenId: "dmt2" }), "taken", "a delete");
    assert.equal(await answer(r, "dm", goblin), "taken", "a create once there is room");
  });
});
