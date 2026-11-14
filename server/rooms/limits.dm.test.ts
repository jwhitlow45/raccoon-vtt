import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { FAR, LIMITS, roundUp, SEAT } from "#shared/limits.ts";
import type { RoomState } from "#shared/model.ts";
import { MOVE_PLAYERS_FIRST } from "#shared/permissions.ts";
import type { Op } from "#shared/protocol.ts";
import { seated, type Seated } from "#shared/privTestutil.ts";
import { actor, castAsk, drawing, entry, member, room, scene, template, token } from "#shared/testutil.ts";
import { answer, Mint, type Answer } from "./limitsTwinTesting.ts";
import { Room } from "./numberingTesting.ts";

/**
 * The DM's side of the player limits: the room caps count only what no
 * player's seat holds, a cap refuses the DM only an op that adds to its
 * total, and deletions and ops that add nothing are never refused, at
 * the caps, at the byte lines and at the far line.
 */

const mint = new Mint();
const PLAYERS = 48;

async function opened(t: TestContext, state: RoomState, name = "R", options = {}): Promise<Room> {
  const r = new Room(t, name, state, options);
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
        await r.actor.sys({ t: "sys.memberJoin", member: { ...member(mint.next(r)), name: "Wren" } });
        await r.settle();
        assert.equal(r.state.members.p48, undefined, `${what}: the member is removed`);
        assert.equal(Object.values(r.state.members).some((m) => m.name === "Wren"), true, `${what}: the join is taken`);
      });
    }
  });
});

describe("the players' scene can be deleted with the DM's yes", () => {
  test("D13: deleting the players' scene is refused without the confirm, taken with it leaving them on no scene, and its undo puts them back, across restarts", async (t) => {
    const r = await opened(t, room());
    assert.deepEqual(await answer(r, "dm", { t: "scene.delete", sceneId: "s1" } as Op), { code: "invalid", message: MOVE_PLAYERS_FIRST });
    await r.restart(false);
    assert.equal(await answer(r, "dm", { t: "scene.delete", sceneId: "s1", leavePlayers: true } as Op), "taken");
    assert.equal(r.state.meta.playerSceneId, null, "the players are on no scene");
    assert.equal(r.state.scenes.s1, undefined, "the scene is gone");
    await r.restart(false);
    assert.equal(r.state.meta.playerSceneId, null, "still on no scene after a restart");
    assert.equal(await undoAnswer(r), "taken");
    assert.ok(r.state.scenes.s1, "the undo brings the scene back");
    assert.equal(r.state.meta.playerSceneId, "s1", "and the players with it");
    await r.restart(false);
    assert.equal(r.state.meta.playerSceneId, "s1", "after a restart too");
  });
});
