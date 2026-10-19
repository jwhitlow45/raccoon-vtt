import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AreaTrigger, LogEvent, RoomState } from "../model.ts";
import { projectState, stableStringify } from "../project.ts";
import type { Op } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { actor, DM, entry, env, P1, P2, reveal, room, template, token } from "../testutil.ts";

/**
 * A cleric (p1's) with Spirit Guardians, a 15 ft emanation that follows
 * her and hits on entering and at the end of a turn, only once a turn, and
 * a goblin 30 ft east. The goblin's turn is running.
 */
function fight(triggers: AreaTrigger[] = ["enter", "turnEnd"]): RoomState {
  const state = room();
  state.tokens.cleric = token("cleric", { kind: "pc", name: "Ayla", x: 5, y: 5, ownerIds: ["p1"], disposition: "ally" });
  state.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 12, y: 5 });
  state.templates.sg = template("sg", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers, oncePerTurn: true });
  state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 }), entry("e-cleric", { tokenId: "cleric", value: 10, tieOrder: 1 })] };
  return state;
}

/** Plays ops in order and returns the state and the area reminders written. */
function play(start: RoomState, ops: Op[]): { state: RoomState; reminders: LogEvent[] } {
  let state = start;
  // Log ids come from the seq, so a later play carries on after the log it inherits.
  let seq = 1 + Math.max(0, ...start.log.map((e) => Number(e.id.split(":")[0])));
  const reminders: LogEvent[] = [];
  for (const op of ops) {
    const r = applyOp(state, op, DM, env(seq++));
    assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
    state = r.state;
    for (const e of r.log) if (e.data?.type === "area") reminders.push(e.data);
  }
  return { state, reminders };
}

const move = (tokenId: string, x: number, y = 5): Op => ({ t: "token.move", tokenId, x, y });

describe("area reminders", () => {
  test("a creature that walks into an area that hits on entering is reminded once that turn", () => {
    const { reminders } = play(fight(), [move("g1", 8), move("g1", 12), move("g1", 8), { t: "encounter.next" }]);
    // In, out and in again, then its turn ends inside: Spirit Guardians hits once per turn.
    assert.deepEqual(reminders, [{ type: "area", templateId: "sg", tokenId: "g1", trigger: "enter", area: "Spirit Guardians", seen: true }]);
  });

  test("an area that does not say once per turn reminds for each trigger, so Grease's end of turn follows its entering", () => {
    const state = fight();
    delete state.templates.sg;
    state.templates.grease = template("grease", { shape: "cube", size: 10, origin: { x: 8, y: 6, z: 0 }, spell: "Grease", triggers: ["enter", "turnEnd"] });
    const { reminders } = play(state, [move("g1", 8), move("g1", 12), move("g1", 8), { t: "encounter.next" }]);
    assert.deepEqual(
      reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger]),
      [["g1", "enter"], ["g1", "turnEnd"]],
      "entering again the same turn reminds no more, ending the turn there does",
    );
    const once = fight();
    delete once.templates.sg;
    once.templates.grease = { ...state.templates.grease!, oncePerTurn: true };
    assert.deepEqual(play(once, [move("g1", 8), { t: "encounter.next" }]).reminders.length, 1, "marked once a turn, the first one stands for both");
  });

  test("a Next that arrives after the turn it names is over reminds nobody of a turn ending", () => {
    const state = fight();
    delete state.templates.sg;
    state.templates.cloud = template("cloud", { size: 40, origin: { x: 8, y: 5, z: 0 }, spell: "Cloudkill", triggers: ["turnEnd"] });
    // Two DM devices press Next for the goblin's turn: one turn ends, the goblin's, and the cleric's goes on.
    const { state: after, reminders } = play(state, [{ t: "encounter.next", from: { entry: "e-g1", round: 1 } }, { t: "encounter.next", from: { entry: "e-g1", round: 1 } }]);
    assert.deepEqual(
      reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger]),
      [["g1", "turnEnd"]],
    );
    assert.equal(after.encounter!.activeEntryId, "e-cleric");
  });

  test("on a later turn the same creature is reminded again", () => {
    const { reminders } = play(fight(), [move("g1", 8), { t: "encounter.next" }, move("g1", 12), move("g1", 8)]);
    assert.deepEqual(
      reminders.map((r) => r.type === "area" && r.trigger),
      ["enter", "enter"],
    );
  });

  test("ending a turn inside reminds, and the area following its cleric onto a goblin says so", () => {
    let { state, reminders } = play(fight(), [move("g1", 10)]);
    assert.deepEqual(reminders, [], "20 ft from Ayla is outside her 15 ft aura");
    // The cleric's turn: she walks up, and her aura comes onto the goblin.
    ({ state, reminders } = play(state, [{ t: "encounter.next" }, move("cleric", 7)]));
    assert.deepEqual(reminders, [{ type: "area", templateId: "sg", tokenId: "g1", trigger: "enter", area: "Spirit Guardians", moved: true, seen: true }]);
    // Round 2: the goblin's turn ends inside. A new turn, so it is reminded again.
    ({ reminders } = play(state, [{ t: "encounter.next" }, { t: "encounter.next" }]));
    assert.deepEqual(
      reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger]),
      [["g1", "turnEnd"]],
    );
  });

  test("an area that hits at the start of a turn reminds the creature whose turn starts there", () => {
    const state = fight();
    state.templates.cloud = template("cloud", { shape: "sphere", size: 10, origin: { x: 6, y: 6, z: 0 }, spell: "Stinking Cloud", triggers: ["turnStart"] });
    delete state.templates.sg;
    // The goblin's turn ends and Ayla's starts inside the cloud.
    const { reminders } = play(state, [{ t: "encounter.next" }]);
    assert.deepEqual(reminders, [{ type: "area", templateId: "cloud", tokenId: "cleric", trigger: "turnStart", area: "Stinking Cloud", seen: true }]);
  });

  test("a turn the removal of the acting row passes on starts in an area as any turn does, and Previous and undo start none", () => {
    const state = fight();
    state.templates.cloud = template("cloud", { shape: "sphere", size: 10, origin: { x: 6, y: 6, z: 0 }, spell: "Stinking Cloud", triggers: ["turnStart"] });
    delete state.templates.sg;
    const removed = play(state, [{ t: "encounter.remove", entryIds: ["e-g1"] }]);
    assert.deepEqual(removed.reminders, [{ type: "area", templateId: "cloud", tokenId: "cleric", trigger: "turnStart", area: "Stinking Cloud", seen: true }]);
    assert.deepEqual(removed.state.log.find((e) => e.data?.type === "turn")?.data, { type: "turn", entryId: "e-cleric", round: 1, seen: true });
    // Back to the goblin's turn and forward into Ayla's again: only the forward step starts a turn.
    const stepped = play(state, [{ t: "encounter.next" }, { t: "encounter.prev" }]);
    assert.deepEqual(stepped.reminders.length, 1);
    const undone = applyOp(stepped.state, { t: "sys.restore", entries: [{ key: "encounter", value: removed.state.encounter }], from: "undo" }, DM, env(50));
    assert.ok(undone.ok);
    assert.deepEqual(undone.log.filter((e) => e.data?.type === "area"), []);
  });

  test("a turn the removal passed on is a turn of its own, so a reminder before it does not stand for it", () => {
    const state = fight();
    state.tokens.orc = token("orc", { name: "Orc", x: 20, y: 20 });
    state.encounter = { ...state.encounter!, activeEntryId: "e-orc", entries: [entry("e-orc", { tokenId: "orc", value: 20 }), ...state.encounter!.entries] };
    // On the orc's turn the goblin is shoved into the aura, then the orc leaves the fight and the goblin's turn ends inside.
    const { reminders } = play(state, [move("g1", 8), { t: "encounter.remove", entryIds: ["e-orc"] }, { t: "encounter.next" }]);
    assert.deepEqual(
      reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger]),
      [["g1", "enter"], ["g1", "turnEnd"]],
    );
  });

  test("an area moved onto a creature reminds it, and placing one does not", () => {
    const state = fight(["enter"]);
    const moonbeam = { id: "mb", sceneId: "s1", shape: "cylinder" as const, size: 5, height: 40, origin: { x: 12.5, y: 5.5, z: 0 }, yaw: 0, includeOrigin: true, color: "#ffffff", ownerId: "dm1", visibility: "all" as const, triggers: ["enter" as const] };
    const { reminders } = play(state, [
      { t: "template.create", template: moonbeam },
      { t: "template.update", templateId: "mb", patch: { origin: { x: 20.5, y: 5.5, z: 0 } } },
      { t: "template.update", templateId: "mb", patch: { origin: { x: 12.5, y: 5.5, z: 0 } } },
    ]);
    assert.deepEqual(reminders, [{ type: "area", templateId: "mb", tokenId: "g1", trigger: "enter", area: "5 ft cylinder", moved: true, seen: true }]);
  });

  test("a creature that walks straight through an area, both ends outside it, entered it on the way", () => {
    const state = fight(["enter"]);
    delete state.templates.sg;
    state.templates.cloud = template("cloud", { shape: "sphere", size: 10, origin: { x: 8, y: 6, z: 0 }, spell: "Cloudkill", triggers: ["enter"] });
    const { reminders } = play(state, [move("g1", 1), move("g1", 1, 12)]);
    assert.deepEqual(reminders, [{ type: "area", templateId: "cloud", tokenId: "g1", trigger: "enter", area: "Cloudkill", seen: true }]);
    // A leg that passes by it enters nothing.
    assert.deepEqual(play(state, [move("g1", 12, 12)]).reminders, []);
  });

  test("an area moved right across a creature, both ends clear of it, came onto it", () => {
    const state = fight(["enter"]);
    delete state.templates.sg;
    state.templates.mb = template("mb", { shape: "cylinder", size: 5, height: 40, origin: { x: 16.5, y: 5.5, z: 0 }, spell: "Moonbeam", triggers: ["enter"] });
    const { reminders } = play(state, [{ t: "template.update", templateId: "mb", patch: { origin: { x: 8.5, y: 5.5, z: 0 } } }]);
    assert.deepEqual(reminders, [{ type: "area", templateId: "mb", tokenId: "g1", trigger: "enter", area: "Moonbeam", moved: true, seen: true }]);
  });

  test("a crossing under fog stays the DM's though the move ends in the open, as does an aura's route through the dark", () => {
    // Fog over the whole room but a strip on the west, where the goblin ends its move.
    const fogged = (state: RoomState) => {
      state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
      reveal(state, "s1", { x: 0, y: 0, w: 4, h: 30 });
    };
    const state = fight(["enter"]);
    delete state.templates.sg;
    state.templates.mb = template("mb", { shape: "cylinder", size: 5, height: 40, origin: { x: 8.5, y: 5.5, z: 0 }, spell: "Moonbeam", triggers: ["enter"] });
    fogged(state);
    const crossed = play(state, [move("g1", 2)]);
    assert.deepEqual(crossed.reminders, [{ type: "area", templateId: "mb", tokenId: "g1", trigger: "enter", area: "Moonbeam" }], "not seen: it crossed in the dark");
    assert.equal(projectState(crossed.state, P2, { sceneId: "s1" }).log.filter((e) => e.data?.type === "area").length, 0);

    // A monster cleric's aura sweeps over a goblin in the open from the dark, and stops in the open.
    const aura = fight(["enter"]);
    aura.tokens.cleric = { ...aura.tokens.cleric!, kind: "npc", ownerIds: [], x: 5, y: 8 };
    aura.scenes.s1 = { ...aura.scenes.s1!, fogEnabled: true };
    reveal(aura, "s1", { x: 12, y: 5, w: 1, h: 1 });
    reveal(aura, "s1", { x: 19, y: 7, w: 4, h: 4 });
    const swept = play(aura, [move("cleric", 20, 8)]);
    assert.deepEqual(swept.reminders, [{ type: "area", templateId: "sg", tokenId: "g1", trigger: "enter", area: "Spirit Guardians", moved: true, seen: true, hidden: true }]);
    assert.equal(projectState(swept.state, P2, { sceneId: "s1" }).log.filter((e) => e.data?.type === "area").length, 0, "its route stays the DM's");
  });

  test("nothing outside a fight, for areas without reminders, or for objects and the dead", () => {
    const calm = fight();
    calm.encounter = null;
    assert.deepEqual(play(calm, [move("g1", 8)]).reminders, []);
    // A room from before reminders: its areas have none, so its ops replay as they did.
    const old = fight();
    delete old.templates.sg!.triggers;
    assert.deepEqual(play(old, [move("g1", 8), { t: "encounter.next" }]).reminders, []);
    const things = fight();
    things.tokens.crate = token("crate", { kind: "object", name: "Crate", x: 12, y: 7 });
    things.tokens.dead = token("dead", { x: 12, y: 8, actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, life: "dead" }) } });
    assert.deepEqual(play(things, [move("crate", 8, 7), move("dead", 8, 6)]).reminders, []);
  });

  test("what players could not see stays the DM's", () => {
    const state = fight();
    state.tokens.g2 = token("g2", { name: "Goblin", number: 2, x: 12, y: 3, visibility: "dm" });
    state.templates.trap = template("trap", { shape: "sphere", size: 10, origin: { x: 16, y: 10, z: 0 }, spell: "Symbol", visibility: "dm", ownerId: "dm1", triggers: ["enter"] });
    const { state: after, reminders } = play(state, [move("g2", 8, 4), move("g1", 16, 10)]);
    assert.deepEqual(reminders, [
      { type: "area", templateId: "sg", tokenId: "g2", trigger: "enter", area: "Spirit Guardians" },
      { type: "area", templateId: "trap", tokenId: "g1", trigger: "enter", area: "Symbol", seen: true, hidden: true },
    ]);
    const areaLines = (viewer: typeof DM) => projectState(after, viewer, { sceneId: "s1" }).log.filter((e) => e.data?.type === "area").length;
    assert.equal(areaLines(DM), 2);
    // Ayla's player owns the aura but not the hidden goblin, and nobody but the DM knows the trap.
    assert.equal(areaLines(P1), 0);
    assert.equal(areaLines(P2), 0);
    // Once the goblin is shown, its line still stays out: players could not see it when it happened.
    const shown = play(after, [{ t: "token.update", tokenId: "g2", patch: { visibility: "all" } }]).state;
    assert.equal(projectState(shown, P1, { sceneId: "s1" }).log.filter((e) => e.data?.type === "area").length, 0);
  });

  test("players read what they could see while they can see the area", () => {
    const { state } = play(fight(), [move("g1", 8)]);
    const lines = (s: RoomState) => projectState(s, P2, { sceneId: "s1" }).log.filter((e) => e.data?.type === "area");
    assert.equal(lines(state).length, 1);
    // The room stops showing players each other's areas: the line goes with the aura.
    const hidden = play(state, [{ t: "room.update", settings: { playersSeeAoeOfOthers: false } }]).state;
    assert.equal(lines(hidden).length, 0);
    assert.equal(projectState(hidden, P1, { sceneId: "s1" }).log.filter((e) => e.data?.type === "area").length, 1, "the aura's owner keeps it");
  });
});

describe("a move that is a leg of the turn's path and an entry into an area", () => {
  test("records the leg and reminds the table, and replays to the same state and log", () => {
    const state = room();
    state.tokens.cleric = token("cleric", { kind: "pc", name: "Ayla", x: 5, y: 5, ownerIds: ["p1"], disposition: "ally" });
    state.tokens.g1 = token("g1", { name: "Goblin", number: 1, x: 12, y: 5 });
    state.templates.sg = template("sg", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers: ["enter", "turnEnd"] });
    // Started by ops, so the goblin's turn carries the seq its path is recorded under (rules/path.ts).
    const { state: turn } = play(state, [
      { t: "encounter.start", entries: [{ id: "e-g1", tokenId: "g1", value: 15 }, { id: "e-cleric", tokenId: "cleric", value: 10 }] },
      { t: "encounter.next" },
    ]);
    const once = applyOp(turn, move("g1", 8), DM, env(10));
    const again = applyOp(turn, move("g1", 8), DM, env(10));
    assert.ok(once.ok && again.ok);
    assert.deepEqual(
      once.state.tokens.g1!.path?.stops.map((s) => [s.x, s.y]),
      [[12, 5], [8, 5]],
    );
    assert.deepEqual(
      once.log.map((e) => e.data),
      [{ type: "area", templateId: "sg", tokenId: "g1", trigger: "enter", area: "Spirit Guardians", seen: true }],
    );
    assert.equal(stableStringify(again.state), stableStringify(once.state));
    assert.deepEqual(again.log, once.log);
    assert.deepEqual(again.touched, once.touched);
  });
});

describe("getting on and off moves a creature into an area as a move does (docs/design-v1-attach.md 9)", () => {
  /** The goblin's turn, a warhorse just outside the cleric's Spirit Guardians, which reach x 8 on her row. */
  const mounted = (setup: (s: RoomState) => void) => {
    const state = fight();
    state.tokens.horse = token("horse", { name: "Warhorse", size: "large", x: 9, y: 5 });
    setup(state);
    return state;
  };
  const entering = (state: RoomState, op: Op) => play(state, [op]).reminders.map((r) => r.type === "area" && [r.tokenId, r.trigger]);

  test("getting off into the area reminds as the same step by a move would", () => {
    const riding = mounted((s) => (s.tokens.g1 = { ...s.tokens.g1!, x: 9, y: 5, attached: { to: "horse", kind: "ride" } }));
    assert.deepEqual(entering(riding, { t: "token.detach", tokenId: "g1", x: 8, y: 5 }), [["g1", "enter"]]);
    const standing = mounted((s) => (s.tokens.g1 = { ...s.tokens.g1!, x: 9, y: 5 }));
    assert.deepEqual(entering(standing, move("g1", 8)), [["g1", "enter"]]);
  });

  test("so does stepping onto a seat inside it, while a drag, which leaves the creature where it stands, reminds nobody", () => {
    const beside = mounted((s) => {
      s.tokens.horse = { ...s.tokens.horse!, x: 7 };
      s.tokens.g1 = { ...s.tokens.g1!, x: 9, y: 5 };
    });
    assert.deepEqual(entering(beside, { t: "token.attach", tokenId: "g1", to: "horse", kind: "ride", x: 8, y: 5, elevation: 0 }), [["g1", "enter"]]);
    assert.deepEqual(entering(beside, { t: "token.attach", tokenId: "g1", to: "horse", kind: "drag", x: 9, y: 5, elevation: 0 }), []);
  });
});
