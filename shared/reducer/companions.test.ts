import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEvent } from "../logText.ts";
import { projectState } from "../project.ts";
import type { Effect, RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { opSchema, type Op, type TokenInput } from "../protocol.ts";
import { applyOp } from "../reducer.ts";
import { DM, P1, P2, actor, apply, character, companionBlock, comparable, effect, entry, env, refused, room, token } from "../testutil.ts";
import { BLOCK_OF_ITS_CHARACTER, ONE_LINK, normalizeCompanionState } from "./companions.ts";

/**
 * Companions (docs/design-v1-combat-flow.md 3.6): a token that belongs to a
 * character, owned as its character is, never numbered, and taking one of
 * three turns. These run the reducer as the server does, the DM included,
 * so the rules hold for everyone.
 */

/** Bree, Ana's druid, with her token, and a goblin. */
function bree(): RoomState {
  const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
  state.tokens.bt = token("bt", { kind: "pc", name: "Bree", actor: { ref: "bree" }, x: 5, y: 5, disposition: "ally", hpVisibility: "exact" });
  state.tokens.gob = token("gob", { name: "Goblin", x: 10, y: 10 });
  return state;
}

function spiritInput(over: Partial<TokenInput> = {}): TokenInput {
  return {
    id: "ws",
    sceneId: "s1",
    kind: "npc",
    name: "Wildfire Spirit",
    size: "small",
    x: 6,
    y: 5,
    layer: "token",
    disposition: "ally",
    actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, ac: 13, dmNotes: "" }) },
    companion: { of: "bree", turn: "shared" },
    ...over,
  };
}

const create = (over: Partial<TokenInput> = {}): Op => ({ t: "token.create", token: spiritInput(over) });

/** Bree with her spirit already beside her. */
function withSpirit(turn: "own" | "shared" | "none" = "shared", over: Partial<Token> = {}): RoomState {
  const state = bree();
  state.tokens.ws = token("ws", {
    kind: "npc",
    name: "Wildfire Spirit",
    x: 6,
    y: 5,
    disposition: "ally",
    ownerIds: ["p1"],
    companion: { of: "bree", turn },
    actor: { inline: actor({ hp: { cur: 15, max: 15, temp: 0 }, ac: 13 }) },
    ...over,
  });
  return state;
}

/** A fight: Bree 20, the spirit's own row 15 (when it has one), the goblin 10. */
function fight(state: RoomState, active: string | null = "e-bree", spiritRow = true): RoomState {
  const entries = [entry("e-bree", { tokenId: "bt", value: 20 }), entry("e-gob", { tokenId: "gob", value: 10, tieOrder: 2 })];
  if (spiritRow) entries.push(entry("e-ws", { tokenId: "ws", value: 15, tieOrder: 1 }));
  state.encounter = { rev: 0, round: 1, activeEntryId: active, entries: entries.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)) };
  return state;
}

function run(state: RoomState, op: Op, who: Viewer = DM, seq = 1, opVersion?: number) {
  const r = applyOp(state, op, who, { ...env(seq), ...(opVersion === undefined ? {} : { opVersion }) });
  assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
  return r;
}

const rows = (state: RoomState) => state.encounter?.entries.map((e) => e.id) ?? [];
const anchorOf = (effects: readonly Effect[] | undefined, id: string) => effects?.find((e) => e.id === id)?.duration?.anchor;

describe("making a companion", () => {
  test("create stores the character's owners and refuses other owners, a PC, a character's token, a number and an effect with its own turn", () => {
    const made = apply(bree(), create()).tokens.ws!;
    assert.deepEqual(made.ownerIds, ["p1"]);
    assert.deepEqual(made.companion, { of: "bree", turn: "shared" });
    assert.equal(apply(bree(), create({ ownerIds: ["p1"] })).tokens.ws!.ownerIds[0], "p1", "the same owners in any order pass");
    assert.match(refused(bree(), create({ ownerIds: ["p2"] })).message, /played by whoever plays its character/);
    assert.match(refused(bree(), create({ kind: "pc" })).message, /never a player character/);
    assert.match(refused(bree(), create({ actor: { ref: "bree" } })).message, /stats of its own/);
    assert.match(refused(bree(), create({ number: 2 })).message, /has no number/);
    assert.match(refused(bree(), create({ kind: "object", companion: { of: "bree", turn: "own" } })).message, /an effect takes no turn of its own/);
    assert.equal(refused(bree(), create({ companion: { of: "nobody", turn: "shared" } })).code, "gone");
  });

  test("a player's create writes the companion line, which only the DM's projection carries, and the DM's writes none", () => {
    const byPlayer = run(bree(), create(), P1);
    const line = byPlayer.log.find((e) => e.data?.type === "companion");
    assert.deepEqual(line?.data, { type: "companion", tokenId: "ws", characterId: "bree", memberId: "p1", name: "Wildfire Spirit" });
    const state = byPlayer.state;
    state.members.p1 = { ...state.members.p1!, name: "Ana" };
    assert.equal(describeEvent(line!.data!, { members: state.members, tokens: state.tokens, characters: state.characters, handouts: {}, encounter: null }), "Ana added Wildfire Spirit beside Bree.");
    assert.equal(run(bree(), create(), DM).log.some((e) => e.data?.type === "companion"), false);
  });

  test("attaching a numbered Owl clears its number first, while a number the op supplies is refused everywhere", () => {
    const state = bree();
    state.tokens.owl = token("owl", { kind: "monster", name: "Owl", number: 2, disposition: "hostile" });
    const attached = apply(state, { t: "token.update", tokenId: "owl", patch: { companion: { of: "bree", turn: "shared" } } }).tokens.owl!;
    assert.equal(attached.number, undefined);
    assert.deepEqual(attached.ownerIds, ["p1"]);
    assert.match(refused(state, { t: "token.update", tokenId: "owl", patch: { companion: { of: "bree", turn: "shared" }, number: 3 } }).message, /no number/);
    const later = withSpirit();
    assert.match(refused(later, { t: "token.update", tokenId: "ws", patch: { number: 4 } }).message, /no number/);
    assert.equal(opSchema.safeParse({ t: "token.updateMany", tokenIds: ["ws"], patch: { number: 4 } }).success, false, "a group edit carries no number");
  });

  test("a new Owl beside a hidden Owl gets no number, and numbering a new Owl leaves the companion alone", () => {
    const state = bree();
    state.tokens.hidden = token("hidden", { kind: "monster", name: "Owl", visibility: "dm" });
    const owl = apply(state, create({ id: "owl", name: "Owl" })).tokens.owl!;
    assert.equal(owl.number, undefined, "it would tell a player a hidden Owl stands there");
    const withOwl = withSpirit("shared", { name: "Owl" });
    const next = apply(withOwl, { t: "token.create", token: { id: "o2", sceneId: "s1", kind: "monster", name: "Owl", size: "small", x: 1, y: 1, actor: { inline: actor() } } });
    assert.equal(next.tokens.ws!.number, undefined);
    assert.equal(next.tokens.o2!.number, undefined, "no sibling to number against");
  });
});

describe("a companion's turn and its rows", () => {
  test("a change to shared removes the row, passes an active row's turn on with its line, binds paused durations to Bree's row, and empties the history", () => {
    let state = fight(withSpirit("own"), "e-bree");
    state.tokens.gob!.actor = { inline: actor({ effects: [effect("blind", { key: "blinded", duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-ws" } } })] }) };
    state = run(state, { t: "encounter.next" }).state;
    assert.equal(state.encounter!.activeEntryId, "e-ws");
    assert.ok(state.encounterHistory[0]!.encounter.entries.some((e) => e.id === "e-ws"));
    const r = run(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "shared" } } }, DM, 3);
    assert.deepEqual(rows(r.state), ["e-bree", "e-gob"]);
    assert.equal(r.state.encounter!.activeEntryId, "e-gob", "the spirit's turn passes on");
    assert.ok(r.log.some((e) => e.data?.type === "turn" && e.data.entryId === "e-gob"));
    const gob = r.state.tokens.gob!.actor;
    assert.ok("inline" in gob);
    assert.deepEqual(anchorOf(gob.inline.effects, "blind"), { entryId: "e-bree" }, "it now counts Bree's turns");
    assert.ok(r.state.encounterHistory.every((step) => !step.encounter.entries.some((e) => e.id === "e-ws")));
    const back = run(r.state, { t: "encounter.prev" }, DM, 4).state;
    assert.deepEqual(rows(back), ["e-bree", "e-gob"], "Previous brings back no row of it");
    assert.equal(back.encounter!.activeEntryId, "e-bree");
  });

  test("a saved active row of the companion passes to the next row, and its spot goes, and from op version 21 Previous walks past that turn", () => {
    for (const opVersion of [20, undefined]) {
      let state = fight(withSpirit("own"), "e-ws");
      state.encounter!.turnStart = { entryId: "e-ws", tokenId: "ws", sceneId: "s1", x: 6, y: 5, elevation: 0, seq: 1 };
      state = run(state, { t: "encounter.next" }, DM, 1, opVersion).state;
      state = run(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "none" } } }, DM, 2, opVersion).state;
      // The saved encounter passes the turn on either way, as a build from before op version 21 puts it back whole.
      const saved = state.encounterHistory[0]!;
      assert.equal(saved.encounter.activeEntryId, "e-gob");
      assert.equal(saved.encounter.turnStart, undefined);
      assert.equal(saved.resumesGone, opVersion === 20 ? undefined : true);
      const back = run(state, { t: "encounter.prev" }, DM, 3, opVersion).state;
      // With no step before it, no row acts, as when the history's first turn leaves the fight (design 9.4).
      assert.equal(back.encounter!.activeEntryId, opVersion === 20 ? "e-gob" : null);
    }
  });

  test("Dismiss and the character's deletion take its rows out of the fight and the history too", () => {
    let state = run(fight(withSpirit("own"), "e-bree"), { t: "encounter.next" }).state;
    const dismissed = run(state, { t: "token.delete", tokenId: "ws" }, DM, 2).state;
    assert.deepEqual(rows(dismissed), ["e-bree", "e-gob"]);
    assert.ok(dismissed.encounterHistory.every((step) => !step.encounter.entries.some((e) => e.id === "e-ws")));
    assert.deepEqual(rows(run(dismissed, { t: "encounter.prev" }, DM, 3).state), ["e-bree", "e-gob"]);
    state = run(fight(withSpirit("own"), "e-bree"), { t: "encounter.next" }).state;
    const gone = run(state, { t: "character.delete", characterId: "bree" }, DM, 2).state;
    assert.equal(gone.tokens.ws, undefined, "the companion goes with its character");
    assert.deepEqual(rows(gone), ["e-gob"]);
    assert.ok(gone.encounterHistory.every((step) => !step.encounter.entries.some((e) => e.id === "e-ws")), "the companion's saved rows go, as for Dismiss");
  });

  test("Ana's delete of Bree, whom she plays alone, does what the DM's does: every token on every scene, hidden ones too, the companion and every row", () => {
    const start = () => {
      const state = fight(withSpirit("own"), "e-bree");
      state.tokens.away = token("away", { kind: "pc", name: "Bree", actor: { ref: "bree" }, sceneId: "s2", x: 3, y: 3 });
      state.tokens.veiled = token("veiled", { kind: "pc", name: "Bree", actor: { ref: "bree" }, visibility: "dm", x: 8, y: 8 });
      state.encounter!.entries.push(entry("e-c", { characterId: "bree", value: 5 }));
      return run(state, { t: "encounter.next" }).state;
    };
    const op: Op = { t: "character.delete", characterId: "bree" };
    assert.ok(canApply(op, P1, start(), { canUseAsset: () => false }).ok);
    const ana = run(start(), op, P1, 2);
    const byAna = ana.state;
    const byDm = run(start(), op, DM, 2).state;
    assert.deepEqual(comparable(byAna), comparable(byDm), "the same state, but for the DM's line");
    assert.equal(byAna.characters.bree, undefined);
    assert.deepEqual(Object.keys(byAna.tokens), ["gob"]);
    assert.deepEqual(rows(byAna), ["e-gob"]);
    assert.equal(byAna.encounter!.activeEntryId, "e-gob", "the turn passes on, as when the DM deletes it");
    assert.ok(byAna.encounterHistory.every((step) => !step.encounter.entries.some((e) => e.id === "e-ws")));
    // What went, on every scene and hidden ones included, in a line for the DM: the DM cannot undo it.
    const line = ana.log.find((e) => e.data?.type === "characterDeleted");
    assert.deepEqual(line?.data, { type: "characterDeleted", characterId: "bree", memberId: "p1", name: "Bree", tokens: 3, companions: 1, rows: 3 });
  });

  test("a player's delete writes a line only the DM's log carries, and the DM's own delete writes none", () => {
    const state = withSpirit();
    state.members.p1 = { ...state.members.p1!, name: "Pat" };
    state.tokens.away = token("away", { kind: "pc", name: "Bree", actor: { ref: "bree" }, sceneId: "s2", x: 3, y: 3 });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e-bree", { tokenId: "bt", value: 20 })] };
    const op: Op = { t: "character.delete", characterId: "bree" };
    const byPat = run(state, op, P1, 2);
    const data = byPat.log.find((e) => e.data?.type === "characterDeleted")?.data;
    assert.ok(data?.type === "characterDeleted");
    const names = { members: byPat.state.members, tokens: byPat.state.tokens, characters: byPat.state.characters, handouts: {}, encounter: null };
    assert.equal(describeEvent(data, names), "Pat deleted Bree, with 2 tokens, 1 companion and its place in the fight.");
    assert.equal(describeEvent({ ...data, tokens: 0, companions: 0, rows: 0 }, names), "Pat deleted Bree.");
    assert.equal(describeEvent({ ...data, tokens: 1, companions: 2, rows: 2 }, names), "Pat deleted Bree, with 1 token, 2 companions and its 2 places in the fight.");
    const has = (viewer: Viewer) => projectState(byPat.state, viewer, { sceneId: "s1" }).log.some((e) => e.data?.type === "characterDeleted");
    assert.equal(has(DM), true, "the DM reads it");
    assert.equal(has(P1), false, "not the player who deleted it");
    assert.equal(has(P2), false, "nor any other player");
    assert.equal(run(state, op, DM, 2).log.some((e) => e.data?.type === "characterDeleted"), false, "the DM's own delete writes none");
  });

  test("a readied effect saved by Next and counting the companion's row comes back counting Bree's row after a turn change, and paused on the companion after Dismiss", () => {
    const start = () => {
      const state = fight(withSpirit("own"), "e-bree");
      state.tokens.gob!.actor = { inline: actor({ effects: [effect("rd", { key: "readied", duration: { remaining: 1, boundary: "turnStart", anchor: { entryId: "e-ws" } } })] }) };
      const next = run(state, { t: "encounter.next" }).state;
      assert.ok(next.encounterHistory[0]!.effects.gob, "Next saved the goblin's effects");
      return next;
    };
    const restored = (state: RoomState) => {
      const gob = run(state, { t: "encounter.prev" }, DM, 5).state.tokens.gob;
      assert.ok(gob && "inline" in gob.actor);
      return anchorOf(gob.actor.inline.effects, "rd");
    };
    const converted = run(start(), { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "shared" } } }, DM, 3).state;
    assert.deepEqual(restored(converted), { entryId: "e-bree" });
    const dismissed = run(start(), { t: "token.delete", tokenId: "ws" }, DM, 3).state;
    assert.deepEqual(restored(dismissed), { tokenId: "ws" });
  });

  test("shared to own, detaching and giving it to another character leave durations bound to Bree's row where they are", () => {
    const base = () => {
      const state = fight(withSpirit("shared"), "e-gob", false);
      state.characters.cy = character("cy", { name: "Cy", ownerIds: ["p2"] });
      return apply(state, { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "hex", key: "blessed", duration: { mode: "turnEnd", of: { tokenId: "ws" } } } });
    };
    const anchor = (state: RoomState) => {
      const gob = state.tokens.gob!.actor;
      assert.ok("inline" in gob);
      return anchorOf(gob.inline.effects, "hex");
    };
    assert.deepEqual(anchor(base()), { entryId: "e-bree" });
    for (const companion of [{ of: "bree", turn: "own" as const }, null, { of: "cy", turn: "shared" as const }]) {
      assert.deepEqual(anchor(apply(base(), { t: "token.update", tokenId: "ws", patch: { companion } }, DM, 2)), { entryId: "e-bree" }, JSON.stringify(companion));
    }
  });

  test("encounter.start and encounter.add refuse rows for shared and none companions and take an own one", () => {
    for (const turn of ["shared", "none"] as const) {
      const state = withSpirit(turn);
      assert.match(refused(state, { t: "encounter.start", entries: [{ id: "e1", tokenId: "ws" }] }).message, /acts on its character's turn/);
      const running = fight(withSpirit(turn), null, false);
      assert.match(refused(running, { t: "encounter.add", entries: [{ id: "e1", tokenId: "ws" }] }).message, /acts on its character's turn/);
    }
    const own = fight(withSpirit("own"), null, false);
    assert.ok(rows(apply(own, { t: "encounter.add", entries: [{ id: "e1", tokenId: "ws" }] })).includes("e1"));
  });
});

describe("a companion's kind", () => {
  test("an own-turn companion cannot become an effect, an effect cannot take its own turn, and an effect made a creature can", () => {
    assert.match(refused(withSpirit("own"), { t: "token.update", tokenId: "ws", patch: { kind: "object" } }).message, /no turn of its own/);
    const effectOne = withSpirit("none", { kind: "object" });
    assert.match(refused(effectOne, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "own" } } }).message, /no turn of its own/);
    const creature = apply(effectOne, { t: "token.update", tokenId: "ws", patch: { kind: "npc" } });
    assert.equal(apply(creature, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "own" } } }).tokens.ws!.companion?.turn, "own");
    assert.match(refused(withSpirit("shared"), { t: "token.update", tokenId: "ws", patch: { kind: "pc" } }).message, /never a player character/);
  });

  test("a living or dead creature made an effect keeps its HP, AC, death saves and life unwritten, and shows them again as a creature", () => {
    for (const life of ["alive", "dead"] as const) {
      const stored = actor({ hp: { cur: life === "dead" ? 0 : 9, max: 15, temp: 2 }, ac: 13, life, deathSaves: { ok: 1, fail: 2 } });
      const state = withSpirit("shared", { actor: { inline: stored } });
      const asEffect = apply(state, { t: "token.update", tokenId: "ws", patch: { kind: "object" } });
      const kept = asEffect.tokens.ws!.actor;
      assert.ok("inline" in kept);
      assert.deepEqual(kept.inline, stored, "the actor is never written");
      const again = apply(asEffect, { t: "token.update", tokenId: "ws", patch: { kind: "npc" } }).tokens.ws!.actor;
      assert.ok("inline" in again);
      assert.deepEqual(again.inline, stored);
    }
  });
});

describe("a companion's owners", () => {
  test("an ownerIds patch is refused, detaching then setting owners in one patch passes, and a group edit of owners over a companion is refused", () => {
    assert.match(refused(withSpirit(), { t: "token.update", tokenId: "ws", patch: { ownerIds: ["p2"] } }).message, /whoever plays its character/);
    const detached = apply(withSpirit(), { t: "token.update", tokenId: "ws", patch: { companion: null, ownerIds: ["p2"] } }).tokens.ws!;
    assert.equal(detached.companion, undefined);
    assert.deepEqual(detached.ownerIds, ["p2"]);
    assert.match(refused(withSpirit(), { t: "token.updateMany", tokenIds: ["gob", "ws"], patch: { ownerIds: ["p2"] } }).message, /whoever plays its character/);
  });

  test("detaching leaves its owners as they were, for the DM to change", () => {
    assert.deepEqual(apply(withSpirit(), { t: "token.update", tokenId: "ws", patch: { companion: null } }).tokens.ws!.ownerIds, ["p1"]);
  });

  test("a character's new owners reach its companions in the same op, in token id order, on every scene", () => {
    const state = withSpirit();
    state.tokens.aa = token("aa", { kind: "object", sceneId: "s2", ownerIds: ["p1"], companion: { of: "bree", turn: "none" }, actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0 }) } });
    const r = run(state, { t: "character.update", characterId: "bree", patch: { ownerIds: ["p2"] } });
    assert.deepEqual(r.state.tokens.ws!.ownerIds, ["p2"]);
    assert.deepEqual(r.state.tokens.aa!.ownerIds, ["p2"]);
    assert.deepEqual(r.touched.filter((k) => k.startsWith("token:")), ["token:aa", "token:ws"]);
  });
});

describe("a shared companion's Reaction", () => {
  const reaction = (on: boolean): Op => ({ t: "token.update", tokenId: "ws", patch: { companionReaction: on } });

  test("its own patch sets and clears the flag and changes nothing else", () => {
    const state = withSpirit("shared");
    const spent = apply(state, reaction(true)).tokens.ws!;
    assert.deepEqual(spent.companion, { of: "bree", turn: "shared", reactionUsed: true });
    const { rev: _a, companion: _c, ...restBefore } = state.tokens.ws!;
    const { rev: _b, companion: _d, ...restAfter } = spent;
    assert.deepEqual(restAfter, restBefore);
    const cleared = apply({ ...state, tokens: { ...state.tokens, ws: spent } }, reaction(false)).tokens.ws!;
    assert.deepEqual(cleared.companion, { of: "bree", turn: "shared" });
  });

  test("it is refused on a token that is not a shared companion, and a late press after the DM made it own and added its row changes nothing", () => {
    assert.match(refused(withSpirit("none"), reaction(true)).message, /does not act on its character's turn/);
    assert.match(refused(bree(), { t: "token.update", tokenId: "gob", patch: { companionReaction: true } }).message, /does not act on its character's turn/);
    let state = fight(withSpirit("shared"), "e-bree", false);
    state = apply(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "own" } } });
    state = apply(state, { t: "encounter.add", entries: [{ id: "e-ws", tokenId: "ws", value: 12 }] });
    const r = applyOp(state, reaction(true), P1, env(9));
    assert.equal(r.ok, false);
    assert.equal(state.tokens.ws!.companion?.turn, "own");
    assert.equal(state.encounter!.entries.find((e) => e.id === "e-ws")?.reactionUsed, false);
    assert.equal(state.encounter!.entries.find((e) => e.id === "e-bree")?.reactionUsed, false);
  });

  test("the flag goes with a turn change away from shared and with detaching, and stays when it is given to another character", () => {
    const spent = withSpirit("shared", { companion: { of: "bree", turn: "shared", reactionUsed: true } });
    spent.characters.cy = character("cy", { name: "Cy", ownerIds: ["p2"] });
    assert.deepEqual(apply(spent, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "none" } } }).tokens.ws!.companion, { of: "bree", turn: "none" });
    assert.equal(apply(spent, { t: "token.update", tokenId: "ws", patch: { companion: null } }).tokens.ws!.companion, undefined);
    const given = apply(spent, { t: "token.update", tokenId: "ws", patch: { companion: { of: "cy", turn: "shared" } } }).tokens.ws!;
    assert.deepEqual(given.companion, { of: "cy", turn: "shared", reactionUsed: true });
    assert.deepEqual(given.ownerIds, ["p2"]);
  });

  test("Next clears it on the landing row's character's shared companions on that row's scene, in id order, and saves their ids for Previous", () => {
    const state = fight(withSpirit("shared", { companion: { of: "bree", turn: "shared", reactionUsed: true } }), "e-gob", false);
    state.tokens.aa = token("aa", { kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.tokens.far = token("far", { kind: "npc", sceneId: "s2", ownerIds: ["p1"], companion: { of: "bree", turn: "shared", reactionUsed: true } });
    const r = run(state, { t: "encounter.next" });
    assert.equal(r.state.encounter!.activeEntryId, "e-bree");
    assert.equal(r.state.tokens.ws!.companion?.reactionUsed, undefined);
    assert.equal(r.state.tokens.aa!.companion?.reactionUsed, undefined);
    assert.equal(r.state.tokens.far!.companion?.reactionUsed, true, "one on another scene keeps its flag");
    assert.deepEqual(r.state.encounterHistory.at(-1)!.companionReactions, ["aa", "ws"]);
    const back = run(r.state, { t: "encounter.prev" }, DM, 2).state;
    assert.equal(back.tokens.ws!.companion?.reactionUsed, true);
    assert.equal(back.tokens.aa!.companion?.reactionUsed, true);
  });

  test("a Next that clears none saves none, so a step's shape is as before", () => {
    const r = run(fight(withSpirit("shared"), "e-gob", false), { t: "encounter.next" });
    assert.equal("companionReactions" in r.state.encounterHistory.at(-1)!, false);
  });

  test("a character-only row clears its companions on the players' scene", () => {
    const state = withSpirit("shared", { companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-gob", entries: [entry("e-gob", { tokenId: "gob", value: 20 }), entry("e-c", { characterId: "bree", value: 10, tieOrder: 1 })] };
    const r = run(state, { t: "encounter.next" });
    assert.equal(r.state.tokens.ws!.companion?.reactionUsed, undefined);
    state.meta.playerSceneId = "s2";
    assert.equal(run(state, { t: "encounter.next" }).state.tokens.ws!.companion?.reactionUsed, true, "the spirit is not on the players' scene");
  });

  test("a mixed row, Ana's own Bree token with Cy's character id, passes the schema and the permissions, and clears only Bree's companions", () => {
    const state = withSpirit("shared", { companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.characters.cy = character("cy", { name: "Cy", ownerIds: ["p2"] });
    state.tokens.cyc = token("cyc", { kind: "npc", ownerIds: ["p2"], companion: { of: "cy", turn: "shared", reactionUsed: true } });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [] };
    const add: Op = { t: "encounter.add", entries: [{ id: "mixed", tokenId: "bt", characterId: "cy" }] };
    assert.ok(opSchema.safeParse(add).success);
    assert.ok(canApply(add, DM, state, { canUseAsset: () => true }).ok);
    const next = run(apply(state, add), { t: "encounter.next" }).state;
    assert.equal(next.tokens.ws!.companion?.reactionUsed, undefined);
    assert.equal(next.tokens.cyc!.companion?.reactionUsed, true);
  });

  test("Previous sets it again only on companions still shared, skipping one converted, detached or deleted since", () => {
    const start = () => run(fight(withSpirit("shared", { companion: { of: "bree", turn: "shared", reactionUsed: true } }), "e-gob", false), { t: "encounter.next" }).state;
    const prev = (state: RoomState) => run(state, { t: "encounter.prev" }, DM, 9).state;
    const converted = apply(start(), { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "none" } } }, DM, 2);
    assert.deepEqual(prev(converted).tokens.ws!.companion, { of: "bree", turn: "none" });
    const detached = apply(start(), { t: "token.update", tokenId: "ws", patch: { companion: null } }, DM, 2);
    assert.equal(prev(detached).tokens.ws!.companion, undefined);
    const deleted = apply(start(), { t: "token.delete", tokenId: "ws" }, DM, 2);
    assert.equal(prev(deleted).tokens.ws, undefined);
  });
});

describe("companions in an imported room", () => {
  test("normalizeCompanionState: owners, numbers, an own-turn effect, a missing character, and rows in the encounter and its history", () => {
    const state = bree();
    state.tokens.ws = token("ws", { kind: "npc", ownerIds: ["p2"], number: 3, companion: { of: "bree", turn: "shared", reactionUsed: true } });
    state.tokens.sw = token("sw", { kind: "object", ownerIds: [], companion: { of: "bree", turn: "own" }, actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0 }) } });
    state.tokens.lost = token("lost", { kind: "npc", companion: { of: "nobody", turn: "shared" } });
    state.tokens.pc2 = token("pc2", { kind: "pc", actor: { ref: "bree" }, companion: { of: "bree", turn: "none" } });
    state.tokens.gob!.actor = { inline: actor({ effects: [effect("e1", { key: "blinded", duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-ws" } } })] }) };
    state.encounter = {
      rev: 0,
      round: 1,
      activeEntryId: "e-ws",
      entries: [entry("e-bree", { tokenId: "bt", value: 20 }), entry("e-ws", { tokenId: "ws", value: 15, tieOrder: 1 }), entry("e-gob", { tokenId: "gob", value: 10, tieOrder: 2 })],
    };
    state.encounterHistory = [{ encounter: structuredClone(state.encounter), effects: { gob: [effect("e1", { key: "blinded", duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-ws" } } })] }, revealed: [], at: "x" }];
    const out = normalizeCompanionState(state);
    assert.deepEqual(out.tokens.ws!.ownerIds, ["p1"]);
    assert.equal(out.tokens.ws!.number, undefined);
    assert.equal(out.tokens.ws!.companion?.reactionUsed, true);
    assert.deepEqual(out.tokens.sw!.companion, { of: "bree", turn: "shared" });
    assert.equal(out.tokens.lost!.companion, undefined, "a companion whose character did not come through is a plain token");
    assert.equal(out.tokens.pc2!.companion, undefined, "a character's token is never a companion");
    assert.deepEqual(rows(out), ["e-bree", "e-gob"]);
    assert.equal(out.encounter!.activeEntryId, "e-gob");
    const gob = out.tokens.gob!.actor;
    assert.ok("inline" in gob);
    assert.deepEqual(anchorOf(gob.inline.effects, "e1"), { entryId: "e-bree" });
    const saved = out.encounterHistory[0]!;
    assert.deepEqual(saved.encounter.entries.map((e) => e.id), ["e-bree", "e-gob"]);
    assert.deepEqual(anchorOf(saved.effects.gob, "e1"), { entryId: "e-bree" });
    assert.equal(state.tokens.ws!.number, 3, "the input is left as it was");
  });
});

describe("permissions read the same rules (P2 as a stranger)", () => {
  test("another player cannot mark Bree's spirit's Reaction", () => {
    const state = withSpirit("shared");
    assert.equal(canApply({ t: "token.update", tokenId: "ws", patch: { companionReaction: true } }, P2, state, { canUseAsset: () => true }).ok, false);
  });
});

describe("a companion's stat block link (docs/design-v1-companion-stat-blocks.md 3.2)", () => {
  /** Bree's spirit, with a block Bree keeps, one Cy keeps, and Cy herself. */
  function linked(over: Partial<Token> = {}): RoomState {
    const state = withSpirit("shared", over);
    state.characters.cy = character("cy", { name: "Cy", ownerIds: ["p2"] });
    state.companionBlocks.moth = companionBlock("moth", "bree");
    state.companionBlocks.wolf = companionBlock("wolf", "cy", { name: "Wolf" });
    return state;
  }
  const inlineOf = (state: RoomState, id = "ws") => {
    const a = state.tokens[id]!.actor;
    assert.ok("inline" in a);
    return a.inline;
  };
  const link = (patch: Record<string, string | null>): Op => ({ t: "token.update", tokenId: "ws", patch: { actor: patch } });

  test("setting any one link clears the other two, so one patch swaps a block", () => {
    const withMonster = linked({ actor: { inline: actor({ monsterId: "m1" }) } });
    const srd = run(withMonster, link({ srdId: "owl" })).state;
    assert.deepEqual([inlineOf(srd).srdId, inlineOf(srd).monsterId, inlineOf(srd).blockId], ["owl", undefined, undefined]);
    const block = run(srd, link({ blockId: "moth" })).state;
    assert.deepEqual([inlineOf(block).srdId, inlineOf(block).monsterId, inlineOf(block).blockId], [undefined, undefined, "moth"]);
    const monster = run(block, link({ monsterId: "m2" })).state;
    assert.deepEqual([inlineOf(monster).srdId, inlineOf(monster).monsterId, inlineOf(monster).blockId], [undefined, "m2", undefined]);
    // Null detaches the one it names and touches nothing else.
    const detached = run(block, link({ blockId: null })).state;
    assert.deepEqual([inlineOf(detached).srdId, inlineOf(detached).blockId], [undefined, undefined]);
    // A patch that sets two is refused.
    assert.deepEqual(refused(linked(), link({ srdId: "owl", blockId: "moth" })), { ok: false, code: "invalid", message: ONE_LINK });
  });

  test("a block must be its own character's and on a companion's actor, and one that is not here is gone", () => {
    assert.deepEqual(refused(linked(), link({ blockId: "wolf" })), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
    assert.equal(refused(linked(), link({ blockId: "nothing" })).code, "gone");
    // On a token that is not a companion.
    const state = linked();
    assert.deepEqual(refused(state, { t: "token.update", tokenId: "gob", patch: { actor: { blockId: "moth" } } }), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
    // On a character, by its own update and through its token's patch.
    assert.deepEqual(refused(state, { t: "character.update", characterId: "bree", patch: { actor: { blockId: "moth" } } }), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
    assert.deepEqual(refused(state, { t: "token.update", tokenId: "bt", patch: { actor: { blockId: "moth" } } }), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
    const { rev: _rev, ...cy } = character("cy2", { actor: actor({ blockId: "moth" }) });
    assert.deepEqual(refused(state, { t: "character.create", character: cy }), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
  });

  test("a new companion may hold its character's block, alone, and a new token that is not a companion never", () => {
    const state = linked();
    delete state.tokens.ws;
    const made = run(state, create({ actor: { inline: actor({ hp: { cur: 9, max: 9, temp: 0 }, blockId: "moth" }) } })).state;
    assert.equal(inlineOf(made).blockId, "moth");
    assert.deepEqual(refused(state, create({ actor: { inline: actor({ blockId: "moth", srdId: "owl" }) } })), { ok: false, code: "invalid", message: ONE_LINK });
    assert.deepEqual(refused(state, create({ actor: { inline: actor({ blockId: "wolf" }) } })), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
    assert.equal(refused(state, create({ actor: { inline: actor({ blockId: "nothing" }) } })).code, "gone");
    const plain = { ...spiritInput({ id: "plain", actor: { inline: actor({ blockId: "moth" }) } }) };
    delete plain.companion;
    assert.deepEqual(refused(state, { t: "token.create", token: plain }), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
  });

  test("given to another character or no longer a companion, it lets its block go and keeps an SRD link, in the same op", () => {
    const state = linked({ actor: { inline: actor({ blockId: "moth" }) } });
    const given = run(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "cy", turn: "shared" } } }).state;
    assert.equal(inlineOf(given).blockId, undefined);
    const freed = run(state, { t: "token.update", tokenId: "ws", patch: { companion: null } }).state;
    assert.equal(inlineOf(freed).blockId, undefined);
    const withSrd = linked({ actor: { inline: actor({ srdId: "owl" }) } });
    assert.equal(inlineOf(run(withSrd, { t: "token.update", tokenId: "ws", patch: { companion: { of: "cy", turn: "shared" } } }).state).srdId, "owl");
    // A change of turn alone keeps it.
    assert.equal(inlineOf(run(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "bree", turn: "none" } } }).state).blockId, "moth");
    // One patch may give it to Cy and link Cy's block, checked as the op leaves it.
    const both = run(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "cy", turn: "shared" }, actor: { blockId: "wolf" } } }).state;
    assert.equal(inlineOf(both).blockId, "wolf");
    assert.deepEqual(refused(state, { t: "token.update", tokenId: "ws", patch: { companion: { of: "cy", turn: "shared" }, actor: { blockId: "moth" } } }), { ok: false, code: "invalid", message: BLOCK_OF_ITS_CHARACTER });
  });

  test("made an effect and a creature again, it keeps its link, and deleting the block leaves the link", () => {
    const state = linked({ actor: { inline: actor({ blockId: "moth" }) } });
    const effect = run(state, { t: "token.update", tokenId: "ws", patch: { kind: "object", companion: { of: "bree", turn: "shared" } } }).state;
    assert.equal(inlineOf(effect).blockId, "moth");
    const creature = run(effect, { t: "token.update", tokenId: "ws", patch: { kind: "npc" } }).state;
    assert.equal(inlineOf(creature).blockId, "moth");
    const deleted = run(creature, { t: "companionBlock.delete", blockId: "moth" });
    assert.equal(inlineOf(deleted.state).blockId, "moth");
    assert.ok(!deleted.touched.includes("token:ws"));
    // An edit that does not name the link leaves a deleted block's link as it is.
    assert.equal(inlineOf(run(deleted.state, { t: "token.update", tokenId: "ws", patch: { name: "Moth" } }).state).blockId, "moth");
  });

  test("a stored attach patch, the SRD block with the room monster cleared, replays to the same actor at any version", () => {
    const state = linked({ actor: { inline: actor({ monsterId: "m1" }) } });
    const op = link({ srdId: "owl", monsterId: null });
    for (const opVersion of [undefined, 4, 5, 6]) {
      const r = applyOp(state, op, DM, { ...env(1), ...(opVersion === undefined ? {} : { opVersion }) });
      assert.ok(r.ok);
      assert.deepEqual([inlineOf(r.state).srdId, inlineOf(r.state).monsterId], ["owl", undefined], `version ${opVersion}`);
    }
  });

  test("an imported room keeps blockId alone where an actor holds more, and drops one off a companion or of another character", () => {
    const state = linked({ actor: { inline: actor({ blockId: "moth", srdId: "owl", monsterId: "m1" }) } });
    state.tokens.cyws = token("cyws", { kind: "npc", companion: { of: "cy", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } });
    state.tokens.gob!.actor = { inline: actor({ blockId: "moth", srdId: "goblin-warrior" }) };
    state.tokens.gone = token("gone", { kind: "npc", companion: { of: "bree", turn: "shared" }, actor: { inline: actor({ blockId: "deleted" }) } });
    state.tokens.orphan = token("orphan", { kind: "npc", companion: { of: "nobody", turn: "shared" }, actor: { inline: actor({ blockId: "moth" }) } });
    state.characters.bree = { ...state.characters.bree!, actor: actor({ blockId: "moth" }) };
    const out = normalizeCompanionState(state);
    assert.deepEqual([inlineOf(out).blockId, inlineOf(out).srdId, inlineOf(out).monsterId], ["moth", undefined, undefined]);
    assert.equal(inlineOf(out, "cyws").blockId, undefined, "another character's block");
    assert.deepEqual([inlineOf(out, "gob").blockId, inlineOf(out, "gob").srdId], [undefined, "goblin-warrior"], "not a companion");
    assert.equal(inlineOf(out, "gone").blockId, "deleted", "a link to a block the file does not hold reads as deleted");
    assert.equal(inlineOf(out, "orphan").blockId, undefined, "a companion whose character is missing becomes a plain token");
    assert.equal(out.characters.bree!.actor.blockId, undefined);
  });
});
