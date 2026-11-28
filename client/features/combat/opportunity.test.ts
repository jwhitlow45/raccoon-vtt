import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { reachInput, reachScan, type Chunks, type SrdBlocks } from "#shared/rules/opportunity.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { actor, DM, entry, env, int, pick, rng, token } from "#shared/testutil.ts";
import { pathNow } from "../measure/movement.ts";
import { onTurn, thorn, world } from "../movement/testing.ts";
type TurnReach = import("./opportunity.ts").TurnReach;
const { LegJobs, legsOf, SHOWN_KEY } = await import("./opportunity.ts");
const { ReachToasts } = await import("./opportunityToasts.ts");

/*
 * The turn's leg jobs (docs/design/design-v1-opportunity-attacks.md 4, Leg
 * jobs, D-261128-057): one job per occurrence, a snapshot when the leg
 * arrives, a wait for the SRD chunks behind "Checking the walk…", queued and
 * never cancelled by a later change. Then randomized sequences of drops,
 * slices, chunk loads and failures, Undo, Doesn't count, joins and turn
 * changes against named invariants: SNAPSHOT (a job's result never reads
 * state after its arrival), NO-STARVE (every leg's job finishes or is
 * cancelled by its own leg or turn), ONE-TOAST (no row toasts twice) and
 * NO-FALSE-FIVE (no result reads 5 ft for a chunk that later loads).
 */

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((r) => setImmediate(r));

function harness(opts: { slice?: number; storage?: Map<string, string> } = {}) {
  const timers: (() => void)[] = [];
  const loads = { rolls: deferred<SrdRolls>(), monsters: deferred<SrdBlocks>() };
  const asked = { rolls: 0, monsters: 0 };
  const storage = opts.storage ?? new Map<string, string>();
  const jobs = new LegJobs({
    later: (run) => {
      timers.push(run);
      return () => {
        const i = timers.indexOf(run);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    load: {
      rolls: () => (asked.rolls++, loads.rolls.promise),
      monsters: () => (asked.monsters++, loads.monsters.promise),
    },
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    ...(opts.slice !== undefined ? { slice: opts.slice } : {}),
  });
  const sync = (view: RoomState | null, viewer: Viewer = DM, on = true, key = "room|dm") => jobs.sync({ key, view, viewer, on });
  const tick = () => timers.shift()?.();
  const drain = () => {
    for (let i = 0; i < 100_000 && timers.length > 0; i++) tick();
  };
  return { jobs, sync, tick, drain, loads, asked, storage, timers };
}

function apply(state: RoomState, op: Op, who: Viewer = DM, seq = 100): RoomState {
  const r = applyOp(state, op, who, env(seq));
  if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
  return r.state;
}

const move = (state: RoomState, id: string, x: number, y: number) => apply(state, { t: "token.move", tokenId: id, x, y } as Op);

/** Thorn, p1's, beside a goblin on Thorn's turn, every square 5 ft. */
function beside(more: Token[] = []): RoomState {
  return onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), token("goblin", { name: "Goblin", x: 6, y: 5 }), ...more] }), "thorn");
}

const rowsOf = (r: TurnReach, mover = "thorn") => r.movers[mover]?.rows.map((row) => row.left.id) ?? [];

describe("a leg's job", () => {
  test("scans the leg once its slices run, between frames, and the rows come from it", () => {
    const h = harness();
    const state = move(beside(), "thorn", 8, 5);
    h.sync(state);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "nothing before its slices run");
    assert.equal(h.jobs.store.getState().movers.thorn?.checking, true);
    assert.equal(h.jobs.leaves.getState().movers.thorn?.settled, false, "the drag waits for it");
    h.drain();
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"]);
    assert.equal(h.jobs.store.getState().movers.thorn?.checking, false);
    assert.deepEqual([...h.jobs.leaves.getState().movers.thorn!.skip], ["goblin"]);
  });

  test("a goblin pushed or a door closed after the leg changes no row, and its Reaction used, death or leaving the copy only remove it (LATER-ONLY-REMOVES)", () => {
    const h = harness();
    let state = move(beside(), "thorn", 8, 5);
    h.sync(state);
    h.drain();
    state = move(state, "goblin", 12, 12);
    h.sync(state);
    h.drain();
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"], "pushed away later, the row stands");
    const rowed = { ...state, encounter: { ...state.encounter!, entries: [...state.encounter!.entries, entry("eg", { tokenId: "goblin", reactionUsed: true })] } };
    h.sync(rowed);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "its Reaction used");
    const dead = { ...state, tokens: { ...state.tokens, goblin: { ...state.tokens.goblin!, actor: { inline: actor({ life: "dead", hp: { cur: 0, max: 7, temp: 0 } }) } } } };
    h.sync(dead);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "dead");
    h.sync(state);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"], "back as it was");
    assert.equal(h.timers.length, 0, "no rescan for any of it");
  });

  test("a Reaction used this device sent stands in the server's copy before its row leaves, so the row's button can show busy until then", () => {
    const h = harness();
    const state = move(beside(), "thorn", 8, 5);
    h.jobs.sync({ key: "room|dm", view: state, confirmed: state, viewer: DM, on: true });
    h.drain();
    const marked = { ...state, encounter: { ...state.encounter!, entries: [...state.encounter!.entries, entry("eg", { tokenId: "goblin", reactionUsed: true })] } };
    h.jobs.sync({ key: "room|dm", view: marked, confirmed: state, viewer: DM, on: true });
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"], "sent, not yet taken");
    h.jobs.sync({ key: "room|dm", view: marked, confirmed: marked, viewer: DM, on: true });
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "taken");
    // A creature gone from the view leaves at once, whatever the server's copy still holds.
    const { goblin: _gone, ...tokens } = state.tokens;
    h.jobs.sync({ key: "room|dm", view: { ...state, tokens }, confirmed: state, viewer: DM, on: true });
    assert.deepEqual(rowsOf(h.jobs.store.getState()), []);
  });

  test("a creature its block says reaches 10 ft waits behind Checking the walk for the rolls table, then reads its reach (SOL-06)", async () => {
    const h = harness();
    const air = token("air", { name: "Air Elemental", size: "large", x: 6, y: 5, actor: { inline: actor({ srdId: "air-elemental" }) } });
    // From beside it to 10 ft away: inside its 10 ft reach, but past the 5 ft a failed table would read.
    const state = move(onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), air] }), "thorn"), "thorn", 4, 5);
    h.sync(state);
    h.drain();
    assert.equal(h.jobs.store.getState().movers.thorn?.checking, true, "waiting for the table");
    assert.equal(h.asked.rolls, 1);
    h.loads.rolls.resolve(await loadSrdRolls());
    h.loads.monsters.resolve(await loadMonsters());
    await settle();
    h.drain();
    assert.equal(h.jobs.store.getState().movers.thorn?.checking, false);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "10 ft, read once the table came (NO-FALSE-FIVE)");
  });

  test("a chunk that fails reads 5 ft for its data, then rows", async () => {
    const h = harness();
    const air = token("air", { name: "Air Elemental", size: "large", x: 6, y: 5, actor: { inline: actor({ srdId: "air-elemental" }) } });
    const state = move(onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), air] }), "thorn"), "thorn", 4, 5);
    h.sync(state);
    h.loads.rolls.reject(new Error("offline"));
    h.loads.monsters.reject(new Error("offline"));
    await settle();
    h.drain();
    const rows = h.jobs.store.getState().movers.thorn!.rows;
    assert.deepEqual(rows.map((r) => [r.left.id, r.left.known]), [["air", false]]);
  });

  test("a Hydra whose Reaction is used keeps its row once its block loads, named by its trait", async () => {
    const h = harness();
    const hydra = token("hydra", { name: "Hydra", size: "huge", x: 6, y: 4, actor: { inline: actor({ srdId: "hydra" }) } });
    let state = onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), hydra] }), "thorn");
    state = { ...state, encounter: { ...state.encounter!, entries: [...state.encounter!.entries, entry("eh", { tokenId: "hydra", reactionUsed: true })] } };
    state = move(state, "thorn", 1, 5);
    h.sync(state);
    h.loads.rolls.resolve(await loadSrdRolls());
    await settle();
    h.drain();
    assert.equal(h.jobs.store.getState().movers.thorn?.checking, true, "the block still on its way");
    h.loads.monsters.resolve(await loadMonsters());
    await settle();
    h.drain();
    const rows = h.jobs.store.getState().movers.thorn!.rows;
    assert.deepEqual(rows.map((r) => [r.left.id, r.left.extra]), [["hydra", "Reactive Heads"]]);
  });

  test("a second drop while the first leg's job runs: both finish, the first on its own snapshot (SOL-07), and a reactor moved between slices changes nothing", () => {
    const h = harness({ slice: 1 });
    let state = move(beside([token("wolf", { name: "Wolf", x: 10, y: 6 })]), "thorn", 8, 5);
    h.sync(state);
    h.tick();
    assert.ok(h.timers.length > 0, "a slice at a time");
    // The goblin steps beside Thorn's new spot, then Thorn walks on past the wolf.
    state = move(state, "goblin", 9, 4);
    state = move(state, "thorn", 12, 5);
    h.sync(state);
    h.drain();
    const legs = h.jobs.store.getState().movers.thorn!.legs;
    assert.equal(legs.length, 2);
    assert.deepEqual(legs[0]!.leaves.map((l) => l.id), ["goblin"], "the first leg left the goblin where it stood then");
    assert.deepEqual(legs[1]!.leaves.map((l) => l.id).sort(), ["goblin", "wolf"], "the second scanned the room as it arrived");
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin", "wolf"], "the goblin once, at its first leave");
  });

  test("Undo during a job cancels it, and Doesn't count keeps it and filters its rows, pressed back bringing them back", () => {
    const h = harness({ slice: 1 });
    const before = beside();
    const walked = move(before, "thorn", 8, 5);
    h.sync(walked);
    h.tick();
    h.sync(before);
    assert.equal(h.jobs.store.getState().movers.thorn?.legs.length ?? 0, 0);
    h.drain();
    assert.equal(h.jobs.store.getState().movers.thorn?.checking ?? false, false, "the undone leg's job is gone");
    h.sync(walked);
    h.tick();
    const uncounted = apply(walked, { t: "token.countLeg", tokenId: "thorn", counts: false } as Op);
    h.sync(uncounted);
    h.drain();
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "its leg does not count");
    h.sync(apply(uncounted, { t: "token.countLeg", tokenId: "thorn", counts: true } as Op));
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"], "counted again, with no rescan");
    assert.equal(h.timers.length, 0);
  });

  test("Undo of the turn's last leg mid-scan stops its job at once, the earlier leg's result kept", () => {
    const h = harness({ slice: 1 });
    const one = move(beside([token("wolf", { name: "Wolf", x: 9, y: 6 })]), "thorn", 8, 5);
    h.sync(one);
    h.drain();
    h.sync(move(one, "thorn", 12, 5));
    h.tick();
    assert.ok(h.timers.length > 0, "the second leg's job is mid-scan");
    h.sync(one);
    let ran = 0;
    while (h.timers.length > 0 && ran < 1_000) {
      h.tick();
      ran++;
    }
    assert.ok(ran <= 1, `the undone leg's job ran ${ran} more slices`);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"]);
  });

  test("a new turn whose first leg lands in the same sync starts afresh, under its own turn", () => {
    const h = harness();
    let state = move(beside(), "thorn", 8, 5);
    state = move(state, "thorn", 5, 5);
    h.sync(state);
    h.drain();
    const old = h.jobs.leaves.getState().movers.thorn!.turn;
    // The goblin steps away before the next turn, and Thorn walks the same first leg again.
    state = move(apply(state, { t: "encounter.next" } as Op), "goblin", 14, 14);
    state = move(state, "thorn", 8, 5);
    h.sync(state);
    h.drain();
    const turn = pathNow(state.encounter, state.tokens.thorn!, "dm")!.turn;
    assert.notEqual(turn, old);
    assert.equal(h.jobs.leaves.getState().movers.thorn?.turn, turn);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), [], "the goblin is far now, and last turn's scan is not this leg's");
  });

  test("a new turn starts afresh and cancels the old turn's jobs, and Previous rescans the restored turn against the room then", () => {
    const h = harness({ slice: 1 });
    const walked = move(beside(), "thorn", 8, 5);
    h.sync(walked);
    h.tick();
    const next = apply(walked, { t: "encounter.next" } as Op);
    h.sync(next);
    h.drain();
    assert.deepEqual(h.jobs.store.getState().movers.thorn?.legs ?? [], []);
    const back = apply(next, { t: "encounter.prev" } as Op);
    h.sync(back);
    h.drain();
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin"]);
  });

  test("past 50 stops a join holds both legs' jobs: their union shows, with no rescan, and Undo brings both back with their rows", () => {
    const h = harness();
    let state = beside([token("wolf", { name: "Wolf", x: 3, y: 8 })]);
    // Away from the goblin, back beside the wolf and away from it, then pacing on open ground until the path is full.
    state = move(state, "thorn", 8, 5);
    state = move(state, "thorn", 4, 7);
    state = move(state, "thorn", 4, 10);
    for (let i = 0; i < 46; i++) state = move(state, "thorn", 10 + (i % 2), 14);
    h.sync(state);
    h.drain();
    const full = h.jobs.store.getState().movers.thorn!;
    assert.equal(full.legs.length, 49);
    const ids = full.legs.map((l) => l.id);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin", "wolf"]);
    const joined = move(state, "thorn", 12, 14);
    h.sync(joined);
    assert.equal(h.timers.length, 1, "one new job, for the new leg alone");
    h.drain();
    const after = h.jobs.store.getState().movers.thorn!;
    assert.equal(after.legs.length, 49);
    assert.ok(after.legs.some((l) => l.parts.length === 2), "a join holds two parts");
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin", "wolf"], "the union, with no rescan");
    h.sync(state);
    assert.deepEqual(h.jobs.store.getState().movers.thorn!.legs.map((l) => l.id), ids, "Undo: both back with their ids");
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["goblin", "wolf"]);
    assert.equal(h.timers.length, 0);
  });

  test("past 50 stops a Doesn't count leg and a Teleport joined with a walk keep their own marks: their rows never come back, and the walk's stand", () => {
    const h = harness();
    let state = beside([token("orc", { name: "Orc", x: 9, y: 6 }), token("wolf", { name: "Wolf", x: 20, y: 20 })]);
    // Away from the goblin, marked Doesn't count, to beside the orc.
    state = move(state, "thorn", 8, 5);
    state = apply(state, { t: "token.countLeg", tokenId: "thorn", counts: false } as Op);
    // A walk away from the orc to beside the wolf, then a Teleport away from the wolf.
    state = move(state, "thorn", 19, 19);
    state = apply(state, { t: "token.move", tokenId: "thorn", x: 19, y: 10, teleport: "wall" } as Op);
    for (let i = 0; i < 46; i++) state = move(state, "thorn", 25 + (i % 2), 2);
    h.sync(state);
    h.drain();
    assert.equal(h.jobs.store.getState().movers.thorn!.legs.length, 49);
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["orc"]);
    // The reducer joins the Doesn't count leg with the walk, a join that counts, then that join with the Teleport.
    state = move(state, "thorn", 25, 3);
    h.sync(state);
    h.drain();
    state = move(state, "thorn", 26, 3);
    h.sync(state);
    h.drain();
    assert.equal(state.tokens.thorn!.path!.stops[1]!.uncounted, undefined, "the stored join counts, as the reducer joins it");
    assert.deepEqual(rowsOf(h.jobs.store.getState()), ["orc"], "no goblin or wolf row from the parts that never provoked");
    assert.deepEqual(h.jobs.leaves.getState().movers.thorn?.skip, new Set(["orc"]), "and the drag skips only the orc");
    const first = h.jobs.store.getState().movers.thorn!.legs[0]!;
    assert.deepEqual(
      first.parts.map((p) => p.provokes),
      [false, true, false],
      "the joined leg's parts: the Doesn't count leg, the walk and the Teleport",
    );
    assert.equal(first.provokes, true, "the walk in it provokes");
    assert.deepEqual(
      first.leaves.map((l) => l.id),
      ["orc"],
    );
  });

  test("off, the part hidden or no room: no job and nothing published", () => {
    const h = harness();
    h.sync(move(beside(), "thorn", 8, 5), DM, false);
    assert.equal(h.timers.length, 0);
    assert.deepEqual(h.jobs.store.getState().movers, {});
    h.sync(null);
    assert.deepEqual(h.jobs.store.getState().movers, {});
  });
});

describe("the shown set", () => {
  test("a row is new once a turn on this device, and a reload in the tab announces no old row", () => {
    const storage = new Map<string, string>();
    const h = harness({ storage });
    const state = move(beside(), "thorn", 8, 5);
    h.sync(state);
    h.drain();
    const first = h.jobs.store.getState().fresh;
    assert.deepEqual(first.rows.map((r) => r.left.id), ["goblin"]);
    h.sync(move(state, "goblin", 6, 6));
    assert.equal(h.jobs.store.getState().fresh.seq, first.seq, "the same row is not new again");
    assert.ok(storage.get(SHOWN_KEY)?.includes("thorn|goblin"));
    const reload = harness({ storage });
    reload.sync(state);
    reload.drain();
    assert.deepEqual(rowsOf(reload.jobs.store.getState()), ["goblin"], "the reload's rows from the stored legs");
    assert.equal(reload.jobs.store.getState().fresh.seq, 0, "none of them new");
  });

  test("storage that fails keeps the set in memory, so a row is still new once", () => {
    const h = harness();
    const broken = new LegJobs({ later: (run) => (run(), () => {}), load: { rolls: () => new Promise(() => {}), monsters: () => new Promise(() => {}) }, storage: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } });
    void h;
    const state = move(beside(), "thorn", 8, 5);
    broken.sync({ key: "k", view: state, viewer: DM, on: true });
    const seq = broken.store.getState().fresh.seq;
    assert.equal(seq, 1);
    broken.sync({ key: "k", view: move(state, "goblin", 6, 6), viewer: DM, on: true });
    assert.equal(broken.store.getState().fresh.seq, 1);
  });
});

describe("randomized event sequences (SNAPSHOT, NO-STARVE, ONE-TOAST, NO-FALSE-FIVE)", () => {
  test("drops, slices, chunk loads and failures, Undo, Doesn't count, joins and turn changes", async () => {
    const rolls = await loadSrdRolls();
    const monsters = await loadMonsters();
    const air = () => token("air", { name: "Air Elemental", size: "large", x: 12, y: 8, actor: { inline: actor({ srdId: "air-elemental" }) } });
    /** What the sequences met, so a change that stops them meeting a case fails here rather than passing on nothing. */
    const met = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const r = rng(seed);
      const h = harness({ slice: pick(r, [1, 3, 20_000]) });
      const fails = r() < 0.3;
      const toasts = new ReachToasts();
      const toasted = new Set<string>();
      const goblins = Array.from({ length: 5 }, (_, i) => token(`g${i}`, { name: "Goblin", number: i + 1, x: int(r, 2, 20), y: int(r, 2, 20) }));
      let state = onTurn(world({ blockMovement: false, tokens: [thorn({ x: 10, y: 10, ownerIds: ["p1"] }), air(), ...goblins] }), "thorn");
      const history: RoomState[] = [];
      /** Each occurrence's room as it arrived, and its leg's end stop then. */
      const arrived = new Map<number, { state: RoomState; end: number }>();
      const seen = new Set<number>();
      let chunksDone = false;
      const land = () => {
        if (fails) {
          h.loads.rolls.reject(new Error("offline"));
          h.loads.monsters.reject(new Error("offline"));
        } else {
          h.loads.rolls.resolve(rolls);
          h.loads.monsters.resolve(monsters);
        }
      };
      const step = () => {
        h.sync(state);
        const mover = h.jobs.store.getState().movers.thorn;
        if (mover?.legs.some((l) => l.parts.length > 1)) met.add("join");
        if (mover?.checking && h.timers.length > 0 && arrived.size > 0) met.add("job running at a sync");
        mover?.legs.forEach((leg, k) => {
          for (const part of leg.parts) {
            if (seen.has(part.id)) continue;
            seen.add(part.id);
            // A part first seen alone is a new occurrence arriving now: its leg is the path's k-th.
            if (leg.parts.length === 1) arrived.set(part.id, { state, end: k + 1 });
          }
        });
        for (const text of toasts.step({ reach: h.jobs.store.getState(), view: state, confirmed: null, viewer: DM, previewing: false, shown: [], labels: new Map() })) {
          assert.ok(!toasted.has(text), `seed ${seed}: "${text}" toasted twice (ONE-TOAST)`);
          toasted.add(text);
        }
      };
      // Every third sequence walks on through one turn, past the path's 50 stops, so its legs join.
      const long = seed % 3 === 0;
      for (let e = 0; e < 150; e++) {
        const raw = r();
        const roll = long ? (raw < 0.6 ? raw * (0.35 / 0.6) : raw < 0.62 ? 0.4 : raw < 0.7 ? 0.5 : 0.7) : raw;
        if (roll < 0.35) {
          history.push(state);
          state = move(state, "thorn", int(r, 1, 24), int(r, 1, 24));
        } else if (roll < 0.45 && history.length > 0) {
          state = history.pop()!;
          met.add("undo");
        } else if (roll < 0.52) {
          const path = state.tokens.thorn?.path;
          if (path && path.stops.length > 1) {
            history.push(state);
            state = apply(state, { t: "token.countLeg", tokenId: "thorn", counts: r() < 0.5 } as Op);
            met.add("doesn't count");
          }
        } else if (roll < 0.6) {
          history.push(state);
          state = move(state, pick(r, goblins).id, int(r, 1, 24), int(r, 1, 24));
        } else if (roll < 0.63) {
          history.length = 0;
          state = apply(state, { t: "encounter.next" } as Op);
          // A new turn may name a creature again.
          toasted.clear();
        } else if (roll < 0.66 && !chunksDone) {
          chunksDone = true;
          land();
          await settle();
        } else {
          for (let t = int(r, 1, 6); t > 0; t--) h.tick();
        }
        step();
      }
      if (!chunksDone) {
        land();
        await settle();
      }
      h.drain();
      step();
      h.drain();
      step();
      const mover = h.jobs.store.getState().movers.thorn;
      // NO-STARVE: with the chunks in and the timers run, every leg still held has finished.
      assert.equal(mover?.checking ?? false, false, `seed ${seed}: a job never finished (NO-STARVE)`);
      const chunks: Chunks = fails ? { rolls: "failed", monsters: "failed" } : { rolls, monsters };
      for (const leg of mover?.legs ?? []) {
        for (const part of leg.parts) {
          const at = arrived.get(part.id);
          if (!at) continue;
          // SNAPSHOT: the job's result is the scan of its leg on the room as it arrived, read with the chunks as they settled (NO-FALSE-FIVE).
          const path = pathNow(at.state.encounter, at.state.tokens.thorn!, "dm");
          const built = reachInput(at.state, "thorn", path, chunks, DM)!;
          const legThen = built.legs.find((l) => l.id === at.end)!;
          const run = reachScan(built.input, { ...legThen, id: part.id, provokes: true }, new Set());
          let s = run.next();
          while (!s.done) s = run.next();
          const want = s.value === "over" ? "over" : s.value.map((l) => l.id);
          assert.deepEqual(part.over ? "over" : part.leaves.map((l) => l.id), want, `seed ${seed}: occurrence ${part.id} (SNAPSHOT)`);
          if (!fails) for (const l of part.leaves) if (l.id === "air") assert.equal(l.known, true, `seed ${seed}: the air elemental read at 5 ft before its table came (NO-FALSE-FIVE)`);
        }
      }
      // The rows are the legs' first leaves of creatures, from provoking legs only.
      const provoking = new Set((mover?.legs ?? []).filter((l) => l.provokes).flatMap((l) => l.leaves.map((x) => x.id)));
      for (const row of mover?.rows ?? []) assert.ok(provoking.has(row.left.id), `seed ${seed}: a row no provoking leg left`);
      assert.deepEqual(legsOf(state.tokens.thorn?.path ?? { turn: 0, stops: [] }).length, mover?.legs.length ?? 0, `seed ${seed}: a record for every leg`);
      met.add(fails ? "chunks failed" : "chunks loaded");
    }
    assert.deepEqual([...met].sort(), ["chunks failed", "chunks loaded", "doesn't count", "job running at a sync", "join", "undo"]);
  });
});
