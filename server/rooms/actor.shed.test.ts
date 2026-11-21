import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { compareLogIds } from "#shared/keys.ts";
import { HARD } from "#shared/limits.ts";
import { lineAudience, liveStart } from "#shared/logRings.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { projectState, stableStringify } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import { T0 } from "#shared/seqTestutil.ts";
import { actor as creature, token, trap } from "#shared/testutil.ts";
import type { ActorDeps } from "./actor.ts";
import { exportableState } from "./exportRoom.ts";
import type { Pool } from "./persistence.ts";
import { remapState } from "./remap.ts";
import { storedBytes } from "./sizeGuard.ts";
import { parseRoomState } from "./stateSchema.ts";
import { restartStored, scopeFixture, storedActor, StoredRoomDb, type ScopeClient } from "./undoScopeTesting.ts";

/*
 * The shed at a batch's close (actor.ts #shed, sizeGuard.ts shedOf,
 * docs/design/design-v1-player-limits.md): a room whose stored bytes pass
 * their bound loses its oldest archived DM lines, then its oldest history
 * steps, in one `sys.shed` that replays as stored and changes nothing a
 * player is sent. The bound is lowered here (ActorOptions.sizeLimits), so
 * a small room meets it.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;

/** A stored room with a log archive: the lines each commit archived, by id, and the archived-id query a load runs. */
class ArchiveDb extends StoredRoomDb {
  readonly archive = new Map<string, LogEntry>();

  override pool(): Pool {
    const base = super.pool() as unknown as { query: Query; connect: () => Promise<{ query: Query; release: () => void }> };
    const wrap = (query: Query): Query => async (text, params = []) => {
      const sql = text.trim();
      if (sql.startsWith("select id from room_log")) return { rows: (params[1] as string[]).filter((id) => this.archive.has(id)).map((id) => ({ id })) };
      if (sql.startsWith("with src as")) {
        const [, ids, , entries] = params as [string, string[], string[], string[]];
        for (const [i, id] of ids.entries()) this.archive.set(id, JSON.parse(entries[i]!) as LogEntry);
      }
      return query(text, params);
    };
    const connect = async () => {
      const client = await base.connect();
      return { ...client, query: wrap(client.query) };
    };
    return { query: wrap(base.query), connect } as unknown as Pool;
  }
}

const AT = new Date(T0).toISOString();
const DM_ACTOR = (f: ReturnType<typeof scopeFixture>): Viewer => ({ memberId: f.dm.id, role: "dm" });
const damage = (tokenId: string): Op => ({ t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 1 } }) as Op;

/**
 * The fixture with a turn-start dart over the party, a creature only the
 * DM sees, a fight of three steps and `dmLines` DM lines from damage to the
 * hidden creature. `db` stores it at seq 100 with every line archived,
 * a fresh copy each time, so twins hold the same ids.
 */
function table(dmLines: number) {
  const f = scopeFixture();
  const s = f.state;
  s.traps = { dart: trap("dart", { sceneId: f.sceneId, name: "Dart", zone: { cells: [{ x: 2, y: 2, w: 8, h: 8 }] }, rig: { on: ["turnStart"], who: "any", floor: true, resets: "nextTurn", stops: false, foundOnSpring: false, hits: "trigger", actions: [], find: [], notice: false, message: "A dart flies." } }) };
  s.tokens.shade = token("shade", { sceneId: f.sceneId, name: "Shade", x: 20, y: 20, visibility: "dm", actor: { inline: creature({ dmNotes: "", hp: { cur: 500, max: 500, temp: 0 } }) } });
  let state: RoomState = s;
  let seq = 0;
  const apply = (op: Op) => {
    const r = applyOp(state, op, DM_ACTOR(f), { seq: ++seq, at: AT });
    assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
    state = r.state;
  };
  apply({ t: "encounter.start", entries: [{ id: "row-gob", tokenId: f.goblin, value: 20 }, { id: "row-pc", tokenId: f.pc, value: 10 }] } as Op);
  for (let i = 0; i < 3; i++) apply({ t: "encounter.next" } as Op);
  for (let i = 0; i < dmLines; i++) apply(damage("shade"));
  assert.equal(state.encounter?.activeEntryId, "row-gob", "the goblin's turn is on, so the next Next starts the pc's, in the dart's squares");
  const db = () => {
    const out = new ArchiveDb(structuredClone(state), { seq: 100 });
    for (const line of state.log) out.archive.set(line.id, line);
    return out;
  };
  return { f, state, db };
}

async function open(t: TestContext, db: ArchiveDb, f: ReturnType<typeof scopeFixture>, options: ActorDeps["options"] = {}) {
  const logged: string[] = [];
  const keep = (_: unknown, message?: string) => void logged.push(String(message));
  const log = { info() {}, warn: keep, error: keep, debug() {} } as ActorDeps["log"];
  const h = await storedActor(t, db, { now: () => T0, ...options }, log);
  const dm = await h.connect(f.dm);
  const player = await h.connect(f.player, "player");
  return { ...h, dm, player, logged };
}

const sheds = (db: StoredRoomDb) => db.rows.filter((r) => (r.op as Op).t === "sys.shed").map((r) => r.op as Extract<Op, { t: "sys.shed" }>);
const dmLinesOf = (state: RoomState) => state.log.filter((e) => lineAudience(e) === "dm").map((e) => e.id);
/** What a client was sent, but the clock and each actor's own history epoch, a random id per load. */
const framesOf = (client: ScopeClient) => client.sent.filter((m) => m.t !== "clock").map((m) => (m.t === "history" ? { ...m, epoch: "" } : m));

/** The turn-start springings each op wrote, by the op's seq. */
function springs(state: RoomState): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of state.trapLog ?? []) {
    if ((line.data as { how?: string } | undefined)?.how !== "turnStart") continue;
    const at = line.id.split(":")[0]!;
    out.set(at, (out.get(at) ?? 0) + 1);
  }
  return out;
}

describe("a batch's close sheds a room past its stored bound (design 1.4)", () => {
  test("a Next onto a turn-start trap past the bound: one springing, one shed of the oldest DM line, the player's frames those of the unshed twin, and replay the same", async (t) => {
    const room = table(6);
    const b = await open(t, room.db(), room.f, { sizeLimits: { storedLimit: HARD.storedBytes } });
    await b.dm.apply({ t: "encounter.next" });
    const unshed = b.actor.committed.state;
    assert.deepEqual(sheds(b.db), [], "the unshed twin sheds nothing");
    const bound = storedBytes(unshed) - 1;

    const a = await open(t, room.db(), room.f, { sizeLimits: { storedLimit: bound } });
    await a.dm.apply({ t: "encounter.next" });
    const shed = a.actor.committed.state;
    const oldest = dmLinesOf(room.state)[0]!;
    assert.deepEqual(sheds(a.db), [{ t: "sys.shed", lines: [oldest], steps: 0 }]);
    assert.equal(shed.dmLogShed, oldest);
    assert.ok(storedBytes(shed) <= bound, "the room fits its bound again");
    assert.deepEqual(shed.encounterHistory.length, unshed.encounterHistory.length, "the lines were enough, so every step stays");

    const next = a.db.rows.find((r) => (r.op as Op).t === "encounter.next")!.seq;
    assert.deepEqual([...springs(shed)].filter(([at]) => Number(at) >= next), [[String(next), 1]], "the Next set the dart off once, and the shed did not again");
    assert.deepEqual(springs(shed), springs(unshed));
    assert.deepEqual(framesOf(a.player), framesOf(b.player), "the player's frames are the unshed twin's");
    assert.equal(stableStringify(projectState(shed, { memberId: room.f.player.id, role: "player" }, { sceneId: null })), stableStringify(projectState(unshed, { memberId: room.f.player.id, role: "player" }, { sceneId: null })));

    const again = await restartStored(t, a, { snapshot: false }, { now: () => T0, sizeLimits: { storedLimit: bound } });
    assert.equal(stableStringify(again.actor.committed.state), stableStringify(shed), "replay drops exactly the lines the shed named");
  });

  test("the prefix stops at a line the archive lacks: an unarchived DM line keeps itself and every newer one, and the oldest steps go instead", async (t) => {
    const allow = { archive: true };
    const room = table(0);
    const run = async (storedLimit: number) => {
      const db = room.db();
      const h = await open(t, db, room.f, { sizeLimits: { storedLimit }, archiveGuard: async () => allow.archive });
      allow.archive = false;
      await h.dm.apply(damage("shade"));
      allow.archive = true;
      await h.dm.apply(damage("shade"));
      await h.dm.apply(damage("shade"));
      return { db, h };
    };
    const plain = await run(HARD.storedBytes);
    const [first, second, third] = dmLinesOf(plain.h.actor.committed.state);
    assert.ok(third && plain.db.archive.has(second!) && !plain.db.archive.has(first!), "line 1 unarchived, line 2 archived, line 3 this batch's");
    allow.archive = true;
    const { db, h } = await run(storedBytes(plain.h.actor.committed.state) - 1);
    const shed = sheds(db);
    assert.equal(shed.length, 1);
    assert.deepEqual(shed[0]!.lines, [], "nothing past line 1 is shed");
    assert.ok(shed[0]!.steps > 0, "a step went instead");
    assert.deepEqual(dmLinesOf(h.actor.committed.state), [first, second, third]);
    assert.equal(h.actor.committed.state.dmLogShed, undefined);
  });

  test("a line the room's own batch archived is shed at a later batch's close", async (t) => {
    const room = table(0);
    const run = async (storedLimit: number) => {
      const h = await open(t, room.db(), room.f, { sizeLimits: { storedLimit } });
      for (let i = 0; i < 3; i++) await h.dm.apply(damage("shade"));
      return h;
    };
    const plain = await run(HARD.storedBytes);
    const [first] = dmLinesOf(plain.actor.committed.state);
    const h = await run(storedBytes(plain.actor.committed.state) - 1);
    assert.deepEqual(sheds(h.db), [{ t: "sys.shed", lines: [first], steps: 0 }], "the oldest line, archived when its batch committed");
  });

  test("with every DM line shed, the DM's live log starts just past the newest, and the archive's older page holds it with no line left out; the newest step stays, and a room with nothing left to shed says so once a load", async (t) => {
    const room = table(4);
    const dmLines = dmLinesOf(room.state);
    const db = room.db();
    const h = await open(t, db, room.f, { sizeLimits: { storedLimit: 1_000 } });
    await h.player.apply({ t: "log.chat", text: "after the lines" });
    await h.dm.apply({ t: "log.chat", text: "and the DM's" });
    const state = h.actor.committed.state;
    const [shed] = sheds(db);
    assert.deepEqual(shed, { t: "sys.shed", lines: dmLines, steps: room.state.encounterHistory.length - 1 });
    assert.deepEqual(dmLinesOf(state), [], "no DM line is left");
    assert.equal(state.encounterHistory.length, 1, "the newest step stays");
    assert.equal(state.dmLogShed, dmLines.at(-1));
    assert.deepEqual(h.logged.filter((m) => m.includes("nothing left to shed")), ["room is past its stored bound and has nothing left to shed"], "told once, though both batches stayed over");

    const dm: Viewer = { memberId: room.f.dm.id, role: "dm" };
    const start = liveStart(state, dm);
    assert.ok(start !== null && compareLogIds(start, dmLines.at(-1)!) > 0, "the DM's start is past the newest shed line");
    const live = (projectState(state, dm, { sceneId: null }).log ?? []).map((e) => e.id);
    assert.ok(live.every((id) => compareLogIds(id, start) >= 0));
    // "Show older" asks the archive for the lines before the live log's oldest, or its newest when the live log is empty.
    const edge = live[0];
    const older = [...db.archive.keys()].filter((id) => edge === undefined || compareLogIds(id, edge) < 0);
    for (const id of dmLines) assert.ok(older.includes(id), `the older page holds ${id}`);
    const read = new Set([...older, ...live]);
    for (const line of [...room.state.log, ...state.log]) assert.ok(read.has(line.id), `the DM reads ${line.id} live or in the archive`);
  });

  test("the DM's Undo of a Next whose oldest steps a shed took answers as for any change since", async (t) => {
    const room = table(0);
    const b = await open(t, room.db(), room.f);
    await b.dm.apply({ t: "encounter.next" });
    const h = await open(t, room.db(), room.f, { sizeLimits: { storedLimit: storedBytes(b.actor.committed.state) - 1 } });
    await h.dm.apply({ t: "encounter.next" });
    assert.equal(sheds(h.db)[0]?.steps, 1);
    const undo = await h.dm.send({ t: "undo", scope: "play", head: h.dm.head().id });
    assert.equal(undo.rejects?.[0]?.message, "could not undo moving to the next turn: it was changed since");
    const unshed = await b.dm.send({ t: "undo", scope: "play", head: b.dm.head().id });
    assert.deepEqual(unshed.rejects ?? [], [], "the unshed twin's Undo is taken");
  });

  test("an exported shed room imports without the shed line's id, its DM's live log starting at its rings", async (t) => {
    const room = table(3);
    const h = await open(t, room.db(), room.f, { sizeLimits: { storedLimit: 1_000 } });
    await h.dm.apply(damage("shade"));
    const state = h.actor.committed.state;
    assert.ok(state.dmLogShed !== undefined);
    const parsed = parseRoomState(JSON.parse(JSON.stringify({ ...exportableState(state, { memberId: room.f.dm.id, role: "dm" }), dmLogShed: state.dmLogShed })));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.message);
    const out = remapState(parsed.state, { assets: new Map() });
    assert.equal("dmLogShed" in out, false);
    assert.equal(liveStart(out, { memberId: room.f.dm.id, role: "dm" }), null);
  });
});
