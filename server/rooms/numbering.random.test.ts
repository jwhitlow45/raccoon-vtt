import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { edge, paint } from "#shared/discoveryTestutil.ts";
import { allKeys } from "#shared/project.ts";
import type { RoomState, Scene, Token } from "#shared/model.ts";
import { boardLabel, numberable, numberScope, previewNumbers, shownName } from "#shared/numbering.ts";
import type { Op } from "#shared/protocol.ts";
import { chance, character, comparable, int, member, pick, rng, scene } from "#shared/testutil.ts";
import { applyOp } from "#shared/reducer.ts";
import { counted } from "./counted.ts";
import { meetOps } from "./meet.ts";
import { growthBound, measuredStateBytes } from "./sizeGuard.ts";
import { creature, inF, inR, liveIsFresh, make, move, numberingRoom, patch, Room, same, viewOf, type Rooms, type Who } from "./numberingTesting.ts";

/**
 * Creature numbers' random pair run: room A and room B take the same
 * random members' ops, and room A alone takes other DMs' ops on
 * creatures the party's copy never holds. After every step:
 * - I1: P1's raw frames are the same in both rooms.
 * - I2: no two members of a group share a number, and at most one has none.
 * - I3: every number a player frame carries is the table's, and no player
 *   frame holds a group mark, scene numbers or the group count.
 * - I4: replaying the step's rows gives the committed state, and across
 *   each `sys.meet` among them no measure rises and the growth bound is 0.
 * - I5: on the DM's copy no two creatures of a scene share a numbered or
 *   previewed label.
 * - I6: the DM's live copy is a fresh snapshot.
 * - I7: a room loaded again from its rows holds the state it stopped with.
 * - I8: a meeting of every creature on the committed state finds nothing
 *   left to meet, so skipping a batch's meeting skipped nothing.
 * NUMBERING_RUNS sets the runs (the private gate runs 300) and
 * NUMBERING_FIRST the first seed. A run with ONE_SIDED=0 drops room A's own
 * steps.
 */

const RUNS = Number(process.env.NUMBERING_RUNS ?? 6);
const FIRST = Number(process.env.NUMBERING_FIRST ?? 1);
const STEPS = Number(process.env.NUMBERING_STEPS ?? 120);
const ONE_SIDED = process.env.ONE_SIDED !== "0";

const NAMES = ["Goblin", "Goblin", "Goblin", "Orc", "Hooded figure", "Unknown creature"] as const;
const DOOR = "12,5,w";
/** Cells the generator picks from: room R, the passage, room F, and room F's far side. */
function cell(r: () => number): { x: number; y: number } {
  return pick(r, [() => inR(int(r, -4, 4), int(r, 0, 5)), () => ({ x: int(r, 13, 22), y: 5 }), () => inF(int(r, -2, 7), int(r, 0, 5))])();
}

/** The fixture: the numbering room with a door into F, an upper floor, scene s2 with fog off, a second DM, P2's character and one no player plays. */
function fixture(): RoomState {
  const s = numberingRoom();
  paint(s, { x: 12, y: 5, w: 12, h: 1 });
  edge(s, DOOR, { kind: "door", state: "closed", secret: false, discovered: false });
  const ground = s.scenes.s1!;
  s.scenes.s1 = { ...ground, floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } } as Scene;
  s.scenes.up = scene("up", { name: ground.name, order: 0, bounds: ground.bounds, floor: { of: "s1", level: 1, name: "Upper floor", height: 10 } });
  s.scenes.s2 = { ...s.scenes.s2!, fogEnabled: false };
  // A third DM takes room A's steps on creatures both rooms hold and never undoes them, so the second DM's Undo reaches only creatures room A alone holds.
  s.members.dm3 = member("dm3", "dm");
  s.characters.bree = character("bree", { name: "Bree", ownerIds: ["p2"] });
  s.characters.npcc = character("npcc", { name: "Captain", ownerIds: [] });
  for (let i = 0; i < 4; i++) s.tokens[`g${i}`] = creature(`g${i}`, i < 2 ? inR(i) : inF(i), { name: "Goblin" });
  return s;
}

type Step = { k: "op"; who: Who; op: Op } | { k: "ops"; who: Who; ops: Op[] } | { k: "undo" | "redo"; who: Who } | { k: "reload" } | { k: "restart"; snapshot: boolean } | { k: "kind"; memberId: string; kind: "dm" | "player" };

/** The creatures both rooms hold, by id, in order. */
const shared = (state: RoomState) => Object.keys(state.tokens).filter((id) => !id.startsWith("zq") && state.tokens[id]!.kind !== "pc").sort();

function sharedStep(r: () => number, state: RoomState, other: RoomState, made: () => string): Step {
  const ids = shared(state);
  const any = () => (ids.length > 0 ? pick(r, ids) : "g0");
  // A companion made an object reads with no HP to players whoever plays it, so an object is made only of a creature both rooms hold alike as a companion or not.
  const alike = ids.filter((id) => JSON.stringify(state.tokens[id]!.companion) === JSON.stringify(other.tokens[id]?.companion));
  const anyAlike = () => (alike.length > 0 ? pick(r, alike) : "g0");
  switch (int(r, 0, 19)) {
    case 0:
    case 1:
      return { k: "op", who: "p1", op: move("a", cell(r)) };
    case 2:
      return { k: "op", who: "p2", op: move("b", cell(r)) };
    case 3:
      return { k: "op", who: "dm", op: { t: "door.set", sceneId: "s1", door: { edge: DOOR }, state: pick(r, ["open", "closed"] as const) } };
    case 4: {
      const name = pick(r, NAMES);
      return { k: "op", who: "dm", op: make(made(), cell(r), { name, visibility: chance(r, 0.8) ? "all" : "dm", ...(chance(r, 0.2) ? { nameHidden: true, ...(chance(r, 0.5) ? { publicName: pick(r, NAMES) } : {}) } : {}) }) };
    }
    case 5:
      return { k: "op", who: "dm", op: patch(any(), { name: pick(r, NAMES) }) };
    case 6:
      return { k: "op", who: "dm", op: patch(any(), chance(r, 0.5) ? { nameHidden: chance(r, 0.6), ...(chance(r, 0.5) ? { publicName: pick(r, NAMES) } : {}) } : { nameHidden: false }) };
    case 7:
      return { k: "op", who: "dm", op: { t: "token.delete", tokenId: any() } };
    case 8:
      return { k: "op", who: "dm", op: patch(any(), { visibility: pick(r, ["all", "dm"] as const) }) };
    case 9:
      return { k: "op", who: "dm", op: move(any(), cell(r)) };
    case 10:
      return { k: "op", who: "dm", op: { t: "view.blackout", blackout: chance(r, 0.4) } };
    case 11:
      return { k: "op", who: "dm", op: patch(any(), { sceneId: pick(r, ["s1", "up"]), ...cell(r) }) };
    case 12:
      return { k: "op", who: "dm", op: { t: "floor.open", sceneId: "up", open: chance(r, 0.5) } };
    case 13:
      return { k: "op", who: "dm", op: patch(anyAlike(), { kind: pick(r, ["monster", "monster", "npc", "object"] as const) }) };
    case 14:
      return { k: "op", who: "dm", op: patch(any(), { sceneId: pick(r, ["s1", "s2"]), ...cell(r) }) };
    case 15:
      return { k: "op", who: "dm", op: patch(any(), { companion: chance(r, 0.6) ? { of: pick(r, ["bree", "npcc"]), turn: "shared" } : null }) };
    case 16:
      return { k: "kind", memberId: "p2", kind: pick(r, ["dm", "player"] as const) };
    case 17:
      // While room A alone holds a creature as a companion, the DM's Undo of a step on it is refused there as changed since, rightly, so only a player undoes then.
      return { k: chance(r, 0.6) ? "undo" : "redo", who: alike.length === ids.length ? pick(r, ["dm", "dm", "p1"] as const) : "p1" };
    case 18:
      return { k: "reload" };
    default:
      return chance(r, 0.5) ? { k: "restart", snapshot: chance(r, 0.4) } : { k: "op", who: "p1", op: move("a", cell(r)) };
  }
}

/** A step room A alone takes, by its second or third DM, on creatures P1's copy never holds or on what it cannot read of them: each is chosen to leave that copy alone. */
function oneSided(r: () => number, state: RoomState, p1Holds: ReadonlySet<string>, made: () => string): Step | null {
  const mine = Object.keys(state.tokens).filter((id) => id.startsWith("zq")).sort();
  const away = shared(state).filter((id) => !p1Holds.has(id) && state.tokens[id]!.visibility === "dm");
  // A name-hidden creature's own name reaches no player's copy but its owners', wherever it stands.
  const veiled = shared(state).filter((id) => state.tokens[id]!.nameHidden && state.tokens[id]!.ownerIds.length === 0);
  const zq = () => pick(r, mine);
  switch (int(r, 0, 10)) {
    case 10: {
      // A name-hidden creature privately renamed and named back.
      if (!veiled.length) return null;
      const id = pick(r, veiled);
      return { k: "ops", who: "dm3", ops: [patch(id, { name: "Zqvaro" }), patch(id, { name: state.tokens[id]!.name })] };
    }
    case 0:
    case 1: {
      const disguise = chance(r, 0.3);
      return { k: "op", who: "dm2", op: make(made(), cell(r), { name: disguise ? "Zqorc" : pick(r, NAMES), visibility: "dm", sceneId: pick(r, ["s1", "s1", "up", "s2"]), ...(disguise ? { nameHidden: true, publicName: pick(r, NAMES) } : {}) }) };
    }
    case 2:
      return mine.length ? { k: "op", who: "dm2", op: { t: "token.delete", tokenId: zq() } } : null;
    case 3:
      return mine.length ? { k: "op", who: "dm2", op: patch(zq(), chance(r, 0.5) ? { name: pick(r, NAMES) } : { nameHidden: chance(r, 0.5), publicName: pick(r, NAMES) }) } : null;
    case 4:
      return mine.length ? { k: "op", who: "dm2", op: patch(zq(), { sceneId: pick(r, ["s1", "s2", "up"]), ...cell(r) }) } : null;
    case 5:
      return mine.length ? { k: "op", who: "dm2", op: patch(zq(), { companion: chance(r, 0.6) ? { of: "npcc", turn: "shared" } : null }) } : null;
    case 6:
      return { k: chance(r, 0.6) ? "undo" : "redo", who: "dm2" };
    case 7:
      return { k: "op", who: "dm2", op: { t: "journal.create", page: { id: made(), title: "Zq notes", access: "dm", blocks: [{ id: `${made()}block`.slice(0, 12).padEnd(12, "0"), text: "Zq ".repeat(int(r, 10, 400)) }] } } as Op };
    case 8: {
      if (!away.length) return null;
      const id = pick(r, away);
      // Only a creature no one owns, to or from the character no player plays: a party member's companion is played, owned and lends its sight.
      const t0 = state.tokens[id]!;
      if (chance(r, 0.5)) return t0.kind === "object" || t0.ownerIds.length > 0 || (t0.companion !== undefined && t0.companion.of !== "npcc") ? null : { k: "op", who: "dm3", op: patch(id, { companion: t0.companion ? null : { of: "npcc", turn: "shared" } }) };
      // A hidden namesake renamed and named back, or its name hidden and shown: its mark is left as it was.
      const t = state.tokens[id]!;
      const there = chance(r, 0.5) ? [{ name: "Zqorc" }, { name: t.name }] : [{ nameHidden: !t.nameHidden }, { nameHidden: t.nameHidden }];
      return { k: "ops", who: "dm3", ops: there.map((p) => patch(id, p)) };
    }
    default:
      return { k: "op", who: "dm2", op: { t: "scene.duplicate", sceneId: "s2", newSceneId: made(), name: "Zq copy" } as Op };
  }
}

/** What a step answered: each op's refusal code, or "taken". */
async function take(room: Room, step: Step): Promise<string> {
  switch (step.k) {
    case "op": {
      const event = await room.send(step.who, step.op);
      return event.rejects?.find((x) => x.n === room.clients[step.who].n)?.code ?? "taken";
    }
    case "undo":
    case "redo": {
      const head = room.clients[step.who].history().play?.[step.k].head;
      if (!head) return "none";
      room.clock.now += 1_000;
      const event = await room.clients[step.who].send({ t: step.k, scope: "play", head: head.id });
      await room.settle();
      return event.rejects?.find((x) => x.n === room.clients[step.who].n)?.code ?? "taken";
    }
    case "ops": {
      const codes: string[] = [];
      for (const op of step.ops) {
        const event = await room.send(step.who, op);
        codes.push(event.rejects?.find((x) => x.n === room.clients[step.who].n)?.code ?? "taken");
      }
      return codes.join(",");
    }
    case "reload":
      await room.reloadP1();
      return "reloaded";
    case "restart": {
      const before = comparable(room.state);
      const kinds = Object.values(room.state.members).map((m) => [m.id, m.kind] as const);
      await room.restart(step.snapshot);
      // A member's kind lives in the members table, which the stored room's stand-in keeps as the fixture made it.
      for (const [memberId, kind] of kinds) {
        if (room.state.members[memberId]?.kind === kind || (kind !== "dm" && kind !== "player")) continue;
        await room.actor.sys({ t: "sys.memberSetKind", memberId, kind });
        await room.settle();
      }
      // I7.
      assert.deepEqual(comparable(room.state), before, `${room.name}: the room loaded again holds the state it stopped with`);
      return "restarted";
    }
    case "kind":
      room.clock.now += 1_000;
      await room.actor.sys({ t: "sys.memberSetKind", memberId: step.memberId, kind: step.kind });
      await room.settle();
      return "kind";
  }
}

/** I2: in each group, numbers are distinct and at most one member has none. */
function i2(room: Room, where: string): void {
  const groups = new Map<number, Array<number | undefined>>();
  for (const t of Object.values(room.state.tokens)) {
    if (t.met === undefined) continue;
    const scope = room.state.scenes[numberScope(room.state, t)];
    const entry = scope?.numbers?.names[shownName(t)];
    if (!entry || entry[0] !== t.met) continue;
    const list = groups.get(t.met) ?? [];
    list.push(t.number);
    groups.set(t.met, list);
  }
  for (const [g, list] of groups) {
    const numbers = list.filter((n) => n !== undefined);
    assert.equal(new Set(numbers).size, numbers.length, `${where}: ${room.name}: group ${g} gives no number twice: ${JSON.stringify(list)}`);
    assert.ok(list.length - numbers.length <= 1, `${where}: ${room.name}: at most one member of group ${g} has no number: ${JSON.stringify(list)}`);
  }
}

/** I5: on the DM's copy, no two creatures of a scene share a label that carries a number or a preview. */
function i5(room: Room, where: string): void {
  // A DM's copy holds every creature, character and scene as stored, which the rules read as the room's.
  const view = viewOf(room.clients.dm.sent) as unknown as RoomState;
  const byScope = new Map<string, Map<string, string>>();
  for (const t of Object.values(view.tokens as Record<string, Token>)) {
    if (!numberable(view, t)) continue;
    const scopeId = numberScope(view, t);
    let labels = byScope.get(scopeId);
    if (!labels) byScope.set(scopeId, (labels = new Map()));
    const previews = previewNumbers(view, scopeId);
    if (t.number === undefined && !previews.has(t.id)) continue;
    const label = boardLabel(previews, t, "dm");
    assert.equal(labels.get(label), undefined, `${where}: ${room.name}: ${t.id} and ${labels.get(label)} both read ${JSON.stringify(label)} on the DM's board`);
    labels.set(label, t.id);
  }
}

/** I4: the step's rows, replayed on the state before it, give the committed state, and no meeting among them moves a measure. */
function i4(room: Room, before: RoomState, fromSeq: number, where: string): number {
  let state = before;
  let meets = 0;
  const rows = [...room.rows.values()].filter((row) => row.seq > fromSeq).sort((x, y) => x.seq - y.seq);
  for (const row of rows) {
    const op = row.op as Op;
    const uncounted = !counted(op.t, row.opVersion);
    const result = applyOp(state, op, { memberId: row.actorMemberId, role: row.actorRole }, { seq: row.pub ?? row.seq, at: row.at, opVersion: row.opVersion, ...(uncounted ? { uncounted: true as const } : {}) });
    assert.ok(result.ok, `${where}: ${room.name}: row ${row.seq} (${op.t}) replays: ${result.ok ? "" : result.message}`);
    if (op.t === "sys.meet") {
      meets++;
      assert.ok(measuredStateBytes(result.state) <= measuredStateBytes(state), `${where}: ${room.name}: the meeting at row ${row.seq} raised the measure from ${measuredStateBytes(state)} to ${measuredStateBytes(result.state)}`);
      assert.equal(growthBound(state, result.state, result.touched), 0, `${where}: ${room.name}: the meeting at row ${row.seq} has a growth bound`);
    }
    state = result.state;
  }
  assert.deepEqual(comparable(state), comparable(room.state), `${where}: ${room.name}: the step's rows replay to the committed state`);
  return meets;
}

/** I8: nothing on the committed state is left to meet. */
function i8(room: Room, where: string): void {
  const state = room.state;
  const keys = [...allKeys(state), "member:dm1"] as Parameters<typeof meetOps>[2];
  assert.deepEqual(meetOps(state, state, keys, { skip: false }), [], `${where}: ${room.name}: a meeting of every creature finds nothing left`);
}

export type Counts = { steps: number; oneSided: number; numbered: number; frames: number; restarts: number; meets: number };

export async function numberingRun(t: TestContext, seed: number, steps: number, counts: Counts, oneSidedOn = ONE_SIDED): Promise<void> {
  const r = rng(seed);
  const pair: Rooms = [new Room(t, "A", fixture()), new Room(t, "B", fixture())];
  // The fixture writes its creatures straight into the state, so a first batch on a creature meets the ones in sight, as the batches that brought them would have.
  for (const room of pair) {
    await room.load();
    await room.apply("dm", move("g0", inR(0, 1)));
  }
  same(pair, `seed ${seed}, opened`, { a: ["zq", "Zq"] });
  let n = 0;
  const made = () => `n${seed}x${++n}`;
  let zq = 0;
  const madeZq = () => `zq${seed}x${++zq}`;
  for (let i = 0; i < steps; i++) {
    const where = `seed ${seed}, step ${i}`;
    const a = pair[0];
    if (oneSidedOn && chance(r, 0.4)) {
      const held = new Set(Object.keys(a.p1View().tokens));
      const step = oneSided(r, a.state, held, madeZq);
      if (step) {
        await take(a, step);
        // Clocks move alike in both rooms, as shared steps move them, so the room count reads alike.
        pair[1].clock.now = a.clock.now;
        counts.oneSided++;
        same(pair, `${where} (A alone: ${JSON.stringify(step)})`, { a: ["zq", "Zq"] });
      }
    }
    const step = sharedStep(r, a.state, pair[1].state, made);
    const answers: string[] = [];
    const befores = pair.map((room) => ({ state: room.state, seq: room.actor.committed.seq }));
    for (const room of pair) answers.push(await take(room, step));
    assert.equal(answers[0], answers[1], `${where}: ${JSON.stringify(step)} answered alike`);
    if (step.k === "restart") counts.restarts++;
    counts.steps++;
    // I1 and I3, P1's frames scanned raw first.
    same(pair, `${where}: ${JSON.stringify(step)}`, { a: ["zq", "Zq"] });
    for (const room of pair) {
      for (const frame of room.clients.p2.sent) {
        const raw = JSON.stringify(frame);
        assert.ok(!/"(met|numbers|numbering)":/.test(raw), `${where}: ${room.name}: P2's frame holds a group mark, scene numbers or the count: ${raw.slice(0, 300)}`);
      }
      i2(room, where);
      const k = pair.indexOf(room);
      if (step.k !== "restart") counts.meets += i4(room, befores[k]!.state, befores[k]!.seq, where);
      i5(room, where);
      liveIsFresh(room, "dm", where);
      i8(room, where);
    }
    counts.numbered += Object.values(a.state.tokens).filter((x) => x.number !== undefined && x.met !== undefined).length > 0 ? 1 : 0;
  }
  counts.frames += pair[0].p1Frames().length;
}

describe("creature numbers' random pair run", () => {
  test(`rooms that differ out of the party's sight give P1 the same frames (${RUNS} runs of ${STEPS} steps from seed ${FIRST})`, async (t) => {
    const counts: Counts = { steps: 0, oneSided: 0, numbered: 0, frames: 0, restarts: 0, meets: 0 };
    for (let seed = FIRST; seed < FIRST + RUNS; seed++) await numberingRun(t, seed, STEPS, counts);
    t.diagnostic(JSON.stringify(counts));
    assert.ok(counts.numbered >= counts.steps / 4, `steps after which a creature holds a number: ${counts.numbered} of ${counts.steps}`);
    if (ONE_SIDED) assert.ok(counts.oneSided >= counts.steps / 6, `room A's own steps: ${counts.oneSided}`);
  });
});
