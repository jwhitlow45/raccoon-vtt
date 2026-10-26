import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { keys } from "./keys.ts";
import { lineAudience } from "./logRings.ts";
import type { DiceResult, LogEntry, LogEvent, RoomState, Viewer } from "./model.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { lineReach, projectEntity, projectState, rowSeenMark, seenMark } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { DM, apply, entry, env, member, room, scene, template, token } from "./testutil.ts";

/**
 * Per-player vision's marks (docs/design-v1-per-player-vision.md 6.5, lane
 * PV1), by the stub sight of perPlayerTestutil.ts: each source sees 3
 * cells out. Thorn is p1's, at the west, Bree p2's, at the south west, a
 * friendly scout every player shares sight with stands east, and p3 owns
 * nothing. p1 and p2 see for themselves. A goblin stands where only Thorn
 * sees it, an ogre where only the scout does, and a wolf where no one does.
 */
const THORN: Viewer = { memberId: "p1", role: "player" };
const BREE: Viewer = { memberId: "p2", role: "player" };
const P3: Viewer = { memberId: "p3", role: "player" };
const ON_S1 = { sceneId: "s1" };

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

function table(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.scenes.s1 = scene("s1", { vision: { on: true, light: "bright", perPlayer: true } });
  s.scenes.s2 = scene("s2", { order: 1, vision: { on: true, light: "bright", perPlayer: true } });
  s.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p2", on: true }, { memberId: "p1", on: true }, { memberId: "p3", on: false }] };
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 5, y: 5, disposition: "ally" });
  s.tokens.bree = token("bree", { kind: "pc", name: "Bree", ownerIds: ["p2"], x: 0, y: 12, disposition: "ally" });
  s.tokens.scout = token("scout", { kind: "npc", name: "Scout", partyVision: true, x: 30, y: 20, disposition: "ally" });
  s.tokens.gob = token("gob", { name: "Goblin", x: 7, y: 6 });
  s.tokens.ogre = token("ogre", { name: "Ogre", x: 31, y: 21 });
  s.tokens.wolf = token("wolf", { name: "Wolf", x: 20, y: 2 });
  return s;
}

function fight(s: RoomState, active: string): RoomState {
  const ids = ["gob", "ogre", "wolf", "thorn"];
  s.encounter = { rev: 0, round: 1, activeEntryId: `e-${active}`, entries: ids.map((id, i) => entry(`e-${id}`, { tokenId: id, value: 20 - i, tieOrder: i })) };
  return s;
}

function lines(state: RoomState, op: Op, who: Viewer = DM, seq = 7): { state: RoomState; log: LogEntry[] } {
  const r = applyOp(state, op, who, env(seq));
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return { state: r.state, log: r.log };
}

/** Who a written line reaches among the players, by its audience: every one, or its copies' readers. */
function readers(log: readonly LogEntry[], type: LogEvent["type"]): string[] {
  const out: string[] = [];
  for (const line of log) {
    if (line.data?.type !== type) continue;
    const audience = lineAudience(line);
    if (audience === "shared") out.push("all");
    if (audience === "party") out.push(line.to![0]!);
  }
  return out.sort();
}

describe("seenMark's two scopes (6.5)", () => {
  test("seen by all, a sorted list of the holders who saw, present when empty, and none on a whole-party scene", () => {
    const s = table();
    assert.deepEqual(seenMark(s, s.tokens.ogre!, {}, "here"), { seen: true }, "the shared sight sees the ogre");
    assert.deepEqual(seenMark(s, s.tokens.gob!, {}, "here"), { seenBy: ["p1"] });
    assert.deepEqual(seenMark(s, s.tokens.wolf!, {}, "here"), { seenBy: [] }, "a list even when no holder saw");
    assert.deepEqual(seenMark(s, s.tokens.thorn!, {}, "here"), { seen: true }, "a party member always");
    s.tokens.bree = { ...s.tokens.bree!, x: 8, y: 7 };
    assert.deepEqual(seenMark(s, s.tokens.gob!, {}, "here"), { seenBy: ["p1", "p2"] }, "sorted, whatever the list's order");
    const whole = table();
    whole.scenes.s1 = { ...whole.scenes.s1!, vision: { on: true, light: "bright" } };
    assert.deepEqual(seenMark(whole, whole.tokens.gob!, {}, "here"), { seen: true }, "the party's sight sees it");
    assert.deepEqual(seenMark(whole, whole.tokens.wolf!, {}, "here"), {});
  });

  test("only holders whose entry is on, and nothing behind a blackout, for a hidden creature, or off the player scene", () => {
    const s = table();
    s.holders.s1 = { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: false }, { memberId: "p2", on: true }] };
    assert.deepEqual(seenMark(s, s.tokens.gob!, {}, "here"), { seenBy: [] }, "unticked, Thorn's player has the shared sight");
    const dark = table();
    dark.meta = { ...dark.meta, view: { ...dark.meta.view, blackout: true } };
    assert.deepEqual(seenMark(dark, dark.tokens.gob!, {}, "here"), {});
    assert.deepEqual(seenMark(dark, dark.tokens.gob!, {}, "anywhere"), {});
    const hidden = table();
    hidden.tokens.gob = { ...hidden.tokens.gob!, visibility: "dm" };
    assert.deepEqual(seenMark(hidden, hidden.tokens.gob!, {}, "anywhere"), {});
    const away = table();
    away.tokens.gob = { ...away.tokens.gob!, sceneId: "s2" };
    away.tokens.thorn = { ...away.tokens.thorn!, sceneId: "s2" };
    assert.deepEqual(seenMark(away, away.tokens.gob!, {}, "here"), {}, "a log line's mark is the player scene's");
    assert.deepEqual(seenMark(away, away.tokens.gob!, {}, "anywhere"), { seenBy: [] }, "a stop's list off the player scene is empty");
  });

  test("a device's mark is a prediction and never a list", () => {
    const s = table();
    const view = projectState(s, THORN, ON_S1) as unknown as RoomState;
    assert.deepEqual(seenMark(view, view.tokens.gob!, {}, "here"), {});
  });
});

describe("what the marks reach (6.5, security rules 3 and 4)", () => {
  test("a line about a creature only Thorn sees is a party line, his copy reading it as seen, and the DM's keeping no list", () => {
    const { log } = lines(table(), { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 3 } });
    assert.deepEqual(readers(log, "hp"), ["p1"]);
    const dm = log.find((l) => l.data?.type === "hp" && lineAudience(l) === "dm")!;
    assert.equal(JSON.stringify(dm.data).includes("seenBy"), false, "the DM's line keeps no list once its readers are fixed");
    const copy = log.find((l) => l.data?.type === "hp" && l.to?.[0] === "p1")!;
    assert.equal((copy.data as { seen?: true }).seen, true);
    assert.deepEqual(readers(lines(table(), { t: "actor.hp", target: { tokenId: "ogre" }, change: { kind: "damage", amount: 3 } }).log, "hp"), ["all"]);
    assert.deepEqual(readers(lines(table(), { t: "actor.hp", target: { tokenId: "wolf" }, change: { kind: "damage", amount: 3 } }).log, "hp"), []);
  });

  test("a turn's line, its start and a path's stops reach only those who saw the creature there", () => {
    const toGoblin = fight(table(), "ogre");
    toGoblin.encounter!.entries = [entry("e-ogre", { tokenId: "ogre", value: 20 }), entry("e-gob", { tokenId: "gob", value: 15, tieOrder: 1 })];
    const start = lines(toGoblin, { t: "encounter.next" }, DM, 11);
    assert.equal(start.state.encounter!.activeEntryId, "e-gob");
    assert.deepEqual(start.state.encounter!.turnStart!.seenBy, ["p1"]);
    assert.deepEqual(readers(start.log, "turn"), ["p1"], "the goblin's turn line reaches Thorn's player alone");
    // The goblin walks from where only Thorn sees it to where only Bree does.
    const walked = lines(start.state, { t: "token.move", tokenId: "gob", x: 1, y: 13 }, DM, 12).state;
    assert.deepEqual(walked.tokens.gob!.path!.stops.map((st) => st.seenBy), [["p1"], ["p2"]]);
    const bree = projectEntity(keys.token("gob"), walked, BREE, ON_S1) as { path?: { stops: unknown[] } } | null;
    assert.equal(bree?.path?.stops.length, 1, "Bree's player gets only the stop she saw");
    assert.equal(projectEntity(keys.token("gob"), walked, P3, ON_S1), null, "and p3, who saw neither, not even the goblin");
    assert.equal((projectEntity(keys.encounter, walked, BREE, ON_S1) as { turnStart?: unknown }).turnStart, undefined, "nor its start");
  });

  test("Previous names the row it resumes only for those who saw it resume", () => {
    const s = fight(table(), "gob");
    s.encounter!.entries = [entry("e-gob", { tokenId: "gob", value: 20 }), entry("e-ogre", { tokenId: "ogre", value: 15, tieOrder: 1 })];
    const onOgre = lines(s, { t: "encounter.next" }, DM, 11).state;
    assert.equal(onOgre.encounter!.activeEntryId, "e-ogre");
    const back = lines(onOgre, { t: "encounter.prev" }, DM, 13);
    const turn = back.log.filter((l) => l.data?.type === "turn");
    const copy = (id: string) => turn.find((l) => l.to?.[0] === id)?.data as Extract<LogEvent, { type: "turn" }> | undefined;
    assert.equal(copy("p1")?.to, "e-gob", "Thorn's player saw the goblin's turn resume");
    assert.ok(copy("p2") && copy("p2")!.to === undefined, "Bree's player reads the take-back without the row she never saw");
    for (const l of turn) assert.equal(JSON.stringify(l.data).includes("eenBy"), false, "no line keeps a list");
  });

  test("a roll's list makes its line a party line, each reader's roll read as seen", () => {
    const s = table();
    const results: DiceResult[] = [{ formula: "1d20", faces: [9], total: 9 }, { formula: "1d20", faces: [4], total: 4 }];
    const op: Op = { t: "sys.dice", asked: { t: "dice.roll", tag: "0192f0a8-6c1e-7a4b-9c3d-2e1f0a9b8c7d", to: "all", rolls: [{ formula: "1d20", creature: { tokenId: "gob" } }, { formula: "1d20", creature: { tokenId: "ogre" } }] }, batch: "AbCdEfGhIjKlMnOp", results };
    const { log } = lines(s, op);
    assert.deepEqual(readers(log, "dice"), ["p1", "p2", "p3"], "a line holding a list is never a shared line with parts");
    const copy = (id: string) => log.find((l) => l.data?.type === "dice" && l.to?.[0] === id)!.data as Extract<LogEvent, { type: "dice" }>;
    assert.deepEqual(copy("p1").rolls.map((r) => [r.tokenId, r.seen]), [["gob", true], ["ogre", true]]);
    assert.deepEqual(copy("p2").rolls.map((r) => r.tokenId), ["ogre"], "Bree's player gets only the roll she saw");
    const reach = lineReach(s, { kind: "event", data: { type: "dice", by: "dm1", to: "all", rolls: [{ ...results[0]!, tokenId: "gob", seenBy: ["p1"] }] } });
    assert.equal(reach.audience, "party");
    assert.deepEqual(reach.audience === "party" ? reach.views.map(([id]) => id) : [], ["p1"]);
  });

  test("a turn line's mark names the holders whose tracker shows the row", () => {
    const s = fight(table(), "ogre");
    assert.deepEqual(rowSeenMark(s, s.encounter!.entries.find((e) => e.id === "e-gob")!, {}), { seenBy: ["p1"] });
    assert.deepEqual(rowSeenMark(s, s.encounter!.entries.find((e) => e.id === "e-ogre")!, {}), { seen: true });
  });
});

describe("an aura's reminder (6.5)", () => {
  /** A wight east of Thorn, in his sight, with a 30 ft aura, and Bree's player's creature to the south, out of the aura. */
  function aura(perPlayer: boolean): RoomState {
    const s = fight(table(), "thorn");
    if (!perPlayer) s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "bright" } };
    s.tokens.wight = token("wight", { name: "Wight", x: 8, y: 5 });
    s.tokens.bree = { ...s.tokens.bree!, x: 8, y: 15 };
    s.templates.dread = template("dread", { shape: "emanation", size: 30, attachedTo: "wight", casterId: "wight", includeOrigin: false, label: "Dread", ownerId: "dm1", triggers: ["enter"] });
    return s;
  }
  const north: Op = { t: "token.move", tokenId: "bree", x: 8, y: 8 };

  test("crossing Bree's creature where her player cannot see the wight, ending where she can, reaches Thorn's player only", () => {
    const s = aura(true);
    assert.deepEqual(seenMark(s, s.tokens.wight!, {}, "here"), { seenBy: ["p1"] }, "only Thorn sees the wight at first");
    const { state, log } = lines(s, north);
    assert.ok(log.some((l) => l.data?.type === "area"), "the crossing reminds");
    assert.deepEqual(readers(log, "area"), ["p1"], "her player owns the creature but did not see the area cross it");
    assert.deepEqual(seenMark(state, state.tokens.wight!, {}, "here"), { seenBy: ["p1", "p2"] }, "and the move ended where her player sees the wight");
    assert.deepEqual(readers(lines(aura(false), north).log, "area"), ["all"], "a whole-party scene keeps today's rule");
  });

  test("a player who holds no sight but owns the area, and sees the creature by the shared sight, is a witness (PV1-ASTRA-3)", () => {
    const s = fight(table(), "ogre");
    s.meta.settings = { ...s.meta.settings, playersSeeAoeOfOthers: false };
    s.tokens.imp = token("imp", { name: "Imp", x: 36, y: 20 });
    s.templates.ward = template("ward", { shape: "emanation", size: 10, attachedTo: "scout", casterId: "scout", includeOrigin: false, label: "Ward", ownerId: "p3", triggers: ["enter"] });
    const { log } = lines(s, { t: "token.move", tokenId: "imp", x: 32, y: 20 });
    assert.ok(log.some((l) => l.data?.type === "area"), "the crossing reminds");
    assert.deepEqual(readers(log, "area"), ["p3"], "p3 sees their own area and the imp, which the scout shows every player");
  });

  test("a creature crossing where only Thorn sees it reaches only Thorn's player, though it ends where Bree's player sees it too", () => {
    const s = fight(table(), "gob");
    s.tokens.gob = { ...s.tokens.gob!, x: 12, y: 5 };
    s.tokens.bree = { ...s.tokens.bree!, x: 0, y: 7 };
    s.templates.sg = template("sg", { shape: "emanation", size: 10, attachedTo: "thorn", casterId: "thorn", includeOrigin: false, spell: "Spirit Guardians", ownerId: "p1", triggers: ["enter"] });
    const { state, log } = lines(s, { t: "token.move", tokenId: "gob", x: 3, y: 6 });
    assert.deepEqual(readers(log, "area"), ["p1"]);
    assert.deepEqual(seenMark(state, state.tokens.gob!, {}, "here"), { seenBy: ["p1", "p2"] });
  });
});

describe("apply keeps the marks of a device's own prediction plain", () => {
  test("a DM's device predicts a line about a creature only some players see with no list", () => {
    const s = table();
    const view = projectState(s, DM, ON_S1) as unknown as RoomState;
    const predicted = apply(view, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 1 } }, DM, 30);
    assert.equal(JSON.stringify(predicted.log).includes("seenBy"), false);
    assert.equal(JSON.stringify(view).includes("seenBy"), false);
  });
});
