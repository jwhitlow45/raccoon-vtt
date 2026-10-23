import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compareLogIds, keys, type EntityKey } from "./keys.ts";
import { LIMITS, serializedBytes } from "./limits.ts";
import {
  countedApart,
  cutLine,
  DM_LINE_BASE,
  dmNumbered,
  droppedLines,
  holdsOp,
  lineAudience,
  linesPastStart,
  liveStart,
  MAX_LOG,
  memberRing,
  PARTY_LINE_BASE,
  PARTY_SLOT,
  rosterRanks,
  whisperParties,
  type MemberRing,
} from "./logRings.ts";
import type { LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { applyChanges, dependents, diffProjection, heldOf, lineReach, projectArchivedLog, projectEntity, projectState, stableStringify, type HeldEntry, type ProjectedState } from "./project.ts";
import { MAX_CHAT, MAX_OWNERS, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { Tx } from "./reducer/tx.ts";
import { AT, DM, P1, P2, chance, effect, member, pick, randomState, rng, room, token } from "./testutil.ts";

/**
 * The room log's rings (shared/logRings.ts, design 7.3). The randomized
 * test writes long runs of mixed lines, several to an op as real ops do,
 * while members come and go, and checks after them what must always hold:
 *
 * 1. Bounds: the shared lines are at most MAX_LOG, the DM lines at most
 *    `dmLogLines`, each player's copies of party lines inside their ring
 *    (memberRing), no copy of a member gone, and the whispers inside the
 *    room's count and bytes.
 * 2. Own newest: the shared lines, the DM lines, each player's copies and
 *    each member's whispers are their ring's newest, less those older than
 *    the oldest shared line once the shared lines are full.
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

/**
 * Writes lines as one op does, at `seq`: the room after it, what the op touched, every line it wrote and each line's
 * own, in the order written: the line, and a party line's copies after it.
 */
function write(state: RoomState, lines: readonly Line[], seq: number): { state: RoomState; touched: EntityKey[]; written: LogEntry[]; copies: LogEntry[][] } {
  const tx = new Tx(state, DM, { seq, at: AT });
  for (const line of lines) tx.addLog(line);
  tx.finish();
  const copies: LogEntry[][] = [];
  for (const e of tx.log) {
    if (lineAudience(e) === "party") copies.at(-1)!.push(e);
    else copies.push([e]);
  }
  assert.equal(copies.length, lines.length);
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

const bytesOf = (lines: readonly LogEntry[]) => lines.reduce((n, e) => n + serializedBytes(e), 0);

/** A member's ring of `lines`, theirs in id order: the newest while their count and bytes stay inside `bound`. */
function ringOf(lines: readonly LogEntry[], bound: MemberRing): LogEntry[] {
  const out: LogEntry[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < bound.lines; i--) {
    const size = serializedBytes(lines[i]!);
    if (bytes + size > bound.bytes) break;
    bytes += size;
    out.unshift(lines[i]!);
  }
  return out;
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
      const joinedAt = new Map<string, number>();
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
          if ("join" in plan) {
            joins++;
            joinedAt.set(plan.join, seq);
          }
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
        const copyRing = memberRing("party", roster.length);
        for (const reader of roster) {
          const held = party.filter((e) => e.to![0] === reader);
          assert.ok(held.length <= copyRing.lines && bytesOf(held) <= copyRing.bytes, `${where}: ${reader} holds ${held.length} copies`);
          const theirs = history.filter((e) => lineAudience(e) === "party" && e.to![0] === reader && sinceFloor(e));
          assert.deepEqual(held.map((e) => e.id), theirs.slice(theirs.length - held.length).map((e) => e.id), `${where}: ${reader}'s copies are their newest`);
        }
        assert.ok(party.every((e) => e.to!.length === 1 && roster.includes(e.to![0]!)), `${where}: every copy names one current member`);
        assert.ok(party.every((e) => e.copyOf !== undefined && dmNumbered(e.copyOf) && e.copyOf.startsWith(e.id.slice(0, e.id.indexOf(":") + 1))), `${where}: every copy names a DM line of its op`);
        const whispers = state.log.filter((e) => e.kind === "whisper");
        assert.ok(whispers.length <= LIMITS.whispersPerRoom && bytesOf(whispers) <= LIMITS.whisperBytesPerRoom, `${where}: ${whispers.length} whispers`);
        // Each ring keeps at least its bound at the largest roster the run can have, of the lines since its member last joined.
        const largest = MEMBERS.length + GUESTS.length;
        for (const m of roster) {
          const since = (e: LogEntry) => sinceFloor(e) && Number(e.id.slice(0, e.id.indexOf(":"))) > (joinedAt.get(m) ?? 0);
          const newest = [
            ...ringOf(history.filter((e) => e.kind === "whisper" && whisperParties(e).includes(m) && since(e)), memberRing("whisper", largest)),
            ...ringOf(history.filter((e) => lineAudience(e) === "party" && e.to![0] === m && since(e)), memberRing("party", largest)),
          ];
          const held = new Set(state.log);
          assert.deepEqual(newest.filter((e) => !held.has(e)).map((e) => e.id), [], `${where}: ${m}'s newest whispers and copies stay`);
        }
        assert.deepEqual(droppedLines(state.log, state.members), [], `${where}: the rings hold what they keep`);

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
          if (viewer.role !== "dm") assert.ok([...live, ...readable].every((e) => e.parts === undefined && e.copyOf === undefined), `${name}: a DM's field reached a player`);
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
      const mounts = history.filter((e) => lineAudience(e) === "party" && e.data?.type === "hp" && e.data.tokenId === "mount");
      assert.ok(mounts.some((e) => e.to![0] === "p1") && mounts.some((e) => e.to![0] === "p2"), `seed ${seed}: a line two players read`);
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

  test("the players' trap lines count with the shared lines, so a line that settles apart leaves no gap in either", () => {
    const tx = new Tx({ ...base(), trapSeen: [] }, DM, { seq: 5, at: AT });
    tx.addEvent({ type: "hp", tokenId: "gob", change: "damage", amount: 2 });
    tx.addTrapLine("trapSeen", { type: "trapSeen", by: [], message: "Darts fly from the wall." }, LIMITS.trapSeenLines);
    tx.addLog({ kind: "chat", from: "dm1", text: "Ouch." });
    tx.finish();
    assert.deepEqual(tx.state.trapSeen.map((e) => e.id), ["5:0"]);
    assert.deepEqual(tx.state.log.map((e) => [e.id, e.kind]), [["5:1", "chat"], ["5:900000", "event"]], "the goblin's line is the DM's, numbered when it was written");
    assert.deepEqual(tx.touched().filter((k) => k.startsWith("log:") || k.startsWith("trapSeen:")).sort(), ["log:5:1", "log:5:900000", "trapSeen:5:0"]);
  });

  test("a DM line too long for its ring is cut, as trap lines are, and keeps its place in the live log", () => {
    const vitals = (cur: number) => ({ hp: { cur, max: 7, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
    const removed = Array.from({ length: 80 }, (_, i) => effect(`e${i}`, { key: "custom", label: "x".repeat(60) }));
    const hp: Line = { kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 7, revert: { before: vitals(7), after: vitals(0), removed } } };
    const chat = (text: string): Line => ({ kind: "chat", from: "dm1", text });
    const out = write(base(), [chat("a"), hp, chat("b")], 3);
    const cut = out.state.log.find((e) => e.data?.type === "hp")!;
    assert.ok(serializedBytes(cut) <= LIMITS.apartLineBytes);
    assert.deepEqual(cut.data, { type: "hp", tokenId: "gob", change: "damage", amount: 7 }, "only the take-back's record went");
    assert.deepEqual(out.written.find((e) => e.id === cut.id), cut, "the archive holds the same line");
    assert.deepEqual(liveLog(out.state, DM).map((e) => e.id), ["3:0", "3:1", cut.id]);
    // Text no event line uses goes first, as from a hand-made file.
    const stray = cutLine({ id: "4:900000", at: AT, kind: "event", text: "x".repeat(9000), data: { type: "teleport", tokenId: "gob", past: "wall" } });
    assert.deepEqual(stray, { id: "4:900000", at: AT, kind: "event", data: { type: "teleport", tokenId: "gob", past: "wall" } });
  });

  test("an op's lines leave memory a ring at a time, so a lookup of them reads the archive once one the viewer reads may have gone", () => {
    const pet: Line = { kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 1 } };
    let state = write(base(), [{ kind: "chat", from: "dm1", text: "first" }], 1).state;
    state = write(state, [{ kind: "chat", from: "dm1", text: "a" }, pet], 2).state;
    const keep = memberRing("party", Object.keys(state.members).length).lines;
    for (let i = 0; i < keep; i++) state = write(state, [pet], 3 + i).state;
    assert.ok(state.log.some((e) => e.id === "2:0"), "the op's chat line is still here");
    assert.ok(!state.log.some((e) => e.to?.[0] === "p1" && e.id.startsWith("2:")), "P1's copy of its line went");
    assert.equal(holdsOp(state, P1, 2), false);
    assert.equal(holdsOp(state, P2, 2), true, "P2 reads only the chat line, which is here");
    assert.equal(holdsOp(state, P1, 2 + keep), true);
    assert.equal(holdsOp(state, P2, 1), false, "the oldest op the log holds may have lost lines to the shared lines' floor");
  });

  test("dmNumbered and countedApart tell the DM's count and the party lines' from the shared one", () => {
    assert.equal(dmNumbered("12:899999"), false);
    assert.equal(dmNumbered("12:900000"), true);
    assert.equal(countedApart("12:799999"), false);
    assert.equal(countedApart("12:800000"), true);
    assert.equal(PARTY_SLOT * LIMITS.membersPerRoom, DM_LINE_BASE - PARTY_LINE_BASE, "every member's run fits below the DM's lines");
  });
});

describe("a line's readers, fixed when it is written (shared/project.ts lineReach)", () => {
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

  test("a line two players read is the DM's, with a copy for each reader as they read it, each player's ids counting on in their own run", () => {
    const out = write(base(), [{ kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 1 } }, { kind: "event", data: { type: "hp", tokenId: "mount", change: "damage", amount: 2 } }, { kind: "event", data: { type: "hp", tokenId: "hero", change: "damage", amount: 3, seen: true } }], 9);
    const ranks = rosterRanks(base().members);
    const run = (id: string) => PARTY_LINE_BASE + ranks.get(id)! * PARTY_SLOT;
    assert.deepEqual(out.written.map((e) => [e.id, e.to]), [
      ["9:900000", undefined],
      [`9:${run("p1")}`, ["p1"]],
      ["9:900001", undefined],
      [`9:${run("p1") + 1}`, ["p1"]],
      [`9:${run("p2")}`, ["p2"]],
      ["9:0", undefined],
    ]);
    assert.deepEqual(liveLog(out.state, P2).map((e) => [e.id, e.to]), [["9:0", undefined], [`9:${run("p2")}`, ["p2"]]]);
    assert.deepEqual(liveLog(out.state, DM).map((e) => e.id), ["9:0", "9:900000", "9:900001"], "the DM reads the mount's line once");
    const reach = lineReach(out.state, { kind: "event", data: { type: "hp", tokenId: "mount", change: "damage" } });
    assert.deepEqual(reach.audience === "party" ? reach.views.map(([id]) => id) : reach, ["p1", "p2"]);
  });

  test("a copy holds only what its reader read, and the DM's line all of it", () => {
    const vitals = (cur: number) => ({ hp: { cur, max: 7, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
    const out = write(base(), [{ kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 4, left: { cur: 3, max: 7, temp: 0 }, label: "Bloodied", revert: { before: vitals(7), after: vitals(3) } } }], 4);
    const [dm, copy] = out.written;
    assert.ok(dm!.data?.type === "hp" && dm!.data.revert !== undefined, "the DM's line keeps the take-back's record");
    assert.deepEqual(copy!.data, { type: "hp", tokenId: "pet", change: "damage", amount: 4, left: { cur: 3, max: 7, temp: 0 }, label: "Bloodied" });
  });

  test("a player's own copies start their live log once they hold their bound, with no gap", () => {
    let state = base();
    const keep = memberRing("party", Object.keys(state.members).length).lines;
    for (let i = 0; i < keep + 10; i++) state = write(state, [{ kind: "chat", from: "dm1", text: `c${i}` }, { kind: "event", data: { type: "hp", tokenId: "pet", change: "damage", amount: 1 } }], i + 1).state;
    const own = state.log.filter((e) => e.to?.[0] === "p1");
    assert.equal(own.length, keep);
    const live = liveLog(state, P1);
    assert.equal(live[0]!.id, own[0]!.id, "it starts at the oldest they hold");
    assert.equal(live.length, keep * 2 - 1, "with every chat line since");
    assert.equal(liveLog(state, P2).length, keep + 10, "P2's, which holds none, keeps every chat line");
  });

  test("a member who leaves takes their copies, and the DM keeps every line, with no gap", () => {
    let state = base();
    state.members.g1 = member("g1");
    state.tokens.gpet = token("gpet", { visibility: "dm", ownerIds: ["g1"] });
    state.tokens.shared = token("shared", { visibility: "dm", ownerIds: ["p1", "g1"] });
    let seq = 1;
    for (let i = 0; i < 40; i++) state = write(state, [{ kind: "event", data: { type: "hp", tokenId: i % 2 === 0 ? "gpet" : "shared", change: "damage", amount: 1 } }, { kind: "chat", from: "dm1", text: `c${i}` }], ++seq).state;
    assert.equal(state.log.filter((e) => e.to?.[0] === "g1").length, 40);
    const r = applyOp(state, { t: "sys.memberRemove", memberId: "g1" }, DM, { seq: ++seq, at: AT });
    assert.ok(r.ok);
    assert.equal(r.state.log.filter((e) => e.to?.[0] === "g1").length, 0, "a copy no one reads goes with its reader");
    assert.equal(r.state.log.filter((e) => e.to?.[0] === "p1").length, 20, "P1's copies of the shared creature's lines stay");
    assert.equal(r.state.log.filter((e) => dmNumbered(e.id)).length, 40, "the DM keeps every line");
    const live = liveLog(r.state, DM);
    assert.equal(live.filter((e) => e.kind === "chat").length, 40);
    assert.equal(live.filter((e) => e.data?.type === "hp").length, 40);
  });

  test("a copy is cut as a DM line is, by what its reader read", () => {
    const rolls = Array.from({ length: 20 }, (_, i) => ({ ...die(), label: `${"x".repeat(500)}${i}`, tokenId: "pet" }));
    const out = write(base(), [{ kind: "event", data: { type: "dice", by: "dm1", to: "all", rolls } }], 6);
    const copy = out.written.find((e) => e.to?.[0] === "p1")!;
    assert.ok(serializedBytes(copy) <= LIMITS.apartLineBytes);
    assert.ok(copy.data?.type === "dice" && copy.data.rolls.length < 20 && copy.data.rolls.length > 0, "rolls went from the end");
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

  const whisper = (n: number, from: string, to: string, text = `w${n}`): LogEntry => ({ id: `${n}:0`, at: AT, kind: "whisper", from, to: [to], text });

  test("each member keeps 50, fewer past 8 members, so a room never holds more than 400", () => {
    assert.equal(memberRing("whisper", 8).lines, 50);
    assert.equal(memberRing("whisper", 9).lines, 44);
    assert.equal(memberRing("whisper", 50).lines, 8);
    for (const players of [3, 7, 19, 49]) {
      const state = roster(players);
      const keep = memberRing("whisper", players + 1).lines;
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

  test("each member keeps their share of the room's bytes too, so long letters never hold more than the old ring did", () => {
    // 1,000 letters of three bytes each, the longest text a whisper takes.
    const long = "\u4e00".repeat(1000);
    for (const players of [1, 7, 19, 49]) {
      const state = roster(players);
      const ring = memberRing("whisper", players + 1);
      state.log = [];
      let n = 0;
      for (let round = 0; round < 60; round++) for (let i = 1; i <= players; i++) state.log.push(whisper(++n, `p${i}`, "dm1", long));
      const dropped = new Set(droppedLines(state.log, state.members));
      const held = state.log.filter((e) => !dropped.has(e.id));
      assert.ok(bytesOf(held) <= LIMITS.whisperBytesPerRoom, `${players} players: ${bytesOf(held)} bytes`);
      for (const id of Object.keys(state.members)) {
        const theirs = state.log.filter((e) => whisperParties(e).includes(id));
        const newest = ringOf(theirs, ring);
        assert.ok(newest.length > 0 && newest.every((e) => !dropped.has(e.id)), `${players} players: ${id}'s newest stay`);
        assert.ok(bytesOf(newest) <= ring.bytes);
        // The live log starts where the ring's bytes pass its bound less the longest line, so a whisper it dropped is never inside it.
        const start = liveStart({ log: held, members: state.members }, { memberId: id, role: id === "dm1" ? "dm" : "player" });
        const live = start === null ? theirs : theirs.filter((e) => compareLogIds(e.id, start) >= 0);
        assert.ok(live.every((e) => !dropped.has(e.id)), `${players} players: ${id}'s live log holds no whisper the ring dropped`);
      }
    }
  });

  test("a ring holds its newest while they fit and none older, so a short whisper behind a long one that did not fit goes too", () => {
    const state = roster(49);
    const long = "\u4e00".repeat(1000);
    state.log = [whisper(1, "p1", "dm1", "short"), ...Array.from({ length: 5 }, (_, i) => whisper(2 + i, "p1", "dm1", long))];
    const ring = memberRing("whisper", 50);
    assert.ok(4 * serializedBytes(state.log[1]!) <= ring.bytes && 5 * serializedBytes(state.log[1]!) > ring.bytes, "four long ones fit, five do not");
    assert.deepEqual(droppedLines(state.log, state.members).sort(), ["1:0", "2:0"]);
  });

  test("the longest whisper the protocol takes fits a line apart, so a ring always holds its newest", () => {
    const id = "m".repeat(64);
    const longest: LogEntry = { id: `${"9".repeat(18)}:999999`, at: AT, kind: "whisper", from: id, to: Array.from({ length: MAX_OWNERS }, (_, i) => `${id.slice(2)}${String(i).padStart(2, "0")}`), text: "\u4e00".repeat(MAX_CHAT) };
    assert.ok(serializedBytes(longest) <= LIMITS.apartLineBytes, `${serializedBytes(longest)} bytes`);
    assert.ok(memberRing("whisper", LIMITS.membersPerRoom).bytes > LIMITS.apartLineBytes);
    assert.ok(memberRing("party", LIMITS.membersPerRoom).bytes > LIMITS.apartLineBytes);
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
