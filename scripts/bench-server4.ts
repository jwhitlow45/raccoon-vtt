/**
 * The wave 4 server rows of the performance gate (docs/design-v1-maps-vision.md
 * section 4.3.6), end to end through the room actor at the caps: each row is
 * one op as a socket sends it, timed from its arrival until the last socket
 * in the room has been sent its `ev`. That covers permissions with the
 * movement test, the reducer and its "seen" marks, the limits step with the
 * split's counting pass and the sight piece cap, the size guard with both
 * reserves, the explore step, the commit (against a database that answers at
 * once, so no I/O is timed) and the fan-out with its narrow sight diff, to a
 * DM and six players.
 *
 * The scenes are part 4C's (scripts/bench-vision.ts `capRoom`): a 200 x 200
 * dungeon at 6,000 potential sight pieces with crossing free walls, pillars
 * and raised areas, 12 party sources with 150 ft darkvision, and 100 free
 * lights plus 20 lit token lights at the radius caps, bright and dark. The
 * walls stop players' moves there, so a player's move runs the leg test.
 * The dark scene runs again at 1 ft per cell, the finest grid the room
 * settings allow, where each light and sense covers the most cells it may
 * (LIMITS.lightRadiusMaxCells and senseMaxCells).
 *
 * Each row's time includes everything around it, so it is held to the row's
 * own budget: a row that fits end to end fits alone. The fan-out row is the
 * time from the commit to the last `ev` of a source's move. Run it alone,
 * with nothing else busy, on the machine being gated:
 *
 *   node scripts/bench-server4.ts            (a laptop: budgets over 1.5, the reference server's ratio on this bench)
 *   node scripts/bench-server4.ts --server   (the server box itself: budgets as they are)
 *
 * Then the bright and dark scenes again per player
 * (docs/design-v1-per-player-vision.md 8.1), with the six players as the
 * scene's sight holders at the worst ownership the cap allows, and a routed
 * walk across areas during a turn on each kind of scene.
 *
 * The phone rows (the derive on a phone, applying sight tiles, the leg test
 * while dragging) run in a browser and are not here. A row over its budget
 * means a cap comes down (section 4.3.6), not that this file changes.
 */
import { holderTileKey, tileKey } from "../shared/keys.ts";
import { SNAPSHOT_VERSION } from "../shared/migrate.ts";
import { DEFAULT_SETTINGS, type EdgeFeature, type Member, type RoomState, type Token } from "../shared/model.ts";
import type { Op } from "../shared/protocol.ts";
import { encodeTile } from "../shared/rules/fog.ts";
import { clearVisionCache } from "../shared/rules/vision.ts";
import { RoomActor, type ActorDeps } from "../server/rooms/actor.ts";
import { SnapshotBudget } from "../server/rooms/budgets.ts";
import { Connection } from "../server/rooms/connection.ts";
import type { RoomGateway } from "../server/rooms/gateway.ts";
import type { Pool } from "../server/rooms/persistence.ts";
import { capRoom } from "./bench-vision.ts";

const SCENE = "bench";
const PLAYERS = 6;
const RUNS = 15;

// The actor logs an explore op it could not store as an error, which would make every row below meaningless.
const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: (...args: unknown[]) => {
    console.error(...args);
    process.exitCode = 1;
  },
  debug: () => undefined,
};

/** The room's members: the DM and six players, each owning two of the party's twelve characters. */
function members(): Record<string, Member> {
  const out: Record<string, Member> = { dm: { id: "dm", rev: 0, name: "DM", color: "#ff0000", kind: "dm", createdAt: "2026-10-14T00:00:00.000Z" } };
  for (let i = 1; i <= PLAYERS; i++) out[`p${i}`] = { id: `p${i}`, rev: 0, name: `Player ${i}`, color: "#00ff00", kind: "player", createdAt: "2026-10-14T00:00:00.000Z" };
  return out;
}

/*
 * Part 4C's room at the caps as a whole stored state, with walls that stop
 * players' moves, at a grid scale. Per player (docs/design-v1-per-player-vision.md
 * 8.1), at the worst ownership the cap allows: the scene is per player, the
 * six players are its sight holders, and player k owns every character but
 * the k-th, so no two share a raster. The fog projection then has each
 * holder's own layer and the party's over the whole scene, and labels and
 * stamps on it, to read.
 */
function benchRoom(level: "bright" | "dark", feetPerCell: number, perPlayer = false): RoomState {
  const cap = capRoom(level).state;
  const tokens: Record<string, Token> = {};
  const players = Array.from({ length: PLAYERS }, (_, i) => `p${i + 1}`);
  for (const t of Object.values(cap.tokens)) {
    const k = t.kind === "pc" ? Number(t.id.slice(2)) : -1;
    tokens[t.id] = k < 0 ? t : { ...t, ownerIds: perPlayer ? players.filter((_, i) => i !== k) : [`p${(k % PLAYERS) + 1}`] };
  }
  const base = { ...cap.scenes[SCENE]!, blockMovement: true };
  const scene = perPlayer ? { ...base, vision: { ...base.vision!, perPlayer: true as const } } : base;
  const layers = perPlayer ? perPlayerLayers(players) : { holders: {}, exploredBy: {}, exploredTiles: {}, labels: {}, stamps: {} };
  return {
    meta: { name: "Bench", settings: { ...DEFAULT_SETTINGS, feetPerCell }, playerSceneId: SCENE, view: { follow: false, blackout: false } },
    members: members(),
    scenes: { [SCENE]: scene },
    buildChunks: cap.buildChunks,
    labels: layers.labels,
    fogTiles: {},
    fogDrafts: {},
    tokens,
    characters: {},
    templates: {},
    drawings: {},
    encounter: null,
    encounterHistory: [],
    handouts: {},
    log: [],
    monsters: {},
    srdImages: {},
    savedEncounters: {},
    stamps: layers.stamps,
    lights: cap.lights,
    exploredTiles: layers.exploredTiles,
    holders: layers.holders,
    exploredBy: layers.exploredBy,
    journal: {},
    pins: {},
    rolls: {},
    handoutDocs: {},
    companionBlocks: {},
    casts: {},
    traps: {},
    trapLog: [],
    trapSeen: [],
  };
}

/** Every tile of the scene explored in a random pattern, for the party and for each holder, and 150 labels and 150 stamps about it. */
function perPlayerLayers(players: readonly string[]): Pick<RoomState, "holders" | "exploredBy" | "exploredTiles" | "labels" | "stamps"> {
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const bits = () => encodeTile(Uint8Array.from({ length: 512 }, () => (rand() < 0.5 ? 0xff : Math.floor(rand() * 256))));
  const across = Math.ceil(200 / 16);
  const exploredTiles: RoomState["exploredTiles"] = {};
  const exploredBy: RoomState["exploredBy"] = {};
  for (let ty = 0; ty < across; ty++) {
    for (let tx = 0; tx < across; tx++) {
      exploredTiles[tileKey(SCENE, tx, ty)] = { sceneId: SCENE, tx, ty, rev: 0, bits: bits() };
      for (const id of players) exploredBy[holderTileKey(SCENE, id, tx, ty)] = { sceneId: SCENE, memberId: id, tx, ty, rev: 0, bits: bits() };
    }
  }
  const labels: RoomState["labels"] = {};
  const stamps: RoomState["stamps"] = {};
  for (let k = 0; k < 150; k++) {
    labels[`lab${k}`] = { id: `lab${k}`, rev: 0, sceneId: SCENE, x: rand() * 200, y: rand() * 200, text: `Room ${k}`, size: 1 };
    stamps[`st${k}`] = { id: `st${k}`, rev: 0, sceneId: SCENE, art: { key: "barrel" }, x: rand() * 200, y: rand() * 200, w: 1, h: 1, rotation: 0, z: k, visibility: "all" };
  }
  return { holders: { [SCENE]: { sceneId: SCENE, rev: 0, entries: players.map((memberId) => ({ memberId, on: true })) } }, exploredBy, exploredTiles, labels, stamps };
}

/**
 * A database that answers every statement at once from memory: the snapshot
 * to load, no op rows, the DM's grant, and success for every write. `commitAt`
 * is when the last batch's COMMIT ran.
 */
function memoryPool(state: RoomState, at: { commitAt: number }): Pool {
  const run = (sql: string): Promise<{ rows: unknown[]; rowCount?: number }> =>
    Promise.resolve().then(() => {
      const s = sql.trim();
      if (s.includes("from room_snapshots")) return { rows: [{ seq: "0", state, schema_version: SNAPSHOT_VERSION }] };
      if (s.includes("from grants")) return { rows: [{ member_id: "dm" }] };
      if (s === "commit") at.commitAt = performance.now();
      return { rows: [], rowCount: 0 };
    });
  return { query: run, connect: () => Promise.resolve({ query: run, release: () => undefined }) } as unknown as Pool;
}

type Table = {
  actor: RoomActor;
  dm: Connection;
  players: Connection[];
  /** When anything was last sent to any socket, and the last message to the socket that sent the op being timed. */
  sent: { last: number; sender: Connection | null; senderText: string };
  db: { commitAt: number };
  n: Map<Connection, number>;
};

type SitDownTimes = { load: number[]; first: number[]; later: number[] };

/** Loads the room and connects the DM and the players, each with its snapshot, as a table sitting down. */
async function sitDown(state: RoomState, times?: SitDownTimes): Promise<Table> {
  const t0 = performance.now();
  const db = { commitAt: 0 };
  const deps: ActorDeps = {
    pool: memoryPool(state, db),
    info: { roomId: "BENCH000", pinned: true, createdIp: null, readOnly: false },
    log: quiet,
    budget: new SnapshotBudget(),
    gateway: {} as RoomGateway,
    // One op per batch, committed at once: every row is one op's whole trip, with no batching wait.
    options: { maxBatchOps: 1, batchMs: 1, roomOpsPerSec: 10_000, snapshotOps: 1_000_000, snapshotIdleMs: 3_600_000, grantRecheckMs: 3_600_000 },
  };
  const actor = await RoomActor.load(deps);
  if (!actor) throw new Error("the bench room did not load");
  times?.load.push(performance.now() - t0);
  const sent: Table["sent"] = { last: 0, sender: null, senderText: "" };
  const open = (memberId: string, role: "dm" | "player"): Connection => {
    let conn: Connection | null = null;
    const socket = {
      readyState: 1,
      OPEN: 1,
      CONNECTING: 0,
      send: (text: string) => {
        sent.last = performance.now();
        if (conn === sent.sender) sent.senderText = text;
      },
      close: () => undefined,
      terminate: () => undefined,
    };
    conn = new Connection(socket as never, { sessionId: `00000000-0000-4000-8000-${memberId.padStart(12, "0")}`, roomId: "BENCH000", memberId, role }, "203.0.113.7", { now: fastClock });
    actor.attach(conn);
    return conn;
  };
  const dm = open("dm", "dm");
  dm.sceneId = SCENE;
  const players = Array.from({ length: PLAYERS }, (_, i) => open(`p${i + 1}`, "player"));
  const table: Table = { actor, dm, players, sent, db, n: new Map() };
  for (const [i, conn] of [dm, ...players].entries()) {
    const start = performance.now();
    await actor.hello(conn, { clientId: "bench", resumeFrom: 1, sceneId: SCENE });
    await settle();
    (i === 0 ? times?.first : times?.later)?.push(sent.last - start);
  }
  return table;
}

/*
 * A socket's op budget allows 20 ops a second, and the bench sends hundreds
 * back to back. A clock a thousand times faster refills it, so no op waits
 * for the budget or is turned away as busy.
 */
const fastClock = () => performance.now() * 1000;

/** Lets every pending promise run: the in-memory database answers within the microtasks before this. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type Timing = { total: number; fanout: number };

/** Sends one op from `conn` and times it to the last `ev` any socket was sent, and from the commit to that `ev`. */
async function send(table: Table, conn: Connection, op: Op, refusalOk = false): Promise<Timing> {
  const n = (table.n.get(conn) ?? 0) + 1;
  table.n.set(conn, n);
  table.sent.sender = conn;
  const t0 = performance.now();
  table.db.commitAt = 0;
  await table.actor.op(conn, n, op);
  // An op that applied commits at once (one op per batch). A refusal changes nothing and waits for the batch timer,
  // so its time is the actor's work on it, which is over when `op` returns.
  const worked = performance.now() - t0;
  await settle();
  const answered = () => {
    const answer = JSON.parse(table.sent.senderText) as { t: string; acks?: number[]; rejects?: { n: number; message: string }[] };
    return answer.t === "ev" && (answer.acks?.includes(n) || answer.rejects?.some((r) => r.n === n)) ? answer : null;
  };
  let answer = answered();
  if (!answer) {
    for (let wait = 0; wait < 100 && !answer; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      answer = answered();
    }
    if (!answer) throw new Error(`${op.t} got no answer`);
  }
  const refused = answer.rejects?.find((r) => r.n === n);
  if (refused && !refusalOk) throw new Error(`${op.t} was refused: ${refused.message}`);
  if (!refused && refusalOk) throw new Error(`${op.t} was meant to be refused`);
  if (refused) return { total: worked, fanout: 0 };
  return { total: table.sent.last - t0, fanout: table.db.commitAt > 0 ? table.sent.last - table.db.commitAt : 0 };
}

type Ms = { median: number; max: number };
type Row = { row: string; budget: number; ms: Ms; covers: string };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

/** Runs `step` two times to warm up and then RUNS times, keeping both timings of each timed run. */
async function timed(step: (run: number) => Promise<Timing>): Promise<{ total: Ms; fanout: Ms }> {
  const totals: number[] = [];
  const fanouts: number[] = [];
  for (let r = 0; r < RUNS + 2; r++) {
    const t = await step(r);
    if (r < 2) continue;
    totals.push(t.total);
    fanouts.push(t.fanout);
  }
  return { total: stats(totals), fanout: stats(fanouts) };
}

let jiggles = 0;

/** Moves the last character to a spot of a 7 x 7 block in the hall it has not stood on lately, untimed. */
async function jiggle(table: Table): Promise<void> {
  const k = jiggles++;
  const t = table.actor.committed.state.tokens.pc11!;
  await send(table, table.dm, { t: "token.move", tokenId: t.id, x: 120 + (k % 7), y: 114 + (Math.floor(k / 7) % 7) });
}

/** Puts the party back as it began between rows, untimed: every character alive and seeing, and none placed. */
async function everyoneUp(table: Table): Promise<void> {
  const s = table.actor.committed.state;
  if (s.tokens.pc0a) await send(table, table.dm, { t: "token.delete", tokenId: "pc0a" });
  for (const t of pcs(s)) {
    const a = "inline" in t.actor ? t.actor.inline : null;
    if (a && a.life !== "alive") await send(table, table.dm, { t: "actor.life", target: { tokenId: t.id }, life: "alive" });
    if (a?.effects.some((e) => e.id === "blind")) await send(table, table.dm, { t: "actor.effect.remove", target: { tokenId: t.id }, effectId: "blind" });
  }
}

const pcs = (s: RoomState) => Object.values(s.tokens).filter((t) => t.kind === "pc" && t.id !== "pc0a");
const owner = (table: Table, t: Token) => table.players[Number(t.ownerIds[0]!.slice(1)) - 1]!;

/** How a per-player row names its scene. */
const PER_PLAYER = `per player with ${PLAYERS} holders`;

async function runLevel(level: "bright" | "dark", feetPerCell: number, rows: Row[], perPlayer = false): Promise<void> {
  clearVisionCache();
  // Every light, sense and box is the same number of cells at any scale of 5 ft or more, so only a finer one costs more.
  const scale = feetPerCell === 5 ? `${level} scene` : `${level} scene at ${feetPerCell} ft per cell`;
  const where = perPlayer ? `${scale}, ${PER_PLAYER}` : scale;
  const table = await sitDown(benchRoom(level, feetPerCell, perPlayer));
  const state = () => table.actor.committed.state;

  // A player moves a character one cell east and back, so each run is a new position for the cache.
  const move = await timed(async (r) => {
    const t = pcs(state())[r % 12]!;
    return send(table, owner(table, t), { t: "token.move", tokenId: t.id, x: t.x + (r % 24 < 12 ? 1 : -1), y: t.y });
  });
  rows.push({
    row: level === "bright" ? `One party source moved, ${where}` : `One source moved among lit lights, ${where}`,
    budget: level === "bright" ? 25 : 30,
    ms: move.total,
    covers: "a player's token.move, with the leg test, explore and the fan-out",
  });
  rows.push({
    row: `Sight fan-out for all players in one batch, ${where}`,
    budget: 10,
    ms: move.fanout,
    // Per player, the fan-out is the first to read each holder's tiles, so their rasters are drawn in it.
    covers: `commit to the last ev of that move, 7 sockets${perPlayer ? ", each holder's raster drawn" : ""}`,
  });

  if (level === "dark") {
    const lightOp = (kind: "added" | "moved" | "switched" | "removed", r: number): Op => {
      const ids = Object.keys(state().lights).sort();
      const l = state().lights[ids[(r * 7) % ids.length]!]!;
      const put = (x: number, on: boolean) => ({ id: l.id, x, y: l.y, bright: l.bright, dim: l.dim, on, walls: l.walls });
      if (kind === "added") return { t: "build.lights", sceneId: SCENE, put: [{ id: `new${r}`, x: 20 + r, y: 30 + r, bright: 120, dim: 120, on: true, walls: true }], remove: [l.id] };
      if (kind === "moved") return { t: "build.lights", sceneId: SCENE, put: [put(l.x + 1, l.on)] };
      if (kind === "switched") return { t: "build.lights", sceneId: SCENE, put: [put(l.x, !l.on)] };
      return { t: "build.lights", sceneId: SCENE, remove: [l.id] };
    };
    for (const kind of ["added", "moved", "switched", "removed"] as const) {
      const light = await timed((r) => send(table, table.dm, lightOp(kind, r)));
      rows.push({ row: `A light ${kind}, ${where}`, budget: 10, ms: light.total, covers: "the DM's build.lights" + (kind === "added" ? " (one in, one out, at the cap of 100)" : "") });
    }
    /*
     * A free light every source sees (docs/design-v1-per-player-vision.md
     * decision 15): in the gap west of the hall's dividing wall, which
     * lights both halves, in place of another so the scene stays at its
     * cap, then moved a cell a run.
     */
    const put = (y: number) => ({ id: "hall", x: 64.5, y, bright: 120, dim: 120, on: true, walls: true });
    await send(table, table.dm, { t: "build.lights", sceneId: SCENE, put: [put(100.5)], remove: [Object.keys(state().lights).sort()[0]!] });
    const hall = await timed((r) => send(table, table.dm, { t: "build.lights", sceneId: SCENE, put: [put(r % 2 === 0 ? 101.5 : 100.5)] }));
    rows.push({ row: `A free light every source sees moved, ${where}`, budget: 30, ms: hall.total, covers: "the DM's build.lights on a light in the hall" });
  }

  /*
   * Sources lost and back: Blinded, a death, and a character placed ahead of
   * the others in the cap's order. The vision cache keeps a scene's last two
   * computations, so an op that puts a source back would find the answer
   * from two ops before and time nothing: a far character steps first,
   * untimed, so every timed op meets a party it has not seen.
   */
  const blind = await timed(async (r) => {
    await jiggle(table);
    const target = { tokenId: pcs(state())[(r >> 1) % 11]!.id };
    return send(table, table.dm, r % 2 === 0 ? { t: "actor.effect.add", target, effect: { id: "blind", key: "blinded" } } : { t: "actor.effect.remove", target, effectId: "blind" });
  });
  rows.push({ row: `A source is Blinded or recovers, ${where}`, budget: 25, ms: blind.total, covers: "the DM's actor.effect.add or remove" });
  await everyoneUp(table);
  const dies = await timed(async (r) => {
    await jiggle(table);
    const target = { tokenId: pcs(state())[(r >> 1) % 11]!.id };
    return send(table, table.dm, { t: "actor.life", target, life: r % 2 === 0 ? "dead" : "alive" });
  });
  rows.push({ row: `A source dies or revives, ${where}`, budget: 25, ms: dies.total, covers: "the DM's actor.life" });
  await everyoneUp(table);
  const placed = await timed(async (r) => {
    await jiggle(table);
    if (r % 2 === 1) return send(table, table.dm, { t: "token.delete", tokenId: "pc0a" });
    const m = pcs(state())[1]!;
    // Without a light: the scene already carries the 20 lit token lights it may.
    const token = { id: "pc0a", sceneId: SCENE, kind: m.kind, name: "pc0a", size: m.size, x: m.x + 2, y: m.y, ownerIds: m.ownerIds, actor: m.actor };
    return send(table, table.dm, { t: "token.create", token });
  });
  rows.push({ row: `A source is placed or removed, ${where}`, budget: 25, ms: placed.total, covers: "the DM's token.create or delete of a character first in the cap's order" });
  await everyoneUp(table);

  // Doors: the hall's door every source sees, and a room's door none of them does (the derive alone).
  const door = (edge: string) => async (r: number) => {
    const [x, y] = edge.split(",").map(Number) as [number, number];
    const chunk = state().buildChunks[`${SCENE}:${Math.floor(x / 16)},${Math.floor(y / 16)}`]!;
    const now = chunk.edges[edge] as Extract<EdgeFeature, { kind: "door" }>;
    void r;
    return send(table, table.dm, { t: "door.set", sceneId: SCENE, door: { edge }, state: now.state === "open" ? "closed" : "open" });
  };
  const seen = await timed(door("100,100,n"));
  rows.push({ row: `A door every source sees, with the derive, ${where}`, budget: 250, ms: seen.total, covers: "the DM's door.set on the hall's door" });
  const unseen = await timed(door("20,9,w"));
  rows.push({ row: `Derive, split and index the wall set after a door no source sees, ${where}`, budget: 40, ms: unseen.total, covers: "the DM's door.set on a room's door" });

  // A wall the split's caps refuse: a free wall across the densest crossings, refused before any piece is built.
  const refusedWall = await timed((r) =>
    send(table, table.dm, { t: "build.walls", sceneId: SCENE, put: [{ id: `cross${r}`, a: [10, 10 + r], b: [17.5, 10 + r], f: { kind: "wall" } }] }, true),
  );
  rows.push({ row: `The split's counting pass on a refused op, ${where}`, budget: 15, ms: refusedWall.total, covers: "the DM's build.walls past the sight piece cap" });

  const group = await timed(async (r) => {
    const dx = r % 24 < 12 ? 1 : -1;
    return send(table, table.dm, { t: "token.moveMany", moves: pcs(state()).map((t) => ({ tokenId: t.id, x: t.x + dx, y: t.y })) });
  });
  rows.push({ row: `A group move of every source, ${where}`, budget: 250, ms: group.total, covers: "the DM's token.moveMany of the 12 characters" });

  // The light level switched, and vision turned on, each re-projecting the room for every socket.
  if (level === "dark") {
    const levels = ["dim", "bright", "dark"] as const;
    const kept = await timed(async (r) => {
      await jiggle(table);
      return send(table, table.dm, { t: "scene.update", sceneId: SCENE, patch: { vision: { on: true, light: levels[r % 3]! } } });
    });
    rows.push({ row: `Sight on a light level switch, the sources' polygons kept, ${where}`, budget: 250, ms: kept.total, covers: "the DM's scene.update, global: every socket re-projected" });
    const cold = await timed(async (r) => {
      clearVisionCache();
      return send(table, table.dm, { t: "scene.update", sceneId: SCENE, patch: { vision: { on: true, light: levels[r % 3]! } } });
    });
    rows.push({ row: `Cold sight on a light level switch, computed from nothing, ${where}`, budget: 250, ms: cold.total, covers: "the same, with the vision cache emptied first" });
    await send(table, table.dm, { t: "scene.update", sceneId: SCENE, patch: { vision: { on: true, light: "dark" } } });
    const on = await timed(async () => {
      await send(table, table.dm, { t: "scene.update", sceneId: SCENE, patch: { vision: { on: false, light: "dark" } } });
      await jiggle(table);
      return send(table, table.dm, { t: "scene.update", sceneId: SCENE, patch: { vision: { on: true, light: "dark" } } });
    });
    rows.push({ row: `Sight on vision turned on, ${where}`, budget: 250, ms: on.total, covers: "the DM's scene.update, global" });
  }
  await table.actor.shutdown({ code: 1012, snapshot: false });

  /*
   * Cold: the room loaded from its snapshot, then each socket's snapshot.
   * Each is its own task on the event loop, so each is its own pause: the
   * load replays and derives nothing, and the first snapshot computes the
   * party's sight from nothing, walls derived and all.
   */
  const times: SitDownTimes = { load: [], first: [], later: [] };
  for (let r = 0; r < 5; r++) {
    clearVisionCache();
    const fresh = JSON.parse(JSON.stringify(benchRoom(level, feetPerCell))) as RoomState;
    const t = await sitDown(fresh, times);
    await t.actor.shutdown({ code: 1012, snapshot: false });
  }
  rows.push({ row: `Room load, ${where}`, budget: 250, ms: stats(times.load), covers: "the snapshot read and replay" });
  rows.push({ row: `Cold sight on room load: the first snapshot, ${where}`, budget: 250, ms: stats(times.first), covers: "the DM's snapshot: walls derived and sight computed from nothing" });
  rows.push({ row: `Each later snapshot, ${where}`, budget: 250, ms: stats(times.later), covers: "a player's snapshot with sight" });
}

/*
 * A routed walk across three areas that remind on entering, during the
 * walker's turn (docs/design-v1-per-player-vision.md 8.1): the reminders
 * judge who saw each crossing at its moment along the walk, which on a
 * per-player scene asks every holder's point query and draws no raster.
 * The DM walks the last character east through the areas and back.
 */
async function runWalk(perPlayer: boolean, rows: Row[]): Promise<void> {
  clearVisionCache();
  const room = benchRoom("dark", 5, perPlayer);
  room.encounter = { rev: 0, round: 1, activeEntryId: "e11", entries: [{ id: "e11", tokenId: "pc11", value: 15, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false, hadTurn: true }] };
  for (const [k, x] of [126, 130, 134].entries()) {
    room.templates[`area${k}`] = { id: `area${k}`, rev: 0, sceneId: SCENE, shape: "sphere", size: 10, origin: { x, y: 111, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff8800", ownerId: "dm", visibility: "all", triggers: ["enter"] };
  }
  const table = await sitDown(room);
  const walk = await timed(async () => {
    // A new turn first, untimed, since an area reminds about a creature once a turn.
    await send(table, table.dm, { t: "encounter.next" });
    const from = table.actor.committed.state.tokens.pc11!.x;
    const xs = from < 130 ? [124, 126, 128, 130, 132, 134, 136, 138] : [136, 134, 132, 130, 128, 126, 124, 122];
    const route = xs.map((x): [number, number, number, 0 | 1] => [x, 110, 0, 0]);
    return send(table, table.dm, { t: "token.move", tokenId: "pc11", x: xs[xs.length - 1]!, y: 110, route });
  });
  const reminded = table.actor.committed.state.log.filter((e) => e.data?.type === "area").length;
  if (reminded < 3 * RUNS) throw new Error(`the walks reminded ${reminded} times`);
  rows.push({ row: `A routed walk across three areas during its turn, dark scene${perPlayer ? `, ${PER_PLAYER}` : ""}`, budget: 30, ms: walk.total, covers: "the DM's token.move with a route, each crossing judged at its moment" });
  await table.actor.shutdown({ code: 1012, snapshot: false });
}

export async function runServerBench(): Promise<Row[]> {
  const rows: Row[] = [];
  await runLevel("bright", 5, rows);
  await runLevel("dark", 5, rows);
  // The finest scale the room settings allow, where each light and sense covers the most cells (and so the most walls).
  await runLevel("dark", 1, rows);
  await runWalk(false, rows);
  // The same per player, at the worst ownership the holder cap allows.
  await runLevel("bright", 5, rows, true);
  await runLevel("dark", 5, rows, true);
  await runWalk(true, rows);
  return rows;
}

export function formatServerBench(rows: Row[], onServer: boolean): string {
  // The reference server ran these rows at about 1.5 times an M1 laptop's times (the gate of 2026-10-14).
  const factor = onServer ? 1 : 1.5;
  const ms = (s: Ms) => `${s.median.toFixed(1)} / ${s.max.toFixed(1)}`;
  const lines = ["row | ms here (median / max) | budget | limit here | ok | what it runs", "--- | --- | --- | --- | --- | ---"];
  for (const r of rows) {
    const limit = r.budget / factor;
    lines.push(`${r.row} | ${ms(r.ms)} | ${r.budget} | ${limit.toFixed(1)} | ${r.ms.median <= limit ? "yes" : "NO"} | ${r.covers}`);
  }
  lines.push(
    "",
    `Times are median / max over ${RUNS} runs (5 for a room load), end to end through the actor. "limit here" is the budget${onServer ? "" : " over 1.5, the reference server's time to this laptop's"}, which the median must meet.`,
  );
  return lines.join("\n");
}

const argv = process.argv;
if (argv[1] && import.meta.url.endsWith(argv[1].replace(/^.*scripts\//, "scripts/"))) {
  console.log(formatServerBench(await runServerBench(), argv.includes("--server")));
}
