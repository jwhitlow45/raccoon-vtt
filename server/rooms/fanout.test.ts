import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { applyChanges, changedSightKeys, hashValue, heldOf, projectState, stableStringify, type ProjectedState } from "#shared/project.ts";
import { opSchema, type Change, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { LIMITS } from "#shared/limits.ts";
import { DM, P1, P2, actor, effect, entry, env, randomOp, randomState, reveal, rng, room, scene, template, token } from "#shared/testutil.ts";
import { Connection } from "./connection.ts";
import { exploreOp } from "./explore.ts";
import { buildSnapshot, publishBatch } from "./fanout.ts";

/**
 * The design 7.3 invariant through the server's own fan-out
 * (docs/design-v1-maps-vision.md 4.3.5 and section 6): batches of random
 * ops, each followed by the explore step the actor appends, published by
 * `publishBatch` with its narrow sight diff to DMs on both scenes and two
 * players. Applying each socket's `ev`s to its snapshot must give exactly a
 * fresh projection, sight tiles and the merged fog included.
 */
type Viewing = { conn: Connection; view: ProjectedState; inbox: ServerMessage[] };

function open(state: RoomState, who: Viewer, sceneId: string): Viewing {
  const inbox: ServerMessage[] = [];
  const socket = { readyState: 1, OPEN: 1, CONNECTING: 0, send: (text: string) => inbox.push(JSON.parse(text) as ServerMessage), close: () => undefined, terminate: () => undefined };
  const conn = new Connection(socket as never, { sessionId: `s-${who.memberId}-${sceneId}`, roomId: "FANOUT00", memberId: who.memberId, role: who.role }, "203.0.113.4");
  conn.sceneId = sceneId;
  const snapshot = buildSnapshot(state, 0, conn, 0);
  conn.held = snapshot.held;
  return { conn, view: snapshot.message.state as ProjectedState, inbox };
}

/*
 * Most random rooms explore nothing: the party must stand on the player
 * scene with vision and fog on and see something. Every other seed puts
 * it there, with darkvision for the player characters, so the explore step
 * and the sight diff run on most batches.
 */
function exploring(state: RoomState, seed: number): RoomState {
  if (seed % 2 === 1) return state;
  const s1 = state.scenes.s1!;
  const characters = Object.fromEntries(Object.entries(state.characters).map(([id, c]) => [id, { ...c, actor: { ...c.actor, senses: "Darkvision 30 ft." } }]));
  return {
    ...state,
    meta: { ...state.meta, playerSceneId: "s1" },
    scenes: { ...state.scenes, s1: { ...s1, fogEnabled: true, vision: { on: true, light: s1.vision?.light ?? "dark" } } },
    characters,
  };
}

/** A DM's move of any token on the first scene, party members included, so sight and what it shows change often. */
function walk(r: () => number, state: RoomState): Op {
  const ids = Object.values(state.tokens)
    .filter((t) => t.sceneId === "s1")
    .map((t) => t.id);
  const tokenId = ids[Math.floor(r() * ids.length)] ?? "none";
  return { t: "token.move", tokenId, x: Math.floor(r() * 30), y: Math.floor(r() * 30) };
}

type Tally = { batches: number; explores: number; narrowSight: number };

function run(seed: number, batches: number, tally: Tally): void {
  const r = rng(seed);
  let state = exploring(randomState(r), seed);
  const viewers = [open(state, DM, "s1"), open(state, DM, "s2"), open(state, P1, "s1"), open(state, P2, "s1")];
  // Past every log id the random room holds, so new log lines sort after them as the state appends them.
  let seq = 100;
  for (let b = 0; b < batches; b++) {
    const before = state;
    const touched: EntityKey[] = [];
    let global = false;
    const size = 1 + Math.floor(r() * 3);
    for (let i = 0; i < size; i++) {
      const who = (b + i) % 5 === 4 ? ((b + i) % 2 === 0 ? P1 : P2) : DM;
      const parsed = opSchema.safeParse(r() < 0.4 ? walk(r, state) : randomOp(r, state, who));
      assert.ok(parsed.success);
      const result = applyOp(state, parsed.data, who, env(++seq));
      if (!result.ok) continue;
      state = result.state;
      touched.push(...result.touched);
      global ||= result.global;
    }
    if (state === before) continue;
    // The actor's explore step, at the end of the batch.
    const explore = exploreOp(state);
    if (explore) {
      const result = applyOp(state, explore, { memberId: "server", role: "dm" }, env(++seq));
      assert.ok(result.ok, result.ok ? "" : result.message);
      state = result.state;
      touched.push(...result.touched);
      global ||= result.global;
      tally.explores++;
    }
    tally.batches++;
    if (!global && changedSightKeys(before, state, ["s1", "s2"]).length > 0) tally.narrowSight++;
    publishBatch({ seq, before, after: state, touched, global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
    for (const v of viewers) {
      for (const msg of v.inbox.splice(0)) {
        if (msg.t !== "ev") continue;
        const changed = (msg.changes as Change[]).map((c) => c.key);
        assert.deepEqual(changed, [...changed].sort(), `seed ${seed} batch ${b}: changes in key order`);
        v.view = applyChanges(v.view, msg.changes as Change[]);
      }
      const fresh = projectState(state, v.conn.viewer, { sceneId: v.conn.sceneId });
      if (stableStringify(v.view) !== stableStringify(fresh)) {
        assert.deepEqual(JSON.parse(JSON.stringify(v.view)), JSON.parse(JSON.stringify(fresh)), `seed ${seed} batch ${b} viewer ${v.conn.memberId}@${v.conn.sceneId}`);
      }
      // The server keeps a snapshot's values unhashed until a batch compares them: each stands for its hash.
      const held = [...v.conn.held!.entries()].map(([k, e]) => [k, typeof e === "string" ? e : hashValue(e)]);
      assert.deepEqual(held.sort(), [...heldOf(v.view).entries()].sort(), `seed ${seed} batch ${b} held map for ${v.conn.memberId}`);
    }
  }
}

describe("the server's fan-out with the explore step", () => {
  test("applying each socket's events to its snapshot equals a fresh projection, over random batches with real sight", () => {
    const tally: Tally = { batches: 0, explores: 0, narrowSight: 0 };
    for (let seed = 201; seed <= 260; seed++) run(seed, 30, tally);
    assert.ok(tally.batches > 1_000, `only ${tally.batches} batches`);
    assert.ok(tally.explores > 50, `only ${tally.explores} explores`);
    assert.ok(tally.narrowSight > 100, `sight changed outside a global batch only ${tally.narrowSight} times`);
  });
});

describe("what hidden work leaves in a player's message", () => {
  /** P1's hero, P2's cleric and a goblin no player sees, on P1's turn in a fight, published to both players. */
  function messages(op: Op, hidden: boolean): string[] {
    const ending = effect("e1", { key: "prone", duration: { remaining: 1, boundary: "turnEnd", anchor: { entryId: "e-hero" } } });
    const state = room({
      tokens: {
        hero: token("hero", { name: "Ayla", kind: "pc", ownerIds: ["p1"], x: 2, y: 2 }),
        cleric: token("cleric", { name: "Bree", kind: "pc", ownerIds: ["p2"], x: 4, y: 2 }),
        gob: token("gob", { name: "Goblin", visibility: "dm", x: 8, y: 8, actor: { inline: actor({ effects: hidden ? [ending] : [] }) } }),
      },
    });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-hero", entries: [entry("e-hero", { tokenId: "hero", value: 15 }), entry("e-cleric", { tokenId: "cleric", value: 10, tieOrder: 1 })] };
    const viewers = [open(state, P1, "s1"), open(state, P2, "s1")];
    const result = applyOp(state, op, DM, env(2));
    assert.ok(result.ok, result.ok ? "" : result.message);
    publishBatch({ seq: 2, before: state, after: result.state, touched: result.touched, global: result.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
    return viewers.map((v) => JSON.stringify(v.inbox));
  }

  test("a hidden creature's effect ending as a turn passes leaves each player's whole message as it is without it", () => {
    const plain = messages({ t: "encounter.next" }, false);
    assert.ok(plain.every((m) => m.includes('"log:2:0"') && m.includes('"encounter"')), "the turn line and the fight reach both");
    assert.deepEqual(messages({ t: "encounter.next" }, true), plain);
  });

  test("a hit on a hidden creature beside one on the hero leaves each player's whole message as the hero's alone does", () => {
    const hit = (ids: string[]): Op => ({ t: "actor.damageMany", hits: ids.map((tokenId) => ({ target: { tokenId }, amount: 2 })) });
    assert.deepEqual(messages(hit(["gob", "hero"]), false), messages(hit(["hero"]), false));
  });

  /** Plays the DM's ops in order from seq 2, each published to both players, and returns every message each one got, and the room. */
  function played(state: RoomState, ops: readonly Op[]): { inboxes: string[]; state: RoomState } {
    const viewers = [open(state, P1, "s1"), open(state, P2, "s1")];
    let before = state;
    ops.forEach((op, i) => {
      const result = applyOp(before, op, DM, env(2 + i));
      assert.ok(result.ok, result.ok ? "" : `${op.t}: ${result.message}`);
      publishBatch({ seq: 2 + i, before, after: result.state, touched: result.touched, global: result.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
      before = result.state;
    });
    return { inboxes: viewers.map((v) => JSON.stringify(v.inbox)), state: before };
  }

  /** P1's hero on its turn beside a glyph only the DM knows of, and a goblin no player sees. */
  function heroTurn(): RoomState {
    const state = room({
      tokens: {
        hero: token("hero", { name: "Ayla", kind: "pc", ownerIds: ["p1"], disposition: "ally", x: 2, y: 5 }),
        gob: token("gob", { name: "Goblin", visibility: "dm", x: 30, y: 25, actor: { inline: actor({ hp: { cur: 1_000, max: 1_000, temp: 0 } }) } }),
      },
    });
    state.templates.glyph = template("glyph", { shape: "sphere", size: 10, origin: { x: 6.5, y: 5.5, z: 0 }, spell: "Glyph", visibility: "dm", ownerId: "dm1", triggers: ["enter"], oncePerTurn: true });
    state.encounter = { rev: 0, round: 1, activeEntryId: "e-hero", entries: [entry("e-hero", { tokenId: "hero", value: 15 })] };
    return state;
  }

  const walk = (x: number): Op => ({ t: "token.move", tokenId: "hero", x, y: 5 });

  test("a reminder only the DM read holds back none a player reads later in the turn, whatever the DM's ring dropped since", () => {
    // The hero walks through the glyph unseen, the DM works on the hidden goblin, then shows the glyph, and the hero walks back in.
    const run = (busy: boolean) => {
      const work: Op[] = Array.from({ length: LIMITS.dmLogLines }, (_, i) =>
        busy ? { t: "actor.damageMany", hits: [{ target: { tokenId: "gob" }, amount: 1 }] } : { t: "token.update", tokenId: "gob", patch: { x: 30 + (i % 2), y: 25 } },
      );
      return played(heroTurn(), [walk(6), walk(15), ...work, { t: "template.update", templateId: "glyph", patch: { visibility: "all" } }, walk(6)]);
    };
    const quiet = run(false);
    const busy = run(true);
    const first = "2:900000";
    assert.ok(quiet.state.log.some((e) => e.id === first) && !busy.state.log.some((e) => e.id === first), "only the busy room's DM ring dropped the first reminder");
    assert.deepEqual(busy.inboxes, quiet.inboxes);
    const reentry = `"log:${5 + LIMITS.dmLogLines}:0"`;
    assert.ok(quiet.inboxes.every((m) => m.includes(reentry) && m.includes('"type":"area"')), "both players read the reminder of the hero walking back in");
  });

  test("a reminder every player reads reaches P2 alike whether or not P1 read it before as their own copy", () => {
    // P1's aura, which only P1 sees at first. In one room it stands where the goblin walks, so only P1 reads the reminder.
    const run = (earlier: boolean) => {
      const state = room({
        tokens: { g1: token("g1", { name: "Goblin", number: 1, x: 12, y: 5 }), orc: token("orc", { name: "Orc", x: 20, y: 20 }) },
      });
      state.meta = { ...state.meta, settings: { ...state.meta.settings, playersSeeAoeOfOthers: false } };
      const at = { x: 6.5, y: 5.5, z: 0 };
      state.templates.sg = template("sg", { shape: "sphere", size: 10, origin: earlier ? at : { x: 6.5, y: 25.5, z: 0 }, spell: "Spirit Guardians", ownerId: "p1", triggers: ["enter"], oncePerTurn: true });
      state.encounter = { rev: 0, round: 1, activeEntryId: "e-g1", entries: [entry("e-g1", { tokenId: "g1", value: 15 }), entry("e-orc", { tokenId: "orc", value: 10, tieOrder: 1 })] };
      const goblin = (x: number): Op => ({ t: "token.move", tokenId: "g1", x, y: 5 });
      const chats: Op[] = Array.from({ length: LIMITS.dmLogLines }, (_, i) => ({ t: "log.chat", text: `c${i}` }));
      // Then P1's aura stands there in both, the room shows players each other's areas, its shared lines fill their ring, and the goblin walks in.
      const ops: Op[] = [goblin(6), goblin(12), { t: "template.update", templateId: "sg", patch: { origin: at } }, ...chats, { t: "room.update", settings: { playersSeeAoeOfOthers: true } }, goblin(6)];
      return played(state, ops);
    };
    const quiet = run(false);
    const earlier = run(true);
    assert.deepEqual([earlier.state.reminded?.players, quiet.state.reminded?.players], [{ p1: { sg: { g1: 1 } } }, undefined], "only one room's P1 read a copy");
    assert.deepEqual(earlier.inboxes[1], quiet.inboxes[1], "P2's every message is the same");
    const p2 = (r: ReturnType<typeof run>) => {
      const log = projectState(r.state, P2, { sceneId: "s1" }).log;
      return { count: log.length, oldest: log[0]?.id, reminders: log.filter((e) => e.data?.type === "area").map((e) => e.id) };
    };
    const seq = 5 + LIMITS.dmLogLines + 1;
    assert.deepEqual(p2(earlier), p2(quiet));
    assert.deepEqual(p2(quiet).reminders, [`${seq}:0`], "a shared line");
  });

  test("the DM's record past its cap changes no player's message, and the players' reminders still come once", () => {
    // A hundred goblins no player sees, in one room only, and ten glyphs only the DM knows of moved onto where they stand.
    const run = (crowd: boolean) => {
      const state = heroTurn();
      state.templates.glyph = { ...state.templates.glyph!, visibility: "all", ownerId: "dm1" };
      for (let i = 0; i < (crowd ? 100 : 0); i++) state.tokens[`g${100 + i}`] = token(`g${100 + i}`, { visibility: "dm", x: 20 + (i % 10), y: 15 + Math.floor(i / 10) });
      const ops: Op[] = [];
      for (let k = 0; k < 11; k++) {
        const id = `h${10 + k}`;
        state.templates[id] = template(id, { shape: "sphere", size: 40, origin: { x: 38, y: 2, z: 0 }, visibility: "dm", ownerId: "dm1", triggers: ["enter"] });
        ops.push({ t: "template.update", templateId: id, patch: { origin: { x: 25, y: 20, z: 0 } } });
      }
      return played(state, [...ops, walk(6), walk(15), walk(6)]);
    };
    const crowded = run(true);
    const empty = run(false);
    const dmPairs = Object.values(crowded.state.reminded!.dm!).reduce((n, tokens) => n + Object.keys(tokens).length, 0);
    assert.equal(dmPairs, LIMITS.remindedDm, "the eleventh glyph's goblins are past the DM's cap");
    assert.deepEqual(crowded.state.reminded!.shared, { glyph: { hero: 1 } });
    assert.deepEqual(crowded.inboxes, empty.inboxes);
    assert.equal(empty.inboxes[0]!.split('"type":"area"').length - 1, 1, "the hero's player reads the glyph's reminder once");
  });
});

describe("the server's held maps", () => {
  test("a snapshot keeps the map's values unhashed, and a batch that re-projects an unchanged map leaves them so and sends none of it", () => {
    const state = room();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone", "2,1": "stone" }, edges: { "3,1,w": { kind: "door", state: "closed", secret: true, discovered: false } } };
    state.buildChunks["s1:1,0"] = { sceneId: "s1", cx: 1, cy: 0, rev: 1, cells: { "17,1": "wood" }, edges: {} };
    reveal(state, "s1", { x: 0, y: 0, w: 20, h: 4 });
    const viewers = [open(state, DM, "s1"), open(state, P1, "s1")];
    for (const v of viewers) {
      const chunkKeys = [...v.conn.held!.keys()].filter((k) => k.startsWith("chunk:"));
      assert.ok(chunkKeys.length > 0);
      for (const key of chunkKeys) assert.equal(typeof v.conn.held!.get(key), "object", key);
      assert.equal(typeof v.conn.held!.get("meta"), "string", "the rest is hashed at once");
    }
    // A settings change re-projects everything (global), the map included, and the map is as it was.
    const result = applyOp(state, { t: "room.update", settings: { skipDefeated: !state.meta.settings.skipDefeated } }, DM, env(500));
    assert.ok(result.ok && result.global);
    publishBatch({ seq: 500, before: state, after: result.state, touched: result.touched, global: true, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
    for (const v of viewers) {
      const ev = v.inbox.find((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev");
      assert.ok(ev && ev.changes.every((c) => !c.key.startsWith("chunk:") && !c.key.startsWith("fog:")), v.conn.memberId);
      for (const [key, entry] of v.conn.held!) if (key.startsWith("chunk:")) assert.equal(typeof entry, "object", `${v.conn.memberId} ${key} was never hashed`);
    }
  });
});

describe("a mount's path in its rider's turn (docs/design-v1-attach.md 7.2)", () => {
  test("reaches a player's socket and leaves it as the rider's row comes into sight and goes out of it, with no change to the mount", () => {
    // The DM's goblin rides P1's horse under control on its own turn, both in the lifted fog. Then the goblin gets off into
    // the fog and back out: its row is hidden and shown again, and with it the horse's path of the turn.
    let state = room({
      tokens: {
        horse: token("horse", { name: "Warhorse", kind: "npc", size: "large", ownerIds: ["p1"], x: 2, y: 2 }),
        gob: token("gob", { name: "Goblin", x: 2, y: 2, attached: { to: "horse", kind: "ride", steer: true } }),
        thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"], x: 0, y: 8 }),
      },
    });
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    reveal(state, "s1", { x: 0, y: 0, w: 10, h: 10 });
    const viewers = [open(state, P1, "s1")];
    let seq = 600;
    const step = (op: Op) => {
      const before = state;
      const result = applyOp(state, op, DM, env(++seq));
      assert.ok(result.ok, result.ok ? "" : result.message);
      state = result.state;
      publishBatch({ seq, before, after: state, touched: result.touched, global: result.global, acks: new Map(), rejects: new Map(), restored: new Map() }, viewers.map((v) => v.conn), () => undefined);
      for (const v of viewers) {
        for (const msg of v.inbox.splice(0)) if (msg.t === "ev") v.view = applyChanges(v.view, msg.changes as Change[]);
        assert.deepEqual(JSON.parse(JSON.stringify(v.view.tokens)), JSON.parse(JSON.stringify(projectState(state, P1, { sceneId: "s1" }).tokens)), `after ${op.t}`);
      }
    };
    step({ t: "encounter.start", entries: [{ id: "eg", tokenId: "gob", value: 20 }, { id: "et", tokenId: "thorn", value: 5 }] });
    step({ t: "encounter.next" });
    assert.deepEqual(state.encounter?.turnStart?.mounts, ["horse"]);
    step({ t: "token.move", tokenId: "horse", x: 4, y: 2 });
    assert.ok(viewers[0]!.view.tokens.horse?.path, "the horse's path of the goblin's turn reaches P1");
    step({ t: "token.detach", tokenId: "gob", x: 6, y: 2 });
    step({ t: "token.move", tokenId: "gob", x: 15, y: 2 });
    assert.equal(viewers[0]!.view.tokens.horse?.path, undefined, "with the goblin's row out of sight, so is the path");
    step({ t: "token.move", tokenId: "gob", x: 7, y: 2 });
    assert.ok(viewers[0]!.view.tokens.horse?.path, "and back with it");
  });
});
