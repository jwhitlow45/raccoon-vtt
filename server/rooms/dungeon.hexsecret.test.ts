import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test, type TestContext } from "node:test";
import type { Member, RoomState } from "#shared/model.ts";
import { privateFieldsIn } from "#shared/privateFields.ts";
import { applyChanges, stableStringify, type ProjectedState } from "#shared/project.ts";
import type { Change, Op, ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { clearVisionCache } from "#shared/rules/vision.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { hexCenter, hexInScene, hexNeighbors, type HexGrid } from "#shared/rules/hex.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { classOfMember, withoutRevs } from "#shared/secretDoorTestutil.ts";
import { FrameReader, T0 } from "#shared/seqTestutil.ts";
import { chance, pick, rng, room, token } from "#shared/testutil.ts";
import { scopeActor, type ScopeClient } from "./undoScopeTesting.ts";

/**
 * Hex dungeons' secret doors and way in (docs/design: dungeon generator
 * phase 3, 2.2, 2.3 and 6), on the hex fixtures the client's
 * ops.fixture.test.ts writes, through the room actor, as phase 2's
 * dungeon.secret.test.ts runs its twins.
 *
 * - Corridor side: the party in the corridor before a secret room's leaf.
 *   Its twin has no secret room: the room's walls, stamps, lights, pins,
 *   traps, heights and marks gone, and the leaf a plain wall of its id.
 * - Room side: the party inside the secret room. Its twin has the leaf a
 *   plain wall of its id, and nothing else changed.
 * - Equal is every frame each player's device got, whole, and each class's
 *   memory and explored layer on the server, revs left out, on Explore for
 *   the party and per player, Reveal by hand, no fog (room side, where the
 *   room is the same in both), and after the party saw and left.
 * - The way in: from each of its edge hexes, on rows and on columns, the
 *   party's sight holds no hex outside the dungeon's floor, so nothing of
 *   the rock or another room's outer wall shows through a scene-edge sliver.
 */

type FixtureHex = {
  name: string;
  sceneId: string;
  grid: "hexRows" | "hexColumns";
  ops: Op[];
  secret: { leaf: string; inside: string; outside: string; room: string[]; walls: string[]; stamps: string[]; lights: string[]; pins: string[]; traps: string[] };
  floor: string[];
  wayIn: string[];
};
const FIXTURE = JSON.parse(readFileSync(new URL("./dungeon.fixture.json", import.meta.url), "utf8")) as { dungeons: FixtureHex[] };
const ROWS = FIXTURE.dungeons.find((d) => d.name === "hex-secret")!;
const COLUMNS = FIXTURE.dungeons.find((d) => d.name === "hex-columns")!;

const S = "s1";
const AT = "2026-01-01T00:00:00.000Z";
const xy = (key: string) => key.split(",").map(Number) as [number, number];

/** The fixture's ops on s1, the test room's players' scene. */
function onS1(d: FixtureHex): Op[] {
  return JSON.parse(JSON.stringify(d.ops).replaceAll(JSON.stringify(d.sceneId), JSON.stringify(S))) as Op[];
}

/** The leaf as a plain wall of its own id and ends: what a player is shown of it while hidden. */
function leafAsWall(ops: Op[], d: FixtureHex): Op[] {
  return ops.map((op) => (op.t === "build.walls" ? { ...op, put: (op.put ?? []).map((w) => (w.id === d.secret.leaf ? { ...w, f: { kind: "wall" as const } } : w)) } : op));
}

/** The dungeon with no secret room: its walls, dressing, pins, traps and marks gone, the leaf a plain wall. */
function withoutRoom(ops: Op[], d: FixtureHex): Op[] {
  const s = d.secret;
  const room = new Set(s.room);
  const gone = new Set([...s.walls, ...s.stamps, ...s.lights, ...s.pins, ...s.traps]);
  const out: Op[] = [];
  for (const op of leafAsWall(ops, d)) {
    if (op.t === "build.walls") out.push({ ...op, put: (op.put ?? []).filter((w) => !gone.has(w.id)) });
    else if (op.t === "build.stamps") out.push({ ...op, put: (op.put ?? []).filter((x) => !gone.has(x.id)) });
    else if (op.t === "build.lights") out.push({ ...op, put: (op.put ?? []).filter((x) => !gone.has(x.id)) });
    else if (op.t === "build.height" || op.t === "build.stairs" || op.t === "build.rough") {
      const cells = op.cells.filter((c) => !room.has(c));
      if (cells.length > 0) out.push({ ...op, cells });
    } else if (op.t === "pin.put" && gone.has(op.pin.id)) continue;
    else if (op.t === "trap.create" && gone.has(op.trap.id)) continue;
    else out.push(op);
  }
  return out;
}

type See = { explore: boolean; perPlayer?: boolean; fog?: boolean };

/** A Medium token's place standing on a hex: its box centered on the hex's center. */
function onHex(g: HexGrid, key: string): { x: number; y: number } {
  const [col, row] = xy(key);
  const c = hexCenter(g, { col, row });
  return { x: c.x - 0.5, y: c.y - 0.5 };
}

/** The test room with the ops landed on its players' scene as the DM, and the party's two creatures on `start`. */
function landed(d: FixtureHex, ops: readonly Op[], see: See, start: string): RoomState {
  const base = room();
  const { s1: _, ...others } = base.scenes;
  let state: RoomState = { ...base, scenes: others };
  for (const [i, raw] of ops.entries()) {
    let op = raw;
    if (op.t === "scene.create") {
      const { vision: _v, ...scene } = op.scene;
      op = { t: "scene.create", scene: { ...scene, fogEnabled: see.fog !== false, ...(see.explore ? { vision: { on: true, light: "bright" as const, ...(see.perPlayer ? { perPlayer: true } : {}) } } : {}) } };
    }
    const r = applyOp(state, op, { memberId: "dm1", role: "dm" }, { seq: i + 1, at: AT });
    assert.ok(r.ok, `${op.t} refused: ${r.ok ? "" : r.message}`);
    state = r.state;
  }
  const g = gridOfShape(d.grid) as HexGrid;
  const at = onHex(g, start);
  state.tokens = {
    ...state.tokens,
    a: token("a", { kind: "pc", name: "Ayla", ownerIds: ["p1"], disposition: "ally", ...at }),
    b: token("b", { kind: "pc", name: "Bree", ownerIds: ["p2"], disposition: "ally", ...at }),
  };
  if (see.perPlayer) state.holders = { [S]: { sceneId: S, rev: 0, entries: [{ memberId: "p1", on: true }] } };
  return { ...state, memory: {}, memoryBy: {}, playedScenes: { [S]: { sceneId: S, rev: 0 } }, memoryShared: {} };
}

type Device = { client: ScopeClient; read: number; compared: number; view: ProjectedState | null };
type Twin = { h: Awaited<ReturnType<typeof scopeActor>>; dm: ScopeClient; devices: Map<string, Device>; clock: { now: number }; reader: FrameReader };
const PLAYERS = ["p1", "p2"] as const;

function members(state: RoomState): Record<"dm" | "p1" | "p2", Member> {
  return { dm: state.members.dm1!, p1: state.members.p1!, p2: state.members.p2! };
}

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
  const h = await scopeActor(t, state, { now: () => clock.now });
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

function layerOf(state: RoomState, layer: string | null): string {
  const mine = (c: { sceneId: string; memberId?: string }) => c.sceneId === S && (layer === null ? c.memberId === undefined : c.memberId === layer);
  const memory = layer === null ? Object.values(state.memory ?? {}) : Object.values(state.memoryBy ?? {});
  const explored = layer === null ? Object.values(state.exploredTiles) : Object.values(state.exploredBy ?? {});
  return stableStringify(withoutRevs({ memory: memory.filter(mine), explored: explored.filter(mine) }));
}

/** The leaf's ends, from the fixture's ops. */
function leafEnds(d: FixtureHex): [[number, number], [number, number]] {
  const w = d.ops.flatMap((op) => (op.t === "build.walls" ? (op.put ?? []) : [])).find((x) => x.id === d.secret.leaf)!;
  return [w.a, w.b];
}

/**
 * Whether a device's view holds a wall at the leaf. Players get a wall's
 * piece under an id of its own and its ends rounded (shared/project.ts),
 * so it is found by ends within a thousandth of a cell.
 */
function holdsLeaf(view: ProjectedState | null, [a, b]: [[number, number], [number, number]]): boolean {
  const near = (p: readonly number[], q: readonly number[]) => Math.abs(p[0]! - q[0]!) < 1e-3 && Math.abs(p[1]! - q[1]!) < 1e-3;
  return Object.values(view?.buildChunks ?? {}).some((c) => ((c as { walls?: { a: number[]; b: number[] }[] }).walls ?? []).some((w) => (near(w.a, a) && near(w.b, b)) || (near(w.a, b) && near(w.b, a))));
}

/** Compares every player's new frames and layer in both twins, and counts the comparisons made while the player's device holds a wall at the leaf. */
function compare(pair: [Twin, Twin], leaf: [[number, number], [number, number]], where: string, counts: { compared: number; leafHeld: number; differ?: boolean }): void {
  const states = pair.map((p) => p.h.actor.committed.state) as [RoomState, RoomState];
  for (const p of PLAYERS) {
    const layer = classOfMember(states[0], p);
    const frames = pair.map((twin) => {
      const d = twin.devices.get(p)!;
      catchUp(d);
      const sent = d.client.sent;
      const texts = twin.reader.texts(sent.slice(d.compared));
      d.compared = sent.length;
      return texts;
    });
    if (counts.differ !== undefined) {
      if (stableStringify(frames[0]) !== stableStringify(frames[1])) counts.differ = true;
      continue;
    }
    assert.deepEqual(frames[0], frames[1], `${where}: ${p}'s device gets the same frames in both twins`);
    assert.equal(layerOf(states[0], layer), layerOf(states[1], layer), `${where}: the ${layer ?? "party"} layer is the same in both twins`);
    counts.compared++;
    if (holdsLeaf(pair[0].devices.get(p)!.view, leaf)) counts.leafHeld++;
  }
}

/** Takes one op in both twins, by the DM or a player, each twin's clock moved alike, and checks both answer alike. */
async function take(pair: [Twin, Twin], by: "dm" | "p1" | "p2", op: Op, where: string): Promise<void> {
  const answers: string[] = [];
  for (const twin of pair) {
    twin.clock.now += 1_000;
    const client = by === "dm" ? twin.dm : twin.devices.get(by)!.client;
    const ev = await client.send(op);
    answers.push(ev.rejects?.find((x) => x.n === client.n)?.code ?? "ok");
  }
  assert.equal(answers[0], answers[1], `${where}: both twins answer ${op.t} alike`);
}

/** A page reload of one player in both twins: the fresh view is what the events built. */
async function reload(pair: [Twin, Twin], who: "p1" | "p2", where: string): Promise<void> {
  for (const twin of pair) {
    const old = twin.devices.get(who)!;
    twin.h.actor.detach(old.client.conn);
    const d: Device = { client: await twin.h.connect(members(twin.h.actor.committed.state)[who]), read: 0, compared: 0, view: null };
    catchUp(d);
    catchUp(old);
    assert.equal(stableStringify(d.view), stableStringify(old.view), `${where}: a reload gives ${who} what the events built`);
    twin.devices.set(who, d);
  }
}

type Case = { name: string; d: FixtureHex; side: "room" | "corridor"; see: See };

/** Hexes within `n` steps of `from`, through floor hexes only, out of `banned`. */
function near(d: FixtureHex, from: string, n: number, banned: ReadonlySet<string>): string[] {
  const g = gridOfShape(d.grid) as HexGrid;
  const floor = new Set(d.floor);
  let ring = [from];
  const seen = new Set(ring);
  for (let i = 0; i < n; i++) {
    const next: string[] = [];
    for (const k of ring) {
      const [col, row] = xy(k);
      for (const h of hexNeighbors(g, { col, row })) {
        const key = `${h.col},${h.row}`;
        if (seen.has(key) || !floor.has(key) || banned.has(key)) continue;
        seen.add(key);
        next.push(key);
      }
    }
    ring = next;
  }
  return [...seen];
}

async function twinRun(t: TestContext, c: Case, seed: number, steps: number, counts: { compared: number; leafHeld: number; differ?: boolean }, shown = false): Promise<void> {
  clearVisionCache();
  const s = c.d.secret;
  const roomSet = new Set(s.room);
  const standing = c.side === "room" ? s.room.slice() : near(c.d, s.outside, 3, roomSet);
  const away = c.d.floor.find((k) => !roomSet.has(k) && !near(c.d, s.outside, 8, roomSet).includes(k))!;
  assert.ok(away, `${c.name}: a hex out of sight of the leaf`);
  const written = onS1(c.d);
  const twin = c.side === "room" ? leafAsWall(written, c.d) : withoutRoom(written, c.d);
  // The check's own check: the leaf written as a plain closed door, which players are shown, must tell the twins apart.
  const ops = shown ? written.map((op) => (op.t === "build.walls" ? { ...op, put: (op.put ?? []).map((w) => (w.id === s.leaf ? { ...w, f: { kind: "door" as const, state: "closed" as const, secret: false, discovered: false } } : w)) } : op)) : written;
  const start = c.side === "room" ? s.inside : away;
  const pair: [Twin, Twin] = [await open(t, landed(c.d, ops, c.see, start)), await open(t, landed(c.d, twin, c.see, start))];
  const g = gridOfShape(c.d.grid) as HexGrid;
  const where = (i: number | string) => `${c.name}, seed ${seed}, step ${i}`;
  compare(pair, leafEnds(c.d), where("start"), counts);
  // The first look: Ayla before the leaf, or the hexes revealed by hand.
  const look = c.side === "room" ? s.inside : s.outside;
  if (c.see.explore || c.see.fog === false) await take(pair, "dm", { t: "token.move", tokenId: "a", ...onHex(g, look) }, where("look"));
  else await take(pair, "dm", { t: "fog.live", sceneId: S, ops: standing.map((k, i) => ({ id: `look${i}`, mode: "reveal" as const, shape: { kind: "cells" as const, cells: [k] } })) }, where("look"));
  compare(pair, leafEnds(c.d), where("look"), counts);
  const r = rng(seed);
  for (let i = 0; i < steps; i++) {
    const roll = r();
    if (roll < 0.45) await take(pair, "dm", { t: "token.move", tokenId: pick(r, ["a", "b"]), ...onHex(g, pick(r, standing)) }, where(i));
    else if (roll < 0.6) {
      const p = pick(r, PLAYERS);
      await take(pair, p, { t: "token.move", tokenId: p === "p1" ? "a" : "b", ...onHex(g, pick(r, standing)) }, where(i));
    } else if (roll < 0.72 && !c.see.explore && c.see.fog !== false) {
      const reveal = chance(r, 0.6);
      await take(pair, "dm", { t: "fog.live", sceneId: S, ops: [{ id: `f${seed}-${i}`, mode: reveal ? "reveal" : "hide", shape: { kind: "cells", cells: [pick(r, standing)] } }] }, where(i));
    } else if (roll < 0.82) {
      // Saw and left: both creatures walk out of sight, and the class keeps what it remembers.
      for (const id of ["a", "b"]) await take(pair, "dm", { t: "token.move", tokenId: id, ...onHex(g, away) }, where(i));
    } else await reload(pair, pick(r, PLAYERS), where(i));
    compare(pair, leafEnds(c.d), where(i), counts);
  }
}

const CASES: Case[] = [
  { name: "rows, corridor side, Explore", d: ROWS, side: "corridor", see: { explore: true } },
  { name: "rows, corridor side, Explore per player", d: ROWS, side: "corridor", see: { explore: true, perPlayer: true } },
  { name: "rows, corridor side, Reveal by hand", d: ROWS, side: "corridor", see: { explore: false } },
  { name: "rows, room side, Explore", d: ROWS, side: "room", see: { explore: true } },
  { name: "rows, room side, no fog", d: ROWS, side: "room", see: { explore: false, fog: false } },
  { name: "columns, corridor side, Explore per player", d: COLUMNS, side: "corridor", see: { explore: true, perPlayer: true } },
  { name: "columns, corridor side, Reveal by hand", d: COLUMNS, side: "corridor", see: { explore: false } },
  { name: "columns, room side, Reveal by hand", d: COLUMNS, side: "room", see: { explore: false } },
];

describe("a hex dungeon's secret leaf, as players get it (phase 3, 6)", () => {
  test("every frame and layer is the same with the hidden leaf as with a plain wall, or with no secret room behind it", async (t) => {
    let compared = 0;
    for (const [i, c] of CASES.entries()) {
      const counts = { compared: 0, leafHeld: 0 };
      await twinRun(t, c, i * 10 + 1, 24, counts);
      // Not vacuous: each case compares with a device holding the leaf, shown as a wall.
      assert.ok(counts.leafHeld > 0, `${c.name}: compared while a device holds the leaf ${counts.leafHeld} times`);
      compared += counts.compared;
    }
    assert.ok(compared > 300, `compared ${compared}`);
  });

  test("a leaf written as a plain door tells the twins apart, so the comparison sees what the hidden leaf hides", async (t) => {
    for (const c of [CASES[0]!, CASES[3]!]) {
      const counts = { compared: 0, leafHeld: 0, differ: false };
      await twinRun(t, c, 7, 6, counts, true);
      assert.equal(counts.differ, true, c.name);
    }
  });

  test("found, the leaf reaches the party as the door it is, so the twins could tell it from a wall", async (t) => {
    clearVisionCache();
    const d = ROWS;
    const ops = onS1(d);
    const see = { explore: true };
    const pair: [Twin, Twin] = [await open(t, landed(d, ops, see, d.secret.outside)), await open(t, landed(d, leafAsWall(ops, d), see, d.secret.outside))];
    const leafChunk = Object.values(pair[0].h.actor.committed.state.buildChunks).find((c) => c?.walls?.some((w) => w.id === d.secret.leaf))!;
    await pair[0].dm.send({ t: "door.set", sceneId: S, door: { cx: leafChunk.cx, cy: leafChunk.cy, id: d.secret.leaf }, state: "closed", found: true });
    const view = (catchUp(pair[0].devices.get("p1")!), pair[0].devices.get("p1")!.view);
    const shown = Object.values(view?.buildChunks ?? {}).flatMap((c) => (c as { walls?: { id: string; f: { kind: string; discovered?: boolean } }[] }).walls ?? []).find((w) => w.id === d.secret.leaf);
    assert.deepEqual(shown?.f, { kind: "door", state: "closed", secret: true, discovered: true }, "found, it is the door");
  });
});

describe("a hex dungeon's way in (phase 3, 2.3, D-261110-230)", () => {
  test("from each of its edge hexes, on rows and on columns, the party sees no hex outside the dungeon's floor", () => {
    for (const d of [ROWS, COLUMNS]) {
      assert.ok(d.wayIn.length >= 1, `${d.name}: a way in`);
      const g = gridOfShape(d.grid) as HexGrid;
      const floor = new Set(d.floor);
      for (const start of d.wayIn) {
        clearVisionCache();
        // Every door open, a secret one too, so sight runs as far through the dungeon as it ever can.
        const opened = onS1(d).map((op) => (op.t === "build.walls" ? { ...op, put: (op.put ?? []).map((w) => (w.f.kind === "door" ? { ...w, f: { kind: "door" as const, state: "open" as const, secret: false, discovered: false } } : w)) } : op));
        const state = landed(d, opened, { explore: true }, start);
        const sight = visionRules.partySight(state, S);
        const bounds = state.scenes[S]!.bounds;
        let seenFloor = 0;
        for (let row = 0; row < 120; row++) {
          for (let col = 0; col < 120; col++) {
            if (!hexInScene(g, bounds, { col, row })) continue;
            const key = `${col},${row}`;
            const probe = { size: "medium" as const, ...onHex(g, key) };
            if (!sight.seesToken(probe, g)) continue;
            assert.ok(floor.has(key), `${d.name}: from ${start} the party sees ${key}, outside the dungeon`);
            seenFloor++;
          }
        }
        assert.ok(seenFloor > 10, `${d.name}: not vacuous, from ${start} the party sees into the dungeon (${seenFloor} hexes)`);
      }
    }
  });
});
