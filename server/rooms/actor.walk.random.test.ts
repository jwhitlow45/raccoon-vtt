import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { edge, fogRoom, lift, paint, wall } from "#shared/discoveryTestutil.ts";
import type { EdgeFeature, FreeWall, RoomState } from "#shared/model.ts";
import { chance, int, pick, rng, token } from "#shared/testutil.ts";
import type { ActorDeps, RoomActor } from "./actor.ts";
import { layerCharge } from "./memorySize.ts";
import { layerKey, memoryGrowth } from "./remember.ts";
import { SizeGuard } from "./sizeGuard.ts";
import { ScopeClient, StoredRoomDb, storedActor, type StoredRow } from "./undoScopeTesting.ts";

/**
 * A walk that needs its batch's sight runs the batch's explore and map
 * steps in place (RoomActor #stepInPlace), where builds before committed
 * the batch first. Over random rooms and random arrivals of walks, ops,
 * deletion steps and held commits, this build and the same build with the
 * commit before each walk (`walkCloses`) store the same rows, row for row,
 * capped batches included, and end with the same state, memory included.
 *
 * Both run on a standing number clock, where a close moves no number, so
 * the rows compare whole, numbers and times too. The batch timer is mocked
 * and every event of a round comes at one instant, so the timers both
 * builds place fire together at the round's end. A commit is held only
 * from a round's tick, so a held one delays the next rounds' events alike
 * in both.
 */

const W = 32;
const H = 20;
const NOW = Date.parse("2026-11-10T20:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

type Who = "dm" | "p1" | "p2";
/** An op a member sends, or one made from what that member's device holds, such as the head an undo names. */
type Event = { who: Who; op: unknown | ((client: ScopeClient) => unknown) } | { step: true };

function randomRoom(r: () => number): RoomState {
  const state = fogRoom({ vision: true, bounds: { w: W, h: H } });
  for (let i = 0; i < int(r, 2, 4); i++) paint(state, { x: int(r, 0, W - 8), y: int(r, 0, H - 8), w: int(r, 3, 8), h: int(r, 3, 8) }, pick(r, ["stone", "wood"] as const));
  for (let i = 0; i < int(r, 3, 8); i++) {
    const f = pick(r, [{ kind: "wall" }, { kind: "door", state: "closed", secret: false, discovered: false }, { kind: "door", state: "open", secret: false, discovered: false }] as EdgeFeature[]);
    edge(state, `${int(r, 1, W - 1)},${int(r, 1, H - 1)},${pick(r, ["n", "w"])}`, f);
  }
  state.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], disposition: "ally", x: int(r, 0, W - 1), y: int(r, 0, H - 1) });
  state.tokens.b = token("b", { kind: "pc", ownerIds: ["p2"], disposition: "ally", x: int(r, 0, W - 1), y: int(r, 0, H - 1) });
  state.tokens.m = token("m", { kind: "monster", name: "Lurker", visibility: "dm", x: int(r, 0, W - 1), y: int(r, 0, H - 1) });
  return { ...state, memory: {}, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
}

/** A step near where a token stands, as a walk is: the generator draws from the room as it began, so both builds get the same ops. */
function near(r: () => number, at: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.max(0, Math.min(W - 1, at.x + int(r, -6, 6))), y: Math.max(0, Math.min(H - 1, at.y + int(r, -6, 6))) };
}

function randomEvent(r: () => number, room: RoomState, n: number): Event {
  const roll = r();
  if (roll < 0.3) {
    const tokenId = pick(r, ["a", "b"] as const);
    return { who: tokenId === "a" ? "p1" : "p2", op: { t: "token.move", tokenId, ...near(r, room.tokens[tokenId]!) } };
  }
  if (roll < 0.4) return { who: "dm", op: { t: "token.move", tokenId: pick(r, ["m", "a", "b"]), ...near(r, room.tokens.m!) } };
  if (roll < 0.55) {
    const x = int(r, 0, W - 3);
    const y = int(r, 0, H - 3);
    const cells = Array.from({ length: int(r, 1, 4) }, (_, i) => `${x + (i % 2)},${y + Math.floor(i / 2)}`);
    return { who: "dm", op: chance(r, 0.7) ? { t: "build.paint", sceneId: "s1", terrain: pick(r, ["stone", "wood", "grass"]), cells, forget: true } : { t: "build.erase", sceneId: "s1", cells, forget: true } };
  }
  if (roll < 0.65) {
    const label = chance(r, 0.85) ? { x: int(r, 0, W * 2 - 1) / 2, y: int(r, 0, H * 2 - 1) / 2, text: pick(r, ["Old", "New", "Shrine"]), size: 1 } : null;
    return { who: "dm", op: { t: "build.label", sceneId: "s1", labelId: `lb${int(r, 0, 3)}`, label, forget: true } };
  }
  if (roll < 0.72) {
    const put = { id: `st${int(r, 0, 3)}`, art: { key: pick(r, ["barrel", "oak-tree"]) }, x: int(r, 0, W * 2 - 1) / 2, y: int(r, 0, H * 2 - 1) / 2, w: 1, h: 1, rotation: 0, z: 0, visibility: pick(r, ["all", "dm"] as const) };
    return { who: "dm", op: { t: "build.stamps", sceneId: "s1", put: [put], forget: true } };
  }
  if (roll < 0.78) {
    const doors = Object.values(room.buildChunks).flatMap((c) => Object.entries(c.edges).filter(([, f]) => f?.kind === "door").map(([key]) => key));
    if (doors.length > 0) return { who: pick(r, ["dm", "p1", "p2"] as const), op: { t: "door.set", sceneId: "s1", door: { edge: pick(r, doors) }, state: pick(r, ["open", "closed"] as const), ...(chance(r, 0.5) ? { by: "a" } : {}) } };
  }
  if (roll < 0.88) return { who: pick(r, ["dm", "p1", "p2"] as const), op: { t: "log.chat", text: `line ${n}` } };
  if (roll < 0.93) return { who: pick(r, ["p1", "p2"] as const), op: { t: "token.move", tokenId: pick(r, ["a", "b"]), x: -5, y: 0 } };
  return { step: true };
}

type Build = { actor: RoomActor; db: StoredRoomDb; clients: Record<Who, ScopeClient>; gate: { held: boolean; release: (() => void) | null }; commitsBeforeTick: number; ticking: boolean };

async function open(t: TestContext, room: RoomState, options: ActorDeps["options"]): Promise<Build> {
  const db = new StoredRoomDb(structuredClone(room));
  const h = await storedActor(t, db, { batchMs: 1, snapshotOps: 1_000_000, now: () => NOW, ...options }, quiet);
  const clients = {
    dm: await h.connect(room.members.dm1!, "dm", () => NOW),
    p1: await h.connect(room.members.p1!, "player", () => NOW),
    p2: await h.connect(room.members.p2!, "player", () => NOW),
  };
  const build: Build = { actor: h.actor, db, clients, gate: { held: false, release: null }, commitsBeforeTick: 0, ticking: false };
  db.beforeCommit = async () => {
    if (!build.ticking) build.commitsBeforeTick++;
    if (!build.gate.held) return;
    await new Promise<void>((resolve) => (build.gate.release = resolve));
  };
  return build;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function send(build: Build, event: Event): void {
  if ("step" in event) {
    void build.actor.deletionStep(async () => ({ deleted: [], result: undefined })).catch(() => undefined);
    return;
  }
  const client = build.clients[event.who];
  const op = typeof event.op === "function" ? (event.op as (client: ScopeClient) => unknown)(client) : event.op;
  void build.actor.op(client.conn, ++client.n, op);
}

function release(build: Build): void {
  build.gate.held = false;
  build.gate.release?.();
  build.gate.release = null;
}

const rowsOf = (db: StoredRoomDb): Omit<StoredRow, "opVersion">[] => db.rows.map(({ opVersion: _v, ...row }) => row);

/**
 * Runs the same rounds against both builds. Each round sends its events to
 * both, lets them run, then fires the round's batch timers. A held round
 * keeps the commit its tick starts until a later round's events are queued.
 */
async function race(t: TestContext, room: RoomState, rounds: Event[][], holds: ReadonlySet<number>, options: ActorDeps["options"] = {}): Promise<{ steps: Build; closes: Build }> {
  const steps = await open(t, room, { ...options, walkCloses: false });
  const closes = await open(t, room, { ...options, walkCloses: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const [i, events] of rounds.entries()) {
      for (const build of [steps, closes]) for (const event of events) send(build, event);
      await flush();
      for (const build of [steps, closes]) if (holds.has(i - 1) || holds.has(i - 2)) release(build);
      await flush();
      for (const build of [steps, closes]) {
        build.ticking = true;
        build.gate.held = holds.has(i);
      }
      t.mock.timers.tick(1);
      await flush();
      for (const build of [steps, closes]) build.ticking = false;
    }
    for (const build of [steps, closes]) release(build);
    await flush();
    t.mock.timers.tick(1);
    await flush();
  } finally {
    t.mock.timers.reset();
  }
  for (const build of [steps, closes]) {
    release(build);
    await build.actor.shutdown({ code: 1012, snapshot: false });
  }
  return { steps, closes };
}

/** Each answer a member's device heard, by its op's number, whatever frame carried it. */
function answersOf(client: ScopeClient): string[] {
  const out: string[] = [];
  for (const m of client.sent) {
    if (m.t !== "ev") continue;
    for (const n of m.acks ?? []) out.push(`${n} taken`);
    for (const r of m.rejects ?? []) out.push(`${r.n} ${r.code}: ${r.message}`);
  }
  return out.sort((a, b) => Number.parseInt(a) - Number.parseInt(b));
}

function same(steps: Build, closes: Build, what: string): void {
  for (const who of ["dm", "p1", "p2"] as const) assert.deepEqual(answersOf(steps.clients[who]), answersOf(closes.clients[who]), `${what}: ${who} heard the same answers, words and all`);
  assert.equal(steps.db.rows.length, closes.db.rows.length, `${what}: as many rows`);
  assert.deepEqual(rowsOf(steps.db), rowsOf(closes.db), `${what}: the same rows, row for row`);
  assert.deepEqual(steps.actor.committed.state, closes.actor.committed.state, `${what}: the same state, memory included`);
  assert.equal(steps.db.pub, closes.db.pub, `${what}: the same stored number`);
}

describe("a walk's steps in place against a commit before the walk", () => {
  test("random rooms and arrivals store the same rows and leave the same state, and no op waits for another's walk", async (t) => {
    let walksAfterAnswers = 0;
    let capped = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const room = randomRoom(r);
      const rounds = Array.from({ length: int(r, 4, 9) }, (_, i) => Array.from({ length: int(r, 1, 7) }, (_, k) => randomEvent(r, room, i * 10 + k)));
      const holds = new Set<number>(rounds.flatMap((_, i) => (chance(r, 0.2) ? [i] : [])));
      const cap = seed % 5 === 0;
      const { steps, closes } = await race(t, room, rounds, holds, cap ? { maxBatchOps: 3 } : {});
      same(steps, closes, `seed ${seed}`);
      if (!cap) assert.equal(steps.commitsBeforeTick, 0, `seed ${seed}: no commit came before a round's tick`);
      if (closes.commitsBeforeTick > 0) walksAfterAnswers++;
      if (cap) capped++;
    }
    assert.ok(walksAfterAnswers >= 10, `walks that needed the steps: ${walksAfterAnswers}`);
    assert.ok(capped >= 8);
  });

  test("a label remembered as Old and seen as New on a walk into sight and out again, in one tick, ends as the commit before the walk leaves it", async (t) => {
    const room = randomRoom(rng(7));
    paint(room, { x: 0, y: 0, w: W, h: H }, "stone");
    room.tokens.a = { ...room.tokens.a!, x: 2, y: 10 };
    room.tokens.b = { ...room.tokens.b!, x: 2, y: 11 };
    const rounds: Event[][] = [
      // Seen as Old, then the party walks away and it changes to New out of sight.
      [{ who: "dm", op: { t: "build.label", sceneId: "s1", labelId: "lb0", label: { x: 6.5, y: 10.5, text: "Old", size: 1 }, forget: true } }],
      [{ who: "p1", op: { t: "token.move", tokenId: "a", x: 30, y: 2 } }, { who: "p2", op: { t: "token.move", tokenId: "b", x: 30, y: 3 } }],
      [{ who: "dm", op: { t: "build.label", sceneId: "s1", labelId: "lb0", label: { x: 6.5, y: 10.5, text: "New", size: 1 }, forget: true } }],
      // One tick: a chat, a walk into sight of it, and a walk away again.
      [
        { who: "p2", op: { t: "log.chat", text: "look" } },
        { who: "p1", op: { t: "token.move", tokenId: "a", x: 7, y: 10 } },
        { who: "p1", op: { t: "token.move", tokenId: "a", x: 30, y: 2 } },
      ],
    ];
    const { steps, closes } = await race(t, room, rounds, new Set());
    same(steps, closes, "the stale label");
    assert.ok(closes.commitsBeforeTick > 0, "the comparison build committed before a walk");
  });

  test("the DM's edit in sight, a walk away and a second edit, and a builder's edit near a layer's cap, a walk and a second edit, are taken as after a commit", async (t) => {
    const room = randomRoom(rng(11));
    paint(room, { x: 0, y: 0, w: W, h: H }, "stone");
    room.tokens.a = { ...room.tokens.a!, x: 4, y: 4 };
    room.tokens.b = { ...room.tokens.b!, x: 5, y: 4 };
    // Every DM edit grows the party's layer by 55% of its cap: a second one in the same batch would pass it, one after a commit would not.
    const guard = new SizeGuard({});
    const growth: typeof memoryGrowth = (before, after, touched, applied) => {
      const real = memoryGrowth(before, after, touched, applied);
      const scene = after.scenes.s1!;
      const cap = guard.memoryCap(after, scene, null);
      return new Map([...real, [layerKey("s1", null), Math.floor(cap * 0.55) - layerCharge(after, scene, null)]]);
    };
    const rounds: Event[][] = [
      [
        { who: "dm", op: { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["5,5"] } },
        { who: "p1", op: { t: "token.move", tokenId: "a", x: 25, y: 15 } },
        { who: "dm", op: { t: "build.paint", sceneId: "s1", terrain: "grass", cells: ["5,6"] } },
      ],
      [
        { who: "dm", op: { t: "build.label", sceneId: "s1", labelId: "lb1", label: { x: 5.5, y: 4.5, text: "Here", size: 1 }, forget: true } },
        { who: "p2", op: { t: "token.move", tokenId: "b", x: 26, y: 15 } },
        { who: "dm", op: { t: "build.label", sceneId: "s1", labelId: "lb1", label: { x: 5.5, y: 4.5, text: "There", size: 1 }, forget: true } },
      ],
    ];
    const { steps, closes } = await race(t, room, rounds, new Set(), { memoryGrowth: growth });
    same(steps, closes, "edits around a walk");
    const refusals = steps.clients.dm.sent.flatMap((m) => (m.t === "ev" ? (m.rejects ?? []) : []));
    assert.deepEqual(refusals, [], "every edit was taken, the second after the walk as after a commit");
  });

  test("a remembered door the DM puts back at its remembered place, a walk, and the player's redo through it: refused in the same words, a wall is in the way", async (t) => {
    const state = fogRoom({ vision: true, bounds: { w: 24, h: 16 } });
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: false, autoWalls: "off", vision: { on: true, light: "dark" } };
    const blinded = { hp: { cur: 7, max: 7, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 9, senses: "", effects: [{ id: "e1", key: "blinded", name: "Blinded" }], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    state.tokens.a = token("a", { kind: "pc", name: "Ayla", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5, actor: { inline: blinded as never } });
    state.tokens.m = token("m", { kind: "monster", name: "Lurker", visibility: "dm", x: 3, y: 12 });
    lift(state, "dm", { x: 0, y: 3, w: 8, h: 5 });
    lift(state, "party", { x: 8, y: 5, w: 2, h: 1 });
    const door: FreeWall = { id: "aaaaaaaaaaaa", a: [8 + 6 / 64, 5 + 6 / 64], b: [8 + 6 / 64, 6 - 6 / 64], f: { kind: "door", state: "closed", secret: false, discovered: false } };
    wall(state, door.id, door.a, door.b, door.f);
    const room = { ...state, memory: {}, memoryBy: {}, playedScenes: { s1: { sceneId: "s1", rev: 0 } }, memoryShared: {} };
    const away: FreeWall = { ...door, a: [door.a[0] + 1, door.a[1]], b: [door.b[0] + 1, door.b[1]] };
    const rounds: Event[][] = [
      [{ who: "p1", op: { t: "token.move", tokenId: "a", x: 12, y: 5 } }],
      [{ who: "p1", op: (client: ScopeClient) => ({ t: "undo", scope: "play", head: client.head("play", "undo").id }) }],
      [{ who: "dm", op: { t: "scene.update", sceneId: "s1", patch: { blockMovement: true } } }],
      // Moved out of the player's sight, so their map keeps it where it was.
      [{ who: "dm", op: { t: "build.walls", sceneId: "s1", put: [away], forget: true } }],
      // One tick: the door back at its remembered place, a walk on the scene, the redo.
      [
        { who: "dm", op: { t: "build.walls", sceneId: "s1", put: [door], forget: true } },
        { who: "dm", op: { t: "token.move", tokenId: "m", x: 4, y: 12 } },
        { who: "p1", op: (client: ScopeClient) => ({ t: "redo", scope: "play", head: client.head("play", "redo").id }) },
      ],
    ];
    const { steps, closes } = await race(t, room, rounds, new Set());
    same(steps, closes, "the door and the redo");
    assert.ok(closes.commitsBeforeTick > 0, "the comparison build committed before the walk");
    assert.equal(answersOf(steps.clients.p1).at(-1), "3 forbidden: could not redo moving Ayla: a wall is in the way");
  });
});
