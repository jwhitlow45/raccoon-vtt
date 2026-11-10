import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { RoomState } from "./model.ts";
import { holds } from "./propertyTestutil.ts";
import { clientOpSchema, type Op } from "./protocol.ts";
import { holdsTurn, reads, TURN_OPS } from "./reads.ts";
import { applyOp } from "./reducer.ts";
import { actor, chance, DM, env, int, pick, randomOp, randomState, rng, room, token } from "./testutil.ts";

/**
 * Which turn runs, as the cards and the record actions read it: the active
 * row, the turn start's row and number, the fight's start, and each
 * creature's turn record by id. A ride's `turnStart.mounts`, which a move
 * or an attach rewrites, is left out: it names no turn.
 */
function turnIdentity(state: RoomState): string {
  const encounter = state.encounter;
  const records: [string, number][] = [];
  for (const [id, t] of Object.entries(state.tokens)) {
    const record = "inline" in t.actor ? t.actor.inline.turnRecord : undefined;
    if (record) records.push([`token:${id}`, record.id]);
  }
  for (const [id, c] of Object.entries(state.characters)) if (c.actor.turnRecord) records.push([`character:${id}`, c.actor.turnRecord.id]);
  records.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify({
    fight: encounter !== null,
    active: encounter?.activeEntryId ?? null,
    startEntry: encounter?.turnStart?.entryId ?? null,
    startSeq: encounter?.turnStart?.seq ?? null,
    fightSeq: encounter?.startSeq ?? null,
    records,
  });
}

/**
 * Ops the random op maker never draws, made here so every op type a device
 * can send is applied. Each reads the room for ids it can act on, and a
 * miss names nothing, which the reducer refuses.
 */
const MADE: Partial<Record<Op["t"], (r: () => number, state: RoomState) => Op>> = {
  "view.follow": (r) => ({ t: "view.follow", follow: chance(r, 0.5) }),
  "scene.delete": (r, state) => ({ t: "scene.delete", sceneId: pick(r, Object.keys(state.scenes)) }),
  "scene.reorder": (r, state) => ({ t: "scene.reorder", order: Object.keys(state.scenes).sort(() => r() - 0.5) }),
  "scene.setGrid": (r, state) => ({ t: "scene.setGrid", sceneId: pick(r, Object.keys(state.scenes)), cellPx: pick(r, [50, 70]), originPx: { x: int(r, 0, 20), y: 0 } }),
  "scene.setPhase": (r, state) => {
    const sceneId = pick(r, Object.keys(state.scenes));
    return { t: "scene.setPhase", sceneId, phaseId: pick(r, [...(state.scenes[sceneId]?.phases ?? []).map((p) => p.id), "missing"]) };
  },
  "drawing.clear": (r, state) => ({ t: "drawing.clear", sceneId: pick(r, Object.keys(state.scenes)), scope: pick(r, ["own", "all"] as const) }),
  "floor.open": (r, state) => ({ t: "floor.open", sceneId: pick(r, Object.keys(state.scenes)), open: chance(r, 0.5) }),
  "floorLink.delete": (r, state) => ({ t: "floorLink.delete", linkId: pick(r, [...Object.keys(state.floorLinks ?? {}), "missing"]) }),
  "token.moveMany": (r, state) => ({ t: "token.moveMany", moves: Object.keys(state.tokens).slice(0, int(r, 1, 3)).map((tokenId) => ({ tokenId, x: int(r, 0, 30), y: int(r, 0, 30) })) }),
  "token.climb": (r, state) => ({ t: "token.climb", tokenId: anyToken(r, state), linkId: pick(r, [...Object.keys(state.floorLinks ?? {}), "missing"]) }),
  "actor.deathSave": (r, state) => ({ t: "actor.deathSave", target: anyTarget(r, state), ok: int(r, 0, 3), fail: int(r, 0, 3) }),
  "actor.effect.update": (r, state) => ({ t: "actor.effect.update", target: anyTarget(r, state), effectId: "e0", patch: { label: "moved" } }),
  "actor.effect.remove": (r, state) => ({ t: "actor.effect.remove", target: anyTarget(r, state), effectId: pick(r, ["e0", "e1"]) }),
  "actor.saveDue": (r, state) => ({ t: "actor.saveDue", target: anyTarget(r, state), effectId: "e0", due: `${int(r, 1, 9)}:0`, state: pick(r, ["resolved", "dismissed"] as const) }),
  "actor.prompt": (r, state) => {
    const target = anyTarget(r, state);
    const record = recordOf(state, target);
    return { t: "actor.prompt", target, record: record ?? 1, what: pick(r, ["regeneration", "deathSave"] as const), state: pick(r, ["skipped", "open"] as const) };
  },
  // A row's creature made a companion that shares its character's turn, or none, which drops its own rows.
  "token.update": (r, state) => {
    const rows = (state.encounter?.entries ?? []).flatMap((e) => (e.tokenId !== undefined ? [e.tokenId] : []));
    const characters = Object.keys(state.characters);
    const tokenId = rows.length > 0 ? pick(r, rows) : anyToken(r, state);
    return { t: "token.update", tokenId, patch: { companion: characters.length > 0 && chance(r, 0.8) ? { of: pick(r, characters), turn: pick(r, ["shared", "none"] as const) } : null } };
  },
  "character.delete": (r, state) => ({ t: "character.delete", characterId: pick(r, [...Object.keys(state.characters), "missing"]) }),
  "template.delete": (r, state) => ({ t: "template.delete", templateId: pick(r, [...Object.keys(state.templates), "missing"]) }),
  "fog.publish": (r, state) => ({ t: "fog.publish", sceneId: pick(r, Object.keys(state.scenes)) }),
  "fog.discard": (r, state) => ({ t: "fog.discard", sceneId: pick(r, Object.keys(state.scenes)) }),
  "build.clear": (r, state) => ({ t: "build.clear", sceneId: pick(r, Object.keys(state.scenes)), forget: true }),
  "trap.spring": (r, state) => ({ t: "trap.spring", trapId: pick(r, [...Object.keys(state.traps), "missing"]), tokenIds: Object.keys(state.tokens).slice(0, int(r, 0, 2)) }),
  "encounter.setValue": (r, state) => ({ t: "encounter.setValue", entryId: anyEntry(r, state), value: pick(r, [1, 10, 20, 30, null]) }),
  "encounter.setValues": (r, state) => ({ t: "encounter.setValues", values: (state.encounter?.entries ?? [{ id: "missing" }]).map((e) => ({ entryId: e.id, value: int(r, -5, 30) })) }),
  "encounter.reorder": (r, state) => ({ t: "encounter.reorder", entryIds: (state.encounter?.entries ?? [{ id: "missing" }]).map((e) => e.id).sort(() => r() - 0.5) }),
  "clock.start": (r) => ({ t: "clock.start", id: "clock1", at: int(r, 0, 100_000), shown: chance(r, 0.5), calendar: { kind: "days" } }),
  "clock.stop": () => ({ t: "clock.stop" }),
  "clock.update": (r) => ({ t: "clock.update", shown: chance(r, 0.5) }),
  "clock.set": (r) => ({ t: "clock.set", at: int(r, 0, 100_000) }),
  "clock.advance": (r) => ({ t: "clock.advance", by: int(r, 1, 3_600) }),
  "handout.close": (r, state) => ({ t: "handout.close", handoutId: pick(r, [...Object.keys(state.handouts), "missing"]) }),
};

/**
 * Op types this test does not apply, each with why. The reducer refuses
 * the first six outright: the server resolves them into other ops first.
 * The rest write sounds, fog drafts, builds, floors, documents, new
 * scenes or characters, an ask or a request's change, and no fight or
 * creature: none of them reaches the encounter or a turn record.
 */
const NOT_APPLIED = new Set<Op["t"]>([
  "undo",
  "redo",
  "dice.roll",
  "roll.dice",
  "actor.deathRoll",
  "actor.rechargeRoll",
  "sound.create",
  "sound.update",
  "sound.delete",
  "playlist.create",
  "playlist.update",
  "playlist.delete",
  "playlist.add",
  "music.play",
  "music.pause",
  "music.resume",
  "music.skip",
  "music.stop",
  "music.set",
  "music.queue",
  "music.jump",
  "loop.start",
  "loop.set",
  "loop.stop",
  "effect.fire",
  "sound.mix",
  "sound.scene",
  "sound.stopAll",
  "handoutDoc.create",
  "vision.holders",
  "fog.draft",
  "build.rect",
  "build.poly",
  "build.rough",
  "build.ask",
  "floorLink.put",
  "floorLink.update",
  "floor.order",
  "scene.create",
  "character.create",
  "roll.change",
  "cast.ask",
]);

function anyToken(r: () => number, state: RoomState): string {
  const ids = Object.keys(state.tokens);
  return ids.length > 0 ? pick(r, ids) : "missing";
}

function anyTarget(r: () => number, state: RoomState): { tokenId: string } | { characterId: string } {
  const characters = Object.keys(state.characters);
  return chance(r, 0.5) && characters.length > 0 ? { characterId: pick(r, characters) } : { tokenId: anyToken(r, state) };
}

function anyEntry(r: () => number, state: RoomState): string {
  const entries = state.encounter?.entries ?? [];
  return entries.length > 0 ? pick(r, entries).id : "missing";
}

function recordOf(state: RoomState, target: { tokenId: string } | { characterId: string }): number | undefined {
  if ("characterId" in target) return state.characters[target.characterId]?.actor.turnRecord?.id;
  const t = state.tokens[target.tokenId];
  if (!t) return undefined;
  return "inline" in t.actor ? t.actor.inline.turnRecord?.id : state.characters[t.actor.ref]?.actor.turnRecord?.id;
}

/**
 * A random room whose fight, when it has one, has run a few turns, so its
 * creatures hold turn records and the turn start carries its number. Its
 * rows are token rows, character-only rows and lair actions.
 */
function playedRoom(seed: number): RoomState {
  const r = rng(seed);
  let state = randomState(r);
  let seq = 100;
  for (let i = int(r, 0, 3); i > 0; i--) {
    const result = applyOp(state, { t: "encounter.next" }, DM, env(seq++));
    if (result.ok) state = result.state;
  }
  return state;
}

function drawOp(r: () => number, state: RoomState): Op {
  const made = Object.entries(MADE);
  if (chance(r, 0.35)) {
    const [, make] = pick(r, made);
    return make!(r, state);
  }
  return randomOp(r, state, DM);
}

const ALL_TYPES = [...(clientOpSchema as unknown as { _zod: { propValues: { t: Set<Op["t"]> } } })._zod.propValues.t];

test("an op the DM's device may show before its answer never changes which turn runs", () => {
  const applied = new Set<Op["t"]>();
  holds(
    fc.property(fc.nat(), fc.nat(), (roomSeed, opSeed) => {
      const before = playedRoom(roomSeed);
      const r = rng(opSeed);
      for (let i = 0; i < 6; i++) {
        const op = drawOp(r, before);
        if (NOT_APPLIED.has(op.t)) continue;
        let result;
        try {
          result = applyOp(before, op, DM, env(10_000 + i));
        } catch {
          // A malformed draw the schema would refuse. It never reaches a device's prediction either.
          continue;
        }
        applied.add(op.t);
        if (!result.ok) continue;
        if (turnIdentity(result.state) !== turnIdentity(before)) {
          assert.ok(holdsTurn(op, before), `${op.t} changed which turn runs, so it belongs in TURN_OPS: ${JSON.stringify(op)}`);
          assert.ok("never" in reads(op, before), `${op.t} changes the turn and must never be predicted`);
        }
      }
    }),
    2_000,
  );
  // Every type a device can send is applied here or named as not reaching a turn, so a new op fails this until it is placed.
  const unplaced = ALL_TYPES.filter((t) => !applied.has(t) && !NOT_APPLIED.has(t));
  assert.deepEqual(unplaced, [], "op types neither applied nor named in NOT_APPLIED");
  for (const t of TURN_OPS) if (t !== "undo" && t !== "redo") assert.ok(applied.has(t), `${t} was never applied`);
});

test("a token deleted outside a fight shows at once, and inside one waits for its answer", () => {
  const room = playedRoom(7);
  const t = token("t-solo", { sceneId: Object.keys(room.scenes)[0]! });
  const outside: RoomState = { ...room, encounter: null, tokens: { ...room.tokens, [t.id]: t } };
  const op: Op = { t: "token.delete", tokenId: t.id };
  assert.equal(holdsTurn(op, outside), false);
  assert.equal("never" in reads(op, outside), false);
  const inside: RoomState = { ...outside, encounter: { rev: 0, round: 1, activeEntryId: null, entries: [] } };
  assert.equal(holdsTurn(op, inside), true);
  assert.ok("never" in reads(op, inside));
});

test("every op of TURN_OPS waits for its answer in a fight", () => {
  const room = playedRoom(11);
  const fight: RoomState = { ...room, encounter: room.encounter ?? { rev: 0, round: 1, activeEntryId: null, entries: [] } };
  const ops: Op[] = [
    { t: "encounter.start", entries: [] },
    { t: "encounter.end" },
    { t: "encounter.next" },
    { t: "encounter.prev" },
    { t: "encounter.remove", entryIds: ["n0"] },
    { t: "token.delete", tokenId: "t1" },
    { t: "token.deleteMany", tokenIds: ["t1"] },
    { t: "scene.delete", sceneId: "s2" },
    { t: "character.delete", characterId: "c1" },
    { t: "token.update", tokenId: "t1", patch: { companion: null } },
    { t: "undo", head: "x", expected: 1 } as unknown as Op,
    { t: "redo", head: "x", expected: 1 } as unknown as Op,
  ];
  assert.deepEqual(new Set(ops.map((op) => op.t)), TURN_OPS);
  for (const op of ops) assert.ok("never" in reads(op, fight), `${op.t} is predicted`);
  // A token change that leaves what a companion is alone stays predicted, as before.
  assert.equal(holdsTurn({ t: "token.update", tokenId: "t1", patch: { name: "Wolf" } }, fight), false);
});

test("a controlled ride that joins the turn, and a move that ends it, change only the turn's mounts and stay predicted", () => {
  let state = room({
    tokens: {
      horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } }),
      bree: token("bree", { name: "Bree", kind: "pc", x: 6, y: 4, ownerIds: ["p1"] }),
    },
  });
  let seq = 0;
  const run = (op: Op): RoomState => {
    const result = applyOp(state, op, DM, env(++seq));
    assert.ok(result.ok, op.t);
    return result.state;
  };
  state = run({ t: "encounter.start", entries: [{ id: "eb", tokenId: "bree", value: 16 }, { id: "eh", tokenId: "horse", value: 8 }] });
  state = run({ t: "encounter.next" });
  const ops: Op[] = [
    { t: "token.attach", tokenId: "bree", to: "horse", kind: "ride", steer: true, x: 5, y: 4, elevation: 0 },
    { t: "token.move", tokenId: "bree", x: 12, y: 12 },
  ];
  const mounts: (string[] | undefined)[] = [];
  for (const op of ops) {
    assert.equal(holdsTurn(op, state), false);
    const next = run(op);
    assert.equal(turnIdentity(next), turnIdentity(state));
    state = next;
    mounts.push(state.encounter?.turnStart?.mounts);
  }
  assert.deepEqual(mounts, [["horse"], undefined]);
});
