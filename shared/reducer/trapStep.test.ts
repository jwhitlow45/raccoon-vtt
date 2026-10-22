import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { BuildChunk, LogEvent, RoomState, Token, Trap, TrapDue, TrapRig, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, P1, actor, env, room, token } from "../testutil.ts";
import { DONE_MEANWHILE, SETTLED_MEANWHILE } from "./traps.ts";

/**
 * The trap step in the reducer (docs/design-v1-traps.md 5, 6.3 and 13.2):
 * what goes off on walks, landings, turns and doors, what it writes, and
 * what it leaves for the DM. P1 plays Thorn. The DM runs everything else.
 */

function rig(overrides: Partial<TrapRig> = {}): TrapRig {
  return { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "A click underfoot.", ...overrides };
}

function trap(id: string, zone: Trap["zone"], overrides: Partial<TrapRig> = {}, extra: Partial<Trap> = {}): Trap {
  return { id, rev: 0, sceneId: "s1", name: id, zone, state: "armed", found: false, rig: rig(overrides), ...extra };
}

const square = (x: number, y: number, w = 1, h = 1): Trap["zone"] => ({ cells: [{ x, y, w, h }] });
const thorn = (over: Partial<Token> = {}) => token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 0, y: 5, ...over });
const goblin = (over: Partial<Token> = {}) => token("gob", { name: "Goblin", x: 0, y: 8, ...over });

const doorChunk = (state: "closed" | "locked" | "open" = "closed"): BuildChunk => ({ sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "9,5,w": { kind: "door", state, secret: false, discovered: false } } });

function world(tokens: Token[], traps: Trap[], tweak: (s: RoomState) => void = () => {}): RoomState {
  const state = room();
  for (const t of tokens) state.tokens[t.id] = t;
  state.traps = Object.fromEntries(traps.map((t) => [t.id, t]));
  tweak(state);
  return state;
}

function applied(state: RoomState, op: Op, who: Viewer = DM, seq = 7): Applied {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.message}`);
  return r;
}

const lines = (state: RoomState) => state.trapLog.map((l) => l.data as LogEvent);
const seenLines = (state: RoomState) => state.trapSeen.map((l) => l.data as LogEvent);
const pos = (state: RoomState, id: string) => [state.tokens[id]!.x, state.tokens[id]!.y];

describe("a walk sets a trap off (5.1, 5.4, 5.5)", () => {
  test("a player's walk onto a plate stops on it, springs it with a use spent, marks it found, and tells the DM and every player", () => {
    const state = world([thorn()], [trap("plate", square(3, 5), { usesLeft: 2, damage: [{ formula: "1d6", type: "bludgeoning" }] })]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1);
    assert.deepEqual(pos(r.state, "thorn"), [3, 5], "stopped where it stepped on it");
    const t = r.state.traps.plate!;
    assert.equal(t.state, "sprung");
    assert.equal(t.rig!.usesLeft, 1);
    assert.equal(t.found, true);
    assert.deepEqual(lines(r.state), [{ type: "trap", trapId: "plate", name: "plate", how: "enter", by: ["thorn"], hits: 1, did: [], seen: [0] }]);
    assert.deepEqual(seenLines(r.state), [{ type: "trapSeen", by: ["thorn"], message: "A click underfoot." }]);
    const due = t.rig!.due!;
    assert.equal(due.length, 1);
    assert.deepEqual({ ...due[0], at: undefined }, { id: r.state.trapLog[0]!.id, at: undefined, how: "enter", by: ["thorn"], hits: ["thorn"], perceived: true, acted: true });
    assert.equal(r.trapped, true, "the step is marked for undo");
    assert.equal(r.state.log.some((l) => l.data?.type === "trap" || l.data?.type === "trapSeen"), false, "no trap line in the shared log");
  });

  test("a silent trap stops nothing and writes no players' line, so the step is not marked", () => {
    const state = world([thorn()], [trap("alarm", square(3, 5), { stops: false, message: undefined, foundOnSpring: false })]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1);
    assert.deepEqual(pos(r.state, "thorn"), [8, 5]);
    assert.equal(r.state.traps.alarm!.state, "sprung");
    assert.equal(r.state.traps.alarm!.found, false);
    assert.deepEqual(r.state.trapSeen, []);
    assert.equal(r.state.trapLog.length, 1);
    assert.equal(r.trapped, undefined);
  });

  test("a sprung or disarmed trap does nothing, and only the players' scene outside a blackout goes off by itself", () => {
    for (const s of ["sprung", "disarmed"] as const) {
      const state = world([thorn()], [trap("plate", square(3, 5), {}, { state: s })]);
      const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1);
      assert.deepEqual(pos(r.state, "thorn"), [8, 5], s);
      assert.deepEqual(r.state.trapLog, []);
    }
    const dark = world([thorn()], [trap("plate", square(3, 5))], (s) => (s.meta.view.blackout = true));
    assert.deepEqual(pos(applied(dark, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }).state, "thorn"), [8, 5]);
    const elsewhere = world([thorn({ sceneId: "s2" })], [trap("plate", square(3, 5), {}, { sceneId: "s2" })]);
    assert.deepEqual(applied(elsewhere, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }).state.trapLog, []);
  });

  test("a teleport goes off only where it lands, a landing from the height controls is a walk down, and setup placements set nothing off", () => {
    const state = world([thorn()], [trap("plate", square(3, 5))]);
    assert.deepEqual(applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5, teleport: "wall" }).state.trapLog, [], "jumped over");
    const onIt = applied(state, { t: "token.move", tokenId: "thorn", x: 3, y: 5, teleport: "wall" }).state;
    assert.equal(onIt.traps.plate!.state, "sprung");
    const flier = world([thorn({ x: 3, elevation: 20 })], [trap("plate", square(3, 5))]);
    assert.equal(applied(flier, { t: "token.update", tokenId: "thorn", patch: { elevation: 0 } }).state.traps.plate!.state, "sprung", "a flier landing on it");
    assert.equal(applied(world([thorn()], [trap("plate", square(3, 5))]), { t: "token.update", tokenId: "thorn", patch: { x: 3, y: 5 } }).state.traps.plate!.state, "armed", "a placement");
  });

  test("a hidden goblin the DM walks onto a plate slams its door, with no line for players, no stop and no found mark", () => {
    const state = world([goblin({ visibility: "dm", y: 5 })], [trap("plate", square(3, 5), { actions: [{ door: { edge: "9,5,w" }, state: "locked" }] })], (s) => (s.buildChunks[chunkKey("s1", 0, 0)] = doorChunk()));
    const r = applied(state, { t: "token.move", tokenId: "gob", x: 8, y: 5 });
    assert.deepEqual(pos(r.state, "gob"), [8, 5], "a trap never stops a hidden creature");
    const edge = r.state.buildChunks[chunkKey("s1", 0, 0)]!.edges["9,5,w"];
    assert.ok(edge?.kind === "door" && edge.state === "locked");
    const t = r.state.traps.plate!;
    assert.equal(t.state, "sprung");
    assert.equal(t.found, false);
    assert.deepEqual(r.state.trapSeen, []);
    assert.deepEqual(lines(r.state), [{ type: "trap", trapId: "plate", name: "plate", how: "enter", by: ["gob"], hits: 1, did: [{ action: 0, ok: true }] }]);
  });

  test("a hidden creature in a player's op leaves the trap armed for them: a hidden occurrence and the DM's line, then nothing more while it waits", () => {
    const familiar = token("imp", { name: "Imp", kind: "npc", ownerIds: ["p1"], visibility: "dm", x: 0, y: 6 });
    const state = world([thorn(), familiar], [trap("plate", square(3, 6))]);
    const op: Op = { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 8, y: 5 }, { tokenId: "imp", x: 8, y: 6 }] };
    const r = applied(state, op, P1);
    const t = r.state.traps.plate!;
    assert.equal(t.state, "armed");
    assert.equal(t.found, false);
    assert.deepEqual(pos(r.state, "imp"), [8, 6]);
    assert.deepEqual(r.state.trapSeen, []);
    assert.deepEqual(lines(r.state), [{ type: "trap", trapId: "plate", name: "plate", how: "enter", by: ["imp"], hits: 1, did: [], hidden: true }]);
    assert.deepEqual(t.rig!.due!.map((d) => [d.hidden, d.acted]), [[true, undefined]]);
    assert.equal(r.trapped, undefined, "a private springing never marks a step");
    // Back and over it again: the trap still waits on the first, so nothing is added.
    const back = applied({ ...r.state }, { t: "token.moveMany", moves: [{ tokenId: "imp", x: 0, y: 6 }] }, P1, 8);
    const again = applied(back.state, { t: "token.moveMany", moves: [{ tokenId: "imp", x: 8, y: 6 }] }, P1, 9);
    assert.equal(again.state.traps.plate!.rig!.due!.length, 1);
    assert.equal(again.state.trapLog.length, 1);
  });

  test("Do its effects then runs the actions and the players' line once, and a second is refused", () => {
    const familiar = token("imp", { name: "Imp", kind: "npc", ownerIds: ["p1"], visibility: "dm", x: 0, y: 6 });
    const state = world([familiar], [trap("plate", square(3, 6), { actions: [{ show: { tokenId: "imp" } }], damage: [{ formula: "1d6", type: "fire" }] })]);
    const r = applied(state, { t: "token.moveMany", moves: [{ tokenId: "imp", x: 8, y: 6 }] }, P1);
    const due = r.state.traps.plate!.rig!.due![0]!;
    const acted = applied(r.state, { t: "trap.act", trapId: "plate", due: due.id }, DM, 8);
    assert.equal(acted.state.tokens.imp!.visibility, "all");
    assert.deepEqual(seenLines(acted.state), [{ type: "trapSeen", by: ["imp"], message: "A click underfoot." }]);
    assert.equal(acted.state.traps.plate!.found, true);
    const second = applyOp(acted.state, { t: "trap.act", trapId: "plate", due: due.id }, DM, env(9));
    assert.ok(!second.ok && second.message === DONE_MEANWHILE);
  });

  test("an automatic springing ran its actions already, so Do its effects is refused while its damage waits", () => {
    const state = world([thorn()], [trap("plate", square(3, 5), { damage: [{ formula: "1d6", type: "fire" }] })]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1);
    const due = r.state.traps.plate!.rig!.due![0]!;
    const act = applyOp(r.state, { t: "trap.act", trapId: "plate", due: due.id }, DM, env(8));
    assert.ok(!act.ok && act.message === DONE_MEANWHILE);
  });

  test("actions whose targets are gone are skipped and named on the DM's line", () => {
    const state = world([thorn()], [trap("plate", square(3, 5), { actions: [{ light: "gone", on: false }, { show: { tokenId: "nobody" } }] })]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1);
    assert.deepEqual((lines(r.state)[0] as Extract<LogEvent, { type: "trap" }>).did, [{ action: 0, ok: false }, { action: 1, ok: false }]);
  });

  test("a creature with an id that is not plain is counted, never stored", () => {
    const odd = token("odd.id", { name: "Odd", x: 0, y: 5 });
    const state = world([odd], [trap("plate", square(3, 5), { damage: [{ formula: "1d6", type: "fire" }] })]);
    const r = applied(state, { t: "token.move", tokenId: "odd.id", x: 8, y: 5 });
    const due = r.state.traps.plate!.rig!.due![0]!;
    assert.deepEqual([due.by, due.more, due.hits, due.hitsMore], [[], 1, [], 1]);
    assert.deepEqual((lines(r.state)[0] as Extract<LogEvent, { type: "trap" }>).by, []);
  });

  test("a creature that gets off its mount walks off it and sets off what it steps onto", () => {
    const horse = token("horse", { name: "Horse", kind: "npc", size: "large", x: 2, y: 4 });
    const rider = thorn({ x: 2, y: 4, elevation: 0, attached: { to: "horse", kind: "ride", steer: true } });
    const state = world([horse, rider], [trap("plate", square(4, 4))]);
    const r = applied(state, { t: "token.detach", tokenId: "thorn", x: 4, y: 4 });
    assert.deepEqual(pos(r.state, "thorn"), [4, 4]);
    assert.equal(r.state.traps.plate!.state, "sprung");
  });
});

describe("turns (5.1, 5.4)", () => {
  function fight(traps: Trap[], at: Partial<Token> = {}): RoomState {
    const state = world([thorn({ x: 3, y: 5, ...at }), goblin({ x: 10, y: 10 })], traps);
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "n2",
      entries: [
        { id: "n1", tokenId: "thorn", value: 20, order: 0 } as never,
        { id: "n2", tokenId: "gob", value: 10, order: 1 } as never,
      ],
    };
    return state;
  }

  test("the creature whose turn starts on a plate sets it off, after the nextTurn traps arm again", () => {
    const statue = trap("statue", square(3, 5), { on: ["turnStart"], resets: "nextTurn", stops: false }, { state: "sprung" });
    const r = applied(fight([statue]), { t: "encounter.next" });
    assert.equal(r.state.encounter!.activeEntryId, "n1");
    assert.equal(r.state.traps.statue!.state, "sprung", "armed again, then off again at once");
    assert.deepEqual(lines(r.state).map((l) => (l as { how: string }).how), ["turnStart"]);
  });

  test("a trap with both turn triggers and nextTurn goes off twice in one Next: the turn that ends, then the one that starts", () => {
    const state = fight([trap("plate", square(3, 5), { on: ["turnStart", "turnEnd"], resets: "nextTurn", stops: false })]);
    // Thorn's turn is the active one, and it is Thorn's again after: a fight of one.
    state.encounter = { ...state.encounter!, activeEntryId: "n1", entries: [state.encounter!.entries[0]!] };
    const r = applied(state, { t: "encounter.next" });
    assert.deepEqual(lines(r.state).map((l) => (l as { how: string }).how), ["turnEnd", "turnStart"]);
  });

  test("a Next that changes nothing tests nothing, Previous starts no turn, and the end of a fight arms every nextTurn trap", () => {
    const statue = trap("statue", square(3, 5), { on: ["turnStart"], resets: "nextTurn", stops: false });
    const once = applied(fight([statue]), { t: "encounter.next" });
    assert.equal(once.state.traps.statue!.state, "sprung");
    const prev = applied(once.state, { t: "encounter.prev" }, DM, 8);
    assert.equal(prev.state.trapLog.length, 1);
    const ended = applied(once.state, { t: "encounter.end" }, DM, 9);
    assert.equal(ended.state.traps.statue!.state, "armed");
  });

  test("outside a fight a nextTurn trap arms again at the end of the op that set it off, and one with no uses left stays sprung", () => {
    const state = world([thorn()], [trap("darts", square(3, 5), { resets: "nextTurn", stops: false, usesLeft: 2 })]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 });
    assert.equal(r.state.traps.darts!.state, "armed");
    assert.equal(r.state.traps.darts!.rig!.usesLeft, 1);
    const back = applied(r.state, { t: "token.move", tokenId: "thorn", x: 0, y: 5 }, DM, 8);
    const last = applied(back.state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, DM, 9);
    assert.equal(last.state.traps.darts!.state, "sprung");
    assert.equal(last.state.traps.darts!.rig!.usesLeft, 0);
  });
});

describe("doors (5.3)", () => {
  const needle = () => trap("needle", { door: { edge: "9,5,w" } }, { on: [], stops: false, damage: [{ formula: "1d10", type: "poison" }] });

  test("a creature that opens a door sets its trap off, the DM's open from afar does not, and closing never does", () => {
    const state = world([thorn({ x: 8, y: 5 })], [needle()], (s) => (s.buildChunks[chunkKey("s1", 0, 0)] = doorChunk()));
    const opened = applied(state, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "open", by: "thorn" }, P1);
    assert.equal(opened.state.traps.needle!.state, "sprung");
    assert.deepEqual(lines(opened.state).map((l) => (l as { how: string }).how), ["open"]);
    const afar = applied(state, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "open" });
    assert.equal(afar.state.traps.needle!.state, "armed");
    const open = world([thorn({ x: 8, y: 5 })], [needle()], (s) => (s.buildChunks[chunkKey("s1", 0, 0)] = doorChunk("open")));
    assert.equal(applied(open, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "closed" }, P1).state.traps.needle!.state, "armed");
    assert.equal(applied(open, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "open", by: "thorn" }, P1).state.traps.needle!.state, "armed", "an open door is not opened");
  });

  test("a rider on a mount every player sees is off the floor: a floor-only door trap lets it open the door, one that catches riders goes off", () => {
    for (const floor of [true, false]) {
      const horse = token("horse", { name: "Horse", kind: "npc", size: "large", disposition: "ally", ownerIds: ["p1"], x: 7, y: 4 });
      const rider = thorn({ x: 7, y: 4, elevation: 0, attached: { to: "horse", kind: "ride", steer: true } });
      const state = world([horse, rider], [trap("needle", { door: { edge: "9,5,w" } }, { on: [], floor, stops: false })], (s) => (s.buildChunks[chunkKey("s1", 0, 0)] = doorChunk()));
      const r = applied(state, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "open", by: "thorn" }, P1);
      assert.equal(r.state.traps.needle!.state, floor ? "armed" : "sprung");
    }
  });

  test("a goblin no player sees opens a door into their sight: who saw it is read before the door opened, so its springing stays the DM's", () => {
    const state = world([thorn({ x: 3, y: 5 }), goblin({ x: 10, y: 5 })], [needle()], (s) => {
      const edges: BuildChunk["edges"] = {};
      for (let y = 0; y < 16; y++) edges[`9,${y},w`] = { kind: "wall" };
      edges["9,5,w"] = { kind: "door", state: "closed", secret: false, discovered: false };
      s.buildChunks[chunkKey("s1", 0, 0)] = { ...doorChunk(), edges };
      s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright" } };
    });
    const r = applied(state, { t: "door.set", sceneId: "s1", door: { edge: "9,5,w" }, state: "open", by: "gob" });
    const t = r.state.traps.needle!;
    assert.deepEqual([t.state, t.found, t.rig!.due?.[0]?.perceived], ["sprung", false, undefined]);
    assert.deepEqual(r.state.trapSeen, [], "no players' line");
  });
});

describe("the DM's Set it off, and settling (6.2)", () => {
  test("Set it off works whatever its state and on any scene, spends a use down to 0 at least, and writes both lines and its occurrence", () => {
    const state = world([thorn({ sceneId: "s2" })], [trap("pit", square(3, 5), { usesLeft: 1, damage: [{ formula: "1d6", type: "bludgeoning" }] }, { sceneId: "s2", state: "disarmed" })]);
    const r = applied(state, { t: "trap.spring", trapId: "pit", tokenIds: ["thorn", "nobody"] });
    const t = r.state.traps.pit!;
    assert.equal(t.state, "sprung");
    assert.equal(t.rig!.usesLeft, 0);
    assert.equal(t.found, true);
    assert.deepEqual(lines(r.state).map((l) => (l as { how: string }).how), ["hand"]);
    assert.equal(r.state.trapSeen.length, 1);
    assert.deepEqual(t.rig!.due![0]!.by, ["thorn"]);
    const again = applied(r.state, { t: "trap.spring", trapId: "pit", tokenIds: [] }, DM, 8);
    assert.equal(again.state.traps.pit!.rig!.usesLeft, 0);
  });

  test("Set it off counts creatures only: an object or a dead creature named is left out of who set it off", () => {
    const chest = token("chest", { name: "Chest", kind: "object", x: 3, y: 5 });
    const dead = goblin({ x: 3, y: 5, actor: { inline: actor({ life: "dead" }) } });
    const state = world([thorn(), chest, dead], [trap("boom", square(3, 5), { message: "Boom." })]);
    const r = applied(state, { t: "trap.spring", trapId: "boom", tokenIds: ["chest", "gob", "thorn"] });
    assert.deepEqual((lines(r.state)[0] as Extract<LogEvent, { type: "trap" }>).by, ["thorn"]);
    assert.deepEqual((seenLines(r.state)[0] as Extract<LogEvent, { type: "trapSeen" }>).by, ["thorn"]);
  });

  test("an outcome settles its occurrence in the same op, a second is refused, and its undo brings it back with the HP", () => {
    const state = world([thorn()], [trap("plate", square(3, 5), { damage: [{ formula: "1d6", type: "fire" }] })]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 });
    const due: TrapDue = r.state.traps.plate!.rig!.due![0]!;
    const out = applied(r.state, { t: "actor.outcome", plan: "p1", trap: { trapId: "plate", due: due.id }, targets: [{ target: { tokenId: "thorn" }, amount: 3 }] }, DM, 8);
    assert.equal(out.state.traps.plate!.rig!.due, undefined);
    const twice = applyOp(out.state, { t: "actor.outcome", plan: "p2", trap: { trapId: "plate", due: due.id }, targets: [{ target: { tokenId: "thorn" }, amount: 3 }] }, DM, env(9));
    assert.ok(!twice.ok && twice.message === SETTLED_MEANWHILE);
    const undone = applied(out.state, { t: "sys.restore", entries: out.inverse!, from: "undo" }, DM, 10);
    assert.deepEqual(undone.state.traps.plate!.rig!.due, [due]);
  });
});

describe("the room's cap through undo (6.1, 6.5)", () => {
  test("an undone Apply brings its occurrence back into a full room, and the room's oldest of the rest goes", () => {
    const due = (id: string): TrapDue => ({ id, at: "2026-10-12T20:00:00.000Z", how: "enter", by: [], hits: [] });
    const held = (id: string, ids: string[]) => trap(id, square(20, 20), {}, { state: "sprung", rig: { ...rig(), due: ids.map(due) } });
    const state = world([thorn(), goblin({ x: 20, y: 25 })], [held("a", ["1:0", "2:0", "3:0"]), held("b", ["4:0", "5:0", "6:0"]), held("c", ["7:0", "8:0", "9:0"]), held("d", ["10:0"]), trap("e", square(3, 5), { damage: [{ formula: "1d6", type: "fire" }] })]);
    const out = applied(state, { t: "actor.outcome", plan: "p", trap: { trapId: "a", due: "1:0" }, targets: [{ target: { tokenId: "gob" }, amount: 1 }] }, DM, 30);
    const walked = applied(out.state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1, 31);
    const ids = (s: RoomState) => Object.values(s.traps).flatMap((t) => (t.rig?.due ?? []).map((d) => d.id));
    assert.equal(ids(walked.state).length, 10);
    const undone = applied(walked.state, { t: "sys.restore", entries: out.inverse!, from: "undo", deps: true }, DM, 32);
    assert.equal(ids(undone.state).filter((id) => id === "1:0").length, 1);
    assert.equal(ids(undone.state).length, 10);
    assert.equal(ids(undone.state).includes("2:0"), false, "the oldest the undo did not bring back");
  });
});

describe("the op as it would apply without the trap step (6.7)", () => {
  test("a stopped move passes or fails as the whole move would, and the room without the trap step is the plain move's", () => {
    const state = world([thorn()], [trap("plate", square(3, 5))]);
    const r = applied(state, { t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1);
    const plain = r.withoutTraps!();
    assert.ok(plain.ok);
    assert.deepEqual(pos(plain.state, "thorn"), [8, 5]);
    assert.deepEqual(plain.state.traps, state.traps);
    assert.equal(applied(world([thorn()], []), { t: "token.move", tokenId: "thorn", x: 8, y: 5 }).withoutTraps, undefined);
  });

  test("replay plans the same: an op log with traps applied twice gives the same traps, tokens and lines", () => {
    const start = world([thorn(), goblin({ visibility: "dm", y: 6 })], [trap("plate", square(3, 5), { damage: [{ formula: "1d6", type: "fire" }] }), trap("wire", { wire: { a: [5, 6], b: [5, 7] } }, { on: [] })]);
    const ops: [Op, Viewer][] = [
      [{ t: "token.move", tokenId: "thorn", x: 8, y: 5 }, P1],
      [{ t: "token.move", tokenId: "gob", x: 8, y: 6 }, DM],
      [{ t: "trap.update", trapId: "plate", patch: { state: "armed" } }, DM],
      [{ t: "token.move", tokenId: "thorn", x: 0, y: 5 }, DM],
    ];
    const run = () => {
      let s = start;
      ops.forEach(([op, who], i) => (s = applied(s, op, who, 20 + i).state));
      return s;
    };
    const a = run();
    const b = run();
    assert.deepEqual([a.traps, a.tokens, a.trapLog, a.trapSeen], [b.traps, b.tokens, b.trapLog, b.trapSeen]);
    assert.ok(a.trapLog.length >= 2);
  });
});
