import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SrdRolls } from "#shared/dice/bonus.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import type { SrdBlocks } from "#shared/rules/opportunity.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { loadSrdRolls } from "#shared/srd/rolls.ts";
import { actor, character, DM, env, token } from "#shared/testutil.ts";
import { reachTurn, type ShownLeaves } from "../movement/store.ts";
import { onTurn, thorn, world } from "../movement/testing.ts";

const { LegJobs, noticesOn } = await import("./opportunity.ts");
const { ReachToasts, toastsMount } = await import("./opportunityToasts.ts");

/*
 * The DM's toast (docs/design/design-v1-opportunity-attacks.md 1, The DM's
 * toast, D-261128-060): "Thorn left Goblin's reach." on each DM device when
 * a player answers for the mover, once the leg's job has its data, once a
 * creature a turn, skipping only a leg this device's own drag line named,
 * seeded on mount and on each turn change, silent while viewing as a
 * player, never for a join, and never on a table display. Hidden here or
 * off in the room, no job runs and so nothing toasts.
 */

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}
const settle = () => new Promise<void>((r) => setImmediate(r));

function apply(state: RoomState, op: Op, who: Viewer = DM, seq = 100): RoomState {
  const r = applyOp(state, op, who, env(seq));
  if (!r.ok) throw new Error(`${op.t}: ${r.message}`);
  return r.state;
}
const move = (state: RoomState, id: string, x: number, y: number) => apply(state, { t: "token.move", tokenId: id, x, y } as Op);

/** A DM device's jobs and toasts over a room the test walks, the chunks loaded when it says. */
function dmDevice(opts: { loaded?: boolean } = {}) {
  const timers: (() => void)[] = [];
  const rolls = deferred<SrdRolls>();
  const monsters = deferred<SrdBlocks>();
  const jobs = new LegJobs({ later: (r) => (timers.push(r), () => {}), load: { rolls: () => rolls.promise, monsters: () => monsters.promise }, storage: null });
  const toasts = new ReachToasts();
  const said: string[] = [];
  /**
   * A new room read as the board's controller reads it (opportunityToasts.ts
   * Toasts): the jobs sync in their effect, the toasts' effect then reads the
   * jobs as the render held them, from before that sync, and reads again
   * once the jobs' publish renders. `confirmed`: the server's copy under
   * `state`, left out the same.
   */
  const see = (state: RoomState, more: { confirmed?: RoomState | null; previewing?: boolean; shown?: ShownLeaves[] } = {}) => {
    const rendered = jobs.store.getState();
    jobs.sync({ key: "room|dm", view: state, confirmed: more.confirmed === undefined ? state : more.confirmed, viewer: DM, on: true });
    const read = (reach: typeof rendered) => said.push(...toasts.step({ reach, view: state, viewer: DM, previewing: more.previewing ?? false, shown: more.shown ?? [], labels: new Map() }));
    read(rendered);
    for (let i = 0; i < 10_000 && timers.length > 0; i++) timers.shift()!();
    read(jobs.store.getState());
  };
  const load = async () => {
    rolls.resolve(await loadSrdRolls());
    monsters.resolve(await loadMonsters());
    await settle();
  };
  /** The line a drop of Thorn at `at` keeps, as the drag's drop writes it from the room before the move lands (movement/stageHooks.ts). */
  const line = (before: RoomState, at: { x: number; y: number }, ids: string[]): ShownLeaves => {
    const leaves = jobs.leaves.getState();
    return { tokenId: "thorn", turn: reachTurn(leaves.key, before.encounter, Object.values(leaves.movers)[0]?.turn), after: leaves.last, ...at, elevation: 0, ids };
  };
  void opts;
  return { jobs, see, said, load, line };
}

/** Thorn, p1's, on his turn beside a goblin. */
function beside(more: Token[] = []): RoomState {
  return onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), token("goblin", { name: "Goblin", x: 6, y: 5 }), ...more] }), "thorn");
}

describe("the DM's Opportunity Attack toast", () => {
  test("a player's creature leaving an enemy's reach toasts once, however the move came, arrow keys and group drags too (SOL-04)", () => {
    const dm = dmDevice();
    const start = beside([token("wolf", { name: "Wolf", x: 9, y: 6 })]);
    dm.see(start);
    let state = move(start, "thorn", 8, 5);
    dm.see(state);
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."]);
    state = move(state, "thorn", 12, 5);
    dm.see(state);
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach.", "Thorn left Wolf's reach."], "the goblin is not named again");
    dm.see(move(state, "goblin", 13, 6));
    assert.equal(dm.said.length, 2, "no move but the mover's toasts");
  });

  test("a creature left twice in a turn is named once", () => {
    const dm = dmDevice();
    const start = beside();
    dm.see(start);
    let state = move(start, "thorn", 8, 5);
    dm.see(state);
    // Back beside the goblin, then away again.
    state = move(state, "thorn", 5, 6);
    dm.see(state);
    state = move(state, "thorn", 5, 9);
    dm.see(state);
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."]);
  });

  test("names two as the drag line does", () => {
    const dm = dmDevice();
    const start = beside([token("g2", { name: "Goblin", number: 2, x: 6, y: 4 })]);
    dm.see(start);
    dm.see(move(start, "thorn", 9, 5));
    assert.deepEqual(dm.said, ["Thorn left the reach of Goblin and Goblin 2."]);
  });

  test("a character shown by two tokens is named once (LP62-OA-TWICE)", () => {
    const dm = dmDevice();
    const shade = (id: string, x: number, y: number) => token(id, { name: "Shade", x, y, actor: { ref: "shade" } });
    const set = beside([shade("s1", 6, 6), shade("s2", 6, 4)]);
    const start = { ...set, characters: { ...set.characters, shade: character("shade", { name: "Shade", ownerIds: [] }) } };
    dm.see(start);
    dm.see(move(start, "thorn", 9, 5));
    assert.deepEqual(dm.said, ["Thorn left the reach of Goblin and Shade."]);
  });

  test("waits for the SRD's data before it reads a leg, so a 10 ft reach is never read at 5 ft", async () => {
    const dm = dmDevice();
    const air = token("air", { name: "Air Elemental", size: "large", x: 6, y: 5, actor: { inline: actor({ srdId: "air-elemental" }) } });
    const start = onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), air] }), "thorn");
    dm.see(start);
    // To 10 ft of it: inside its 10 ft reach, past the 5 ft it would read without the table.
    const near = move(start, "thorn", 4, 5);
    dm.see(near);
    assert.deepEqual(dm.said, [], "nothing while the data loads");
    await dm.load();
    dm.see(near);
    assert.deepEqual(dm.said, [], "and nothing once it reads 10 ft");
    dm.see(move(near, "thorn", 1, 5));
    assert.deepEqual(dm.said, ["Thorn left Air Elemental's reach."]);
  });

  test("a leg this device's own drag line named is skipped, and one it named only some of is not", () => {
    const dm = dmDevice();
    const start = beside([token("g2", { name: "Goblin", number: 2, x: 6, y: 4 })]);
    dm.see(start);
    const state = move(start, "thorn", 9, 5);
    dm.see(state, { shown: [dm.line(start, { x: 9, y: 5 }, ["goblin", "g2"])] });
    assert.deepEqual(dm.said, []);
    const other = dmDevice();
    other.see(start);
    other.see(state, { shown: [other.line(start, { x: 9, y: 5 }, ["goblin"])] });
    assert.deepEqual(other.said, ["Thorn left the reach of Goblin and Goblin 2."]);
  });

  test("a drop's line skips its own leg alone: never a later turn's walk to the same square", () => {
    const dm = dmDevice();
    const start = beside();
    dm.see(start);
    // Round 1: the DM's drag to 8,5 names the goblin, so its leg is not toasted.
    const lines = [dm.line(start, { x: 8, y: 5 }, ["goblin"])];
    const dropped = move(start, "thorn", 8, 5);
    dm.see(dropped, { shown: lines });
    assert.deepEqual(dm.said, []);
    // Round 2, Thorn's turn again: back beside the goblin, then to 8,5 again by the arrow keys.
    let next = apply(dropped, { t: "encounter.next" } as Op);
    dm.see(next, { shown: lines });
    next = move(next, "thorn", 5, 5);
    dm.see(next, { shown: lines });
    next = move(next, "thorn", 8, 5);
    dm.see(next, { shown: lines });
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."], "last round's line says nothing of this round's leg");
  });

  test("a line whose move the server refused never claims a later turn's leg to its square", () => {
    const dm = dmDevice();
    const start = beside();
    dm.see(start);
    const refused = [dm.line(start, { x: 8, y: 5 }, ["goblin"])];
    dm.see(start, { shown: refused });
    let next = apply(start, { t: "encounter.next" } as Op);
    dm.see(next, { shown: refused });
    next = move(next, "thorn", 8, 5);
    dm.see(next, { shown: refused });
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."]);
  });

  test("a line kept at one height never skips a leg to the same square at another", () => {
    const dm = dmDevice();
    const start = beside();
    dm.see(start);
    // A drop over 8,5 at 30 ft, which the walk on the ground there is not.
    const high = { ...dm.line(start, { x: 8, y: 5 }, ["goblin"]), elevation: 30 };
    dm.see(move(start, "thorn", 8, 5), { shown: [high] });
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."]);
  });

  test("a line binds to the leg its drop landed, not an earlier leg to the same square still waiting for the server", () => {
    const dm = dmDevice();
    const start = beside();
    dm.see(start);
    // A to B by the arrow keys and back, both still on their way to the server.
    const there = move(start, "thorn", 8, 5);
    dm.see(there, { confirmed: start });
    const back = move(there, "thorn", 5, 5);
    dm.see(back, { confirmed: start });
    // Then a drop A to B whose line names the goblin.
    const lines = [dm.line(back, { x: 8, y: 5 }, ["goblin"])];
    const again = move(back, "thorn", 8, 5);
    dm.see(again, { confirmed: start, shown: lines });
    dm.see(again, { confirmed: again, shown: lines });
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."], "the first A to B, which no line named");
  });

  test("a leg first seen pending toasts once, when the server confirms it", () => {
    const dm = dmDevice();
    const start = beside();
    dm.see(start);
    const walked = move(start, "thorn", 8, 5);
    dm.see(walked, { confirmed: start });
    assert.deepEqual(dm.said, []);
    dm.see(walked, { confirmed: walked });
    dm.see(walked, { confirmed: walked });
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."]);
  });

  test("a predicted walk that repeats an earlier leg's spots waits for the server to take that move, and one it refuses never toasts", () => {
    const start = beside([token("wolf", { name: "Wolf", x: 20, y: 20 })]);
    // A to B, back to A, and the wolf steps up beside A, all taken by the server.
    const there = move(start, "thorn", 8, 5);
    const back = move(there, "thorn", 5, 5);
    const taken = move(back, "wolf", 4, 5);
    // A to B again, predicted: it leaves the wolf's reach too.
    const predicted = move(taken, "thorn", 8, 5);
    const devices = [dmDevice(), dmDevice()];
    for (const dm of devices) {
      for (const state of [start, there, back, taken]) dm.see(state);
      dm.see(predicted, { confirmed: taken });
      assert.deepEqual(dm.said, ["Thorn left Goblin's reach."], "nothing before the server takes the second A to B");
    }
    const [takes, refuses] = devices as [ReturnType<typeof dmDevice>, ReturnType<typeof dmDevice>];
    takes.see(predicted, { confirmed: predicted });
    assert.deepEqual(takes.said, ["Thorn left Goblin's reach.", "Thorn left Wolf's reach."]);
    refuses.see(taken, { confirmed: taken });
    refuses.see(taken, { confirmed: taken });
    assert.deepEqual(refuses.said, ["Thorn left Goblin's reach."], "the refused move never toasts");
  });

  test("legs joined past 50 stops before their jobs finish toast once the server holds them, a Teleport among them saying nothing", async () => {
    const dm = dmDevice();
    // An SRD creature far off makes every leg's job wait for the rolls table, so these legs are read only after their joins.
    const air = token("air", { name: "Air Elemental", size: "large", x: 25, y: 25, actor: { inline: actor({ srdId: "air-elemental" }) } });
    let state = beside([token("orc", { name: "Orc", x: 9, y: 6 }), token("wolf", { name: "Wolf", x: 15, y: 6 }), air]);
    dm.see(state);
    // A walk away from the goblin to beside the orc, a Teleport away from the orc to beside the wolf, and a walk away from the wolf.
    state = move(state, "thorn", 8, 5);
    dm.see(state);
    state = apply(state, { t: "token.move", tokenId: "thorn", x: 14, y: 5, teleport: "wall" } as Op);
    dm.see(state);
    state = move(state, "thorn", 14, 9);
    dm.see(state);
    for (let i = 0; i < 48; i++) {
      state = move(state, "thorn", 20 + (i % 2), 12);
      dm.see(state);
    }
    const joined = state.tokens.thorn!.path!.stops[1]!;
    assert.deepEqual([joined.x, joined.y, joined.via, joined.uncounted], [14, 9, [8, 5, 14, 5], undefined], "the three legs joined, a join that counts");
    assert.deepEqual(dm.said, [], "nothing while the table loads");
    await dm.load();
    dm.see(state);
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach.", "Thorn left Wolf's reach."]);
  });

  test("on mount, a reload, a second DM device and Previous it seeds from the stored legs and repeats nothing", () => {
    const walked = move(beside([token("wolf", { name: "Wolf", x: 9, y: 6 })]), "thorn", 8, 5);
    const late = dmDevice();
    late.see(walked);
    assert.deepEqual(late.said, [], "a device that mounts after the leg");
    const next = apply(walked, { t: "encounter.next" } as Op);
    late.see(next);
    const back = apply(next, { t: "encounter.prev" } as Op);
    late.see(back);
    assert.deepEqual(late.said, [], "Previous brings the turn back seeded");
    late.see(move(back, "thorn", 12, 5));
    assert.deepEqual(late.said, ["Thorn left Wolf's reach."], "a leg after it still toasts");
  });

  test("Next, a rendered gap and Previous bring Thorn's walk back past four goblins with no toast again, though the jobs publish the restored legs after the turn shows (LP62-OA-1)", () => {
    const goblins = [
      ["grub", "Grub", 6, 5],
      ["snag", "Snag", 9, 6],
      ["nix", "Nix", 12, 6],
      ["mog", "Mog", 15, 6],
    ] as const;
    let state = onTurn(world({ blockMovement: false, tokens: [thorn({ x: 5, y: 5 }), ...goblins.map(([id, name, x, y]) => token(id, { name, x, y }))] }), "thorn");
    const dm = dmDevice();
    dm.see(state);
    // Each leg ends beside the next goblin and leaves the one before.
    for (const x of [8, 11, 14, 17]) {
      state = move(state, "thorn", x, 5);
      dm.see(state);
    }
    const four = ["Thorn left Grub's reach.", "Thorn left Snag's reach.", "Thorn left Nix's reach.", "Thorn left Mog's reach."];
    assert.deepEqual(dm.said, four);
    const next = apply(state, { t: "encounter.next" } as Op);
    dm.see(next);
    const back = apply(next, { t: "encounter.prev" } as Op);
    assert.equal(back.tokens.thorn!.path!.stops.length, 5, "Previous put the walk back");
    dm.see(back);
    dm.see(back);
    assert.deepEqual(dm.said, four, "no toast again");
    // A second DM device that first reads the turn now, in the same order, says nothing either.
    const late = dmDevice();
    late.see(back);
    assert.deepEqual(late.said, []);
  });

  test("while the DM views as a player it says nothing, and what lands then is seeded", () => {
    const dm = dmDevice();
    const start = beside([token("wolf", { name: "Wolf", x: 9, y: 6 })]);
    dm.see(start);
    const walked = move(start, "thorn", 8, 5);
    dm.see(walked, { previewing: true });
    dm.see(walked);
    assert.deepEqual(dm.said, []);
    dm.see(move(walked, "thorn", 12, 5));
    assert.deepEqual(dm.said, ["Thorn left Wolf's reach."]);
  });

  test("the DM's own creature is the DM's turn card's, never a toast", () => {
    const dm = dmDevice();
    const start = onTurn(world({ blockMovement: false, tokens: [token("orc", { name: "Orc", disposition: "hostile", x: 5, y: 5 }), thorn({ x: 6, y: 5 })] }), "orc");
    dm.see(start);
    dm.see(move(start, "orc", 8, 5));
    assert.deepEqual(dm.said, []);
  });

  test("past 50 stops the join toasts nothing", () => {
    const dm = dmDevice();
    let state = beside();
    dm.see(state);
    state = move(state, "thorn", 8, 5);
    dm.see(state);
    for (let i = 0; i < 49; i++) {
      state = move(state, "thorn", 10 + (i % 2), 14);
      dm.see(state);
    }
    assert.ok((state.tokens.thorn!.path!.stops.length ?? 0) >= 50);
    assert.deepEqual(dm.said, ["Thorn left Goblin's reach."]);
  });

  test("hidden on this device, off in the room, or on a table display, nothing runs", () => {
    const view = { meta: { settings: {} } } as never;
    assert.equal(noticesOn({ shown: true, room: { display: false }, view }), true);
    assert.equal(noticesOn({ shown: false, room: { display: false }, view }), false, "the part hidden here");
    assert.equal(noticesOn({ shown: true, room: { display: true }, view }), false, "a table display");
    assert.equal(noticesOn({ shown: true, room: { display: false }, view: { meta: { settings: { opportunityNotices: false } } } as never }), false, "the room's notices off");
    assert.equal(noticesOn({ shown: true, room: null, view }), false);
    assert.equal(toastsMount({ display: true }), false);
    assert.equal(toastsMount({ display: false }), true);
    assert.equal(toastsMount(null), false);
  });
});
