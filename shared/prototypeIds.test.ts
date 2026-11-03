import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OP_VERSION } from "./migrate.ts";
import type { RoomState, Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { projectState, stableStringify } from "./project.ts";
import { clientOpSchema, opSchema, serverOnlyOpSchema, type Op } from "./protocol.ts";
import { applyOp, type ApplyResult, type Env } from "./reducer.ts";
import { ownEntry } from "./records.ts";
import { RESERVED_ID } from "./reducer/tx.ts";
import { actor, AT, DM, P1, P2, randomOp, randomState, rng } from "./testutil.ts";

/**
 * Ids that name a member of Object.prototype (PROTO-IDS). A state record is
 * a plain object, so before every read by key went through ownEntry
 * (records.ts), "constructor" found Object's constructor in a record with no
 * such entity, and canApply or applyOp threw on it. "prototype" is no member
 * of Object.prototype and stands for an ordinary id beside them.
 */
const NAMES = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"] as const;

const LIVE: Env = { seq: 2, at: AT };
/** An op stored at today's version: from version 41 a replay reads and refuses as a live op does (records.ts readsOwnKeys). */
const REPLAY: Env = { seq: 2, at: AT, opVersion: OP_VERSION };
/** An op stored before own-key reads, which replays as it applied then (reducer/opVersion40.test.ts). */
const STORED: Env = { seq: 2, at: AT, opVersion: 40 };
const SERVER_ONLY = new Set<string>(serverOnlyOpSchema.options.map((o) => o.shape.t.value));
const ALL_KINDS = new Set<string>(opSchema.options.flatMap((o) => ("shape" in o ? [o.shape.t.value] : ["undo", "redo"])));

type Case = { op: unknown; who: Viewer };

/** Ops of the kinds randomOp never makes, each naming what the room holds where it can. */
function handMade(state: RoomState): Case[] {
  const tokens = Object.keys(state.tokens);
  const t0 = tokens[0] ?? "t0";
  const t1 = tokens[1] ?? "t1";
  const c0 = Object.keys(state.characters)[0] ?? "c0";
  const roll = Object.keys(state.rolls)[0] ?? "r1";
  let effect = { target: { tokenId: t0 } as { tokenId: string } | { characterId: string }, effectId: "e1" };
  for (const t of Object.values(state.tokens)) {
    const held = "inline" in t.actor ? t.actor.inline : state.characters[t.actor.ref]?.actor;
    const first = held?.effects[0];
    if (first) {
      effect = { target: { tokenId: t.id }, effectId: first.id };
      break;
    }
  }
  const entries = state.encounter?.entries ?? [];
  const e0 = entries[0]?.id ?? "en1";
  const batch = "AbCdEfGhIjKlMnOp";
  const ops: Case[] = [];
  const both = (op: unknown) => ops.push({ op, who: DM }, { op, who: P1 });
  const dm = (op: unknown) => ops.push({ op, who: DM });
  both({ t: "view.follow", follow: true });
  both({ t: "scene.create", scene: { id: "s9", name: "New", bounds: { w: 10, h: 10 } } });
  both({ t: "vision.holders", sceneId: "s1", on: ["p1"] });
  both({ t: "scene.delete", sceneId: "s2" });
  both({ t: "scene.reorder", order: ["s2", "s1"] });
  both({ t: "token.moveMany", moves: [{ tokenId: t0, x: 3, y: 3 }, { tokenId: t1, x: 4, y: 4 }] });
  both({ t: "actor.deathSave", target: { characterId: c0 }, ok: 1, fail: 0 });
  both({ t: "actor.effect.update", ...effect, patch: { label: "x" } });
  both({ t: "actor.effect.remove", ...effect });
  both({ t: "actor.saveDue", ...effect, due: "1:0", state: "resolved" });
  both({ t: "actor.prompt", target: { tokenId: t0 }, record: 1, what: "regeneration", state: "skipped" });
  both({ t: "character.create", character: { id: "c9", name: "New", size: "medium", ownerIds: ["p1"], actor: actor() } });
  both({ t: "character.delete", characterId: c0 });
  both({ t: "template.delete", templateId: Object.keys(state.templates)[0] ?? "a0" });
  both({ t: "fog.draft", sceneId: "s1", add: [{ id: "d9", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 2, h: 2 } }], remove: ["d1"] });
  both({ t: "drawing.clear", sceneId: "s1", scope: "own" });
  both({ t: "fog.publish", sceneId: "s1" });
  both({ t: "fog.discard", sceneId: "s1" });
  both({ t: "build.rect", sceneId: "s1", terrain: "stone", x: 1, y: 1, w: 2, h: 2 });
  both({ t: "build.poly", sceneId: "s1", terrain: "stone", points: [1, 1, 4, 1, 4, 4] });
  both({ t: "build.clear", sceneId: "s2" });
  both({ t: "build.rough", sceneId: "s1", cells: ["1,1"], on: true });
  both({ t: "build.ask", sceneId: "s1", ops: [{ t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["1,1"] }], part: 0 });
  both({ t: "trap.spring", trapId: Object.keys(state.traps)[0] ?? "trap1", tokenIds: [t0] });
  both({ t: "encounter.setValue", entryId: e0, value: 12 });
  both({ t: "encounter.setValues", values: [{ entryId: e0, value: 12 }] });
  both({ t: "encounter.reorder", entryIds: entries.length > 0 ? entries.map((e) => e.id).reverse() : [e0] });
  both({ t: "handout.close", handoutId: Object.keys(state.handouts)[0] ?? "h0" });
  both({ t: "handoutDoc.create", doc: { id: "doc9", title: "Letter", pages: [{ assetId: "img-x", width: 100, height: 100 }] } });
  both({ t: "roll.change", rollId: roll, target: { characterId: c0 }, ask: { id: "ask1", on: "tag1", reason: "lucky" } });
  both({ t: "roll.change", rollId: roll, target: { tokenId: t0 }, clear: "ask1" });
  both({ t: "dice.roll", tag: "tag9", to: "all", rolls: [{ formula: "1d20+2", label: "Attack", creature: { tokenId: t0 } }] });
  both({ t: "roll.dice", tag: "tag9", rollId: roll, target: { characterId: c0 } });
  both({ t: "actor.deathRoll", tag: "tag9", target: { characterId: c0 }, record: 1 });
  both({ t: "actor.rechargeRoll", tag: "tag9", target: { tokenId: t0 }, key: "actions:fire-breath", name: "Fire Breath", min: 5 });
  both({ t: "clock.start", id: "clock1", at: 8 * 3_600, shown: true, calendar: { kind: "months", months: [{ name: "Deepwinter", days: 30 }], week: ["Moonday"], era: "AF" } });
  both({ t: "clock.stop" });
  both({ t: "clock.update", calendar: { kind: "days" }, shown: false, at: 0 });
  both({ t: "clock.set", at: 3_600 });
  both({ t: "clock.advance", by: 600, why: "longRest" });
  both({ t: "undo", head: "0192f0aa-0000-7000-8000-000000000001" });
  both({ t: "redo", head: "0192f0aa-0000-7000-8000-000000000001" });
  dm({ t: "sys.memberJoin", member: { id: "p9", name: "New", color: "#ff0000", kind: "player", createdAt: AT } });
  dm({ t: "sys.memberSetKind", memberId: "p2", kind: "dm" });
  dm({ t: "sys.memberRemove", memberId: "p2" });
  dm({ t: "sys.remember", sceneId: "s1", layers: [{ chunks: [{ cx: 0, cy: 0, set: { cells: { "1,1": null }, labels: { l0: null } } }] }] });
  dm({ t: "sys.remember", sceneId: "s1", layers: [{ memberId: "p1", chunks: [{ cx: 0, cy: 0, drop: { labels: ["l0"] } }] }] });
  dm({ t: "sys.explore", sceneId: "s1", tiles: [], join: [{ memberId: "p1", on: true }] });
  dm({ t: "sys.restore", entries: [{ key: `token:${t0}`, value: null }], from: "undo", deps: true });
  ops.push({ op: { t: "sys.restore", entries: [{ key: `token:${t0}`, value: state.tokens[t0] ?? null }], from: "redo", deps: true }, who: P1 });
  const asked = [
    { t: "dice.roll", tag: "tag9", to: "all", rolls: [{ formula: "1d20+2", creature: { tokenId: t0 } }] },
    { t: "roll.dice", tag: "tag9", rollId: roll, target: { characterId: c0 } },
    { t: "actor.deathRoll", tag: "tag9", target: { characterId: c0 } },
    { t: "actor.rechargeRoll", tag: "tag9", target: { tokenId: t0 }, key: "actions:fire-breath", name: "Fire Breath", min: 5 },
  ];
  for (const a of asked) ops.push({ op: { t: "sys.dice", asked: a, batch, results: [{ formula: "1d20", faces: [7], total: 9 }] }, who: P1 });
  return ops;
}

/** Valid ops of every kind in a room: a few of randomOp's for each role, and the hand-made rest. */
function cases(state: RoomState, seed: number): Case[] {
  const out: Case[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < 3_000; i++) {
    for (const who of [DM, P1, P2]) {
      const op = randomOp(rng(seed * 100_000 + i), state, who);
      const key = `${op.t} ${who.role}`;
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({ op, who });
    }
  }
  return [...out, ...handMade(state)];
}

type Slot = { path: (string | number)[]; key: boolean };

/** Every string in an op and every object key, by path, the op's tag aside. */
function slots(value: unknown, path: (string | number)[] = [], out: Slot[] = []): Slot[] {
  if (typeof value === "string") out.push({ path, key: false });
  else if (Array.isArray(value)) value.forEach((v, i) => slots(v, [...path, i], out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (path.length === 0 && k === "t") continue;
      // A restore's values are entities as the server stored them: their field names are no ids.
      if (!(path[0] === "entries" && path[2] === "value")) out.push({ path: [...path, k], key: true });
      slots(v, [...path, k], out);
    }
  }
  return out;
}

/** The value with one slot set to `name`, every object rebuilt with own properties, so "__proto__" stays a key. */
function replaced(value: unknown, path: readonly (string | number)[], name: string, key: boolean): unknown {
  if (path.length === 0) return name;
  const [head, ...rest] = path;
  if (Array.isArray(value)) return value.map((v, i) => (i === head ? replaced(v, rest, name, key) : v));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (k !== head) return [k, v];
      return key && rest.length === 0 ? [name, v] : [k, replaced(v, rest, name, key)];
    }),
  );
}

function at(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((v, p) => (v as Record<string | number, unknown>)[p], value);
}

/**
 * The op with each name in each slot, and in an entity key's id
 * ("token:constructor"), as the schema the server reads it with takes it.
 */
function variants(op: Op): { op: Op; label: string }[] {
  const raw = JSON.parse(JSON.stringify(op)) as unknown;
  const schema = SERVER_ONLY.has(op.t) ? opSchema : clientOpSchema;
  const out: { op: Op; label: string }[] = [];
  for (const slot of slots(raw)) {
    const text = slot.key ? null : (at(raw, slot.path) as string);
    const colon = text?.indexOf(":") ?? -1;
    for (const name of NAMES) {
      const tries: string[] = [name];
      if (text !== null && colon > 0 && /^[A-Za-z]+$/.test(text.slice(0, colon))) tries.push(`${text.slice(0, colon)}:${name}`);
      for (const value of tries) {
        const parsed = schema.safeParse(replaced(raw, slot.path, value, slot.key));
        if (parsed.success) out.push({ op: parsed.data as Op, label: `${op.t} ${slot.key ? "key" : "value"} ${slot.path.join(".")} = ${value}` });
      }
    }
  }
  return out;
}

/** Where an object in a value has a prototype other than Object's, as writing "__proto__" by assignment gives it. */
function reparented(value: unknown, path = "state"): string | null {
  if (value === null || typeof value !== "object") return null;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return path;
  for (const [k, v] of Object.entries(value)) {
    const found = reparented(v, `${path}.${k}`);
    if (found) return found;
  }
  return null;
}

describe("ids that name Object.prototype's members", () => {
  test("every op kind with such a name as any id is refused or applies, and never throws, live or on replay at today's version, which does as live", () => {
    const kinds = new Set<string>();
    let tried = 0;
    for (const seed of [0, 1, 2]) {
      const state = randomState(rng(seed));
      for (const { op: raw, who } of cases(state, seed)) {
        const base = (SERVER_ONLY.has((raw as Op).t) ? opSchema : clientOpSchema).safeParse(raw);
        assert.ok(base.success, `the ${(raw as Op).t} case is a valid op`);
        kinds.add(base.data.t);
        for (const { op, label } of variants(base.data as Op)) {
          tried++;
          let decision;
          try {
            decision = canApply(op, who, state, { canUseAsset: () => true });
          } catch (err) {
            assert.fail(`canApply threw on ${label} for ${who.memberId}: ${(err as Error).message}`);
          }
          const results = [LIVE, REPLAY].map((env) => {
            try {
              return applyOp(state, op, who, env);
            } catch (err) {
              assert.fail(`applyOp threw on ${label} for ${who.memberId}${env === REPLAY ? " on replay" : ""}: ${(err as Error).message}`);
            }
          });
          const [live, replay] = results as [ApplyResult, ApplyResult];
          assert.deepEqual(replay.ok ? stableStringify(replay.state) : replay.message, live.ok ? stableStringify(live.state) : live.message, `${label} replays at version ${OP_VERSION} as it applies live`);
          if (!live.ok) continue;
          assert.equal(reparented(live.state), null, `${label} leaves every record a plain object`);
          if (!decision.ok) continue;
          for (const viewer of [DM, P1, P2]) assert.equal(reparented(projectState(live.state, viewer, { sceneId: null }), "projection"), null, `${label} projects for ${viewer.memberId}`);
        }
      }
    }
    assert.deepEqual([...ALL_KINDS].filter((t) => !kinds.has(t)), [], "every op kind is driven");
    assert.ok(tried > 5_000, `enough variants parse to reach the checks past the schema (${tried})`);
  });

  test("a lookup that found the prototype's member refuses as for any id not there", () => {
    const state = randomState(rng(4));
    const tokenId = Object.keys(state.tokens)[0]!;
    for (const name of NAMES.filter((n) => n !== "prototype")) {
      const asked: [Op, Viewer][] = [
        [{ t: "roll.answer", rollId: name, target: { tokenId }, total: 12, tag: "a1" }, P1],
        [{ t: "actor.hp", target: { tokenId: name }, change: { kind: "damage", amount: 3 } }, DM],
        [{ t: "actor.rest", target: { characterId: name }, kind: "long" }, P1],
        [{ t: "build.walls", sceneId: name, put: [] }, DM],
        [{ t: "token.delete", tokenId: name }, DM],
      ];
      for (const [op, who] of asked) {
        assert.ok(clientOpSchema.safeParse(op).success, `${op.t} naming ${name} passes the schema`);
        assert.equal(canApply(op, who, state, { canUseAsset: () => true }).ok && applyOp(state, op, who, LIVE).ok, false, `${op.t} naming ${name} is refused`);
      }
    }
  });

  test("a new entity may not take such an id, and an older op that made one replays as it applied", () => {
    const state = randomState(rng(5));
    const make = (id: string): Op => ({ t: "token.create", token: { id, sceneId: "s1", kind: "monster", name: "Goblin", size: "medium", x: 2, y: 2, actor: { inline: actor() } } });
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      for (const env of [LIVE, REPLAY]) {
        const made = applyOp(state, make(name), DM, env);
        assert.deepEqual(made.ok ? null : made.message, RESERVED_ID, `a new token named ${name} is refused${env === REPLAY ? " on replay" : ""}`);
      }
    }
    assert.ok(applyOp(state, make("prototype"), DM, LIVE).ok, "an id no prototype member holds is any other id");
    // A handout replaced by id was stored under "constructor" before ids were checked, and replays as an entry of its own.
    const show = (id: string): Op => ({ t: "handout.show", handout: { id, assetId: "img-1", title: "Map", to: "all" } });
    const shown = applyOp(state, show("constructor"), DM, STORED);
    assert.ok(shown.ok);
    assert.equal(Object.hasOwn(shown.state.handouts, "constructor"), true);
    assert.equal(ownEntry(shown.state.handouts, "constructor")?.title, "Map");
    const closed = applyOp(shown.state, { t: "handout.close", handoutId: "constructor" }, DM, LIVE);
    assert.ok(closed.ok, "an entity stored under such an id is found by it");
    assert.equal(Object.hasOwn(closed.state.handouts, "constructor"), false);
    // Its undo would make it again, which no op from today's version may.
    const remade = applyOp(closed.state, { t: "sys.restore", entries: closed.inverse!, from: "undo", deps: true }, DM, LIVE);
    assert.deepEqual(remade.ok ? null : remade.message, RESERVED_ID);
    // "__proto__" set the record's prototype rather than storing an entry, which lasts until the record's next copy and which no snapshot holds.
    const proto = applyOp(state, show("__proto__"), DM, STORED);
    assert.ok(proto.ok);
    assert.equal(Object.hasOwn(proto.state.handouts, "__proto__"), false);
    assert.equal((Object.getPrototypeOf(proto.state.handouts) as { title?: string }).title, "Map");
    assert.deepEqual(JSON.parse(JSON.stringify(proto.state.handouts)), JSON.parse(JSON.stringify(state.handouts)));
    assert.equal(ownEntry(proto.state.handouts, "title"), undefined, "a live read finds nothing through it");
  });

  test("stored ops that named a missing entity by such a name replay as they applied before own-key reads, and from today's version refuse as live ones", () => {
    const state = randomState(rng(6));
    const stored: [Op, Viewer][] = [
      [{ t: "drawing.delete", drawingId: "__proto__" }, DM],
      [{ t: "log.whisper", to: ["__proto__"], text: "psst" }, P1],
      [{ t: "token.update", tokenId: "constructor", patch: { name: "X" } }, DM],
      [{ t: "room.setPlayerScene", sceneId: "toString" }, DM],
    ];
    for (const [op, who] of stored) {
      const live = applyOp(state, op, who, LIVE);
      assert.equal(live.ok, false, `${op.t} is refused where it arrives`);
      const replay = applyOp(state, op, who, REPLAY);
      assert.deepEqual(replay.ok ? null : replay.message, live.message, `${op.t} stored at version ${OP_VERSION} refuses on replay`);
      const old = applyOp(state, op, who, STORED);
      assert.ok(old.ok, `${op.t} stored at version 40 replays`);
      assert.notEqual(old.state, state, `${op.t} writes what it wrote then`);
    }
    // A replayed op naming nothing of the kind is refused as before, so a replay that went wrong still stops the room.
    assert.equal(applyOp(state, { t: "token.delete", tokenId: "missing" }, DM, STORED).ok, false);
  });
});
