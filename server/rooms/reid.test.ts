import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSealedShape, isUuidv7, sealedTime, uuidv7 } from "#shared/ids.ts";
import { SEALED_IDS_SNAPSHOT_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { projectArchivedLog, projectState } from "#shared/project.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { hash12 } from "#shared/rules/pcSync.ts";
import { actor, character, drawing, member, room, scene, template, token } from "#shared/testutil.ts";
import { DEVELOPMENT_ROOM_SECRET_KEY } from "../config.ts";
import { RoomIdKeys } from "./idKeys.ts";
import { loadRoom } from "./persistence.ts";
import { ReidPlan, reidDue, renamedState, renamedText, v7IdsIn, type ArchivedLine } from "./reid.ts";
import { parseRoomState } from "./stateSchema.ts";
import { storedActor, StoredRoomDb } from "./undoScopeTesting.ts";

/**
 * A room stored below SEALED_IDS_SNAPSHOT_VERSION gives its version 7 ids
 * anew at its first load on this build, all but those some player can
 * name (reid.ts). Each case reads what a player reads before and after,
 * byte for byte.
 */

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
let clock = T0 + 10 * MINUTE;
/** A version 7 id made a minute after the one before, as a DM's ghoul goes. */
const made = () => uuidv7((clock += MINUTE));

const ROLL = (id: string) => ({ id, name: "Scimitar", kind: "weapon" as const, ability: "dex" as const, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6" }] });

/** An old room: things players hold, things only the DM holds, and records and lines that name some of the latter. */
function oldRoom() {
  const dm = member(uuidv7(T0), "dm");
  const p1 = member(uuidv7(T0 + MINUTE));
  const p2 = member(uuidv7(T0 + 2 * MINUTE));
  // The first scene, made with the room's first member (shared/initial.ts).
  const mat = uuidv7(T0 + 3);
  const cave = made();
  const crypt = made();
  const ids = {
    dm: dm.id,
    p1: p1.id,
    p2: p2.id,
    mat,
    cave,
    crypt,
    seen: made(),
    dmGoblin: made(),
    met: made(),
    ghoul: made(),
    pc: made(),
    hero: made(),
    heroRoll: made(),
    npc: made(),
    npcRoll: made(),
    npcRes: made(),
    remembered: made(),
    cryptStamp: made(),
    sketch: made(),
    area: made(),
    whispered: made(),
    dmLine: made(),
    tag: made(),
    plan: made(),
    page: made(),
    ask: made(),
  };
  const s = room({
    members: { [dm.id]: dm, [p1.id]: p1, [p2.id]: p2 },
    scenes: {
      [mat]: scene(mat, { name: "Battle mat" }),
      [cave]: scene(cave, { name: "Cave", order: 1 }),
      [crypt]: scene(crypt, { name: "Crypt", order: 2, fogEnabled: true }),
    },
    playedScenes: { [mat]: { sceneId: mat, rev: 0 }, [cave]: { sceneId: cave, rev: 0 } },
    numbering: { rev: 0, groups: 1 },
  });
  s.meta.playerSceneId = mat;
  s.tokens = {
    [ids.seen]: token(ids.seen, { sceneId: mat, name: "Goblin" }),
    [ids.dmGoblin]: token(ids.dmGoblin, { sceneId: mat, name: "Goblin", visibility: "dm" }),
    [ids.met]: token(ids.met, { sceneId: mat, name: "Goblin", visibility: "dm", met: 1 }),
    [ids.ghoul]: token(ids.ghoul, { sceneId: crypt, name: "Ghoul" }),
    [ids.pc]: token(ids.pc, { sceneId: mat, kind: "pc", name: "Ayla", ownerIds: [p1.id], actor: { ref: ids.hero } }),
  };
  s.characters = {
    [ids.hero]: character(ids.hero, { name: "Ayla", ownerIds: [p1.id], stats: { ...structuredClone(EMPTY_PC_STATS), rolls: [ROLL(ids.heroRoll)] } as never }),
    [ids.npc]: character(ids.npc, {
      name: "Captain",
      ownerIds: [],
      actor: actor(),
      stats: { ...structuredClone(EMPTY_PC_STATS), rolls: [ROLL(ids.npcRoll)] } as never,
      resources: [{ id: ids.npcRes, name: "Rage", max: 2, used: 0, reset: "long" }],
      ddbSync: { at: "2026-10-01T12:30:00.000Z", base: { level: 3 }, rolls: { [hash12(ids.npcRoll)]: { k: "w:000000000001", h: "000000000002" } }, res: { [hash12(ids.npcRes)]: { k: "r:000000000003", h: "000000000004" } } } as never,
    }),
  };
  const stamp = (id: string, sceneId: string) => ({ id, rev: 0, sceneId, art: { key: "barrel" }, x: 2, y: 2, w: 1, h: 1, rotation: 0, z: 0, visibility: "all" as const });
  s.stamps = { [ids.remembered]: stamp(ids.remembered, cave) as never, [ids.cryptStamp]: stamp(ids.cryptStamp, crypt) as never };
  // The party remembers the cave's barrel, which no player holds now that they left the cave.
  s.memory = { [`${cave}:0,0`]: { sceneId: cave, cx: 0, cy: 0, rev: 0, stamps: { [ids.remembered]: stamp(ids.remembered, cave) } } as never };
  s.drawings = { [ids.sketch]: drawing(ids.sketch, { sceneId: mat, ownerId: dm.id, visibility: "dm" }) };
  s.templates = { [ids.area]: template(ids.area, { sceneId: mat, ownerId: dm.id, visibility: "dm" }) };
  s.saveOutcomes = { [ids.page]: { memberId: dm.id, plan: ids.plan, revision: 1, state: "applied", firstAppliedAt: "2026-10-01T12:40:00.000Z", seq: 3 } };
  return { state: s, ids };
}

const at = "2026-10-01T13:00:00.000Z";
/** The archive: P1's whisper naming a thing, a DM line naming another, and P1's roll with its tag. */
function archive(ids: ReturnType<typeof oldRoom>["ids"]): ArchivedLine[] {
  const lines: LogEntry[] = [
    { id: "4:0", at, kind: "whisper", from: ids.p1, to: [ids.dm], text: `Is ${ids.whispered} still in the crypt?` },
    { id: "5:900000", at, kind: "event", data: { type: "teleport", tokenId: ids.dmLine, past: "wall" } },
    { id: "6:0", at, kind: "event", data: { type: "dice", tag: ids.tag, part: 0, by: ids.p1, to: "all", rolls: [] } },
    { id: "7:900000", at, kind: "event", data: { type: "teleport", tokenId: ids.dmGoblin, past: "wall" } },
  ];
  return lines.map((entry) => ({ entry, complete: true }));
}

const viewers = (s: RoomState): Viewer[] => [
  ...Object.values(s.members).flatMap((m) => (m.kind === "player" ? [{ memberId: m.id, role: "player" as const }] : [])),
  { memberId: "display:000000000000", role: "player" },
];
/** What each player and the display reads: their copy, and their log page of the archive. */
function read(s: RoomState, lines: readonly LogEntry[]): string[] {
  return viewers(s).flatMap((v) => [JSON.stringify(projectState(s, v, { sceneId: null })), JSON.stringify(projectArchivedLog(s, lines, v, { sceneId: null }))]);
}

const KEY = new RoomIdKeys(DEVELOPMENT_ROOM_SECRET_KEY, "UNDOSCOPE").server.key;
const plan = (s: RoomState, lines: readonly ArchivedLine[]) => {
  const p = new ReidPlan(s);
  p.addLines(lines);
  return p;
};

describe("the first load's new ids (reid.ts)", () => {
  test("C28, C30: what a player holds, a record shows or a line a player reads keeps its id, and every other version 7 id is renamed", () => {
    const { state, ids } = oldRoom();
    const lines = archive(ids);
    const renames = plan(state, lines).renames(() => "x");
    // Every player reads the party's characters by name, so the captain keeps its id, but not its rolls and resources.
    const kept = ["dm", "p1", "p2", "mat", "cave", "seen", "met", "pc", "hero", "heroRoll", "npc", "remembered", "whispered", "tag", "plan", "page"] as const;
    const renamed = ["crypt", "dmGoblin", "ghoul", "npcRoll", "npcRes", "cryptStamp", "sketch", "area", "dmLine"] as const;
    assert.deepEqual([...renames.keys()].sort(), renamed.map((k) => ids[k]).sort());
    for (const k of kept) assert.equal(renames.has(ids[k]), false, `${k} keeps its id`);
    // The ask's id is in no state or line here, so nothing names it to rename.
    assert.equal(renames.has(ids.ask), false);
  });

  test("C28, C29: every player's and the display's copy and log page are byte-equal after, the state parses, and no renamed id is left anywhere", () => {
    const { state, ids } = oldRoom();
    const lines = archive(ids);
    assert.ok(parseRoomState(state).ok, "the old room parses");
    const renames = plan(state, lines).renames(() => uuidv7());
    const after = renamedState(state, renames);
    const rewritten = lines.map((l) => JSON.parse(renamedText(JSON.stringify(l.entry), renames)) as LogEntry);
    assert.deepEqual(read(after, rewritten), read(state, lines.map((l) => l.entry)));
    const parsed = parseRoomState(after);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const text = JSON.stringify([after, rewritten]);
    for (const id of renames.keys()) assert.ok(!text.includes(id), `${id} is gone`);
    for (const id of renames.values()) assert.ok(text.includes(id));
    const dmLine = rewritten[1]!.data;
    assert.equal(dmLine?.type === "teleport" && dmLine.tokenId, renames.get(ids.dmLine), "the DM's line names the new id");
  });

  test("C29: a sync record follows its rolls' and resources' new ids", () => {
    const { state, ids } = oldRoom();
    const renames = plan(state, []).renames(() => uuidv7());
    const npc = renamedState(state, renames).characters[ids.npc]!;
    assert.deepEqual(Object.keys(npc.ddbSync!.rolls ?? {}), [hash12(renames.get(ids.npcRoll)!)]);
    assert.deepEqual(Object.keys(npc.ddbSync!.res ?? {}), [hash12(renames.get(ids.npcRes)!)]);
    assert.deepEqual(npc.stats!.rolls.map((r) => r.id), [renames.get(ids.npcRoll)]);
  });

  test("C29: a history step's walks are sorted by their creatures' new ids", () => {
    const { state, ids } = oldRoom();
    const walk = (tokenId: string) => ({ tokenId, sceneId: ids.mat, x: 1, y: 1, elevation: 0, path: { turn: 1, stops: [] } });
    state.encounterHistory = [{ encounter: { rev: 0, round: 1, activeEntryId: null, entries: [] }, effects: {}, revealed: [], walks: [walk(ids.seen), walk(ids.dmGoblin), walk(ids.ghoul)], at } as never];
    // The renamed ids sort before and after the kept one, so the old order cannot stand.
    const renames = new Map([[ids.dmGoblin, "00000000-0000-8000-8000-000000000000"], [ids.ghoul, "ffffffff-ffff-8fff-bfff-ffffffffffff"]]);
    const walks = renamedState(state, renames).encounterHistory[0]!.walks!.map((w) => w.tokenId);
    assert.deepEqual(walks, [renames.get(ids.dmGoblin), ids.seen, renames.get(ids.ghoul)]);
  });

  test("a renamed id is written inside longer strings too, keys included, and maps keep their order", () => {
    const { state, ids } = oldRoom();
    state.memoryBy = { [`${ids.crypt}:${ids.p1}:0,0`]: { sceneId: ids.crypt, memberId: ids.p1, cx: 0, cy: 0, rev: 0 } as never };
    const renames = new Map([[ids.crypt, "0190f0a8-0000-8000-8000-000000000001"]]);
    const after = renamedState(state, renames);
    assert.deepEqual(Object.keys(after.memoryBy ?? {}), [`0190f0a8-0000-8000-8000-000000000001:${ids.p1}:0,0`]);
    assert.deepEqual(Object.keys(after.scenes), [ids.mat, ids.cave, "0190f0a8-0000-8000-8000-000000000001"]);
    assert.equal(renamedState(state, new Map()), state, "nothing renamed is the state itself");
  });

  test("a line counts for the players who read it: a party copy for its reader alone, a DM line for none, and a row without its access rows as every player reads it", () => {
    const { state, ids } = oldRoom();
    // A member line names its member to every reader it reaches.
    const line = (id: string, lineId: string, complete: boolean, to?: string): ArchivedLine => ({ entry: { id: lineId, at, kind: "event", ...(to ? { to: [to] } : {}), data: { type: "member", memberId: id, action: "join" } }, complete });
    const p = new ReidPlan(state);
    const found = p.addLines([line(ids.dmGoblin, "8:1", true, ids.p1), line(ids.ghoul, "8:2", true, "gone-member"), line(ids.sketch, "8:900001", true), line(ids.area, "8:3", false)]);
    assert.deepEqual(found, [[ids.p1, ids.dmGoblin], [ids.ghoul], [ids.sketch], [ids.area]]);
    assert.equal(p.keeps(ids.dmGoblin), true, "P1's own copy of the line");
    assert.equal(p.keeps(ids.ghoul), false, "a copy for no player now");
    assert.equal(p.keeps(ids.sketch), false, "a DM line");
    assert.equal(p.keeps(ids.area), true, "a shared line from an older server, without its access rows");
  });

  test("the room's first scene, made with its first member, keeps its id unplayed, as does any id another table names as a member's", () => {
    const { state, ids } = oldRoom();
    state.playedScenes = { [ids.cave]: { sceneId: ids.cave, rev: 0 } };
    state.meta.playerSceneId = ids.cave;
    // A scene the DM made two seconds after the room, which no player has seen.
    const later = uuidv7(T0 + 2_000);
    state.scenes[later] = scene(later, { order: 3 });
    const former = uuidv7(T0 + 30 * MINUTE);
    const p = new ReidPlan(state, [former]);
    p.addLines([{ entry: { id: "9:900000", at, kind: "event", data: { type: "member", memberId: former, action: "remove" } }, complete: true }]);
    assert.equal(p.keeps(ids.mat), true, "the first scene");
    assert.equal(p.keeps(later), false);
    assert.equal(p.keeps(former), true, "a former member another table names");
  });

  test("only a whole replay below the format gives ids anew", () => {
    assert.equal(reidDue({ replayFailed: false, snapshotVersion: SEALED_IDS_SNAPSHOT_VERSION - 1 }), true);
    assert.equal(reidDue({ replayFailed: true, snapshotVersion: SEALED_IDS_SNAPSHOT_VERSION - 1 }), false);
    assert.equal(reidDue({ replayFailed: false, snapshotVersion: SEALED_IDS_SNAPSHOT_VERSION }), false);
    assert.deepEqual([...v7IdsIn(`a ${uuidv7(T0).toUpperCase()}b`)].map((id) => isUuidv7(id)), [true], "either case, inside text");
  });
});

describe("the first load on this build", () => {
  test("C28, C29: renames, seals under the server's key, stores the room at today's version with its count once, and replays from it equal; ops and undo on a renamed thing work", async (t) => {
    const { state, ids } = oldRoom();
    const db = new StoredRoomDb(state, { version: SEALED_IDS_SNAPSHOT_VERSION - 1, seq: 9 });
    const before = (await loadRoom(db.pool(), "UNDOSCOPE"))!;
    const h = await storedActor(t, db, { idGate: false });
    const after = h.actor.committed.state;
    assert.deepEqual(read(after, []), read(before.state, []), "every player's copy, byte for byte");
    assert.equal(after.tokens[ids.dmGoblin], undefined);
    const fresh = Object.keys(after.tokens).filter((id) => state.tokens[id] === undefined);
    assert.equal(fresh.length, 2, "the DM's Goblin and the crypt's Ghoul");
    for (const id of fresh) {
      assert.ok(isSealedShape(id), `${id} is version 8`);
      assert.notEqual(sealedTime(KEY, id), null, "sealed under the server's key");
    }
    assert.equal(db.snapshotWrites, 1);
    assert.deepEqual([db.snapshot.version, db.snapshot.seq, db.pub], [SNAPSHOT_VERSION, 9, 9]);
    assert.deepEqual(db.snapshot.state, after, "the stored snapshot is the renamed room");

    // The DM moves the renamed Goblin and takes it back.
    const dm = await h.connect(state.members[ids.dm]!);
    const goblin = fresh.find((id) => after.tokens[id]!.sceneId === ids.mat)!;
    const moved = await dm.apply({ t: "token.update", tokenId: goblin, patch: { x: 9 } });
    assert.equal(moved.rejects, undefined);
    assert.equal(h.actor.committed.state.tokens[goblin]!.x, 9);
    assert.equal((await dm.restore()).rejects, undefined);
    assert.equal(h.actor.committed.state.tokens[goblin]!.x, 3);
    assert.equal(db.snapshotWrites, 1, "no commit carries another snapshot");

    // Loaded again from that snapshot, nothing is renamed again.
    await h.actor.shutdown({ code: 1012, snapshot: false });
    const again = await storedActor(t, db, { idGate: false });
    assert.deepEqual(Object.keys(again.actor.committed.state.tokens).sort(), Object.keys(h.actor.committed.state.tokens).sort());
    assert.deepEqual(again.actor.committed.state.tokens[goblin], h.actor.committed.state.tokens[goblin]);
  });

  test("C31: a room whose replay fails renames nothing and stores nothing", async (t) => {
    const { state, ids } = oldRoom();
    const db = new StoredRoomDb(state, { version: SEALED_IDS_SNAPSHOT_VERSION - 1, seq: 9, rows: [{ seq: 10, at, actorMemberId: ids.dm, actorRole: "dm", op: { t: "token.update", tokenId: "nothing-here", patch: { x: 1 } }, opVersion: 65, pub: 10 }] });
    const h = await storedActor(t, db, { idGate: false });
    assert.equal(h.actor.replayFailed, true);
    assert.deepEqual(Object.keys(h.actor.committed.state.tokens).sort(), Object.keys(state.tokens).sort());
    assert.deepEqual([db.snapshotWrites, db.snapshot.version], [0, SEALED_IDS_SNAPSHOT_VERSION - 1]);
  });
});
