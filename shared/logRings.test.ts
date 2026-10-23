import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareLogIds, keys, type EntityKey } from "./keys.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import {
  countedApart,
  cutDmLine,
  DM_LINE_BASE,
  dmNumbered,
  droppedLines,
  lineAudience,
  linesPastStart,
  liveStart,
  MAX_LOG,
  PARTY_LINE_BASE,
  PARTY_SLOT,
  partyLinesKept,
  rosterRanks,
  whisperParties,
  whispersKept,
} from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { applyChanges, dependents, diffProjection, heldOf, lineReaders, projectArchivedLog, projectEntity, projectState, stableStringify, type HeldEntry, type ProjectedState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { Tx } from "./reducer/tx.ts";
import { AT, DM, P1, P2, chance, effect, member, pick, randomState, rng, room, token } from "./testutil.ts";

/**
 * The room log's rings (shared/logRings.ts, design 7.3). The randomized
 * test writes long runs of mixed lines, several to an op as real ops do,
 * while members come and go, and checks after them what must always hold:
 *
 * 1. Bounds: the shared lines are at most MAX_LOG, the DM lines at most
 *    `dmLogLines`, each player's party lines at most partyLinesKept, those
 *    of members gone at most `partyLinesKept`, and every whisper held is
 *    among the newest whispersKept of a current member it reaches.
 * 2. Own newest: the shared lines, the DM lines and each player's party
 *    lines are their ring's newest, less those older than the oldest
 *    shared line once the shared lines are full.
 * 3. Audience: every viewer's live log is the same as in a room that was
 *    never written a line they do not receive, by the real projection of
 *    the room the op left: a whisper they are not party to, a line about a
 *    creature only others play, or one no player could read.
 * 4. No gap: a viewer's live log holds every line they may read from its
 *    oldest on, so the archive's pages, which start before it, leave
 *    nothing out.
 * 5. Ids: in order, unique, and the lines a player gets in one op count 0,
 *    1, 2, and their party lines on from the start of their own run.
 * 6. Fan-out: each viewer's copy kept by the ev changes (touched keys,
 *    their dependents and the lines a live log's start passed) is their
 *    fresh projection.
 */

const DM2: Viewer = { memberId: "dm2", role: "dm" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const VIEWERS = [DM, DM2, P1, P2, DISPLAY];
const MEMBERS = ["dm1", "dm2", "p1", "p2"];
const GUESTS = ["g1", "g2", "g3", "g4", "g5", "g6"];

function base(): RoomState {
  const state = room();
  state.members.dm2 = { ...state.members.dm1!, id: "dm2", name: "dm2" };
  // A goblin no player owns or sees: its lines are the DM's.
  state.tokens.gob = token("gob", { visibility: "dm" });
  // P1's pet, and the mount P1 and P2 share, which players who do not own them never see: their lines are their players'.
  state.tokens.pet = token("pet", { visibility: "dm", ownerIds: ["p1"] });
  state.tokens.mount = token("mount", { visibility: "dm", ownerIds: ["p1", "p2"] });
  // P2's hero, whom everyone sees.
  state.tokens.hero = token("hero", { kind: "pc", ownerIds: ["p2"] });
  return state;
}

type Line = Omit<LogEntry, "id" | "at">;
type Step = { lines: Line[] } | { join: string } | { leave: string };

const roll = (tokenId: string, extra: Partial<Extract<LogEvent, { type: "roll" }>> = {}): LogEvent => ({ type: "roll", test: { kind: "save", choices: [{ ability: "dex" }] }, tokenId, total: 12, ...extra });
const die = (extra: Record<string, unknown> = {}) => ({ formula: "1d20", faces: [7], total: 7, ...extra });

function randomLine(r: () => number, state: RoomState): Line {
  const guests = GUESTS.filter((g) => state.members[g]);
  const roll100 = r();
  if (roll100 < 0.25) return { kind: "chat", from: pick(r, MEMBERS), text: "x".repeat(1 + Math.floor(r() * 30)) };
  if (roll100 < 0.6) {
    const about = pick(r, ["gob", "pet", "mount", "hero", ...guests.map((g) => `pet-${g}`)]);
    const events: LogEvent[] = [
      { type: "hp", tokenId: about, change: "damage", amount: 3, ...(about === "hero" ? { seen: true as const } : {}) },
      { type: "teleport", tokenId: "gob", past: "wall" },
      { type: "area", templateId: "glyph", tokenId: "gob", trigger: "enter", area: "Glyph", hidden: true },
      roll(about === "gob" ? "pet" : about),
      // A DM's mark with pass or fail hidden, which its own players never read.
      roll("hero", { result: "pass", tag: "t1", mark: true }),
      { type: "dice", by: "dm1", to: "all", rolls: [{ ...die(), tokenId: about, ...(about === "hero" ? { seen: true as const } : {}) }] },
      { type: "dice", by: "p2", to: "dm", rolls: [die()] },
    ];
    return { kind: "event", data: pick(r, events) };
  }
  const parties = [...MEMBERS, ...guests];
  const from = pick(r, parties);
  const to = parties.filter((m) => m !== from && chance(r, 0.3));
  return { kind: "whisper", from, to: to.length > 0 ? to : [pick(r, parties.filter((m) => m !== from))], text: "psst" };
}

function randomStep(r: () => number, state: RoomState): Step {
  const roll100 = r();
  const absent = GUESTS.filter((g) => !state.members[g]);
  const present = GUESTS.filter((g) => state.members[g]);
  if (roll100 < 0.03 && absent.length > 0) return { join: pick(r, absent) };
  if (roll100 < 0.05 && present.length > 0) return { leave: pick(r, present) };
  // Only `log.whisper` writes a whisper, and nothing else beside it, so an op of several lines holds none.
  const first = randomLine(r, state);
  if (first.kind === "whisper" || !chance(r, 0.3)) return { lines: [first] };
  const more = Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomLine(r, state)).filter((l) => l.kind !== "whisper");
  return { lines: [first, ...more] };
}

/** Writes lines as one op does, at `seq`: the room after it, what the op touched, every line it wrote and each line's copies. */
function write(state: RoomState, lines: readonly Line[], seq: number): { state: RoomState; touched: EntityKey[]; written: LogEntry[]; copies: LogEntry[][] } {
  const tx = new Tx(state, DM, { seq, at: AT });
  const copies: LogEntry[][] = [];
  for (const line of lines) {
    const from = tx.log.length;
    tx.addLog(line);
    copies.push(tx.log.slice(from));
  }
  tx.finish();
  return { state: tx.state, touched: tx.touched(), written: tx.log, copies };
}

/** A member joining or leaving, by the server's own ops, with a pet of their own for a guest who joins. */
function churn(state: RoomState, step: { join: string } | { leave: string }, seq: number): { state: RoomState; touched: EntityKey[]; written: LogEntry[] } {
  let start = state;
  if ("join" in step) start = { ...state, tokens: { ...state.tokens, [`pet-${step.join}`]: token(`pet-${step.join}`, { visibility: "dm", ownerIds: [step.join] }) } };
  const op: Op = "join" in step ? { t: "sys.memberJoin", member: { id: step.join, name: step.join, color: "#ff0000", kind: "player", createdAt: AT } } : { t: "sys.memberRemove", memberId: step.leave };
  const r = applyOp(start, op, DM, { seq, at: AT });
  assert.ok(r.ok, r.ok ? "" : r.message);
  return { state: r.state, touched: [...r.touched, ...("join" in step ? [keys.token(`pet-${step.join}`)] : [])], written: r.log };
}

/**
 * Whether a viewer receives a line: the real projection for them of the
 * room the op left carries one of its copies. A table display is no member,
 * so it gets no dice line, which every member gets, and its live log counts
 * those among the shared lines as every member's does: a line every member
 * reads tells no one at the table anything.
 */
function receives(viewer: Viewer, copies: readonly LogEntry[], after: RoomState): boolean {
  if (viewer === DISPLAY && copies.some((c) => lineAudience(c) === "shared")) return true;
  return copies.some((c) => projectArchivedLog(after, [c], viewer, { sceneId: "s1" }).length > 0);
}

type Copy = { viewer: Viewer; held: Map<EntityKey, HeldEntry>; view: ProjectedState };

function liveLog(state: RoomState, viewer: Viewer): LogEntry[] {
  return projectState(state, viewer, { sceneId: "s1" }).log;
}

const index = (id: string) => Number(id.slice(id.indexOf(":") + 1));

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

  test("random runs of mixed lines, while members come and go, keep every ring's invariants", () => {
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
      let joins = 0;
      for (let step = 0; step < steps; step++) {
        const seq = step + 1;
        const before = state;
        const plan = randomStep(r, state);
        let out: { state: RoomState; touched: EntityKey[]; written: LogEntry[] };
        if ("lines" in plan) {
          const wrote = write(state, plan.lines, seq);
          out = wrote;
          for (const [viewer, room] of alone) alone.set(viewer, write(room, plan.lines.filter((_, i) => receives(viewer, wrote.copies[i]!, wrote.state)), seq).state);
        } else {
          out = churn(state, plan, seq);
          if ("join" in plan) joins++;
          for (const [viewer, room] of alone) alone.set(viewer, churn(room, plan, seq).state);
        }
        state = out.state;
        history.push(...out.written);
        const where = `seed ${seed}, step ${step}`;
        const roster = Object.keys(state.members);

        // 5. Ids.
        const ids = state.log.map((e) => e.id);
        assert.deepEqual(ids, [...ids].sort(compareLogIds), `${where}: in id order`);
        assert.equal(new Set(ids).size, ids.length, `${where}: unique`);
        for (const viewer of VIEWERS) {
          // A display gets no dice line, which every member reads, so its count may pass one (receives).
          if (viewer === DISPLAY) continue;
          const got = out.written.filter((e) => projectArchivedLog(state, [e], viewer, { sceneId: "s1" }).length > 0).map((e) => index(e.id));
          const shared = got.filter((i) => i < PARTY_LINE_BASE);
          assert.deepEqual(shared, shared.map((_, i) => i), `${where}: ${viewer.memberId}'s ids in the op count on from 0`);
          if (viewer.role === "dm") continue;
          const own = got.filter((i) => i >= PARTY_LINE_BASE && i < DM_LINE_BASE);
          const run = PARTY_LINE_BASE + rosterRanks(before.members).get(viewer.memberId)! * PARTY_SLOT;
          assert.deepEqual(own, own.map((_, i) => run + i), `${where}: ${viewer.memberId}'s party lines count on from their own run`);
        }

        // 1 and 2. Bounds, and each ring its own newest.
        const shared = state.log.filter((e) => lineAudience(e) === "shared");
        const writtenShared = history.filter((e) => lineAudience(e) === "shared");
        assert.deepEqual(shared.map((e) => e.id), writtenShared.slice(-MAX_LOG).map((e) => e.id), `${where}: the shared lines are their newest`);
        const floor = shared.length >= MAX_LOG ? shared[0]!.id : null;
        const sinceFloor = (e: LogEntry) => floor === null || compareLogIds(e.id, floor) >= 0;
        const dm = state.log.filter((e) => lineAudience(e) === "dm");
        assert.deepEqual(dm.map((e) => e.id), history.filter((e) => lineAudience(e) === "dm").slice(-LIMITS.dmLogLines).filter(sinceFloor).map((e) => e.id), `${where}: the DM lines are their newest`);
        const party = state.log.filter((e) => lineAudience(e) === "party");
        for (const reader of roster) {
          const held = party.filter((e) => e.to![0] === reader);
          assert.ok(held.length <= partyLinesKept(roster.length), `${where}: ${reader} holds ${held.length} party lines`);
          const theirs = history.filter((e) => lineAudience(e) === "party" && e.to![0] === reader && sinceFloor(e));
          assert.deepEqual(held.map((e) => e.id), theirs.slice(theirs.length - held.length).map((e) => e.id), `${where}: ${reader}'s party lines are their newest`);
        }
        const gone = party.filter((e) => !roster.includes(e.to![0]!));
        assert.ok(gone.length <= LIMITS.partyLinesKept && gone.every((e) => e.to!.length === 1), `${where}: ${gone.length} lines of members gone`);
        const whispers = state.log.filter((e) => e.kind === "whisper");
        assert.ok(whispers.length <= LIMITS.whispersPerRoom, `${where}: ${whispers.length} whispers`);
        for (const e of whispers) {
          const newer = (m: string) => whispers.filter((w) => compareLogIds(w.id, e.id) > 0 && whisperParties(w).includes(m)).length;
          assert.ok(whisperParties(e).some((m) => roster.includes(m) && newer(m) < whispersKept(roster.length)), `${where}: whisper ${e.id} is among a current member's newest`);
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
          if (process.env.DEBUG_RINGS && stableStringify(live.map((e) => e.id)) !== stableStringify(fromFirst.map((e) => e.id))) {
            const a = new Set(live.map((e) => e.id));
            const missing = fromFirst.filter((e) => !a.has(e.id));
            console.log(name, "start", liveStart(state, viewer), "missing", missing.map((e) => [e.id, e.kind, e.to, e.data?.type]), "roster", Object.keys(state.members));
          }
          assert.deepEqual(live.map((e) => e.id), fromFirst.map((e) => e.id), `${name}: a gap in the live log`);
        }
      }
      // The run reached every bound, so each rule above was tested where it bites.
      assert.ok(history.filter((e) => lineAudience(e) === "shared").length > MAX_LOG, `seed ${seed}: shared lines`);
      assert.ok(VIEWERS.some((v) => liveStart(state, v) !== null), `seed ${seed}: a live log started at a ring's bound`);
      assert.ok(MEMBERS.some((m) => history.filter((e) => e.kind === "whisper" && whisperParties(e).includes(m)).length > LIMITS.whispersKept), `seed ${seed}: whispers`);
      assert.ok(history.filter((e) => lineAudience(e) === "party" && e.to![0] === "p1").length > LIMITS.partyLinesKept, `seed ${seed}: party lines`);
      assert.ok(history.some((e) => lineAudience(e) === "party" && e.to!.length === 2), `seed ${seed}: a line two players read`);
      assert.ok(joins > 2 && history.some((e) => lineAudience(e) === "party" && GUESTS.includes(e.to![0]!)), `seed ${seed}: members came and went`);
    }
  });

  test("a whisper or a line a player cannot read never changes another viewer's log, even with the shared lines full", () => {
    let state = base();
    state.log = Array.from({ length: MAX_LOG }, (_, i) => ({ id: `1:${i}`, at: AT, kind: "chat" as const, from: "p1", text: `m${i}` }));
    const others: Line[] = [
      { kind: "whisper", from: "p1", to: ["dm1"], text: "only us" },
      { kind: "whisper", from: "dm1", to: ["p1", "dm2"], text: "and you" },
      { kind: "event", data: { type: "teleport", tokenId: "gob", past: "ledge" } },
      { kind: "event", data: { type: "area", templateId: "glyph", tokenId: "gob", trigger: "turnStart", area: "Glyph", hidden: true } },
      { kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 4 } },
      { kind: "event", data: { type: "hp", tokenId: "pet", change: "heal", amount: 2 } },
      { kind: "event", data: roll("pet") },
      { kind: "event", data: roll("hero", { result: "fail", tag: "t2", mark: true }) },
    ];
    const p2 = liveLog(state, P2);
    for (let i = 0; i < 300; i++) {
      state = write(state, [others[i % others.length]!], 10 + i).state;
      assert.deepEqual(liveLog(state, P2), p2, `line ${i}: ${others[i % others.length]!.data?.type ?? "whisper"}`);
    }
    // Every ring is bounded on its own, so the room still holds every chat line.
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

  test("a DM line too long for its ring is cut, as trap lines are, and keeps its place in the live log", () => {
    const vitals = (cur: number) => ({ hp: { cur, max: 7, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
    const removed = Array.from({ length: 60 }, (_, i) => effect(`e${i}`, { key: "custom", label: "x".repeat(60) }));
    const hp: Line = { kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 7, revert: { before: vitals(7), after: vitals(0), removed } } };
    const chat = (text: string): Line => ({ kind: "chat", from: "dm1", text });
    const out = write(base(), [chat("a"), hp, chat("b")], 3);
    const cut = out.state.log.find((e) => e.data?.type === "hp")!;
    assert.ok(serializedBytes(cut) <= LIMITS.dmLogLineBytes);
    assert.deepEqual(cut.data, { type: "hp", tokenId: "gob", change: "damage", amount: 7 }, "only the take-back's record went");
    assert.deepEqual(out.written.find((e) => e.id === cut.id), cut, "the archive holds the same line");
    assert.deepEqual(liveLog(out.state, DM).map((e) => e.id), ["3:0", "3:1", cut.id]);
    // Text no event line uses goes first, as from a hand-made file.
    const stray = cutDmLine({ id: "4:900000", at: AT, kind: "event", text: "x".repeat(7000), data: { type: "teleport", tokenId: "gob", past: "wall" } });
    assert.deepEqual(stray, { id: "4:900000", at: AT, kind: "event", data: { type: "teleport", tokenId: "gob", past: "wall" } });
  });

  test("dmNumbered and countedApart tell the DM's count and the party lines' from the shared one", () => {
    assert.equal(dmNumbered("12:899999"), false);
    assert.equal(dmNumbered("12:900000"), true);
    assert.equal(countedApart("12:799999"), false);
    assert.equal(countedApart("12:800000"), true);
    assert.equal(PARTY_SLOT * LIMITS.membersPerRoom, DM_LINE_BASE - PARTY_LINE_BASE, "every member's run fits below the DM's lines");
  });
});

describe("a line's readers, fixed when it is written (shared/project.ts lineReaders)", () => {
  /** A room with 200 chat lines, every player's live log full. */
  function full(): RoomState {
    const state = base();
    state.log = Array.from({ length: MAX_LOG }, (_, i) => ({ id: `1:${i}`, at: AT, kind: "chat" as const, from: "p1", text: `m${i}` }));
    return state;
  }

  /** The lines P1 and P2 get, and the ids and drops, with and without `extra` between two chat lines of one op. */
  function paired(extra: Line): { with: ReturnType<typeof write>; without: ReturnType<typeof write> } {
    const chat = (text: string): Line => ({ kind: "chat", from: "dm1", text });
    return { with: write(full(), [chat("a"), extra, chat("b")], 5), without: write(full(), [chat("a"), chat("b")], 5) };
  }

  for (const [name, extra, reader] of [
    ["a DM's mark of a roll with pass or fail hidden", { kind: "event", data: roll("pet", { result: "pass", tag: "t3", mark: true }) }, null],
    ["an HP line about a creature no player plays or sees", { kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 5 } }, null],
    ["an HP line about P1's pet, which no one else sees", { kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 5 } }, "p1"],
  ] as const) {
    test(`${name}: every player who cannot read it gets the same copy, ids and drops as in a room without it`, () => {
      const pair = paired(extra as Line);
      for (const viewer of [P1, P2, DISPLAY]) {
        const got = liveLog(pair.with.state, viewer);
        const plain = liveLog(pair.without.state, viewer);
        if (viewer.memberId === reader) {
          assert.deepEqual(got.filter((e) => e.kind === "chat"), plain.filter((e) => e.kind === "chat"), `${viewer.memberId}: their chat`);
          assert.equal(got.length, plain.length + 1, `${viewer.memberId}: their line too`);
          assert.deepEqual(got.at(-1)!.to, [viewer.memberId], "a party line names only its reader");
        } else assert.deepEqual(got, plain, viewer.memberId);
      }
      assert.deepEqual(new Set(pair.with.state.log.filter((e) => e.kind === "chat").map((e) => e.id)), new Set(pair.without.state.log.filter((e) => e.kind === "chat").map((e) => e.id)), "it pushed out no chat line");
    });
  }

  for (const [name, op, only] of [
    ["actor.damageMany", (ids: string[]): Op => ({ t: "actor.damageMany", hits: ids.map((tokenId) => ({ target: { tokenId }, amount: 2 })) }), "a hit"],
    ["actor.outcome", (ids: string[]): Op => ({ t: "actor.outcome", plan: "pl1", label: "Fireball", targets: ids.map((tokenId) => ({ target: { tokenId }, amount: 2 })) }), "an outcome"],
  ] as const) {
    test(`${name} on seen and unseen creatures leaves no gap in any player's ids, and those who see one get what a room with that one alone gives`, () => {
      const all = applyOp(base(), op(["gob", "pet", "hero", "mount"]), DM, { seq: 3, at: AT });
      const seenOnly = applyOp(base(), op(["hero"]), DM, { seq: 3, at: AT });
      if (!all.ok || !seenOnly.ok) throw new Error("refused");
      assert.deepEqual(liveLog(all.state, P2).filter((e) => !e.to), liveLog(seenOnly.state, P2), `${only} on creatures P2 cannot see moved nothing of theirs`);
      for (const viewer of [P1, P2]) {
        const got: number[] = liveLog(all.state, viewer).map((e) => index(e.id));
        const run = PARTY_LINE_BASE + rosterRanks(base().members).get(viewer.memberId)! * PARTY_SLOT;
        const shared = got.filter((i) => i < PARTY_LINE_BASE);
        const own = got.filter((i) => i >= PARTY_LINE_BASE);
        assert.deepEqual(shared, shared.map((_, i) => i), `${viewer.memberId}: shared ids`);
        assert.deepEqual(own, own.map((_, i) => run + i), `${viewer.memberId}: their own run`);
      }
      assert.ok(liveLog(all.state, P1).some((e) => e.data?.type === "hp" && e.data.tokenId === "pet"), "P1 reads their pet's line");
      assert.ok(all.state.log.some((e) => dmNumbered(e.id) && e.data?.type === "hp" && e.data.tokenId === "gob"), "the goblin's line is the DM's");
    });
  }

  test("a line keeps the readers it had: a player who comes to own the creature later never gets it", () => {
    const state = write(base(), [{ kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 5 } }, { kind: "event", data: { type: "hp", tokenId: "pet", change: "heal", amount: 1 } }], 4).state;
    // The DM lends both creatures to P2.
    const lent = { ...state, tokens: { ...state.tokens, gob: { ...state.tokens.gob!, ownerIds: ["p2"] }, pet: { ...state.tokens.pet!, ownerIds: ["p1", "p2"] } } };
    assert.deepEqual(liveLog(lent, P2), []);
    assert.equal(liveLog(lent, P1).length, 1, "P1, who played the pet then, keeps their line");
    // A line written now reaches its new players.
    const now = write(lent, [{ kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 2 } }], 5).state;
    assert.equal(liveLog(now, P2).length, 1);
  });

  test("a line two players read is a copy for each, the first one the DM's, and each player's ids count on in their own run", () => {
    const out = write(base(), [{ kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 1 } }, { kind: "event", data: { type: "hp", tokenId: "mount", change: "damage", amount: 2 } }, { kind: "event", data: { type: "hp", tokenId: "hero", change: "damage", amount: 3, seen: true } }], 9);
    const ranks = rosterRanks(base().members);
    const run = (id: string) => PARTY_LINE_BASE + ranks.get(id)! * PARTY_SLOT;
    assert.deepEqual(out.written.map((e) => [e.id, e.to]), [
      [`9:${run("p1")}`, ["p1"]],
      [`9:${run("p1") + 1}`, ["p1"]],
      [`9:${run("p2")}`, ["p2", "p1"]],
      ["9:0", undefined],
    ]);
    assert.deepEqual(liveLog(out.state, P2).map((e) => [e.id, e.to]), [["9:0", undefined], [`9:${run("p2")}`, ["p2"]]]);
    assert.deepEqual(liveLog(out.state, DM).map((e) => e.id), ["9:0", `9:${run("p1")}`, `9:${run("p1") + 1}`], "the DM reads the mount's line once");
    assert.deepEqual(lineReaders(out.state, { kind: "event", data: { type: "hp", tokenId: "mount", change: "damage" } }), ["p1", "p2"]);
  });

  test("a player's own party lines start their live log once they hold their bound, with no gap", () => {
    let state = base();
    const keep = partyLinesKept(Object.keys(state.members).length);
    for (let i = 0; i < keep + 10; i++) state = write(state, [{ kind: "chat", from: "dm1", text: `c${i}` }, { kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 1 } }], i + 1).state;
    const own = state.log.filter((e) => e.to?.[0] === "p1");
    assert.equal(own.length, keep);
    const live = liveLog(state, P1);
    assert.equal(live[0]!.id, own[0]!.id, "it starts at the oldest they hold");
    assert.equal(live.length, keep * 2 - 1, "with every chat line since");
    assert.equal(liveLog(state, P2).length, keep + 10, "P2's, which holds none, keeps every chat line");
  });

  test("a member who leaves takes their copies, and the DM keeps the first copies of those gone, 50 of them, with no gap", () => {
    let state = base();
    state.members.g1 = member("g1");
    state.members.z1 = member("z1");
    state.tokens.gpet = token("gpet", { visibility: "dm", ownerIds: ["g1"] });
    state.tokens.shared = token("shared", { visibility: "dm", ownerIds: ["p1", "g1"] });
    // z1 sorts after p1, so z1's copy of this one's lines is not the DM's.
    state.tokens.zshared = token("zshared", { visibility: "dm", ownerIds: ["p1", "z1"] });
    let seq = 1;
    for (let i = 0; i < 40; i++) state = write(state, [{ kind: "event", data: { type: "hp", tokenId: i % 2 === 0 ? "gpet" : "shared", change: "damage", amount: 1 } }, { kind: "chat", from: "dm1", text: `c${i}` }], ++seq).state;
    for (let i = 0; i < 5; i++) state = write(state, [{ kind: "event", data: { type: "hp", tokenId: "zshared", change: "damage", amount: 1 } }], ++seq).state;
    assert.equal(state.log.filter((e) => e.to?.[0] === "z1").length, 5);
    const z = applyOp(state, { t: "sys.memberRemove", memberId: "z1" }, DM, { seq: ++seq, at: AT });
    assert.ok(z.ok);
    assert.equal(z.state.log.filter((e) => e.to?.[0] === "z1").length, 0, "a copy no one reads goes with its reader");
    assert.equal(z.state.log.filter((e) => e.to?.[0] === "p1" && e.data?.type === "hp" && e.data.tokenId === "zshared").length, 5, "P1's and the DM's stay");
    const r = applyOp(z.state, { t: "sys.memberRemove", memberId: "g1" }, DM, { seq: ++seq, at: AT });
    assert.ok(r.ok);
    const party = r.state.log.filter((e) => lineAudience(e) === "party");
    assert.ok(party.every((e) => e.to![0] === "p1" || e.to!.length === 1), "no copy of g1's is left that no one reads");
    // g1 sorts before p1, so g1's copy of the shared creature's lines is the DM's too, as many as g1 kept with six members.
    assert.equal(party.filter((e) => e.to![0] === "g1").length, partyLinesKept(6), "the DM's copies stay");
    assert.equal(party.filter((e) => e.to![0] === "p1" && e.data?.type === "hp" && e.data.tokenId === "shared").length, 20, "P1's copies of the shared creature's lines stay");
    // Twelve more members' worth of lines would pass the bound for those gone: the DM's live log starts at its newest 50.
    for (const g of ["g2", "g3"]) {
      let next = applyOp(r.state, { t: "sys.memberJoin", member: { id: g, name: g, color: "#ff0000", kind: "player", createdAt: AT } }, DM, { seq: ++seq, at: AT });
      assert.ok(next.ok);
      let s2 = { ...next.state, tokens: { ...next.state.tokens, [`pet-${g}`]: token(`pet-${g}`, { visibility: "dm", ownerIds: [g] }) } };
      for (let i = 0; i < 20; i++) s2 = write(s2, [{ kind: "event", data: { type: "hp", tokenId: `pet-${g}`, change: "damage", amount: 1 } }], ++seq).state;
      next = applyOp(s2, { t: "sys.memberRemove", memberId: g }, DM, { seq: ++seq, at: AT });
      assert.ok(next.ok);
      r.state = next.state;
    }
    const gone = r.state.log.filter((e) => lineAudience(e) === "party" && e.to![0] !== "p1");
    assert.ok(gone.every((e) => e.to!.length === 1));
    assert.equal(gone.length, LIMITS.partyLinesKept);
    const live = liveLog(r.state, DM);
    assert.equal(live[0]!.id, gone[0]!.id, "the DM's live log starts at the oldest kept, so no line inside it is missing");
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

