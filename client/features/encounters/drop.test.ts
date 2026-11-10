import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, SavedEncounterMonster, Viewer } from "#shared/model.ts";
import type { ClientOp, RestoreEntry } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { loadMonsters } from "#shared/srd/monsters.ts";
import { monsterView } from "#shared/statBlock.ts";
import { DM, actor, comparable, customMonster, env, imageRef, room, srdImage, token } from "#shared/testutil.ts";
import { footprint } from "../../lib/scene.ts";
import { fightOps } from "../tokens/groupEdit.ts";
import { resolveLine, srdIndex } from "./draft.ts";
import { dropPlan, joinEntry, placedInLair, sendDrop, type DropOptions } from "./drop.ts";

const LINES: SavedEncounterMonster[] = [
  { srdId: "goblin-warrior", count: 3 },
  { monsterId: "mon1", count: 1 },
  { srdId: "adult-red-dragon", count: 1, inLair: true },
  { monsterId: "deleted-since", count: 2 },
];

function setup(): RoomState {
  const state = room();
  state.scenes.s1!.bounds = { w: 30, h: 30 };
  state.monsters.mon1 = customMonster("mon1", { name: "Cave Lurker", defaultImage: imageRef("lurker-pic") });
  state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "goblin-pic");
  // A creature already standing where the DM taps.
  state.tokens.pc = token("pc", { kind: "pc", name: "Ayla", x: 10, y: 10, actor: { inline: actor() } });
  return state;
}

async function plan(state: RoomState, options: Partial<DropOptions> = {}) {
  const srd = srdIndex(await loadMonsters());
  let n = 0;
  return dropPlan({
    monsters: LINES,
    resolve: (m) => resolveLine(m, srd, state.monsters),
    state,
    scene: state.scenes.s1!,
    center: { x: 10.5, y: 10.5 },
    options: { hidden: false, addToFight: false, ...options },
    newId: () => `new-${n++}`,
  });
}

/** The server, which meets creatures at a batch's end with its own op. */
const SERVER: Viewer = { memberId: "server", role: "dm" };

/** Applies every op as the DM, collecting each inverse, and fails on a refusal. */
function applyAll(state: RoomState, ops: ClientOp[]) {
  const inverses: RestoreEntry[][] = [];
  let s = state;
  ops.forEach((op, i) => {
    const r = applyOp(s, op, DM, env(i + 1));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    assert.ok(r.inverse);
    inverses.push(r.inverse);
    s = r.state;
  });
  return { state: s, inverses };
}

describe("placing a saved encounter", () => {
  test("every creature becomes a token like one placed by hand, around the tap, the biggest nearest it", async () => {
    // Huge, then Large, then Small, each kind in the encounter's order.
    const state = setup();
    const p = await plan(state);
    assert.equal(p.skipped, 2, "the monster deleted since is left out");
    const tokens = p.ops.map((op) => (op.t === "token.create" ? op.token : assert.fail(op.t)));
    assert.deepEqual(
      tokens.map((t) => t.name),
      ["Adult Red Dragon", "Cave Lurker", "Goblin Warrior", "Goblin Warrior", "Goblin Warrior"],
    );
    for (const t of tokens) {
      assert.equal(t.kind, "monster");
      assert.equal(t.disposition, "hostile");
      assert.equal(t.visibility, "all");
      assert.equal(t.sceneId, "s1");
    }
    // The room's own monster's token keeps its link, so the DM reads its stat block on the token. SRD ones keep their SRD id.
    const inline = (t: (typeof tokens)[number]) => ("inline" in t.actor ? t.actor.inline : assert.fail("an inline actor"));
    assert.equal(inline(tokens[1]!).monsterId, "mon1");
    assert.equal(inline(tokens[2]!).srdId, "goblin-warrior");
    assert.equal("monsterId" in inline(tokens[2]!), false);
    // Each wears its monster's default image: the DM's where one is set, and the dragon, with none, its shipped icon.
    assert.deepEqual(tokens[0]!.image, { icon: "lorc/dragon-head", color: "#ff6b4a" });
    assert.deepEqual(tokens[1]!.image, imageRef("lurker-pic"));
    assert.deepEqual(tokens[2]!.image, imageRef("goblin-pic"));
    // In its lair, the dragon takes the lair's XP and legendary uses from its stat block.
    const dragon = tokens[0]!.actor;
    assert.ok("inline" in dragon);
    assert.equal(dragon.inline.xp, 20_000);
    assert.equal(dragon.inline.srdId, "adult-red-dragon");
    // Nobody lands on anybody, nor off the scene.
    const boxes = [footprint(state.tokens.pc!), ...tokens.map((t) => footprint(t))].map((fp, i) => {
      const at = i === 0 ? state.tokens.pc! : tokens[i - 1]!;
      return { x: at.x, y: at.y, w: fp.w, h: fp.h };
    });
    for (const [i, a] of boxes.entries()) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 30 && a.y + a.h <= 30, `box ${i} inside the scene`);
      for (const b of boxes.slice(i + 1)) assert.ok(a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h, "no overlap");
    }

    // The goblins are made with no number, and take theirs when the party first sees them, as any duplicates do.
    const { state: after } = applyAll(state, p.ops);
    const goblins = Object.values(after.tokens).filter((t) => t.name === "Goblin Warrior");
    assert.deepEqual(goblins.map((t) => t.number), [undefined, undefined, undefined]);
    const met = applyOp(after, { t: "sys.meet", tokenIds: goblins.map((t) => t.id).sort() }, SERVER, env(p.ops.length + 1));
    assert.ok(met.ok);
    assert.deepEqual(goblins.map((t) => met.state.tokens[t.id]!.number).sort(), [1, 2, 3]);
  });

  test("hidden from players, and into a running fight grouped as the tracker groups them", async () => {
    const state = setup();
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
    const p = await plan(state, { hidden: true, addToFight: true });
    const last = p.ops[p.ops.length - 1]!;
    assert.equal(last.t, "encounter.add");
    const { state: after } = applyAll(state, p.ops);
    const rows = after.encounter!.entries;
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.hidden, true);
      assert.equal(after.tokens[row.tokenId!]!.visibility, "dm");
    }
    assert.deepEqual(rows.filter((r) => r.groupKey === "goblin-warrior").length, 3);
    assert.equal(rows.find((r) => after.tokens[r.tokenId!]!.name === "Cave Lurker")?.groupKey, "Cave Lurker");
    // The dragon placed in its lair joins with In lair on, so the switch says what its counts say (docs/design/design-v1-combat-controls.md 13.4).
    assert.deepEqual(
      rows.filter((r) => r.inLair).map((r) => after.tokens[r.tokenId!]!.name),
      ["Adult Red Dragon"],
    );

    // Without a fight there is nothing to add to, whatever the switch says.
    const quiet = await plan(setup(), { addToFight: true });
    assert.ok(quiet.ops.every((op) => op.t === "token.create"));
  });

  test("goes out as one undo group, and taking every op back leaves the room as it was", async () => {
    const state = setup();
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
    const p = await plan(state, { addToFight: true });
    const sent: { op: ClientOp; group?: string }[] = [];
    let n = 0;
    const last = sendDrop(p, {
      dispatch: (op, opts) => {
        sent.push({ op, group: opts?.group });
        return ++n;
      },
      newId: () => "group-1",
    });
    assert.equal(sent.length, p.ops.length);
    assert.ok(sent.every((s) => s.group === "group-1"));
    const creates = p.ops.filter((op) => op.t === "token.create");
    assert.equal(last, creates[creates.length - 1]?.t === "token.create" ? creates[creates.length - 1]!.token.id : null);

    const { state: after, inverses } = applyAll(state, p.ops);
    let back = after;
    inverses.reverse().forEach((entries, i) => {
      const r = applyOp(back, { t: "sys.restore", entries, from: "undo" }, DM, env(100 + i));
      assert.ok(r.ok, r.ok ? "" : r.message);
      back = r.state;
    });
    assert.deepEqual(comparable(back), comparable(state));
  });

  test("an encounter with nothing to place sends nothing", async () => {
    const empty = dropPlan({
      monsters: [{ monsterId: "deleted-since", count: 2 }],
      resolve: () => null,
      state: setup(),
      scene: { id: "s1", bounds: { w: 30, h: 30 } },
      center: { x: 1, y: 1 },
      options: { hidden: false, addToFight: true },
      newId: () => "x",
    });
    assert.deepEqual(empty, { ops: [], skipped: 2 });
    let calls = 0;
    assert.equal(sendDrop(empty, { dispatch: () => ++calls, newId: () => "g" }), null);
    assert.equal(calls, 0);
  });
});

describe("a creature placed in its lair (docs/design/design-v1-combat-controls.md 13.4)", () => {
  test("its counts against its block: the lair's and not the base's, or the lair's XP where the counts say nothing", async () => {
    const monsters = await loadMonsters();
    const dragon = monsters.find((m) => m.srdId === "adult-red-dragon")!;
    const goblin = monsters.find((m) => m.srdId === "goblin-warrior")!;
    const counts = (actionsMax: number, resistMax: number) => ({ actionsMax, actionsUsed: 0, resistMax, resistUsed: 0 });
    assert.equal(placedInLair({ legendary: counts(4, 4) }, dragon), true);
    assert.equal(placedInLair({ legendary: counts(3, 3) }, dragon), false);
    assert.equal(placedInLair({ legendary: counts(4, 4) }, null), false, "no block, no lair");
    assert.equal(placedInLair({ legendary: counts(5, 5) }, dragon), false, "counts set by hand to neither");
    assert.equal(placedInLair({}, goblin), false, "a block with no lair");
    assert.equal(placedInLair({ xp: goblin.xp }, goblin), false, "nor its own XP");
    // A block whose lair changes only its XP.
    const xpOnly = { ...goblin, xpInLair: goblin.xp * 2 };
    assert.equal(placedInLair({ xp: goblin.xp * 2 }, xpOnly), true);
    assert.equal(placedInLair({ xp: goblin.xp }, xpOnly), false);
  });

  test("a saved line's In lair choice, true or false, rides on its tokens, and their counts decide where the block's lair changes them (CCB-ASTRA-07, FU46-C2)", async () => {
    // A block whose lair changes neither its counts nor its XP: its counts can never tell.
    const state = setup();
    state.monsters.mon1 = customMonster("mon1", { xp: 450, xpInLair: 450 });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
    const srd = srdIndex(await loadMonsters());
    const rows = (lines: SavedEncounterMonster[]) => {
      let n = 0;
      const p = dropPlan({ monsters: lines, resolve: (m) => resolveLine(m, srd, state.monsters), state, scene: state.scenes.s1!, center: { x: 10.5, y: 10.5 }, options: { hidden: false, addToFight: true }, newId: () => `new-${n++}` });
      return applyAll(state, p.ops).state.encounter!.entries.map((e) => e.inLair === true);
    };
    assert.deepEqual(rows([{ monsterId: "mon1", count: 2, inLair: true }]), [true, true], "the line's In lair");
    assert.deepEqual(rows([{ monsterId: "mon1", count: 1, inLair: false }]), [false]);
    assert.deepEqual(rows([{ monsterId: "mon1", count: 1 }]), [false], "no choice, and counts that cannot tell");
    assert.deepEqual(rows([{ srdId: "adult-red-dragon", count: 1 }]), [false], "no choice, the base counts");

    // Where the block's counts tell, they decide, a token from before the tick included. Elsewhere the tick does, only for a block with a lair.
    const monsters = await loadMonsters();
    const dragon = monsters.find((m) => m.srdId === "adult-red-dragon")!;
    const goblin = monsters.find((m) => m.srdId === "goblin-warrior")!;
    const keeper = monsterView(customMonster("keeper", { traits: [{ name: "Lair Actions", text: "On initiative count 20, the dead stir." }] }));
    const flat = monsterView(customMonster("flat", { xp: 450, xpInLair: 450 }));
    const lair = { legendary: { actionsMax: 4, actionsUsed: 0, resistMax: 4, resistUsed: 0 } };
    const base = { legendary: { actionsMax: 3, actionsUsed: 0, resistMax: 3, resistUsed: 0 } };
    const join = (actor: Parameters<typeof joinEntry>[1], block: Parameters<typeof joinEntry>[2]) => joinEntry({ id: "r", tokenId: "t" }, actor, block).inLair ?? false;
    assert.equal(join(lair, dragon), true, "no tick: the lair counts say so");
    assert.equal(join(base, dragon), false);
    assert.equal(join({ ...base, inLair: true }, dragon), false, "FU46-C2: counts set back by hand stand over the tick");
    assert.equal(join({ ...lair, inLair: true }, dragon), true);
    assert.equal(join({ inLair: true }, keeper), true, "lair actions alone: the tick decides");
    assert.equal(join({ inLair: true }, flat), true, "a lair that changes neither counts nor XP: the tick decides");
    assert.equal(join({ srdId: "adult-red-dragon", inLair: true }, null), true, "an SRD block not read: the tick decides");
    assert.equal(join({ inLair: true }, null), false, "FU46 round 2: a room block deleted since left the link, so no block is loading");
    assert.equal(join({ inLair: true }, goblin), false, "FU46-C1: never for a block read with no lair");
    assert.equal(join({}, keeper), false);
    assert.equal(join(undefined, dragon), false, "no actor of its own");
  });
});

/*
 * LAIR-TICK-CARRY (D-261026-19): a line ticked In its lair for a block with
 * lair actions alone reaches a fight started after the drop, as the
 * tracker's and the group bar's Start a fight build its rows
 * (combat/state.ts useFightJoin, groupEdit.ts fightOps), not only a drop
 * into a running one.
 */
describe("lair46: a line's In its lair rides on its tokens into a fight started later", () => {
  const keeper = () => customMonster("keeper", { name: "Crypt Keeper", traits: [{ name: "Lair Actions", text: "On initiative count 20, the dead stir." }] });

  async function placed(lines: SavedEncounterMonster[], withFight: boolean) {
    const state = setup();
    state.monsters.keeper = keeper();
    if (withFight) state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
    const srd = srdIndex(await loadMonsters());
    let n = 0;
    const resolve = (m: SavedEncounterMonster) => resolveLine(m, srd, state.monsters);
    const p = dropPlan({ monsters: lines, resolve, state, scene: state.scenes.s1!, center: { x: 10.5, y: 10.5 }, options: { hidden: false, addToFight: true }, newId: () => `new-${n++}` });
    const after = applyAll(state, p.ops).state;
    const created = p.ops.flatMap((op) => (op.t === "token.create" ? [op.token.id] : []));
    return { after, created, block: resolve(lines[0]!)!.view };
  }

  /** The tracker's Start a fight with these tokens, each row built by the rule every join shares. */
  function startFight(state: RoomState, ids: string[], block: Parameters<typeof joinEntry>[2]): boolean[] {
    let n = 0;
    const tokens = ids.map((id) => state.tokens[id]!);
    const mark = (entry: Parameters<typeof joinEntry>[0]) => {
      const t = state.tokens[entry.tokenId!]!;
      return joinEntry(entry, "inline" in t.actor ? t.actor.inline : undefined, block);
    };
    const started = applyAll(state, fightOps(tokens, null, () => `row-${n++}`, mark)).state;
    return started.encounter!.entries.map((e) => e.inLair);
  }

  test("ticked, the tokens keep the tick and join a fight started later with In lair on, its block read or not", async () => {
    const { after, created, block } = await placed([{ monsterId: "keeper", count: 2, inLair: true }], false);
    assert.equal(after.encounter, null, "no fight to add to");
    for (const id of created) assert.equal((after.tokens[id]!.actor as { inline: { inLair?: true } }).inline.inLair, true, `${id} keeps the tick`);
    assert.deepEqual(startFight(after, created, block), [true, true]);
    assert.deepEqual(startFight(after, created, null), [false, false], "a room block is at hand, so a null one is deleted and the tick goes with it");
  });

  test("unticked, they join out of their lair", async () => {
    const { after, created, block } = await placed([{ monsterId: "keeper", count: 1 }], false);
    assert.equal("inLair" in (after.tokens[created[0]!]!.actor as { inline: object }).inline, false);
    assert.deepEqual(startFight(after, created, block), [false]);
  });

  test("a tick from before its block lost its lair reaches no token and no row, dropped into a running fight included", async () => {
    const lost = { srdId: "goblin-warrior", count: 1, inLair: true };
    const quiet = await placed([lost], false);
    assert.equal("inLair" in (quiet.after.tokens[quiet.created[0]!]!.actor as { inline: object }).inline, false);
    const running = await placed([lost], true);
    assert.deepEqual(running.after.encounter!.entries.map((e) => e.inLair), [false]);
  });
});
