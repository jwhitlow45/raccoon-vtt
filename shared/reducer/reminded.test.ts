import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMITS } from "../limits.ts";
import { eventLines, lineAudience } from "../logRings.ts";
import type { AreaTemplate, RoomState, Viewer } from "../model.ts";
import { projectState } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp, type Applied } from "../reducer.ts";
import { DM, P1, P2, entry, env, room, template, token } from "../testutil.ts";

/**
 * The record of a turn's reminders (reminded.ts): each audience's own
 * reminders hold back a matching one for it alone, under a cap of its own,
 * and a turn that starts starts an empty record.
 */

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 2, opVersion?: number): Applied {
  const r = applyOp(state, op, who, { ...env(seq), ...(opVersion !== undefined ? { opVersion } : {}) });
  assert.ok(r.ok, r.ok ? "" : `${op.t}: ${r.message}`);
  return r;
}

/** The area reminders a viewer reads among an op's lines: a player the shared lines and their own copies, the DM one line per event. */
function read(r: Applied, who: Viewer): string[] {
  const lines = who.role === "dm" ? eventLines(r.log) : r.log.filter((e) => lineAudience(e) === "shared" || e.to?.includes(who.memberId) === true);
  return lines.flatMap((e) => (e.data?.type === "area" ? [`${e.data.templateId} ${e.data.tokenId} ${e.data.trigger}`] : []));
}

/** The server's own actor, as it removes a member. */
const SERVER: Viewer = { memberId: "server", role: "dm" };

const move = (tokenId: string, x: number, y = 5): Op => ({ t: "token.move", tokenId, x, y });
const place = (templateId: string, x: number, y: number): Op => ({ t: "template.update", templateId, patch: { origin: { x, y, z: 0 } } });

/**
 * Goblin 1's turn, with players who see only their own areas, beside one
 * area that reminds on entering and at a turn's end.
 */
function goblinTurn(area: Partial<AreaTemplate>): RoomState {
  const state = room();
  state.meta = { ...state.meta, settings: { ...state.meta.settings, playersSeeAoeOfOthers: false } };
  state.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 12, y: 5 });
  state.tokens.orc = token("orc", { name: "Orc", x: 20, y: 20 });
  state.templates.sg = template("sg", { shape: "sphere", size: 10, origin: { x: 6.5, y: 5.5, z: 0 }, spell: "Spirit Guardians", triggers: ["enter", "turnEnd"], ...area });
  state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 }), entry("e-orc", { tokenId: "orc", value: 10, tieOrder: 1 })] };
  return state;
}

/** An area every player reads the reminders of, one only P1 does, and one only the DM does, each with the viewer who reads it. */
const AUDIENCES: [string, Partial<AreaTemplate>, Viewer][] = [
  ["shared", { ownerId: "dm1" }, P2],
  ["P1's copies", { ownerId: "p1" }, P1],
  ["the DM's", { ownerId: "dm1", visibility: "dm" }, DM],
];

describe("each audience's own reminders hold back a matching one this turn (reminded.ts)", () => {
  test("for an area that hits once a turn one of any trigger, else one of the same trigger, in every audience", () => {
    for (const [name, area, who] of AUDIENCES) {
      for (const once of [false, true]) {
        const into = run(goblinTurn({ ...area, ...(once ? { oncePerTurn: true as const } : {}) }), move("g1", 6), DM, 2);
        const out = run(into.state, move("g1", 12), DM, 3);
        const back = run(out.state, move("g1", 6), DM, 4);
        const ended = run(back.state, { t: "encounter.next" }, DM, 5);
        assert.deepEqual(
          [into, back, ended].map((r) => read(r, who)),
          once ? [["sg g1 enter"], [], []] : [["sg g1 enter"], [], ["sg g1 turnEnd"]],
          `${name}, ${once ? "once a turn" : "each trigger once"}`,
        );
      }
    }
  });

  test("a reminder some of its readers already read goes to the rest alone, and the DM reads it again", () => {
    // P1's own aura: only P1 reads the goblin's first entering. Then the room shows players each other's areas.
    const into = run(goblinTurn({ ownerId: "p1", oncePerTurn: true }), move("g1", 6), DM, 2);
    assert.deepEqual([read(into, P1), read(into, P2)], [["sg g1 enter"], []]);
    let state = run(into.state, { t: "room.update", settings: { playersSeeAoeOfOthers: true } }, DM, 3).state;
    state = run(state, move("g1", 12), DM, 4).state;
    const back = run(state, move("g1", 6), DM, 5);
    assert.deepEqual([read(back, P1), read(back, P2), read(back, DM)], [[], ["sg g1 enter"], ["sg g1 enter"]]);
    assert.deepEqual(
      back.log.map((e) => [lineAudience(e), e.to]),
      [
        ["dm", undefined],
        ["party", ["p2"]],
      ],
      "a party line for P2 alone, though every player reads the area now",
    );
    assert.deepEqual(back.state.reminded?.players, { p1: { sg: { g1: 1 } }, p2: { sg: { g1: 1 } } });
  });

  test("a player past their cap is reminded again only of pairs past it, and another player's record holds", () => {
    // A hundred goblins every player sees, on the orc's turn, and areas only their owners see, moved onto them from far off.
    const state = goblinTurn({ ownerId: "dm1", origin: { x: 35, y: 25, z: 0 } });
    delete state.tokens.g1;
    state.tokens.orc = { ...state.tokens.orc!, x: 38, y: 2 };
    state.encounter = { ...state.encounter!, activeEntryId: "e-orc", entries: [state.encounter!.entries[1]!] };
    for (let i = 0; i < 100; i++) state.tokens[`g${100 + i}`] = token(`g${100 + i}`, { name: "Goblin", number: i + 1, x: i % 10, y: Math.floor(i / 10) });
    for (const [id, ownerId] of [["a", "p1"], ["b", "p1"], ["c", "p1"], ["d", "p2"]] as const) {
      state.templates[id] = template(id, { shape: "sphere", size: 40, origin: { x: 30, y: 25, z: 0 }, ownerId, triggers: ["enter"] });
    }
    let seq = 2;
    const step = (s: RoomState, op: Op) => run(s, op, DM, seq++);
    const count = (r: Applied, who: Viewer, id: string) => read(r, who).filter((line) => line.startsWith(`${id} `)).length;
    let s = state;
    const on: Record<string, number[]> = {};
    for (const id of ["a", "b", "c", "d"]) {
      const r = step(s, place(id, 5, 5));
      on[id] = [count(r, P1, id), count(r, P2, id)];
      s = r.state;
    }
    assert.deepEqual(on, { a: [100, 0], b: [100, 0], c: [100, 0], d: [0, 100] }, "each area reminds its owner of every goblin");
    const players = s.reminded!.players!;
    const pairs = (id: string) => Object.values(players[id]!).reduce((n, tokens) => n + Object.keys(tokens).length, 0);
    assert.deepEqual([pairs("p1"), pairs("p2")], [LIMITS.remindedPerPlayer, 100], "P1's record stopped at its cap, and C's goblins are not on it");
    const again: Record<string, number[]> = {};
    for (const id of ["a", "c", "d"]) {
      s = step(s, place(id, 30, 25)).state;
      const r = step(s, place(id, 5, 5));
      again[id] = [count(r, P1, id), count(r, P2, id)];
      s = r.state;
    }
    assert.deepEqual(again, { a: [0, 0], c: [100, 0], d: [0, 0] }, "only the pairs P1's cap left out remind again, and only P1");
  });
});

describe("a player's record goes with them", () => {
  test("a player who leaves keeps no record once the next reminder settles", () => {
    const into = run(goblinTurn({ ownerId: "p1" }), move("g1", 6), DM, 2);
    assert.deepEqual(into.state.reminded, { players: { p1: { sg: { g1: 1 } } } });
    const left = run(into.state, { t: "sys.memberRemove", memberId: "p1" }, SERVER, 3).state;
    const web = template("web", { shape: "sphere", size: 10, origin: { x: 12.5, y: 8.5, z: 0 }, ownerId: "dm1", triggers: ["enter"] });
    const next = run({ ...left, templates: { ...left.templates, web } }, move("g1", 12, 8), DM, 4);
    assert.deepEqual(next.state.reminded, { shared: { web: { g1: 1 } } });
  });
});

describe("a turn that starts starts an empty record", () => {
  test("a turn put back with Previous reminds again, as an op before op version 19 did", () => {
    // The hero's turn starts, the goblin's follows, the hero walks into the area and out, and the DM steps back to the hero's turn.
    const fight = (): RoomState => {
      const state = room();
      state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", x: 2, y: 5, ownerIds: ["p1"], disposition: "ally" });
      state.tokens.gob = token("gob", { x: 20, y: 20 });
      state.templates.web = template("web", { shape: "sphere", size: 10, origin: { x: 6.5, y: 5.5, z: 0 }, spell: "Web", ownerId: "dm1", triggers: ["enter"], oncePerTurn: true });
      state.encounter = { rev: 0, round: 1, activeEntryId: "e-gob", entries: [entry("e-hero", { tokenId: "hero", value: 15 }), entry("e-gob", { tokenId: "gob", value: 10, tieOrder: 1 })] };
      return state;
    };
    const ops: Op[] = [{ t: "encounter.next" }, { t: "encounter.next" }, move("hero", 6), move("hero", 12), { t: "encounter.prev" }, move("hero", 6)];
    const lines: string[][] = [];
    for (const opVersion of [18, undefined]) {
      let state = fight();
      const out: string[] = [];
      ops.forEach((op, i) => {
        const r = run(state, op, DM, 2 + i, opVersion);
        state = r.state;
        for (const e of eventLines(r.log)) if (e.data?.type === "area") out.push(`${e.id} ${e.data.trigger}`);
      });
      lines.push(out);
    }
    assert.deepEqual(lines, [["4:0 enter", "7:0 enter"], ["4:0 enter", "7:0 enter"]], "the goblin's turn's reminder does not stand for the hero's turn put back");
  });

  test("a turn put back with Previous keeps none of its first reminders, as an op before op version 19 did", () => {
    // The hero's turn starts in a once-a-turn Web, the cleric's follows, and Previous puts the hero's back before it walks out and in.
    const lines: string[][] = [];
    for (const opVersion of [18, undefined]) {
      let state = room();
      state.tokens.hero = token("hero", { kind: "pc", name: "Ayla", x: 5, y: 5, ownerIds: ["p1"], disposition: "ally" });
      state.tokens.cleric = token("cleric", { kind: "pc", name: "Bree", x: 20, y: 5, ownerIds: ["p2"], disposition: "ally" });
      state.templates.web = template("web", { shape: "sphere", size: 10, origin: { x: 5.5, y: 5.5, z: 0 }, spell: "Web", ownerId: "dm1", triggers: ["turnStart", "enter"], oncePerTurn: true });
      state.encounter = { rev: 0, round: 1, activeEntryId: "e-cleric", entries: [entry("e-hero", { tokenId: "hero", value: 15 }), entry("e-cleric", { tokenId: "cleric", value: 10, tieOrder: 1 })] };
      const ops: Op[] = [{ t: "encounter.next" }, { t: "encounter.next" }, { t: "encounter.prev" }, move("hero", 12), move("hero", 5)];
      const out: string[] = [];
      ops.forEach((op, i) => {
        const r = run(state, op, DM, 2 + i, opVersion);
        state = r.state;
        for (const e of eventLines(r.log)) if (e.data?.type === "area") out.push(`${op.t} ${e.data.trigger}`);
      });
      lines.push(out);
    }
    assert.deepEqual(lines, [
      ["encounter.next turnStart", "token.move enter"],
      ["encounter.next turnStart", "token.move enter"],
    ]);
  });

  test("a turn the removal of the acting row passes on starts one too", () => {
    // On the orc's turn the goblin walks into P1's aura, then the orc leaves the fight and the goblin's turn ends inside.
    const state = goblinTurn({ ownerId: "p1", oncePerTurn: true });
    state.encounter = { ...state.encounter!, activeEntryId: "e-orc" };
    const into = run(state, move("g1", 6), DM, 2);
    assert.deepEqual(into.state.reminded, { players: { p1: { sg: { g1: 1 } } } });
    const removed = run(into.state, { t: "encounter.remove", entryIds: ["e-orc"] }, DM, 3);
    assert.equal(removed.state.encounter!.activeEntryId, "e-g1");
    assert.equal(removed.state.reminded, undefined);
    const ended = run(removed.state, { t: "encounter.next" }, DM, 4);
    assert.deepEqual([read(into, P1), read(ended, P1)], [["sg g1 enter"], ["sg g1 turnEnd"]]);
  });
});

describe("the record is no entity", () => {
  test("a reminder writes no key, so the DM's undo of an older edit of the fight still applies", () => {
    const set = run(goblinTurn({ ownerId: "dm1" }), { t: "encounter.setValue", entryId: "e-orc", value: 12 }, DM, 2);
    const into = run(set.state, move("g1", 6), DM, 3);
    assert.deepEqual(read(into, P1), ["sg g1 enter"]);
    assert.ok(into.state.reminded !== undefined);
    assert.ok(!into.touched.includes("encounter"), "the move left the fight as it was");
    const undone = run(into.state, { t: "sys.restore", entries: set.inverse!, from: "undo" }, DM, 4);
    assert.equal(undone.state.encounter!.entries.find((e) => e.id === "e-orc")!.value, 10);
  });

  test("no projection carries it, the DM's included", () => {
    const into = run(goblinTurn({ ownerId: "dm1" }), move("g1", 6), DM, 2);
    assert.ok(into.state.reminded !== undefined);
    for (const who of [DM, P1, P2]) assert.equal("reminded" in projectState(into.state, who, { sceneId: "s1" }), false);
  });
});
