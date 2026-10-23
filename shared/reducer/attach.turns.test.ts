import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InitEntry, RoomSettings, RoomState, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { sortEntries } from "../rules/initiative.ts";
import { DM, P1, P2, actor, character, effect, env, room, token } from "../testutil.ts";

/**
 * A controlled mount's turn is its rider's (docs/design-v1-attach.md 7.1):
 * the mount's row takes its rider's value and place, `skipRound` passes it
 * once, the turn's `mounts` list and `markRound`, the Reaction, every
 * player seeing the pair, the end of a ride, and Previous.
 */

/**
 * Bree (16) rides nothing yet. Rows: Bree 16, Goblin 12, Warhorse 8, Ogre 4.
 * Bree stands beside the warhorse at 4,4.
 */
function fight(setup?: (s: RoomState) => void) {
  const state = room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 6, y: 4, ownerIds: ["p1"] }),
      gob: token("gob", { name: "Goblin", x: 20, y: 20 }),
      ogre: token("ogre", { name: "Ogre", size: "large", x: 25, y: 20 }),
    },
  });
  setup?.(state);
  const f = {
    state,
    seq: 0,
    last: null as Applied | null,
    run(op: Op, who: Viewer = DM) {
      f.seq++;
      const r = applyOp(f.state, op, who, env(f.seq));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      f.last = r;
      f.state = r.state;
      return f;
    },
    next() {
      return f.run({ t: "encounter.next" });
    },
    order(): string[] {
      return sortEntries(f.state.encounter!.entries).map((e) => e.tokenId!);
    },
    row(tokenId: string): InitEntry {
      return f.state.encounter!.entries.find((e) => e.tokenId === tokenId)!;
    },
    active(): string | undefined {
      const e = f.state.encounter!;
      return e.entries.find((x) => x.id === e.activeEntryId)?.tokenId;
    },
    mounts(): string[] | undefined {
      return f.state.encounter!.turnStart?.mounts;
    },
    ride(steer = true) {
      return f.run({ t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", ...(steer ? { steer: true as const } : {}), x: 5, y: 4, elevation: 0 });
    },
    getOff() {
      return f.run({ t: "token.detach", tokenId: "bree", x: 6, y: 4 });
    },
  };
  return f.run({
    t: "encounter.start",
    entries: [
      { id: "eb", tokenId: "bree", value: 16 },
      { id: "eg", tokenId: "gob", value: 12 },
      { id: "eh", tokenId: "horse", value: 8 },
      { id: "eo", tokenId: "ogre", value: 4 },
    ],
  });
}

describe("the mount's row on a controlled ride (7.1)", () => {
  test("takes its rider's value and goes right after it, when it has not acted this round", () => {
    const f = fight().next().ride();
    assert.deepEqual(f.order(), ["bree", "horse", "gob", "ogre"]);
    assert.equal(f.row("horse").value, 16);
    assert.equal(f.row("horse").skipRound, undefined);
  });

  test("one that already acted this round is passed over once, its durations untouched, and acts again next round", () => {
    const f = fight((s) => {
      s.tokens.horse = { ...s.tokens.horse!, actor: { inline: actor({ effects: [effect("fx", { key: "blessed", duration: { remaining: 5, boundary: "turnStart", anchor: { entryId: "eh" } } })] }) } };
    });
    f.next().next().next().next();
    assert.equal(f.active(), "ogre");
    f.run({ t: "token.move", tokenId: "bree", x: 6, y: 4 });
    f.ride();
    assert.equal(f.row("horse").skipRound, 1);
    const remaining = () => ("inline" in f.state.tokens.horse!.actor ? f.state.tokens.horse!.actor.inline.effects[0]!.duration!.remaining : -1);
    const before = remaining();
    // Round 2: Bree, then the horse right after her, then the goblin.
    f.next();
    assert.equal(f.active(), "bree");
    f.next();
    assert.equal(f.active(), "horse");
    assert.equal(remaining(), before - 1, "its own turn start ticks once in round 2");
  });

  test("the acting mount's row moves nowhere", () => {
    const f = fight().next().next().next();
    assert.equal(f.active(), "horse");
    f.ride();
    assert.deepEqual(f.order(), ["bree", "gob", "horse", "ogre"]);
    assert.equal(f.row("horse").value, 8);
  });

  test("an independent ride changes no row", () => {
    const f = fight().next().ride(false);
    assert.deepEqual(f.order(), ["bree", "gob", "horse", "ogre"]);
  });
});

describe("sharing the rider's turn (7.1)", () => {
  test("a controlled ride taken on the rider's turn joins the turn and marks the mount's row for the round", () => {
    const f = fight().next().ride();
    assert.deepEqual(f.mounts(), ["horse"]);
    assert.equal(f.row("horse").markRound, 1);
    f.run({ t: "token.move", tokenId: "horse", x: 8, y: 4 });
    assert.equal(f.state.tokens.horse!.path!.stops.length, 2);
  });

  test("a mount on its character's row with no token is found as the reorder finds it: the row marks time and its Reaction comes back", () => {
    const f = fight((s) => {
      s.characters.steed = character("steed", { name: "Warhorse", actor: actor({ speeds: { walk: 60 } }) });
      s.tokens.horse = { ...s.tokens.horse!, actor: { ref: "steed" } };
    });
    // The fight's rows, the horse's on its character alone.
    f.run({ t: "encounter.remove", entryIds: ["eh"] }).run({ t: "encounter.add", entries: [{ id: "ec", characterId: "steed", value: 8 }] });
    const steed = () => f.state.encounter!.entries.find((e) => e.id === "ec")!;
    f.next().ride();
    assert.deepEqual(f.mounts(), ["horse"]);
    assert.equal(steed().markRound, 1);
    f.next().next();
    f.run({ t: "encounter.update", entryId: "ec", patch: { reactionUsed: true } });
    while (f.active() !== "bree") f.next();
    assert.equal(steed().reactionUsed, false);
    assert.equal(steed().markRound, 2);
  });

  test("the rider's turn starting with the ride in place joins it, and brings the mount's Reaction back with its own", () => {
    const f = fight().next().ride().next().next();
    assert.equal(f.active(), "gob");
    f.run({ t: "encounter.update", entryId: "eh", patch: { reactionUsed: true } });
    f.run({ t: "encounter.update", entryId: "eb", patch: { reactionUsed: true } });
    f.next().next();
    assert.equal(f.active(), "bree");
    assert.equal(f.state.encounter!.round, 2);
    assert.deepEqual(f.mounts(), ["horse"]);
    assert.equal(f.row("horse").reactionUsed, false);
    assert.equal(f.row("horse").markRound, 2);
  });

  test("on its own row that round the mount keeps a spent Reaction and writes no leg", () => {
    const f = fight().next().ride();
    f.run({ t: "encounter.update", entryId: "eh", patch: { reactionUsed: true } });
    f.next();
    assert.equal(f.active(), "horse");
    assert.equal(f.row("horse").reactionUsed, true);
    f.run({ t: "token.move", tokenId: "horse", x: 10, y: 4 });
    assert.equal(f.state.tokens.horse!.path, undefined);
  });

  test("a rider no player sees shares nothing: its mount's row stays ordinary", () => {
    const f = fight().next().run({ t: "token.update", tokenId: "bree", patch: { visibility: "dm" } }).ride();
    assert.equal(f.mounts(), undefined);
    assert.equal(f.row("horse").markRound, undefined);
    f.run({ t: "token.move", tokenId: "horse", x: 8, y: 4 });
    assert.equal(f.state.tokens.horse!.path, undefined);
  });

  test("the ride ending takes the mount off the list at once, and its row keeps marking time to the round's end", () => {
    const f = fight().next().ride().getOff();
    assert.equal(f.mounts(), undefined);
    assert.equal(f.row("horse").markRound, 1);
    f.run({ t: "token.move", tokenId: "horse", x: 10, y: 4 });
    assert.equal(f.state.tokens.horse!.path, undefined);
    // So does the link pass and switching to independent.
    const passed = fight().next().ride().run({ t: "token.move", tokenId: "bree", x: 12, y: 12 });
    assert.equal(passed.mounts(), undefined);
    const freed = fight().next().ride().ride(false);
    assert.equal(freed.mounts(), undefined);
  });

  test("the remount cases: a hidden rider getting on later the same turn shares nothing", () => {
    const f = fight().next().ride().getOff();
    f.run({ t: "token.update", tokenId: "bree", patch: { visibility: "dm" } });
    f.ride();
    assert.equal(f.mounts(), undefined);
  });

  test("another rider later in the round shares only through a qualifying mounting of its own", () => {
    const f = fight((s) => (s.tokens.gob = { ...s.tokens.gob!, x: 6, y: 5 })).next().ride().getOff().next().next();
    assert.equal(f.active(), "gob");
    f.run({ t: "token.attach", tokenId: "gob", to: "horse", kind: "ride", steer: true, x: 5, y: 5, elevation: 0 });
    assert.deepEqual(f.mounts(), ["horse"]);
    assert.equal(f.row("horse").markRound, 1);
  });

  test("Previous puts back the rows, the list and the Reactions", () => {
    const f = fight().next().ride().next().next();
    f.run({ t: "encounter.update", entryId: "eh", patch: { reactionUsed: true } });
    f.next().next();
    assert.equal(f.active(), "bree");
    const shared = structuredClone(f.state.encounter!);
    f.next();
    f.run({ t: "encounter.prev" });
    assert.deepEqual(f.state.encounter!.entries, shared.entries);
    assert.deepEqual(f.mounts(), ["horse"]);
    assert.equal(f.row("horse").markRound, 2);
  });

  test("the DM's undo of a Get off puts the mount back on the same turn's list", () => {
    const f = fight().next().ride().getOff();
    const inverse = f.last!.inverse!;
    f.run({ t: "sys.restore", entries: inverse, from: "undo", deps: true });
    assert.deepEqual(f.mounts(), ["horse"]);
    f.run({ t: "token.move", tokenId: "horse", x: 10, y: 4 });
    assert.ok(f.state.tokens.horse!.path);
  });
});

describe("replay below op version 14 (8.6)", () => {
  test("Next writes no list and resets every Reaction as before", () => {
    const f = fight().next().ride().next().next();
    f.run({ t: "encounter.update", entryId: "eh", patch: { reactionUsed: true } });
    f.next().next();
    let state = f.state;
    const r = applyOp(state, { t: "encounter.next" }, DM, { ...env(99), opVersion: 13 });
    assert.ok(r.ok);
    state = r.state;
    assert.equal(state.encounter!.turnStart?.mounts, undefined);
  });
});

/**
 * A rider's row some player cannot see leads no mount (7.1, op version 18,
 * reviews FU21A-OP-1, FU21A-OP-2, FU21A-OP-6 and FU21A-OP-7): the mount's
 * row, its value, place, `skipRound`, `markRound` and Reaction, never tells
 * players that row's value or that its turn is under way. Thorn (P2's) 20,
 * Bree (P1's, beside her warhorse) 15, the warhorse (P1's) 8 and the DM's
 * goblin 4. `hidden` names the rows the DM hides, which their turn does not
 * reveal. Players see the whole order unless `order` says otherwise. Each
 * op is stored at `opVersion`, live by default.
 */
function rows(opts: { hidden?: readonly string[]; order?: RoomSettings["playersSeeOrder"]; reveal?: boolean; opVersion?: number; setup?: (s: RoomState) => void } = {}) {
  let state = room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", ownerIds: ["p1"], x: 6, y: 4, actor: { inline: actor({ speeds: { walk: 30 } }) } }),
      thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p2"], x: 12, y: 12 }),
      gob: token("gob", { name: "Goblin", x: 6, y: 5 }),
    },
  });
  state.meta.settings = { ...state.meta.settings, revealHiddenOnTurn: opts.reveal ?? false, playersSeeOrder: opts.order ?? "all" };
  opts.setup?.(state);
  let seq = 0;
  const f = {
    get state() {
      return state;
    },
    run(op: Op, who: Viewer = DM) {
      const r = applyOp(state, op, who, { ...env(++seq), ...(opts.opVersion !== undefined ? { opVersion: opts.opVersion } : {}) });
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      state = r.state;
      return f;
    },
    next() {
      return f.run({ t: "encounter.next" });
    },
    /** P2's tracker. */
    seen() {
      return projectState(state, P2, { sceneId: "s1" }).encounter;
    },
    row(tokenId: string): InitEntry {
      return state.encounter!.entries.find((e) => e.tokenId === tokenId)!;
    },
    mounts(): string[] | undefined {
      return state.encounter!.turnStart?.mounts;
    },
  };
  const hide = new Set(opts.hidden ?? []);
  const entry = (id: string, tokenId: string, value: number) => ({ id, tokenId, value, ...(hide.has(id) ? { hidden: true } : {}) });
  return f.run({ t: "encounter.start", entries: [entry("et", "thorn", 20), entry("eb", "bree", 15), entry("eh", "horse", 8), entry("eg", "gob", 4)] });
}

const controlled: Op = { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 };

describe("a rider's row some player cannot see leads no mount (op version 18)", () => {
  test("Bree's player gets her on her warhorse controlled on her own hidden turn: the server takes it, and the other player's tracker does not change (review FU21A-OP-1)", () => {
    const f = rows({ hidden: ["eb"] }).next().next();
    assert.equal(f.state.encounter!.activeEntryId, "eb");
    assert.ok(canApply(controlled, P1, f.state, { canUseAsset: () => true }).ok, "a player rides on its own hidden turn (FU20A-RIDEHIDDEN)");
    const before = f.seen();
    f.run(controlled, P1);
    assert.deepEqual(f.seen(), before);
    assert.deepEqual([f.row("horse").value, f.row("horse").markRound, f.mounts()], [8, undefined, undefined]);
    // Stored at op version 17, it replays as it applied: the horse's row took Bree's hidden value and marked time.
    const old = rows({ hidden: ["eb"], opVersion: 17 }).next().next().run(controlled, P1);
    assert.deepEqual([old.row("horse").value, old.row("horse").markRound, old.mounts()], [15, 1, ["horse"]]);
  });

  test("the DM's Next into Bree's hidden turn while she rides controlled shares nothing: no mark, no Reaction back (review FU21A-OP-2)", () => {
    const seated = (s: RoomState) => {
      s.tokens.bree = { ...s.tokens.bree!, x: 5, y: 4, attached: { to: "horse", kind: "ride", steer: true } };
    };
    const f = rows({ hidden: ["eb"], setup: seated }).next().run({ t: "encounter.update", entryId: "eh", patch: { reactionUsed: true } });
    const before = f.seen()!.entries;
    f.next();
    assert.equal(f.state.encounter!.activeEntryId, "eb");
    assert.deepEqual(f.seen()!.entries, before, "the other player's rows");
    assert.deepEqual([f.row("horse").markRound, f.row("horse").reactionUsed, f.mounts()], [undefined, true, undefined]);
    const old = rows({ hidden: ["eb"], setup: seated, opVersion: 17 }).next().run({ t: "encounter.update", entryId: "eh", patch: { reactionUsed: true } }).next();
    assert.deepEqual([old.row("horse").markRound, old.row("horse").reactionUsed, old.mounts()], [1, false, ["horse"]]);
  });

  test("a row the order setting keeps from players leads no mount either: the DM's goblin gets on the ally warhorse controlled on Thorn's turn (review FU21A-OP-6)", () => {
    const onHorse: Op = { t: "token.attach", tokenId: "gob", to: "horse", kind: "ride", steer: true, x: 5, y: 5, elevation: 0 };
    const f = rows({ order: "allies" }).next();
    const before = f.seen();
    assert.equal(before!.entries.some((e) => e.id === "eg"), false, "the goblin's row is the DM's until its turn");
    f.run(onHorse);
    assert.deepEqual(f.seen(), before);
    assert.equal(f.row("horse").value, 8);
    const old = rows({ order: "allies", opVersion: 17 }).next().run(onHorse);
    assert.equal(old.row("horse").value, 4, "op version 17 gave the horse's row the goblin's value");
  });

  test("on a chain the rider's own row gives the value and the acting row the sharing: Bree's controlled horse gets on an elephant (review FU21A-OP-6)", () => {
    const elephant = (s: RoomState) => {
      s.tokens.elephant = token("elephant", { name: "Elephant", kind: "npc", size: "huge", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 40 } }) } });
    };
    const withRow = (f: ReturnType<typeof rows>) => f.run({ t: "encounter.add", entries: [{ id: "ee", tokenId: "elephant", value: 2 }] });
    const horseOn: Op = { t: "token.attach", tokenId: "horse", to: "elephant", kind: "ride", steer: true, x: 4, y: 4, elevation: 0 };
    // The horse's row hidden, Bree's acting row seen: the elephant keeps its own value, and joins Bree's turn.
    const a = withRow(rows({ hidden: ["eh"], setup: elephant })).next().next().run(controlled).run(horseOn);
    assert.equal(a.row("elephant").value, 2);
    assert.deepEqual([a.mounts(), a.row("elephant").markRound], [["horse", "elephant"], 1]);
    // Bree's acting row hidden, the horse's seen: no row moves, since skipRound reads where the acting row stands, and nothing joins.
    const b = withRow(rows({ hidden: ["eb"], setup: elephant })).next().next().run(controlled);
    const before = b.seen();
    b.run(horseOn);
    assert.deepEqual(b.seen(), before);
    assert.deepEqual([b.row("elephant").value, b.mounts(), b.row("elephant").markRound], [2, undefined, undefined]);
    // Both seen: the elephant takes the horse's value, goes right after it, and joins.
    const c = withRow(rows({ setup: elephant })).next().next().run(controlled).run(horseOn);
    assert.deepEqual([c.row("elephant").value, c.mounts()], [15, ["horse", "elephant"]]);
  });

  test("a turn's start reads the rows it is about to write: a monster rider on its first turn under the default order, and a row its turn reveals, share their mount (review FU21A-OP-7)", () => {
    const goblinRides = (s: RoomState) => {
      s.tokens.gob = { ...s.tokens.gob!, x: 5, y: 5, attached: { to: "horse", kind: "ride", steer: true } };
    };
    // "party": the goblin's row reaches players only once its turn comes.
    const party = rows({ order: "party", setup: goblinRides }).next().next().next().next();
    assert.equal(party.state.encounter!.activeEntryId, "eg");
    assert.deepEqual([party.mounts(), party.row("horse").markRound], [["horse"], 1]);
    // A hidden row the turn reveals.
    const revealed = rows({ hidden: ["eg"], reveal: true, setup: goblinRides }).next().next().next().next();
    assert.equal(revealed.row("gob").hidden, false);
    assert.deepEqual(revealed.mounts(), ["horse"]);
  });

  test("Next reveals a row anew, so Previous puts the hidden row back, where an older op changed the state it was given (review FU21A-OP-8)", () => {
    // The horse's hidden row marks time on Bree's turn, so it keeps its spent Reaction as its own turn comes.
    const seated = (s: RoomState) => {
      s.tokens.bree = { ...s.tokens.bree!, x: 5, y: 4, attached: { to: "horse", kind: "ride", steer: true } };
    };
    const f = rows({ hidden: ["eh"], reveal: true, setup: seated }).next().next();
    assert.equal(f.row("horse").markRound, 1);
    const before = f.state;
    f.next();
    assert.equal(f.row("horse").hidden, false);
    assert.equal(before.encounter!.entries.find((e) => e.id === "eh")!.hidden, true, "the state before is as it was");
    f.run({ t: "encounter.prev" });
    assert.equal(f.row("horse").hidden, true);
    const old = rows({ hidden: ["eh"], reveal: true, setup: seated, opVersion: 17 }).next().next().next().run({ t: "encounter.prev" });
    assert.equal(old.row("horse").hidden, false, "op version 17 replays as it applied");
  });
});
