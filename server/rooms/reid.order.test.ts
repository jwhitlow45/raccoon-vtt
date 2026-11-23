import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { LogEntry, RoomState, Token, TrapDue } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { actor, member, room, scene, token, trap } from "#shared/testutil.ts";
import { ReidPlan, renamedState } from "./reid.ts";
import { storedActor, StoredRoomDb } from "./undoScopeTesting.ts";

/**
 * Twin rooms apart only in when the DM made two creatures that no player
 * holds: after the first load gives them new ids (reid.ts), the lists the
 * reducer keeps in id order are in the order of those ids, so what players
 * read once the DM shows the creatures and settles a trap or a fall is the
 * same in both. The two share the DM's name, so a group save's rows keep
 * the list's order (client/features/dice/groupSave/rows.ts groupRows), and
 * their public names tell their lines apart. Each twin gives each thing the
 * same new id, the Thug's before the Bandit's, so only the order the old
 * ids left could set them apart.
 */

const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
const AT = "2026-10-01T13:00:00.000Z";
const DUE = "5:0";
const FALL = "8:0";

type Ids = { bandit: string; thug: string; pc: string; mat: string };
type Twin = { state: RoomState; dm: ReturnType<typeof member>; p1: ReturnType<typeof member>; trapId: string; ids: Ids };

const sorted = (...ids: string[]) => [...ids].sort();

/** The room, with the Bandit made before the Thug or after it, a trap whose occurrence is `due`, and maybe a fall card. */
function twin(banditFirst: boolean, due: (ids: Ids) => TrapDue, withFall = false): Twin {
  const dm = member(uuidv7(T0), "dm");
  const p1 = member(uuidv7(T0 + 1));
  const ids: Ids = {
    mat: uuidv7(T0 + 2),
    bandit: uuidv7(T0 + (banditFirst ? 10 : 20) * MINUTE),
    thug: uuidv7(T0 + (banditFirst ? 20 : 10) * MINUTE),
    pc: uuidv7(T0 + 30 * MINUTE),
  };
  const trapId = uuidv7(T0 + 40 * MINUTE);
  const s = room({ members: { [dm.id]: dm, [p1.id]: p1 }, scenes: { [ids.mat]: scene(ids.mat, { name: "Battle mat" }) }, playedScenes: { [ids.mat]: { sceneId: ids.mat, rev: 0 } } });
  s.meta.playerSceneId = ids.mat;
  const goblin = (id: string, publicName: string, x: number): Token =>
    token(id, { sceneId: ids.mat, kind: "monster", name: "Goblin", nameHidden: true, publicName, visibility: "dm", x, y: 2, actor: { inline: actor({ hp: { cur: 20, max: 20, temp: 0 } }) } });
  s.tokens = {
    [ids.bandit]: goblin(ids.bandit, "Bandit", 4),
    [ids.thug]: goblin(ids.thug, "Thug", 6),
    [ids.pc]: token(ids.pc, { sceneId: ids.mat, kind: "pc", name: "Ayla", ownerIds: [p1.id], x: 1, y: 1 }),
  };
  const base = trap(trapId);
  s.traps = { [trapId]: { ...base, name: "Spike Pit", sceneId: ids.mat, rig: { ...base.rig!, message: "Spikes shoot up.", damage: [{ formula: "2d6", type: "piercing" }], due: [due(ids)] } } };
  if (withFall) s.falls = { [FALL]: { id: FALL, rev: 0, tokenId: ids.pc, riders: sorted(ids.bandit, ids.thug), sceneId: ids.mat, from: ids.mat, ft: 10, made: 8 } };
  return { state: s, dm, p1, trapId, ids };
}

/** The new id each renamed thing takes in both twins: the Thug's sorts before the Bandit's. */
const NEW: Record<string, string> = {
  thug: "10000000-0000-8000-8000-000000000001",
  bandit: "f0000000-0000-8000-8000-000000000002",
  trap: "50000000-0000-8000-8000-000000000003",
};

/** The room given its new ids as its first load does (ReidPlan, renamedState), stored and loaded at today's version, both goblins shown, with the DM's socket. */
async function loaded(t: TestContext, w: Twin) {
  const label = new Map([[w.ids.bandit, "bandit"], [w.ids.thug, "thug"], [w.trapId, "trap"]]);
  const renames = new Map([...new ReidPlan(w.state).renames(() => "").keys()].map((old) => [old, NEW[label.get(old)!]!] as const));
  assert.deepEqual([...renames.keys()].sort(), [...label.keys()].sort(), "the goblins and the trap, which no player holds");
  const db = new StoredRoomDb(renamedState(w.state, renames), { version: SNAPSHOT_VERSION, seq: 9 });
  const h = await storedActor(t, db, { idGate: false });
  const dm = await h.connect(w.dm);
  for (const id of [NEW.bandit!, NEW.thug!]) assert.equal((await dm.apply({ t: "token.update", tokenId: id, patch: { visibility: "all" } })).rejects, undefined);
  return { h, dm, trapId: NEW.trap! };
}

/** What P1 reads in their log and trap log, each creature by the name P1 reads. */
function p1Reads(state: RoomState, p1: string): string[] {
  const copy = projectState(state, { memberId: p1, role: "player" }, { sceneId: null });
  const name = (id: string) => copy.tokens[id]?.publicName ?? copy.tokens[id]?.name ?? "?";
  const line = (e: LogEntry): string[] => {
    const d = e.data;
    if (d?.type === "hp" && d.tokenId) return [`hp ${name(d.tokenId)}`];
    if (d?.type === "trapSeen") return [`trap ${d.by.map(name).join(", ")}`];
    return [];
  };
  return [...copy.log, ...copy.trapSeen].flatMap(line);
}

describe("lists kept in id order after the first load's new ids (reid.ts inIdOrderAgain)", () => {
  test("a trap's creatures it hits: the Apply's HP lines read the same whichever goblin the DM made first", async (t) => {
    const reads: string[][] = [];
    for (const banditFirst of [true, false]) {
      const w = twin(banditFirst, (ids) => ({ id: DUE, at: AT, how: "enter", by: [], hits: sorted(ids.bandit, ids.thug), acted: true }));
      const { h, dm, trapId } = await loaded(t, w);
      const hits = h.actor.committed.state.traps[trapId]!.rig!.due![0]!.hits;
      assert.deepEqual(hits, [NEW.thug, NEW.bandit], "in the order of the new ids");
      // The DM's rows keep this order, the names tying, so the outcome's targets do too.
      const ev = await dm.apply({ t: "actor.outcome", plan: uuidv7(), trap: { trapId, due: DUE }, targets: hits.map((id) => ({ target: { tokenId: id }, amount: 3 })) });
      assert.equal(ev.rejects, undefined);
      reads.push(p1Reads(h.actor.committed.state, w.p1.id));
    }
    assert.equal(reads[0]!.filter((r) => r.startsWith("hp ")).length, 2, "both HP lines reach P1");
    assert.deepEqual(reads[0], reads[1]);
  });

  test("who set a trap off: Do its effects names them to players the same whichever the DM made first", async (t) => {
    const reads: string[][] = [];
    for (const banditFirst of [true, false]) {
      const w = twin(banditFirst, (ids) => ({ id: DUE, at: AT, how: "enter", by: sorted(ids.bandit, ids.thug), hits: [], hidden: true }));
      const { h, dm, trapId } = await loaded(t, w);
      const by = h.actor.committed.state.traps[trapId]!.rig!.due![0]!.by;
      assert.deepEqual(by, [NEW.thug, NEW.bandit], "neither was seen or is a player's: in the order of the new ids");
      assert.equal((await dm.apply({ t: "trap.act", trapId, due: DUE })).rejects, undefined);
      reads.push(p1Reads(h.actor.committed.state, w.p1.id));
    }
    assert.equal(reads[0]!.filter((r) => r.startsWith("trap ")).length, 1, "the players' trap line reaches P1");
    assert.deepEqual(reads[0], reads[1]);
  });

  test("a fall card's riders: their HP lines read the same whichever the DM made first", async (t) => {
    const reads: string[][] = [];
    for (const banditFirst of [true, false]) {
      const w = twin(banditFirst, () => ({ id: DUE, at: AT, how: "enter", by: [], hits: [], acted: true }), true);
      const { h, dm } = await loaded(t, w);
      const card = h.actor.committed.state.falls![FALL]!;
      assert.deepEqual(card.riders, [NEW.thug, NEW.bandit], "in the order of the new ids");
      // The rows read the card's creature, then its riders, Ayla before the Goblins by name.
      const ev = await dm.apply({ t: "actor.outcome", plan: uuidv7(), fall: { fallId: FALL, tokenIds: [card.tokenId, ...card.riders!] }, targets: card.riders!.map((id) => ({ target: { tokenId: id }, amount: 3 })) });
      assert.equal(ev.rejects, undefined);
      reads.push(p1Reads(h.actor.committed.state, w.p1.id));
    }
    assert.equal(reads[0]!.filter((r) => r.startsWith("hp ")).length, 2, "both HP lines reach P1");
    assert.deepEqual(reads[0], reads[1]);
  });

  test("who set it off keeps first those the DM's trap line marks seen and those players own, each part in the order of the ids now", () => {
    const w = twin(true, (ids) => ({ id: DUE, at: AT, how: "enter", by: sorted(ids.bandit, ids.thug, ids.pc), hits: [], hidden: true }));
    const { bandit, thug, pc } = w.ids;
    const by = sorted(bandit, thug, pc);
    w.state.trapLog = [{ id: DUE, at: AT, kind: "event", data: { type: "trap", trapId: w.trapId, sceneId: w.ids.mat, name: "Spike Pit", how: "enter", by, hits: 0, did: [], seen: [by.indexOf(thug)], hidden: true } }];
    // New ids that put the Thug last, after the Bandit, though the DM's line marks only the Thug seen.
    const renames = new Map([
      [bandit, "00000000-0000-8000-8000-000000000001"],
      [thug, "ffffffff-ffff-8fff-bfff-ffffffffffff"],
    ]);
    const out = renamedState(w.state, renames).traps[w.trapId]!.rig!.due![0]!.by;
    assert.deepEqual(out, [...sorted(pc, renames.get(thug)!), renames.get(bandit)!]);
    // A list that holds no new id stays as it was.
    const kept = renamedState(w.state, new Map([[w.ids.mat, "00000000-0000-8000-8000-0000000000aa"]])).traps[w.trapId]!.rig!.due![0]!.by;
    assert.deepEqual(kept, by);
  });
});
