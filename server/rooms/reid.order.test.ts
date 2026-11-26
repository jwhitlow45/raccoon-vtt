import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import { FALL_RIDERS_MOST, type LogEntry, type RoomState, type Token, type TrapDue, type TrapRig, type Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
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
      const ev = await dm.apply({ t: "actor.outcome", plan: uuidv7(), trap: { trapId, due: DUE, tokenIds: hits }, targets: hits.map((id) => ({ target: { tokenId: id }, amount: 3 })) });
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

/**
 * Twin rooms apart only in the order 51 creatures no player holds were
 * made, G00 first in one and G50 first in the other. The trap reducer cut
 * a pending occurrence's list of them at its cap, first by version 7 id,
 * so each twin kept a different part. The first load gives each creature
 * the same new id in both, then the DM shows them all and settles the
 * trap, and P1 reads the same lines in both.
 */
describe("lists cut at a cap by id before the first load's new ids (reid.ts withoutCutLists)", () => {
  const MANY = 51;
  const label = (i: number) => `G${String(i).padStart(2, "0")}`;
  /** Each creature's new id, the same in both twins and in no order of their making. */
  const newId = (i: number) => `${String((i * 7919) % 100_000).padStart(8, "0")}-0000-8000-8000-${String(i).padStart(12, "0")}`;

  type Crowd = { state: RoomState; dm: Viewer; p1: Viewer; dmMember: ReturnType<typeof member>; trapId: string; old: string[] };

  /** The room before the update: the creatures, made G00 first or G50 first, at `spot`, and the trap. */
  function crowd(g50First: boolean, spot: (i: number) => { x: number; y: number }, rig: Partial<TrapRig>, zone: { x: number; y: number; w: number; h: number }, over: Partial<Token> = {}): Crowd {
    const dm = member(uuidv7(T0), "dm");
    const p1 = member(uuidv7(T0 + 1));
    const mat = uuidv7(T0 + 2);
    const old = Array.from({ length: MANY }, (_, i) => uuidv7(T0 + (10 + (g50First ? MANY - 1 - i : i)) * MINUTE));
    const trapId = uuidv7(T0 + 200 * MINUTE);
    const s = room({ members: { [dm.id]: dm, [p1.id]: p1 }, scenes: { [mat]: scene(mat, { name: "Battle mat" }) }, playedScenes: { [mat]: { sceneId: mat, rev: 0 } } });
    s.meta.playerSceneId = mat;
    s.tokens = Object.fromEntries(
      old.map((id, i) => [id, token(id, { sceneId: mat, kind: "monster", name: "Goblin", nameHidden: true, publicName: label(i), visibility: "dm", ...spot(i), actor: { inline: actor({ hp: { cur: 20, max: 20, temp: 0 } }) }, ...over })]),
    );
    const pc = uuidv7(T0 + 3);
    s.tokens[pc] = token(pc, { sceneId: mat, kind: "pc", name: "Ayla", ownerIds: [p1.id], x: 38, y: 28 });
    const base = trap(trapId);
    s.traps = { [trapId]: { ...base, name: "Spike Pit", sceneId: mat, zone: { cells: [zone] }, rig: { ...base.rig!, message: "Spikes shoot up.", damage: [{ formula: "2d6", type: "piercing" }], ...rig } } };
    return { state: s, dm: { memberId: dm.id, role: "dm" }, p1: { memberId: p1.id, role: "player" }, dmMember: dm, trapId, old };
  }

  function run(state: RoomState, op: Op, who: Viewer, seq: number): RoomState {
    const r = applyOp(state, op, who, { seq, at: AT });
    assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.message}`);
    return r.state;
  }

  const labelOf = (c: Crowd, id: string) => label(c.old.indexOf(id));

  /** The room given its new ids as its first load does, stored and loaded at today's version, every creature shown, with the DM's socket. */
  async function migrated(t: TestContext, c: Crowd) {
    const fresh = new Map<string, string>([[c.trapId, NEW.trap!], ...c.old.map((id, i) => [id, newId(i)] as const)]);
    const renames = new Map([...new ReidPlan(c.state).renames(() => "").keys()].map((id) => [id, fresh.get(id)!] as const));
    assert.ok(c.old.every((id) => renames.has(id)), "every creature, which no player holds");
    assert.ok([...renames.values()].every((id) => id !== undefined), "and nothing but them and the trap");
    const trapId = renames.get(c.trapId) ?? c.trapId;
    const h = await storedActor(t, new StoredRoomDb(renamedState(c.state, renames), { version: SNAPSHOT_VERSION, seq: 9 }), { idGate: false });
    const dm = await h.connect(c.dmMember);
    const all = c.old.map((_, i) => newId(i));
    assert.equal((await dm.apply({ t: "token.updateMany", tokenIds: all, patch: { visibility: "all" } })).rejects, undefined);
    return { h, dm, all, trapId };
  }

  test("the creatures a trap hits past its cap: the Apply's HP lines read the same whichever the DM made first", async (t) => {
    const reads: string[][] = [];
    for (const g50First of [false, true]) {
      const c = crowd(g50First, (i) => ({ x: 10 + (i % 10), y: 2 + Math.floor(i / 10) }), { hits: "zone" }, { x: 10, y: 2, w: 10, h: 6 });
      c.state = run(c.state, { t: "trap.spring", trapId: c.trapId, tokenIds: [] }, c.dm, 5);
      const cut = c.state.traps[c.trapId]!.rig!.due![0]!;
      assert.deepEqual([cut.hits.length, cut.hitsMore], [50, 1]);
      assert.deepEqual(c.old.filter((id) => !cut.hits.includes(id)).map((id) => labelOf(c, id)), [g50First ? "G00" : "G50"], "the cut left out the last made");
      const { h, dm, all, trapId } = await migrated(t, c);
      const due = h.actor.committed.state.traps[trapId]!.rig!.due![0]!;
      assert.deepEqual([due.hits, due.hitsMore], [[], MANY], "counted, so the DM picks who it hits");
      // The DM's group save takes the occurrence's creatures where it names any, else those the DM picks: here every one, in the order of their ids.
      const picked = due.hits.length > 0 ? due.hits : [...all].sort();
      const ev = await dm.apply({ t: "actor.outcome", plan: uuidv7(), trap: { trapId, due: due.id }, targets: picked.map((id) => ({ target: { tokenId: id }, amount: 3 })) });
      assert.equal(ev.rejects, undefined);
      reads.push(p1Reads(h.actor.committed.state, c.p1.memberId));
    }
    assert.deepEqual(reads[0], reads[1]);
    assert.equal(reads[0]!.filter((r) => r.startsWith("hp ")).length, MANY, "every HP line reaches P1");
  });

  test("who set a trap off past its cap: Do its effects names them to players the same whichever the DM made first", async (t) => {
    const reads: string[][] = [];
    for (const g50First of [false, true]) {
      // P1's creatures, out of sight, walk onto the plate together from both sides, and the DM then takes them over.
      const left = (i: number) => i < 26;
      const c = crowd(g50First, (i) => (left(i) ? { x: 9, y: i } : { x: 21, y: i - 26 }), { hits: { cells: [{ x: 30, y: 28, w: 1, h: 1 }] } }, { x: 10, y: 0, w: 11, h: 26 }, { kind: "npc" });
      for (const id of c.old) c.state.tokens[id]!.ownerIds = [c.p1.memberId];
      const moves = c.old.map((tokenId, i) => ({ tokenId, x: left(i) ? 10 : 20, y: left(i) ? i : i - 26 }));
      c.state = run(c.state, { t: "token.moveMany", moves }, c.p1, 5);
      c.state = run(c.state, { t: "token.updateMany", tokenIds: c.old, patch: { ownerIds: [] } }, c.dm, 6);
      const cut = c.state.traps[c.trapId]!.rig!.due![0]!;
      assert.deepEqual([cut.hidden, cut.by.length, cut.more], [true, 10, MANY - 10]);
      assert.equal(labelOf(c, cut.by[0]!), g50First ? "G50" : "G00", "the cut kept the first made");
      const { h, dm, trapId } = await migrated(t, c);
      const due = h.actor.committed.state.traps[trapId]!.rig!.due![0]!;
      assert.deepEqual([due.by, due.more], [[], MANY], "counted, so its line names none of them");
      assert.equal((await dm.apply({ t: "trap.act", trapId, due: due.id })).rejects, undefined);
      reads.push(p1Reads(h.actor.committed.state, c.p1.memberId));
    }
    assert.deepEqual(reads[0], reads[1]);
    assert.equal(reads[0]!.filter((r) => r.startsWith("trap")).length, 1, "the players' trap line reaches P1");
  });

  test("a fall card's riders, full at FALL_RIDERS_MOST, go and the card names its creature alone, and a shorter list stays", () => {
    const w = twin(true, () => ({ id: DUE, at: AT, how: "enter", by: [], hits: [], acted: true }), true);
    const riders = Array.from({ length: FALL_RIDERS_MOST }, (_, i) => newId(i));
    w.state.falls![FALL]!.riders = riders;
    assert.equal(renamedState(w.state, new Map()).falls![FALL]!.riders, undefined);
    w.state.falls![FALL]!.riders = riders.slice(1);
    assert.deepEqual(renamedState(w.state, new Map()).falls![FALL]!.riders, riders.slice(1));
  });
});
