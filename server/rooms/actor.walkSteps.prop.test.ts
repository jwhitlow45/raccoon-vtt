import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { twins } from "#shared/secretDoorTestutil.ts";
import { int, pick, rng, token, trap } from "#shared/testutil.ts";
import type { ActorDeps } from "./actor.ts";
import { ScopeClient, StoredRoomDb, storedActor } from "./undoScopeTesting.ts";

/*
 * The steps before a walk run only for some walks (RoomActor
 * #walkNeedsSteps). Over random traps, DM answers before the walk in its
 * tick, and walks with routes, round trips among them, the walk ends the
 * same as in a build that commits the batch before every walk
 * (`walkCloses`), whose walks always read the sight the batch left: so
 * wherever the trap step read stop ground between a walk's ends, the steps
 * had run.
 */

const NOW = Date.parse("2026-11-10T20:00:00.000Z");
const SEEDS = 60;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
type Ev = Extract<ServerMessage, { t: "ev" }>;

type Scenario = { room: RoomState; answer: unknown; walk: { t: "token.move"; tokenId: "a"; x: number; y: number; route: Array<[number, number, number, 0]> } };

/** The party's room, its corridor and the passage past the door, each cell a walk may reach. */
const FLOOR = [
  ...Array.from({ length: 8 * 8 }, (_, i) => ({ x: 2 + (i % 8), y: 2 + Math.floor(i / 8) })),
  ...Array.from({ length: 9 }, (_, i) => ({ x: 10 + i, y: 5 })),
  ...Array.from({ length: 7 * 7 }, (_, i) => ({ x: 19 + (i % 7), y: 3 + Math.floor(i / 7) })),
];

function scenario(seed: number): Scenario {
  const r = rng(seed);
  const room = twins({ cover: "auto", explore: true }).door;
  room.tokens.m = token("m", { kind: "monster", name: "Lurker", visibility: "dm", x: int(r, 2, 9), y: int(r, 2, 9) });
  // Half the party waits at the corridor's end by the door, half in its room.
  if (r() < 0.5) {
    room.tokens.a = { ...room.tokens.a!, x: 15, y: 5 };
    room.tokens.b = { ...room.tokens.b!, x: 14, y: 5 };
  }
  // Where the DM takes Bree, whose sight the party shares: the walk goes that way, onto ground she may have just seen.
  const bree = r() < 0.5 ? pick(r, FLOOR.filter((c) => c.x >= 17)) : pick(r, FLOOR);
  const nearBree = FLOOR.filter((c) => Math.abs(c.x - bree.x) <= 3 && Math.abs(c.y - bree.y) <= 3);
  room.traps = {};
  for (let k = 0; k < int(r, 1, 3); k++) {
    const at = pick(r, nearBree);
    room.traps[`t${k}`] = trap(`t${k}`, { sceneId: "s1", name: "Pit", zone: { cells: [{ x: at.x, y: at.y, w: int(r, 1, 2), h: 1 }] } });
  }
  const answers: unknown[] = [
    { t: "token.move", tokenId: "b", x: bree.x, y: bree.y },
    { t: "door.set", sceneId: "s1", door: { edge: "16,5,w" }, state: "open" },
    { t: "door.set", sceneId: "s1", door: { edge: "16,5,w" }, state: "open" },
    { t: "token.move", tokenId: "m", x: int(r, 2, 9), y: int(r, 2, 9) },
    { t: "log.chat", text: "a DM line" },
  ];
  const answer = pick(r, answers);
  const start = { x: room.tokens.a!.x, y: room.tokens.a!.y };
  const via = pick(r, nearBree);
  // A round trip out to a cell and back, or a walk to a cell through another.
  const back = r() < 0.4;
  const end = back ? start : pick(r, FLOOR);
  const route: Array<[number, number, number, 0]> = [
    [via.x, via.y, 0, 0],
    [end.x, end.y, 0, 0],
  ];
  return { room, answer, walk: { t: "token.move", tokenId: "a", x: end.x, y: end.y, route } };
}

async function run(t: TestContext, s: Scenario, options: ActorDeps["options"]) {
  const db = new StoredRoomDb(structuredClone(s.room));
  const h = await storedActor(t, db, { batchMs: 20, now: () => NOW, ...options }, quiet);
  const dm = await ScopeClient.open(h.actor, s.room.members.dm1!, "dm", () => NOW);
  const p1 = await ScopeClient.open(h.actor, s.room.members.p1!, "player", () => NOW);
  // Explored as it loaded, so the steps start from the room's own ground.
  await dm.apply({ t: "log.chat", text: "ready" });
  // One turn of the queue: the DM's answer, then the walk, in one batch.
  void h.actor.op(dm.conn, ++dm.n, s.answer);
  const n = ++p1.n;
  void h.actor.op(p1.conn, n, s.walk);
  const ev = await waitFor(() => p1.sent.find((m): m is Ev => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((x) => x.n === n))));
  const state = h.actor.committed.state;
  const a = state.tokens.a;
  await h.actor.shutdown({ code: 1012, snapshot: false });
  return {
    answer: ev.rejects?.find((x) => x.n === n)?.code ?? "taken",
    a: a === undefined ? null : [a.x, a.y, a.elevation ?? 0],
    traps: Object.fromEntries(Object.values(state.traps ?? {}).map((x) => [x.id, [x.state, x.found]])),
  };
}

async function waitFor<T>(get: () => T | undefined): Promise<T> {
  for (let i = 0; i < 2_000; i++) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("no answer");
}

test(`over ${SEEDS} random walks, a walk ends as it does where the batch commits before it`, async (t) => {
  let stops = 0;
  let trips = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = scenario(seed);
    const steps = await run(t, s, { walkCloses: false });
    const closes = await run(t, s, { walkCloses: true });
    assert.deepEqual(steps, closes, `seed ${seed}: ${JSON.stringify(s.answer)} then ${JSON.stringify(s.walk)}`);
    if (closes.answer === "taken" && (closes.a?.[0] !== s.walk.x || closes.a?.[1] !== s.walk.y)) stops++;
    if (s.walk.x === s.room.tokens.a!.x && s.walk.y === s.room.tokens.a!.y) trips++;
  }
  // The walks reached what the property is about: stops on the way, and round trips.
  assert.ok(stops >= 5, `${stops} walks stopped short`);
  assert.ok(trips >= 10, `${trips} round trips`);
});
