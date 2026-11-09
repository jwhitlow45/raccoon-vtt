import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { autoAt } from "#shared/discoveryTestutil.ts";
import type { Member, PlayerChunk, RoomState } from "#shared/model.ts";
import { privateFieldsIn } from "#shared/privateFields.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { classesOf, classOfMember, HIDDEN_DOOR, holdsAny, TWIN_H, twins, withoutRevs, type TwinOptions } from "#shared/secretDoorTestutil.ts";
import { FrameReader, T0 } from "#shared/seqTestutil.ts";
import { chance, int, pick, rng } from "#shared/testutil.ts";
import { mapStepOps } from "./remember.ts";
import { parseRoomState } from "./stateSchema.ts";
import { scopeActor, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * The secret door twin test through the room actor (docs/design/design-v1-maps-vision.md
 * 2.1, SB6): a room with a secret door and its hidden passage, and the same
 * room with the passage left as rock and the door gone, or a plain drawn
 * wall for a door with a drawn cover, take the same random events. For
 * every fog class whose history holds no square of the passage and none
 * beside it, the near doorway squares aside, every player's device gets the
 * same frames from both, whole, their numbers and revs included
 * (shared/seqTestutil.ts FrameReader), and the class's memory and explored
 * layer on the server are the same, until the door is found. Each event
 * moves both twins' clocks alike. The events: the DM's and the players' moves
 * with real sight, the explore and map steps, the DM's reveals and hides,
 * fog resets, blackouts, holders turned on and off, the scene switched
 * between Per player and Whole party, the DM's edits away from the passage
 * and the near squares, a player's door press on the hidden door, page
 * reloads, a room reloaded from its snapshot, and the map step capped
 * small or failing, so layers forget whole tiles or fail closed.
 */

type Step = "normal" | "tiny" | "throw";
/** How the next batch's map step runs, the same in both twins. */
let stepMode: Step = "normal";
const mapStep: typeof mapStepOps = (input) => {
  if (stepMode === "throw") throw new Error("the twin test's failing map step");
  return mapStepOps(stepMode === "tiny" ? { ...input, cap: () => 900 } : input);
};

/** A player's device: what it got, how far the view and the comparison have read it, and the view. */
type Device = { client: ScopeClient; read: number; compared: number; view: ProjectedState | null };
/** One twin: its room, which keeps its clock and frame reader across room reloads, and its devices. */
type Twin = { h: Awaited<ReturnType<typeof scopeActor>>; dm: ScopeClient; devices: Map<string, Device>; clock: { now: number }; reader: FrameReader };

const PLAYERS = ["p1", "p2"] as const;

function members(state: RoomState): { dm: Member; p1: Member; p2: Member } {
  return { dm: state.members.dm1!, p1: state.members.p1!, p2: state.members.p2! };
}

/** Reads every message the device got since the last read into its view, and checks no frame holds anything private. */
function catchUp(d: Device): void {
  const sent = d.client.sent as ServerMessage[];
  for (; d.read < sent.length; d.read++) {
    const msg = sent[d.read]!;
    assert.deepEqual(privateFieldsIn(msg), [], `a frame to ${d.client.conn.viewer.memberId} holds something private`);
    if (msg.t === "snapshot") d.view = msg.state as ProjectedState;
    else if (msg.t === "ev" && d.view) d.view = applyChanges(d.view, msg.changes as Change[]);
  }
}

async function open(t: TestContext, state: RoomState, clock = { now: T0 }, reader = new FrameReader()): Promise<Twin> {
  const h = await scopeActor(t, state, { mapStep, now: () => clock.now });
  const who = members(state);
  const dm = await h.connect(who.dm);
  const devices = new Map<string, Device>();
  for (const p of PLAYERS) {
    const d: Device = { client: await h.connect(who[p]), read: 0, compared: 0, view: null };
    catchUp(d);
    devices.set(p, d);
  }
  return { h, dm, devices, clock, reader };
}

/** The frames a device got since the last comparison, as its twin's reader reads them. */
function newFrames(twin: Twin, d: Device): string[] {
  const sent = d.client.sent;
  const texts = twin.reader.texts(sent.slice(d.compared));
  d.compared = sent.length;
  return texts;
}

function rejection(event: Extract<ServerMessage, { t: "ev" }>, n: number): string {
  const r = event.rejects?.find((x) => x.n === n);
  return r ? r.code : "ok";
}

/** A random event both twins take: an op by the DM or a player, or a reload, as a step the run applies to each. */
type Event = { by: "dm" | "p1" | "p2"; op: Op; mode: Step } | { reload: "page"; who: "p1" | "p2" } | { reload: "room" };

/** A cell of room R or the corridor, the near squares included. */
function floorCell(r: () => number, wide: boolean): { x: number; y: number } {
  if (chance(r, 0.7)) return { x: int(r, 2, 9), y: int(r, 2, 9) };
  return { x: int(r, 10, 15), y: wide ? int(r, 5, 6) : 5 };
}

/** A rectangle west of the near squares, or now and then anywhere, which can reveal the passage and end a class's part. */
function fogRect(r: () => number): { x: number; y: number; w: number; h: number } {
  if (chance(r, 0.85)) return { x: int(r, 0, 12), y: int(r, 0, TWIN_H - 3), w: int(r, 1, 4), h: int(r, 1, 4) };
  return { x: int(r, 0, 28), y: int(r, 0, TWIN_H - 3), w: int(r, 1, 4), h: int(r, 1, 4) };
}

function randomEvent(r: () => number, state: RoomState, opts: TwinOptions, doors: readonly string[], n: number): Event {
  const mode: Step = chance(r, 0.12) ? "tiny" : chance(r, 0.04) ? "throw" : "normal";
  const wide = opts.wide === true;
  const roll = r();
  const dm = (op: Op): Event => ({ by: "dm", op, mode });
  if (roll < 0.3) return dm({ t: "token.move", tokenId: pick(r, ["a", "b"]), ...floorCell(r, wide) });
  if (roll < 0.4) {
    const p = pick(r, PLAYERS);
    return { by: p, op: { t: "token.move", tokenId: p === "p1" ? "a" : "b", ...floorCell(r, wide) }, mode };
  }
  if (roll < 0.52) return dm({ t: "fog.live", sceneId: "s1", ops: [{ id: `f${n}`, mode: chance(r, 0.7) ? "reveal" : "hide", shape: { kind: "rect", ...fogRect(r) } }] });
  if (roll < 0.54) return dm({ t: "fog.reset", sceneId: "s1", to: "hidden" });
  if (roll < 0.57) return dm({ t: "view.blackout", blackout: state.meta.view?.blackout !== true });
  if (roll < 0.63 && opts.explore) {
    const scene = state.scenes.s1!;
    if (scene.vision?.perPlayer === true && chance(r, 0.8)) return dm({ t: "vision.holders", sceneId: "s1", on: PLAYERS.filter(() => chance(r, 0.5)) });
    return dm({ t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "bright", perPlayer: scene.vision?.perPlayer !== true } } });
  }
  if (roll < 0.8) {
    // The DM's edits away from the passage and the near squares: x 14 and less.
    const x = int(r, 0, 13);
    const y = int(r, 0, TWIN_H - 2);
    const sub = r();
    if (sub < 0.4) return dm({ t: "build.paint", sceneId: "s1", terrain: pick(r, ["stone", "wood", "water"] as const), cells: [`${x},${y}`, `${x + 1},${y}`] });
    if (sub < 0.6) return dm({ t: "build.erase", sceneId: "s1", cells: [`${x},${y}`] });
    if (sub < 0.8) return dm({ t: "build.height", sceneId: "s1", cells: [`${x},${y}`], height: pick(r, [0, 5, 10]) });
    const feature = pick(r, [{ kind: "wall" }, { kind: "window" }, { kind: "door", state: "closed", secret: false, discovered: false }, HIDDEN_DOOR, null] as const);
    return dm({ t: "build.edge", sceneId: "s1", edges: [{ key: `${x},${y},${pick(r, ["n", "w"])}`, feature: feature === null ? null : { ...feature } }] });
  }
  if (roll < 0.86) {
    const p = pick(r, PLAYERS);
    return { by: p, op: { t: "door.set", sceneId: "s1", door: { edge: pick(r, doors) }, state: "open", by: p === "p1" ? "a" : "b" }, mode };
  }
  if (roll < 0.97) return { reload: "page", who: pick(r, PLAYERS) };
  return { reload: "room" };
}

/** What the twin test compares of a class on the server: its memory and its explored layer, revs left out. */
function layerOf(state: RoomState, layer: string | null): string {
  const scene = (c: { sceneId: string; memberId?: string }) => c.sceneId === "s1" && (layer === null ? c.memberId === undefined : c.memberId === layer);
  const memory = layer === null ? Object.values(state.memory ?? {}) : Object.values(state.memoryBy ?? {});
  const explored = layer === null ? Object.values(state.exploredTiles) : Object.values(state.exploredBy ?? {});
  return stableStringify(withoutRevs({ memory: memory.filter(scene), explored: explored.filter(scene) }));
}

type Counts = { compared: number; nearHeld: number; forgets: number; reloads: number; answers: Map<string, number> };

async function run(t: TestContext, opts: TwinOptions, seed: number, steps: number, counts: Counts): Promise<{ diverged: boolean }> {
  const r = rng(seed);
  const w = twins(opts);
  const pair: [Twin, Twin] = [await open(t, w.door), await open(t, w.rock)];
  const left = new Set<string>();
  const near = new Set(w.doors.map((k) => k.split(",").map(Number) as [number, number]).map(([x, y]) => `${x - 1},${y}`));
  const where = (i: number) => `${opts.cover} cover${opts.wide ? ", wide" : ""}${opts.explore ? ", Explore" : ", Reveal by hand"}${opts.perPlayer ? " per player" : ""}${opts.rule ? `, ${opts.rule}` : ""}, seed ${seed}, step ${i}`;
  let diverged = false;
  for (let i = 0; i < steps && !diverged; i++) {
    const before = pair[0].h.actor.committed.state;
    const event = randomEvent(r, before, opts, w.doors, seed * 1000 + i);
    const answers: string[] = [];
    for (const twin of pair) {
      twin.clock.now += 1_000;
      if ("reload" in event) {
        if (event.reload === "page") {
          const old = twin.devices.get(event.who)!;
          twin.h.actor.detach(old.client.conn);
          const d: Device = { client: await twin.h.connect(members(twin.h.actor.committed.state)[event.who]), read: 0, compared: 0, view: null };
          catchUp(d);
          catchUp(old);
          assert.equal(stableStringify(d.view), stableStringify(old.view), `${where(i)}: a reload gives ${event.who} what the events built`);
          twin.devices.set(event.who, d);
        } else {
          const state = twin.h.actor.committed.state;
          for (const d of twin.devices.values()) catchUp(d);
          const views = new Map([...twin.devices].map(([p, d]) => [p, stableStringify(d.view)]));
          const next = await open(t, state, twin.clock, twin.reader);
          for (const [p, d] of next.devices) assert.equal(stableStringify(d.view), views.get(p), `${where(i)}: the room reloaded gives ${p} what it held`);
          twin.h = next.h;
          twin.dm = next.dm;
          twin.devices = next.devices;
        }
        counts.reloads++;
        continue;
      }
      stepMode = event.mode;
      const client = event.by === "dm" ? twin.dm : twin.devices.get(event.by)!.client;
      const sent = await client.send(event.op);
      answers.push(rejection(sent, client.n));
      stepMode = "normal";
    }
    if (answers.length === 2) assert.equal(answers[0], answers[1], `${where(i)}: both twins answer ${"op" in event ? event.op.t : ""} alike`);
    if ("op" in event) {
      const tally = `${event.op.t} ${answers[0]}`;
      counts.answers.set(tally, (counts.answers.get(tally) ?? 0) + 1);
    }
    if ("mode" in event && event.mode !== "normal") counts.forgets++;
    const states = pair.map((p) => p.h.actor.committed.state);
    for (const layer of new Set([...classesOf(states[0]!), ...classesOf(states[1]!)])) {
      if (holdsAny(states, layer, w.banned)) left.add(layer ?? "");
    }
    for (const p of PLAYERS) {
      const layer = classOfMember(states[0]!, p);
      assert.equal(layer, classOfMember(states[1]!, p), `${where(i)}: ${p} is in one class in both twins`);
      if (left.has(layer ?? "")) continue;
      const frames = pair.map((twin) => {
        const d = twin.devices.get(p)!;
        catchUp(d);
        return newFrames(twin, d);
      });
      const layers = states.map((s) => layerOf(s, layer));
      if (opts.cover === null) {
        // A door from before covers is the leak the cover ends: the run only looks for the first difference.
        if (stableStringify(frames[0]) !== stableStringify(frames[1]) || layers[0] !== layers[1]) diverged = true;
        continue;
      }
      assert.deepEqual(frames[0], frames[1], `${where(i)}: ${p}'s device (${layer ?? "party"}) gets the same frames in both twins`);
      assert.equal(layers[0], layers[1], `${where(i)}: the ${layer ?? "party"} layer is the same in both twins`);
      counts.compared++;
      if (holdsAny([states[0]!], layer, near)) counts.nearHeld++;
    }
  }
  // No stored op the map step wrote, nor any stored op at all, names a cover a player could be sent through memory.
  for (const twin of pair) {
    for (const op of twin.h.db.stored) if (op.t === "sys.remember") assert.deepEqual(privateFieldsIn(op).filter((p) => p.endsWith(".cover")), [], `${where(-1)}: a stored map step holds a cover`);
  }
  return { diverged };
}

const CONFIGS: TwinOptions[] = [
  { cover: "auto", explore: true },
  { cover: "auto", explore: true, perPlayer: true, wide: true },
  { cover: "auto", explore: false, rule: "floor" },
  { cover: "drawn", explore: true, perPlayer: true },
  { cover: "drawn", explore: false, wide: true },
  { cover: "drawn", explore: true, rule: "floor" },
];

describe("the secret door twin test through the room actor (SB6)", () => {
  test("for every class in the audience, each device and each layer is the same with the secret door and passage as with rock, until the door is found", async (t) => {
    const counts: Counts = { compared: 0, nearHeld: 0, forgets: 0, reloads: 0, answers: new Map() };
    for (const [i, opts] of CONFIGS.entries()) for (let seed = 1; seed <= 3; seed++) await run(t, opts, i * 100 + seed, 45, counts);
    // The runs must compare many steps with a class holding a near doorway square, or they test nothing.
    assert.ok(counts.compared > 1200, `compared ${counts.compared}`);
    assert.ok(counts.nearHeld > 400, `compared with a near square held ${counts.nearHeld}`);
    assert.ok(counts.forgets > 60, `capped or failing map steps ${counts.forgets}`);
    assert.ok(counts.reloads > 100, `reloads ${counts.reloads}`);
    // And the events must apply, not be refused alike in both twins.
    for (const t of ["token.move", "fog.live", "fog.reset", "view.blackout", "vision.holders", "scene.update", "build.paint", "build.erase", "build.height", "build.edge"]) {
      assert.ok((counts.answers.get(`${t} ok`) ?? 0) >= 5, `${t} applied ${counts.answers.get(`${t} ok`) ?? 0} times`);
    }
  });

  test("a door from before covers, in an automatic line, is told from the rock by the same runs, so they can see the leak covers end", async (t) => {
    const counts: Counts = { compared: 0, nearHeld: 0, forgets: 0, reloads: 0, answers: new Map() };
    let found = 0;
    for (let seed = 1; seed <= 3; seed++) if ((await run(t, { cover: null, explore: true }, 900 + seed, 45, counts)).diverged) found++;
    assert.ok(found >= 2, `the leak showed in ${found} of 3 runs`);
  });
});

/** The chunk at 1, 0 as a player's device holds it now: the one the doors on x 16 are filed in. */
function doorChunk(twin: Twin, p: "p1" | "p2" = "p1"): PlayerChunk | undefined {
  const d = twin.devices.get(p)!;
  catchUp(d);
  return d.view?.buildChunks["s1:1,0"] as PlayerChunk | undefined;
}

async function dmDoes(twin: Twin, op: Op): Promise<void> {
  await twin.dm.apply(op);
}

/** Moves Ayla, whose sight the party shares, to the near square, where she sees the door's edge, or to 3, 2, where she does not. */
const toDoor: Op = { t: "token.move", tokenId: "a", x: 15, y: 5 };
const away: Op = { t: "token.move", tokenId: "a", x: 3, y: 2 };

describe("secret doors through the room actor, case by case", () => {
  test("the generated dead end, live and then remembered, is the same with the passage as with rock, and Mark found ends it", async (t) => {
    const w = twins({ cover: "auto", explore: true });
    const pair = [await open(t, w.door), await open(t, w.rock)] as const;
    const same = (what: string) => {
      const frames = pair.map((twin) => {
        for (const d of twin.devices.values()) catchUp(d);
        return newFrames(twin, twin.devices.get("p1")!);
      });
      assert.deepEqual(frames[0], frames[1], what);
    };
    for (const twin of pair) await dmDoes(twin, toDoor);
    same("live");
    assert.ok(autoAt(doorChunk(pair[0]), "16,5,w"), "the door is the automatic wall");
    for (const twin of pair) await dmDoes(twin, away);
    same("remembered");
    for (const twin of pair) await dmDoes(twin, { t: "build.paint", sceneId: "s1", terrain: "wood", cells: ["4,8"] });
    same("after an edit away from it");
    await dmDoes(pair[0], { t: "door.set", sceneId: "s1", door: { edge: "16,5,w" }, state: "closed", found: true });
    await dmDoes(pair[0], toDoor);
    assert.deepEqual(doorChunk(pair[0])?.edges["16,5,w"], { kind: "door", state: "closed", secret: true, discovered: true }, "found, it is the door, without its cover");
  });

  test("a drawn wall remembered where the DM then puts an automatic door out of sight stays the drawn wall until seen again (DR-ASTRA-19)", async (t) => {
    const w = twins({ cover: "auto", explore: true });
    const twin = await open(t, w.rock);
    await dmDoes(twin, { t: "build.edge", sceneId: "s1", edges: [{ key: "16,5,w", feature: { kind: "wall" } }] });
    await dmDoes(twin, toDoor);
    assert.deepEqual(doorChunk(twin)?.edges["16,5,w"], { kind: "wall" });
    await dmDoes(twin, away);
    await dmDoes(twin, { t: "build.edge", sceneId: "s1", edges: [{ key: "16,5,w", feature: { ...HIDDEN_DOOR, cover: "auto" } }] });
    assert.deepEqual(doorChunk(twin)?.edges["16,5,w"], { kind: "wall" }, "memory keeps the drawn wall");
    assert.ok(!autoAt(doorChunk(twin), "16,5,w"));
    await dmDoes(twin, toDoor);
    assert.equal(doorChunk(twin)?.edges["16,5,w"], undefined);
    assert.ok(autoAt(doorChunk(twin), "16,5,w"), "seen again, it is the automatic wall");
  });

  test("a door found, then hidden out of sight, stays the door in memory until seen again, and its map step forgets nothing (DR2-01)", async (t) => {
    const w = twins({ cover: "auto", explore: true });
    const twin = await open(t, w.door);
    const found = { kind: "door", state: "closed", secret: true, discovered: true };
    await dmDoes(twin, { t: "door.set", sceneId: "s1", door: { edge: "16,5,w" }, state: "closed", found: true });
    await dmDoes(twin, toDoor);
    assert.deepEqual(doorChunk(twin)?.edges["16,5,w"], found);
    await dmDoes(twin, away);
    const stored = twin.h.db.stored.length;
    await dmDoes(twin, { t: "door.set", sceneId: "s1", door: { edge: "16,5,w" }, state: "closed", found: false });
    assert.deepEqual(doorChunk(twin)?.edges["16,5,w"], found, "memory keeps the found door");
    const steps = twin.h.db.stored.slice(stored).filter((op) => op.t === "sys.remember");
    assert.ok(steps.length > 0, "the map step remembered the door");
    for (const op of steps) {
      assert.equal(op.t === "sys.remember" && op.forget, undefined, "nothing forgotten");
      assert.deepEqual(privateFieldsIn(op), []);
    }
    assert.match(stableStringify(steps), /"discovered":true/);
    await dmDoes(twin, toDoor);
    assert.ok(autoAt(doorChunk(twin), "16,5,w"), "seen again, it is the automatic wall");
  });

  test("the stored state takes a grid edge door's cover and refuses one on a free door", () => {
    const w = twins({ cover: "drawn", explore: true });
    assert.ok(parseRoomState(structuredClone(w.door)).ok);
    const bad = structuredClone(w.door);
    const chunk = bad.buildChunks["s1:0,0"]!;
    chunk.walls = [{ id: "abcdefghijkl", a: [1, 1], b: [2, 1], f: { ...HIDDEN_DOOR, cover: "auto" } }];
    assert.equal(parseRoomState(bad).ok, false);
  });
});
