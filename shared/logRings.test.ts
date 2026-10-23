import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareLogIds, keys, type EntityKey } from "./keys.ts";
import { LIMITS } from "./limits.ts";
import { DM_LINE_BASE, dmNumbered, droppedLines, lineAudience, linesPastStart, liveStart, MAX_LOG, whisperParties, whispersKept } from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { applyChanges, dependents, diffProjection, heldOf, projectArchivedLog, projectEntity, projectState, stableStringify, type HeldEntry, type ProjectedState } from "./project.ts";
import { Tx } from "./reducer/tx.ts";
import { AT, DM, P1, P2, chance, member, pick, randomState, rng, room, token } from "./testutil.ts";

/**
 * The room log's rings (shared/logRings.ts, design 7.3). The randomized
 * test writes long runs of mixed lines, several to an op as real ops do,
 * and checks after them what must always hold:
 *
 * 1. Bounds: the shared lines are at most MAX_LOG, the DM lines at most
 *    `dmLogLines`, and every whisper held is among the newest
 *    `whispersKept` of someone it reaches.
 * 2. Own newest: each ring holds exactly its own newest lines, less those
 *    older than the oldest shared line once the shared lines are full.
 * 3. Audience: every viewer's live log is the same as in a room that was
 *    never written a line they do not receive (a whisper they are not party
 *    to, or a DM line for a player).
 * 4. No gap: a viewer's live log holds every line they may read from its
 *    oldest on, so the archive's pages, which start before it, leave
 *    nothing out.
 * 5. Ids: in order, unique, and the lines a player may get in one op count
 *    0, 1, 2 with the DM's from DM_LINE_BASE.
 * 6. Fan-out: each viewer's copy kept by the ev changes (touched keys,
 *    their dependents and the lines a live log's start passed) is their
 *    fresh projection.
 */

const DM2: Viewer = { memberId: "dm2", role: "dm" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const VIEWERS = [DM, DM2, P1, P2, DISPLAY];
const MEMBERS = ["dm1", "dm2", "p1", "p2"];

function base(): RoomState {
  const state = room();
  state.members.dm2 = { ...state.members.dm1!, id: "dm2", name: "dm2" };
  // A goblin no player owns or sees, whose lines are shared but reach no player: what the rings cannot tell apart.
  state.tokens.gob = token("gob", { visibility: "dm" });
  return state;
}

type Line = Omit<LogEntry, "id" | "at">;

function randomLine(r: () => number): Line {
  const roll = r();
  if (roll < 0.35) return { kind: "chat", from: pick(r, MEMBERS), text: "x".repeat(1 + Math.floor(r() * 30)) };
  if (roll < 0.45) return { kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 3 } };
  if (roll < 0.7) {
    const data: LogEvent = chance(r, 0.5) ? { type: "teleport", tokenId: "gob", past: "wall" } : { type: "area", templateId: "glyph", tokenId: "gob", trigger: "enter", area: "Glyph", hidden: true };
    return { kind: "event", data };
  }
  const from = pick(r, MEMBERS);
  const to = MEMBERS.filter((m) => m !== from && chance(r, 0.4));
  return { kind: "whisper", from, to: to.length > 0 ? to : [pick(r, MEMBERS.filter((m) => m !== from))], text: "psst" };
}

/** Writes lines as one op does, at `seq`, and returns the room after it and what the op touched. */
function write(state: RoomState, lines: readonly Line[], seq: number): { state: RoomState; touched: EntityKey[]; written: LogEntry[] } {
  const tx = new Tx(state, DM, { seq, at: AT });
  for (const line of lines) tx.addLog(line);
  tx.finish();
  return { state: tx.state, touched: tx.touched(), written: tx.log };
}

/** Whether a viewer receives a line at all, whatever the room holds: what a ring may count for them. */
function receives(viewer: Viewer, line: Pick<LogEntry, "kind" | "data" | "from" | "to">): boolean {
  const audience = lineAudience(line);
  if (audience === "whisper") return whisperParties(line).includes(viewer.memberId);
  return audience === "shared" || viewer.role === "dm";
}

type Copy = { viewer: Viewer; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function liveLog(state: RoomState, viewer: Viewer): LogEntry[] {
  return projectState(state, viewer, { sceneId: "s1" }).log;
}

describe("the log's rings (shared/logRings.ts)", () => {
  test("a line no player gets is one no player's projection carries, in any room", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = randomState(rng(seed));
      for (const line of state.log) {
        if (lineAudience(line) !== "dm") continue;
        for (const viewer of [P1, P2, DISPLAY]) assert.deepEqual(projectArchivedLog(state, [line], viewer, { sceneId: "s1" }), [], `seed ${seed}: ${line.data?.type} reached ${viewer.memberId}`);
      }
    }
  });

  test("random runs of mixed lines keep every ring's invariants", () => {
    const steps = 900;
    for (const seed of [3, 17, 29]) {
      const r = rng(seed);
      let state = base();
      // What each viewer's room would be had it never been written a line they do not receive.
      const alone = new Map(VIEWERS.map((v) => [v, base()]));
      const copies: Copy[] = VIEWERS.map((viewer) => {
        const view = projectState(state, viewer, { sceneId: "s1" });
        return { viewer, held: heldOf(view), view };
      });
      const history: LogEntry[] = [];
      for (let step = 0; step < steps; step++) {
        const seq = step + 1;
        // Only `log.whisper` writes a whisper, and nothing else beside it, so an op of several lines holds none.
        const first = randomLine(r);
        const lines = first.kind !== "whisper" && chance(r, 0.3) ? [first, ...Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomLine(r)).filter((l) => l.kind !== "whisper")] : [first];
        const before = state;
        const out = write(state, lines, seq);
        state = out.state;
        history.push(...out.written);
        for (const [viewer, room] of alone) alone.set(viewer, write(room, lines.filter((l) => receives(viewer, l)), seq).state);
        const where = `seed ${seed}, step ${step}`;

        // 5. Ids.
        const ids = state.log.map((e) => e.id);
        assert.deepEqual(ids, [...ids].sort(compareLogIds), `${where}: in id order`);
        assert.equal(new Set(ids).size, ids.length, `${where}: unique`);
        let index = 0;
        let dmIndex = 0;
        for (const e of out.written) {
          assert.equal(e.id, `${seq}:${lineAudience(e) === "dm" ? DM_LINE_BASE + dmIndex++ : index++}`, `${where}: ${e.id}`);
        }

        // 1 and 2. Bounds, and each ring its own newest.
        const shared = state.log.filter((e) => lineAudience(e) === "shared");
        const writtenShared = history.filter((e) => lineAudience(e) === "shared");
        assert.deepEqual(shared.map((e) => e.id), writtenShared.slice(-MAX_LOG).map((e) => e.id), `${where}: the shared lines are their newest`);
        const floor = shared.length >= MAX_LOG ? shared[0]!.id : null;
        const sinceFloor = (e: LogEntry) => floor === null || compareLogIds(e.id, floor) >= 0;
        const dm = state.log.filter((e) => lineAudience(e) === "dm");
        assert.ok(dm.length <= LIMITS.dmLogLines, `${where}: ${dm.length} DM lines`);
        assert.deepEqual(dm.map((e) => e.id), history.filter((e) => lineAudience(e) === "dm").slice(-LIMITS.dmLogLines).filter(sinceFloor).map((e) => e.id), `${where}: the DM lines are their newest`);
        const whispers = state.log.filter((e) => e.kind === "whisper");
        for (const member of MEMBERS) {
          const theirs = (list: readonly LogEntry[]) => list.filter((e) => e.kind === "whisper" && whisperParties(e).includes(member));
          const newest = theirs(history).slice(-LIMITS.whispersKept).filter(sinceFloor);
          const held = new Set(whispers.map((e) => e.id));
          for (const e of newest) assert.ok(held.has(e.id), `${where}: ${member}'s whisper ${e.id} is held`);
        }
        for (const e of whispers) {
          const newer = (member: string) => whispers.filter((w) => compareLogIds(w.id, e.id) > 0 && whisperParties(w).includes(member)).length;
          assert.ok(whisperParties(e).some((m) => newer(m) < LIMITS.whispersKept), `${where}: whisper ${e.id} is among someone's newest`);
        }

        // 6. Fan-out, every step, so each copy's held map stays the server's.
        const candidates = new Set([...out.touched, ...dependents(before, out.touched), ...dependents(state, out.touched), ...linesPastStart(before, state, VIEWERS).map((id) => keys.log(id))]);
        for (const copy of copies) {
          const next = new Map<EntityKey, unknown>();
          for (const key of candidates) next.set(key, projectEntity(key, state, copy.viewer, { sceneId: "s1" }));
          const diff = diffProjection(copy.held, next);
          copy.held = diff.held;
          copy.view = applyChanges(copy.view, diff.changes);
        }

        if (step % 10 !== 9 && step !== steps - 1) continue;
        for (const copy of copies) {
          const viewer = copy.viewer;
          const live = liveLog(state, viewer);
          const name = `${where}, ${viewer.memberId}`;
          assert.equal(stableStringify(copy.view.log), stableStringify(live), `${name}: the ev stream keeps the live log`);
          // 3. Audience.
          assert.deepEqual(live, liveLog(alone.get(viewer)!, viewer), `${name}: lines they never receive changed their log`);
          // 4. No gap.
          const readable = projectArchivedLog(state, history, viewer, { sceneId: "s1" }).sort((a, b) => compareLogIds(a.id, b.id));
          const first = live[0];
          const fromFirst = first ? readable.filter((e) => compareLogIds(e.id, first.id) >= 0) : [];
          assert.deepEqual(live.map((e) => e.id), fromFirst.map((e) => e.id), `${name}: a gap in the live log`);
        }
      }
      // The run reached every bound, so each rule above was tested where it bites.
      assert.ok(history.filter((e) => lineAudience(e) === "shared").length > MAX_LOG, `seed ${seed}: shared lines`);
      assert.ok(VIEWERS.some((v) => liveStart(state, v) !== null), `seed ${seed}: a live log started at a ring's bound`);
      assert.ok(MEMBERS.some((m) => history.filter((e) => e.kind === "whisper" && whisperParties(e).includes(m)).length > LIMITS.whispersKept), `seed ${seed}: whispers`);
    }
  });

  test("a whisper or a DM line never changes another viewer's log, even with the shared lines full", () => {
    let state = base();
    state.log = Array.from({ length: MAX_LOG }, (_, i) => ({ id: `1:${i}`, at: AT, kind: "chat" as const, from: "p1", text: `m${i}` }));
    const others: Line[] = [
      { kind: "whisper", from: "p1", to: ["dm1"], text: "only us" },
      { kind: "whisper", from: "dm1", to: ["p1", "dm2"], text: "and you" },
      { kind: "event", data: { type: "teleport", tokenId: "gob", past: "ledge" } },
      { kind: "event", data: { type: "area", templateId: "glyph", tokenId: "gob", trigger: "turnStart", area: "Glyph", hidden: true } },
    ];
    const p2 = liveLog(state, P2);
    for (let i = 0; i < 300; i++) {
      state = write(state, [others[i % others.length]!], 10 + i).state;
      assert.deepEqual(liveLog(state, P2), p2, `line ${i}: ${others[i % others.length]!.kind}`);
    }
    // The whispers and the DM lines are bounded on their own, so the room still holds every chat line.
    assert.equal(state.log.filter((e) => e.kind === "chat").length, MAX_LOG);
    assert.equal(state.log.filter((e) => lineAudience(e) === "dm").length, LIMITS.dmLogLines);
  });

  test("a line only the DM gets never moves the id of a line a player gets in the same op", () => {
    const hidden: Line = { kind: "event", data: { type: "area", templateId: "glyph", tokenId: "gob", trigger: "enter", area: "Glyph", hidden: true } };
    const chat: Line = { kind: "chat", from: "dm1", text: "The floor shakes." };
    const both = write(base(), [hidden, chat, hidden, chat], 7);
    const plain = write(base(), [chat, chat], 7);
    assert.deepEqual(liveLog(both.state, P1), liveLog(plain.state, P1));
    assert.deepEqual(both.written.map((e) => e.id), ["7:900000", "7:0", "7:900001", "7:1"]);
    assert.deepEqual(both.state.log.map((e) => e.id), ["7:0", "7:1", "7:900000", "7:900001"], "the DM lines sort after the op's shared lines");
  });

  test("a DM line too long for its ring stays in the archive alone", () => {
    const long: Line = { kind: "event", data: { type: "companion", tokenId: "\u0001".repeat(64), characterId: "\u0002".repeat(64), memberId: "\u0003".repeat(64), name: "\u0004".repeat(80) } };
    const out = write(base(), [long], 3);
    assert.equal(out.written.length, 1, "the archive gets it");
    assert.deepEqual(out.state.log, []);
  });

  test("dmNumbered tells the DM's count from the shared one", () => {
    assert.equal(dmNumbered("12:899999"), false);
    assert.equal(dmNumbered("12:900000"), true);
  });
});

describe("whispers, bounded by the room (shared/logRings.ts)", () => {
  /** A room of the DM and `players` players, p1 to pN. */
  function roster(players: number): RoomState {
    const state = room();
    state.members = { dm1: member("dm1", "dm") };
    for (let i = 1; i <= players; i++) state.members[`p${i}`] = member(`p${i}`);
    return state;
  }

  const whisper = (n: number, from: string, to: string): LogEntry => ({ id: `${n}:0`, at: AT, kind: "whisper", from, to: [to], text: `w${n}` });

  test("each member keeps 50, fewer past 8 members, so a room never holds more than 400", () => {
    assert.equal(whispersKept(8), 50);
    assert.equal(whispersKept(9), 44);
    assert.equal(whispersKept(50), 8);
    for (const players of [3, 7, 19, 49]) {
      const state = roster(players);
      const keep = whispersKept(players + 1);
      // Every player whispers the DM, and the next player, more than they keep.
      state.log = [];
      let n = 0;
      for (let round = 0; round < 60; round++) {
        for (let i = 1; i <= players; i++) {
          state.log.push(whisper(++n, `p${i}`, "dm1"));
          state.log.push(whisper(++n, `p${i}`, `p${(i % players) + 1}`));
        }
      }
      const dropped = new Set(droppedLines(state.log, state.members));
      const held = state.log.filter((e) => !dropped.has(e.id));
      assert.ok(held.length <= LIMITS.whispersPerRoom, `${players} players: ${held.length} whispers`);
      for (const id of Object.keys(state.members)) {
        const theirs = state.log.filter((e) => whisperParties(e).includes(id));
        for (const e of theirs.slice(-keep)) assert.ok(!dropped.has(e.id), `${players} players: ${id}'s newest ${keep} stay`);
        const start = liveStart({ log: held, members: state.members }, { memberId: id, role: id === "dm1" ? "dm" : "player" });
        assert.equal(start, theirs.at(-keep)!.id, `${players} players: ${id}'s live log starts at their own bound`);
      }
    }
  });

  test("a removed member keeps none, so each whisper stays by the members left, and one only those gone were party to goes", () => {
    const state = roster(3);
    state.log = [];
    let n = 0;
    for (let i = 0; i < 60; i++) state.log.push(whisper(++n, "p1", "dm1"));
    for (let i = 0; i < 10; i++) state.log.push(whisper(++n, "p1", "p2"));
    for (let i = 0; i < 5; i++) state.log.push(whisper(++n, "p1", "p3"));
    const before = new Set(droppedLines(state.log, state.members));
    // The DM's 10 oldest are outside both the DM's newest 50 and P1's, and P2's and P3's are each one's own newest.
    assert.deepEqual([...before], state.log.slice(0, 10).map((e) => e.id).reverse());
    const { p1: _p1, p3: _p3, ...left } = state.members;
    const dropped = new Set(droppedLines(state.log, left));
    const kept = state.log.filter((e) => !dropped.has(e.id));
    assert.deepEqual(kept.map((e) => e.id), [...state.log.slice(10, 60), ...state.log.slice(60, 70)].map((e) => e.id), "the DM's newest 50 and P2's 10, and none of P3's");
  });
});

