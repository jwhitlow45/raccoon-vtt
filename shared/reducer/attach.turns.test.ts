import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InitEntry, RoomState, Viewer } from "../model.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { sortEntries } from "../rules/initiative.ts";
import { DM, actor, effect, env, room, token } from "../testutil.ts";

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
