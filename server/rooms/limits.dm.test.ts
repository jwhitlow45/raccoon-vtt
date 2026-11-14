import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { FAR, LIMITS, NO_ROOM_TO_EXPLORE, roundUp, SEAT } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { MOVE_PLAYERS_FIRST } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { idAt, seated, type Seated } from "#shared/privTestutil.ts";
import { actor, castAsk, drawing, entry, member, rng, room, scene, template, token } from "#shared/testutil.ts";
import { fullRoom } from "./limitsTesting.ts";
import { answer, joinOp, Mint, type Answer } from "./limitsTwinTesting.ts";
import { Room } from "./numberingTesting.ts";
import { PER_PLAYER_FULL } from "./sizeGuard.ts";
import { ScopeClient, StoredRoomDb, storedActor } from "./undoScopeTesting.ts";

/**
 * The DM's side of the player limits: the room caps count only what no
 * player's seat holds, a cap refuses the DM only an op that adds to its
 * total, and deletions and ops that add nothing are never refused, at
 * the caps, at the byte lines and at the far line.
 */

const mint = new Mint();
const PLAYERS = 48;

async function opened(t: TestContext, state: RoomState, name = "R", options = {}): Promise<Room> {
  const r = new Room(t, name, state, { idGate: true, ...options });
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

/** A room with the DM's rest and, when `players` is more than 0, that many players with full seats on s1. */
function dmRoom(rest: Rest, players: number): { state: RoomState; seats: Seated | null } {
  const state = room();
  for (let p = 3; p <= PLAYERS; p++) state.members[`p${p}`] = member(`p${p}`);
  state.members.dm2 = member("dm2", "dm");
  const seats = players > 0 ? seated(state, players) : null;
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
  test("D1: with 48 players' seats full on the scene, the DM's creates, edits, deletes, undo, clear and duplicate answer as in the room without them", async (t) => {
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

/*
 * D9: a room past the far line, by its companion blocks, and the same
 * room at the line. Bookkeeping and deletions are taken in both, and
 * every op that adds things or text is refused in both, a player's and
 * the DM's alike.
 */
describe("a room past the far line goes on with play", () => {
  test("D9: past the line and at it, moves, turns, HP, life, conditions, an AC edit, rolls, talk, an undo and a group delete are taken, and creates, notes and block saves refused", async (t) => {
    const results: Array<Array<[string, string]>> = [];
    for (const roomBytes of [FAR.roomBytes + 1024 * 1024, FAR.roomBytes]) {
      const full = fullRoom({ roomBytes });
      const clock = { now: Date.parse("2026-11-10T20:00:00.000Z") };
      const { actor: r } = await storedActor(t, new StoredRoomDb(full.state), { idGate: true, now: () => clock.now });
      const dmId = full.dms[0]!;
      const playerId = full.players[0]!;
      const dm = await ScopeClient.open(r, full.state.members[dmId]!, "dm");
      const player = await ScopeClient.open(r, full.state.members[playerId]!, "player");
      const character = Object.values(full.state.characters).find((c) => c.ownerIds.includes(playerId))!;
      const own = Object.values(full.state.tokens).find((x) => "ref" in x.actor && x.actor.ref === character.id)!;
      const creatures = Object.values(full.state.tokens).filter((x) => "inline" in x.actor && x.visibility === "all").map((x) => x.id);
      const block = Object.values(full.state.companionBlocks)[0]!;
      const ids = rng(9_009);
      const mint = () => idAt(ids, clock.now);
      const steps: Array<[string, "dm" | "player", () => Op, "taken" | "refused"]> = [
        ["a move", "player", () => ({ t: "token.move", tokenId: own.id, x: own.x, y: own.y + 1 }) as Op, "taken"],
        ["the move's undo", "player", () => ({ t: "undo", scope: "play", head: player.head("play", "undo").id }) as Op, "taken"],
        ["Next", "dm", () => ({ t: "encounter.next" }) as Op, "taken"],
        ["Previous", "dm", () => ({ t: "encounter.prev" }) as Op, "taken"],
        ["HP", "dm", () => ({ t: "actor.hp", target: { tokenId: creatures[0]! }, change: { kind: "damage", amount: 3 } }) as Op, "taken"],
        ["bulk damage", "dm", () => ({ t: "actor.damageMany", hits: creatures.slice(1, 4).map((id) => ({ target: { tokenId: id }, amount: 2 })) }) as Op, "taken"],
        ["down to 0", "dm", () => ({ t: "actor.hp", target: { characterId: character.id }, change: { kind: "damage", amount: character.actor.hp.cur } }) as Op, "taken"],
        ["a death save", "player", () => ({ t: "actor.deathSave", target: { characterId: character.id }, ok: 1, fail: 0 }) as Op, "taken"],
        ["a Revive", "dm", () => ({ t: "actor.life", target: { characterId: character.id }, life: "alive" }) as Op, "taken"],
        ["a condition", "dm", () => ({ t: "actor.effect.add", target: { tokenId: creatures[4]! }, effect: { id: mint(), key: "prone" } }) as Op, "taken"],
        ["an AC edit", "player", () => ({ t: "character.update", characterId: character.id, patch: { actor: { ac: 17 } } }) as Op, "taken"],
        ["a roll", "player", () => ({ t: "dice.roll", tag: mint(), to: "all", rolls: [{ formula: "1d20+5", label: "Check" }] }) as Op, "taken"],
        ["a chat line", "player", () => ({ t: "log.chat", text: "Onward" }), "taken"],
        ["a whisper", "player", () => ({ t: "log.whisper", to: [dmId], text: "A secret" }) as Op, "taken"],
        ["a group delete", "dm", () => ({ t: "token.deleteMany", tokenIds: creatures.slice(5, 7) }) as Op, "taken"],
        ["a create", "dm", () => ({ t: "token.create", token: { id: mint(), sceneId: full.sceneId, kind: "monster", name: "Goblin", size: "medium", x: 1, y: 1, actor: { inline: actor() } } }) as Op, "refused"],
        ["a creature's notes", "dm", () => ({ t: "token.update", tokenId: creatures[8]!, patch: { notes: "A long note" } }) as Op, "refused"],
        ["a character's notes", "player", () => ({ t: "character.update", characterId: character.id, patch: { actor: { notes: "A long note" } } }) as Op, "refused"],
        ["a stat block update", "dm", () => ({ t: "companionBlock.update", blockId: block.id, patch: { name: "Moth" } }) as Op, "refused"],
      ];
      const got: Array<[string, string]> = [];
      for (const [what, who, op, expected] of steps) {
        clock.now += 1_000;
        const client = who === "dm" ? dm : player;
        const event = await client.send(op());
        const refusal = event.rejects?.find((x) => x.n === client.n);
        const kind = refusal === undefined ? "taken" : refusal.code === "quota" ? "refused" : `${refusal.code}: ${refusal.message}`;
        got.push([what, kind]);
        assert.equal(kind, expected, `${roomBytes > FAR.roomBytes ? "past the line" : "at the line"}: ${what}`);
      }
      results.push(got);
    }
    assert.deepEqual(results[0], results[1], "past the line and at it answer alike");
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

  test("D11: a scene change in a room at its near line answers as today, its reserve refusal included, and a move back to the played scene is taken", async (t) => {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "bright" } };
    state.scenes.s2 = { ...state.scenes.s2!, fogEnabled: true, vision: { on: true, light: "bright" }, bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells } };
    state.playedScenes = { s1: { sceneId: "s1", rev: 0 } };
    for (let i = 0; i < 60; i++) state.tokens[`dmt${i}`] = token(`dmt${i}`, { name: "Goblin", visibility: "dm", notes: "x".repeat(4_000) });
    const r = await opened(t, state, "R", { sizeLimits: { stateLimit: 400_000 } });
    assert.deepEqual(await answer(r, "dm", { t: "room.setPlayerScene", sceneId: "s2" }), { code: "quota", message: NO_ROOM_TO_EXPLORE });
    assert.equal(await answer(r, "dm", { t: "room.setPlayerScene", sceneId: "s1" }), "taken");
  });
});
