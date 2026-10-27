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
 *   node scripts/bench-server4.ts --discovery   (map discovery's rows alone, with or without --server)
 *   node scripts/bench-server4.ts --ask   (the builder's ask rows alone)
 *
 * Then the bright and dark scenes again per player
 * (docs/design-v1-per-player-vision.md 8.1), with the six players as the
 * scene's sight holders at the worst ownership the cap allows, a player's
 * move on each with fog off, a free light every source sees on a hall it
 * alone lights, and a routed walk across areas during a turn on each kind
 * of scene.
 *
 * Then map discovery's rows (docs/design-v1-map-discovery.md 7), whole
 * party and with the six holders, the scene played and explored: a build
 * edit in sight and one on remembered ground, a stair edit whose run passes
 * its direction chunks away, a move that explores a tile, a move and a
 * global batch with every layer's memory at its cap, and that room's first
 * snapshots. Then 4,000 free walls each cut into 5 pieces by the ground
 * players hold, on a Reveal by hand scene: a global batch and the first
 * snapshots.
 *
 * The phone rows (the derive on a phone, applying sight tiles, the leg test
 * while dragging) run in a browser and are not here. A row over its budget
 * means a cap comes down (section 4.3.6), not that this file changes.
 */
import { chunkKey, holderChunkKey, holderTileKey, tileKey, wallChunk } from "../shared/keys.ts";
import { SNAPSHOT_VERSION } from "../shared/migrate.ts";
import { DEFAULT_SETTINGS, FOG_SUBCELLS, type BuildChunk, type EdgeFeature, type FreeWall, type Member, type MemoryChunk, type RoomState, type TerrainId, type Token } from "../shared/model.ts";
import { MAX_ASK_OPS, type Op } from "../shared/protocol.ts";
import { uuidv7 } from "../shared/ids.ts";
import { encodeTile, fullTileBits, TILE_SUB } from "../shared/rules/fog.ts";
import { projectState } from "../shared/project.ts";
import { visionRules, type PartySight } from "../shared/ruleHooks.ts";
import { clearVisionCache } from "../shared/rules/vision.ts";
import { RoomActor, type ActorDeps } from "../server/rooms/actor.ts";
import { SnapshotBudget } from "../server/rooms/budgets.ts";
import { Connection } from "../server/rooms/connection.ts";
import type { RoomGateway } from "../server/rooms/gateway.ts";
import { chunkCharge, layerCharge, MEMORY_CAP } from "../server/rooms/memorySize.ts";
import type { Pool } from "../server/rooms/persistence.ts";
import { capRoom, lightReachesEveryHolder, lightScene } from "./bench-vision.ts";

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
/** The bench room at the caps, per player or not, and with `hallLitAlone` on bench-vision.ts `lightScene`'s scene. */
function benchRoom(level: "bright" | "dark", feetPerCell: number, perPlayer = false, hallLitAlone = false): RoomState {
  const cap = hallLitAlone ? lightScene(capRoom(level).state, false) : capRoom(level).state;
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

/** Throws unless the room is in the mode its rows name: per player with every player holding sight, or for the whole party with no holders. */
function checkMode(state: RoomState, perPlayer: boolean): void {
  const mode = state.scenes[SCENE]?.vision?.perPlayer === true;
  const on = state.holders[SCENE]?.entries.filter((e) => e.on).length ?? 0;
  if (mode !== perPlayer || on !== (perPlayer ? PLAYERS : 0)) throw new Error(`the bench room is ${mode ? "per player" : "for the whole party"} with ${on} holders`);
}

/** The commit and fan-out of the op being timed: when its batch's COMMIT ran, and how long holders' tiles took to read since. */
type Span = { commitAt: number; drawn: number };

/** The span of the table sitting at the bench, which the wrapped holder sight below adds to. */
let live: Span | null = null;

/*
 * Holders' rasters drawn, timed apart from the rest of the fan-out (PV3's
 * gate needs the two apart): per player, the fan-out is the first to read
 * each holder's tiles, so reading them there draws the rasters. Each read
 * after the commit adds its time to the span. One wrapper per sight keeps
 * a sight's identity across reads. Only a run wraps the hook, and it puts
 * the hook back after, so a file that imports this one is left as it was
 * (review PV2-BENCH-PROXY). Returns what puts it back.
 */
function timeHolderSight(): () => void {
  const wrapped = new WeakMap<PartySight, PartySight>();
  const holderSight = visionRules.holderSight;
  visionRules.holderSight = (state, sceneId, memberId) => {
    const sight = holderSight(state, sceneId, memberId);
    let timedSight = wrapped.get(sight);
    if (!timedSight) {
      timedSight = new Proxy(sight, {
        get(target, prop) {
          const start = performance.now();
          const value: unknown = Reflect.get(target, prop, target);
          if (prop === "tiles" && live && live.commitAt > 0) live.drawn += performance.now() - start;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      wrapped.set(sight, timedSight);
    }
    return timedSight;
  };
  return () => {
    visionRules.holderSight = holderSight;
  };
}

/**
 * A database that answers every statement at once from memory: the snapshot
 * to load, no op rows, the DM's grant, and success for every write. A COMMIT
 * starts the fan-out's span.
 */
function memoryPool(state: RoomState, at: Span): Pool {
  const run = (sql: string): Promise<{ rows: unknown[]; rowCount?: number }> =>
    Promise.resolve().then(() => {
      const s = sql.trim();
      if (s.includes("from room_snapshots")) return { rows: [{ seq: "0", state, schema_version: SNAPSHOT_VERSION }] };
      if (s.includes("from grants")) return { rows: [{ member_id: "dm" }] };
      if (s === "commit") {
        at.commitAt = performance.now();
        at.drawn = 0;
      }
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
  db: Span;
  n: Map<Connection, number>;
};

type SitDownTimes = { load: number[]; first: number[]; later: number[] };

/** Loads the room and connects the DM and the players, each with its snapshot, as a table sitting down. */
async function sitDown(state: RoomState, times?: SitDownTimes): Promise<Table> {
  const t0 = performance.now();
  const db: Span = { commitAt: 0, drawn: 0 };
  live = db;
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

type Timing = { total: number; fanout: number; drawn: number };

/** Sends one op from `conn` and times it to the last `ev` any socket was sent, from the commit to that `ev`, and the holders' rasters drawn in between. */
async function send(table: Table, conn: Connection, op: Op, refusalOk = false): Promise<Timing> {
  const n = (table.n.get(conn) ?? 0) + 1;
  table.n.set(conn, n);
  table.sent.sender = conn;
  const t0 = performance.now();
  table.db.commitAt = 0;
  table.db.drawn = 0;
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
  if (refused) return { total: worked, fanout: 0, drawn: 0 };
  return { total: table.sent.last - t0, fanout: table.db.commitAt > 0 ? table.sent.last - table.db.commitAt : 0, drawn: table.db.drawn };
}

type Ms = { median: number; max: number };
type Row = { row: string; budget: number; ms: Ms; covers: string };

function stats(times: number[]): Ms {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! };
}

/** Runs `step` two times to warm up and then RUNS times, keeping each timed run's timings, its fan-out split into the rasters drawn and the rest. */
async function timed(step: (run: number) => Promise<Timing>): Promise<{ total: Ms; fanout: Ms; drawn: Ms; rest: Ms }> {
  const totals: number[] = [];
  const fanouts: number[] = [];
  const drawn: number[] = [];
  const rest: number[] = [];
  for (let r = 0; r < RUNS + 2; r++) {
    const t = await step(r);
    if (r < 2) continue;
    totals.push(t.total);
    fanouts.push(t.fanout);
    drawn.push(t.drawn);
    rest.push(t.fanout - t.drawn);
  }
  return { total: stats(totals), fanout: stats(fanouts), drawn: stats(drawn), rest: stats(rest) };
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
  checkMode(table.actor.committed.state, perPlayer);
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
    covers: `commit to the last ev of that move, 7 sockets${perPlayer ? ", each holder's raster drawn" : ""}: the gate reads its 10 ms budget on the server box and 6.7 ms (10 over 1.5) on a laptop`,
  });
  if (perPlayer) {
    const part = "a part of the fan-out row above, which the gate reads, shown against the same limit";
    rows.push({ row: `Holders' rasters drawn in that fan-out, ${where}`, budget: 10, ms: move.drawn, covers: `${part}: each holder's tiles read the first time` });
    rows.push({ row: `The rest of that fan-out, ${where}`, budget: 10, ms: move.rest, covers: `${part}: the per-player projection, its sight diffs and the sends` });
  }

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
    const fresh = JSON.parse(JSON.stringify(benchRoom(level, feetPerCell, perPlayer))) as RoomState;
    const t = await sitDown(fresh, times);
    checkMode(t.actor.committed.state, perPlayer);
    await t.actor.shutdown({ code: 1012, snapshot: false });
  }
  rows.push({ row: `Room load, ${where}`, budget: 250, ms: stats(times.load), covers: "the snapshot read and replay" });
  rows.push({ row: `Cold sight on room load: the first snapshot, ${where}`, budget: 250, ms: stats(times.first), covers: "the DM's snapshot: walls derived and sight computed from nothing" });
  rows.push({ row: `Each later snapshot, ${where}`, budget: 250, ms: stats(times.later), covers: "a player's snapshot with sight" });
}

/*
 * A player's move on a per-player scene with fog off, where the explore
 * step writes nothing and still draws every holder's raster before the
 * commit (review PV3-OPUS-4), so its fan-out is the gate's to read too.
 */
async function runFogOff(level: "bright" | "dark", rows: Row[]): Promise<void> {
  clearVisionCache();
  const room = benchRoom(level, 5, true);
  room.scenes[SCENE] = { ...room.scenes[SCENE]!, fogEnabled: false };
  const table = await sitDown(room);
  checkMode(table.actor.committed.state, true);
  const state = () => table.actor.committed.state;
  const move = await timed(async (r) => {
    const t = pcs(state())[r % 12]!;
    return send(table, owner(table, t), { t: "token.move", tokenId: t.id, x: t.x + (r % 24 < 12 ? 1 : -1), y: t.y });
  });
  const where = `${level} scene, ${PER_PLAYER}, fog off`;
  rows.push({ row: `Sight fan-out for all players in one batch, ${where}`, budget: 10, ms: move.fanout, covers: "commit to the last ev of a player's token.move, 7 sockets: the gate reads its 10 ms budget on the server box and 6.7 ms (10 over 1.5) on a laptop" });
  rows.push({ row: `Holders' rasters drawn in that fan-out, ${where}`, budget: 10, ms: move.drawn, covers: "a part of the fan-out row above, shown against the same limit: each holder's tiles read the first time" });
  await table.actor.shutdown({ code: 1012, snapshot: false });
}

/*
 * A free light every source sees (docs/design-v1-per-player-vision.md
 * decision 15), on bench-vision.ts `lightScene`'s scene: the characters
 * carry no light and the hall's free lights stand outside it, so the hall's
 * light alone gives the hall its levels, and its move changes tiles of the
 * union and of every holder's raster (checked before the timed runs). It
 * goes in the gap west of the hall's dividing wall, in place of another so
 * the scene stays at its cap, then moves half a cell a run through eight
 * spots, so no timed run meets a state the vision cache still holds.
 */
async function runFreeLight(feetPerCell: number, perPlayer: boolean, rows: Row[]): Promise<void> {
  clearVisionCache();
  const scale = feetPerCell === 5 ? "dark scene" : `dark scene at ${feetPerCell} ft per cell`;
  const table = await sitDown(benchRoom("dark", feetPerCell, perPlayer, true));
  checkMode(table.actor.committed.state, perPlayer);
  const put = (spot: number) => ({ id: "hall", x: 64.5, y: 98.5 + (spot % 8) / 2, bright: 120, dim: 120, on: true, walls: true });
  await send(table, table.dm, { t: "build.lights", sceneId: SCENE, put: [put(0)], remove: [Object.keys(table.actor.committed.state.lights).sort()[0]!] });
  lightReachesEveryHolder(table.actor.committed.state, perPlayer ? table.players.map((p) => p.memberId) : []);
  clearVisionCache();
  const hall = await timed((r) => send(table, table.dm, { t: "build.lights", sceneId: SCENE, put: [put(r + 1)] }));
  rows.push({ row: `A free light every source sees moved, ${scale}, hall lit by it alone${perPlayer ? `, ${PER_PLAYER}` : ""}`, budget: 30, ms: hall.total, covers: "the DM's build.lights on the hall's light" });
  await table.actor.shutdown({ code: 1012, snapshot: false });
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
  checkMode(table.actor.committed.state, perPlayer);
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

/*
 * Map discovery (docs/design-v1-map-discovery.md 7). The bench room with its
 * scene played, every tile explored for the whole party (per player,
 * perPlayerLayers' random half of each layer), and when `full` every
 * layer's memory, the party's and each holder's, within one chunk of its
 * 64 KiB cap, on chunks away from the hall the party sees.
 */
function remembering(perPlayer: boolean, full: boolean): RoomState {
  const state: RoomState = { ...benchRoom("dark", 5, perPlayer), memory: {}, memoryBy: {}, playedScenes: { [SCENE]: { sceneId: SCENE, rev: 0 } }, memoryShared: {} };
  if (!perPlayer) {
    const bits = encodeTile(fullTileBits());
    const explored: RoomState["exploredTiles"] = {};
    for (let ty = 0; ty < 13; ty++) for (let tx = 0; tx < 13; tx++) explored[tileKey(SCENE, tx, ty)] = { sceneId: SCENE, tx, ty, rev: 0, bits };
    state.exploredTiles = explored;
  }
  if (full) {
    const scene = state.scenes[SCENE]!;
    const layers = perPlayer ? [null, ...Array.from({ length: PLAYERS }, (_, i) => `p${i + 1}`)] : [null];
    for (const layer of layers) {
      let charge = 0;
      fill: for (let cy = 0; cy < 13; cy++) {
        for (let cx = 0; cx < 13; cx++) {
          if (cx >= 3 && cx <= 9 && cy >= 4 && cy <= 8) continue;
          const cells: Record<string, TerrainId> = {};
          for (let k = 0; k < 256; k++) cells[`${cx * 16 + (k % 16)},${cy * 16 + (k >> 4)}`] = "wood";
          const chunk: MemoryChunk = { sceneId: SCENE, cx, cy, rev: 0, cells, ...(layer === null ? {} : { memberId: layer }) };
          const bytes = chunkCharge(scene, chunk);
          if (charge + bytes > MEMORY_CAP) break fill;
          charge += bytes;
          if (layer === null) state.memory![chunkKey(SCENE, cx, cy)] = chunk;
          else state.memoryBy![holderChunkKey(SCENE, layer, cx, cy)] = chunk;
        }
      }
      const held = layerCharge(state, scene, layer);
      if (held > MEMORY_CAP || held < MEMORY_CAP - 8_192) throw new Error(`layer ${layer ?? "party"} holds ${held} bytes of memory`);
    }
  }
  return state;
}

/** Throws unless the party's explored layer, or each holder's, holds sub-cells of the tile. */
function exploredAt(state: RoomState, tx: number, ty: number, perPlayer: boolean): boolean {
  if (!perPlayer) return state.exploredTiles[tileKey(SCENE, tx, ty)] !== undefined;
  return Array.from({ length: PLAYERS }, (_, i) => state.exploredBy[holderTileKey(SCENE, `p${i + 1}`, tx, ty)]).some((t) => t !== undefined);
}

async function runDiscovery(perPlayer: boolean, rows: Row[]): Promise<void> {
  clearVisionCache();
  const where = perPlayer ? `dark scene, ${PER_PLAYER}` : "dark scene";
  const table = await sitDown(remembering(perPlayer, false));
  checkMode(table.actor.committed.state, perPlayer);
  const state = () => table.actor.committed.state;
  const memoryEntries = () => Object.values({ ...state().memory, ...state().memoryBy }).reduce((n, c) => n + Object.keys(c.cells ?? {}).length + Object.keys(c.upDir ?? {}).length, 0);

  // A cell of the hall every source sees, and one far west on ground the party explored and does not see now.
  const terrain = (r: number): TerrainId => (r % 2 === 0 ? "wood" : "stone");
  const inSight = await timed((r) => send(table, table.dm, { t: "build.paint", sceneId: SCENE, terrain: terrain(r), cells: ["100,98"] }));
  rows.push({ row: `A build edit in sight, ${where}`, budget: 25, ms: inSight.total, covers: "the DM's build.paint where the party looks: the map step finds nothing to remember" });
  const before = memoryEntries();
  const remembered = await timed((r) => send(table, table.dm, { t: "build.paint", sceneId: SCENE, terrain: terrain(r), cells: [`${8 + (r % 4)},20`] }));
  if (memoryEntries() <= before) throw new Error("the edit on remembered ground was not remembered");
  rows.push({ row: `A build edit on remembered ground, ${where}`, budget: 25, ms: remembered.total, covers: "the DM's build.paint out of sight: the map step's sys.remember in the same batch" });

  // A run of 81 stairs along row 150, out of sight, whose east end's direction passes along the whole run, over 6 chunks.
  // The scene is at the sight cap, which the run's edges count toward, so 20 free walls far from it make room first.
  const spare = Object.values(state().buildChunks).flatMap((c) => (c.walls ?? []).filter((w) => w.a[1] < 60).map((w) => ({ cx: c.cx, cy: c.cy, id: w.id }))).slice(0, 20);
  await send(table, table.dm, { t: "build.walls", sceneId: SCENE, remove: spare });
  await send(table, table.dm, { t: "build.stairs", sceneId: SCENE, cells: Array.from({ length: 81 }, (_, i) => `${10 + i},150`), up: "a" });
  const stairs = await timed((r) => send(table, table.dm, { t: "build.stairs", sceneId: SCENE, cells: ["90,150"], up: r % 2 === 0 ? "e" : "a" }));
  rows.push({ row: `A stair edit felt chunks away, ${where}`, budget: 25, ms: stairs.total, covers: "the DM's build.stairs at a run's end: every chunk whose stair map changed is remembered and re-sent" });

  // A tile hidden again, then a character set down in it: the move explores it.
  const hide = (r: number): Op => ({ t: "fog.live", sceneId: SCENE, ops: [{ id: `hide${r}`, mode: "hide", shape: { kind: "rect", x: 176, y: 176, w: 16, h: 16 } }] });
  const explore = await timed(async (r) => {
    await jiggle(table);
    await send(table, table.dm, hide(r));
    if (exploredAt(state(), 11, 11, perPlayer)) throw new Error("the hide left the tile explored");
    const t = await send(table, table.dm, { t: "token.move", tokenId: "pc11", x: 184, y: 184, teleport: "wall" });
    if (!exploredAt(state(), 11, 11, perPlayer)) throw new Error("the move explored nothing");
    return t;
  });
  rows.push({ row: `A move exploring a tile, ${where}`, budget: 25, ms: explore.total, covers: "the DM's token.move into a tile hidden again: the explore and the map step" });
  rows.push({ row: `Sight fan-out for that move, ${where}`, budget: 10, ms: explore.fanout, covers: "commit to the last ev, 7 sockets" });
  await table.actor.shutdown({ code: 1012, snapshot: false });

  // Every layer's memory at its cap.
  clearVisionCache();
  const times: SitDownTimes = { load: [], first: [], later: [] };
  const full = await sitDown(remembering(perPlayer, true), times);
  checkMode(full.actor.committed.state, perPlayer);
  const fullState = () => full.actor.committed.state;
  const move = await timed(async (r) => {
    const t = pcs(fullState())[r % 12]!;
    return send(full, owner(full, t), { t: "token.move", tokenId: t.id, x: t.x + (r % 24 < 12 ? 1 : -1), y: t.y });
  });
  rows.push({ row: `A move with every layer's memory full, ${where}`, budget: 25, ms: move.total, covers: "a player's token.move, with the leg test, explore, the map step and the fan-out (MD-O-21)" });
  rows.push({ row: `Sight fan-out for that move, memory full, ${where}`, budget: 10, ms: move.fanout, covers: "commit to the last ev, 7 sockets" });
  const levels = ["dim", "bright", "dark"] as const;
  const global = await timed(async (r) => {
    await jiggle(full);
    return send(full, full.dm, { t: "scene.update", sceneId: SCENE, patch: { vision: { on: true, light: levels[r % 3]! } } });
  });
  rows.push({ row: `A global batch with every layer's memory full, ${where}`, budget: 250, ms: global.total, covers: "the DM's light level switch: every socket re-projected, memory merged" });
  await full.actor.shutdown({ code: 1012, snapshot: false });
  for (let r = 0; r < 4; r++) {
    clearVisionCache();
    const t = await sitDown(JSON.parse(JSON.stringify(remembering(perPlayer, true))) as RoomState, times);
    await t.actor.shutdown({ code: 1012, snapshot: false });
  }
  rows.push({ row: `The first snapshot with memory full, ${where}`, budget: 250, ms: stats(times.first), covers: "the DM's snapshot after a load" });
  rows.push({ row: `Each player's first snapshot with memory full, ${where}`, budget: 250, ms: stats(times.later), covers: "a player's snapshot: held chunks, stubs and memory merged" });
}

/*
 * The worst fragmented free walls (ASTRA-12): the bench room on Reveal by
 * hand, its free walls replaced by 4,000 walls along rows, each over 9
 * cells, with every other column of the scene revealed, so each wall gives
 * players 5 pieces. A fog write is a global batch.
 */
async function runFragmented(rows: Row[]): Promise<void> {
  clearVisionCache();
  const room = benchRoom("dark", 5);
  room.scenes[SCENE] = { ...room.scenes[SCENE]!, vision: { on: false, light: "dark" } };
  const chunks: Record<string, BuildChunk> = {};
  for (const [key, c] of Object.entries(room.buildChunks)) chunks[key] = { ...c, walls: [] };
  for (let k = 0; k < 4_000; k++) {
    const y = 0.5 + (k % 200);
    const x = 0.5 + 10 * Math.floor(k / 200);
    const wall: FreeWall = { id: `f${String(k).padStart(11, "0")}`, a: [x, y], b: [x + 8, y], f: { kind: "wall" } };
    const { cx, cy } = wallChunk(wall);
    const key = chunkKey(SCENE, cx, cy);
    const c = chunks[key] ?? { sceneId: SCENE, cx, cy, rev: 0, cells: {}, edges: {} };
    chunks[key] = { ...c, walls: [...(c.walls ?? []), wall] };
  }
  room.buildChunks = chunks;
  // Every other column revealed: fog bits by sub-cell, row by row, FOG_SUBCELLS to a cell and TILE_SUB to a tile's row.
  const columns = new Uint8Array((TILE_SUB * TILE_SUB) / 8);
  for (let sy = 0; sy < TILE_SUB; sy++) {
    for (let sx = 0; sx < TILE_SUB; sx++) if (Math.floor(sx / FOG_SUBCELLS) % 2 === 0) columns[(sy * TILE_SUB + sx) >> 3]! |= 1 << ((sy * TILE_SUB + sx) & 7);
  }
  const bits = encodeTile(columns);
  for (let ty = 0; ty < 13; ty++) for (let tx = 0; tx < 13; tx++) room.fogTiles[tileKey(SCENE, tx, ty)] = { sceneId: SCENE, tx, ty, rev: 0, bits };
  const times: SitDownTimes = { load: [], first: [], later: [] };
  const table = await sitDown({ ...room, memory: {}, memoryBy: {}, playedScenes: { [SCENE]: { sceneId: SCENE, rev: 0 } }, memoryShared: {} }, times);
  const pieces = projectState(table.actor.committed.state, { memberId: "p1", role: "player" }, { sceneId: SCENE });
  const cut = Object.values(pieces.buildChunks).reduce((n, c) => n + (c.walls?.length ?? 0), 0);
  if (cut < 4_000 * 5) throw new Error(`players hold ${cut} pieces of the 4,000 walls`);
  const global = await timed((r) => send(table, table.dm, { t: "fog.live", sceneId: SCENE, ops: [{ id: `r${r}`, mode: "reveal", shape: { kind: "rect", x: 1 + 2 * (r % 50), y: 199, w: 1, h: 1 } }] }));
  rows.push({ row: "A global batch, 4,000 free walls at 5 pieces each, Reveal by hand", budget: 250, ms: global.total, covers: "the DM's fog.live: every position of every socket re-projected, each wall cut per held cell" });
  await table.actor.shutdown({ code: 1012, snapshot: false });
  rows.push({ row: "Each player's first snapshot, 4,000 free walls at 5 pieces each", budget: 250, ms: stats(times.later), covers: "a player's snapshot of that scene" });
}

/*
 * The builder's ask (docs/design-v1-map-discovery.md 5.3, MD4-ASTRA-7) on an
 * empty 200 x 200 Explore scene the party never saw, where no op forgets
 * anything and so every op of an ask is read: a gesture of 64 rectangles of
 * 2,000 squares, the most four asks carry, and the 20 bands of a rectangle
 * over the whole scene, in two. Each gesture's asks go back to back, as a
 * device sends them, and each is timed twice: its longest synchronous turn,
 * as the delay of a zero-delay timer kept running through it, which every
 * other room on the server waits out, and its whole time to the answer.
 */
async function runAsk(rows: Row[]): Promise<void> {
  clearVisionCache();
  const room = benchRoom("dark", 5);
  const table = await sitDown({ ...room, buildChunks: {}, memory: {}, memoryBy: {}, playedScenes: { [SCENE]: { sceneId: SCENE, rev: 0 } }, memoryShared: {} });
  const terrain = (r: number): TerrainId => (r % 2 === 0 ? "wood" : "stone");
  const rect = (r: number, k: number): Op => ({ t: "build.rect", sceneId: SCENE, terrain: terrain(r), x: 0, y: (k % 20) * 10, w: 200, h: 10 });
  const gestures = [
    ["A gesture of 64 rectangles of 2,000 squares in 4 asks", 64],
    ["A whole-scene rectangle's 20 bands in 2 asks", 20],
  ] as const;
  for (const [what, count] of gestures) {
    const turns: number[] = [];
    const totals: number[] = [];
    for (let r = 0; r < RUNS + 2; r++) {
      const ops = Array.from({ length: count }, (_, k) => rect(r, k));
      const t = await askTimed(table, ops);
      if (r < 2) continue;
      turns.push(t.turn);
      totals.push(t.total);
    }
    rows.push({ row: `${what}, its longest synchronous turn, empty Explore scene`, budget: 25, ms: stats(turns), covers: "the DM's build.ask parts: the event loop's delay while they are read, which every room waits out" });
    rows.push({ row: `${what}, to its answer, empty Explore scene`, budget: 5_000, ms: stats(totals), covers: "the DM's build.ask parts from the first's arrival to the last's answer" });
  }
  // What an ask's turn is held to: a batch today with one such band, applied, remembered and sent.
  const turns: number[] = [];
  for (let r = 0; r < RUNS + 2; r++) {
    const sampler = longestTurn();
    await send(table, table.dm, rect(r, r));
    const turn = sampler.stop();
    if (r >= 2) turns.push(turn);
  }
  rows.push({ row: "One band of 2,000 squares sent as an op, its longest synchronous turn, empty Explore scene", budget: 25, ms: stats(turns), covers: "the DM's build.rect: a batch's turn, which an ask's turn matches" });
  await table.actor.shutdown({ code: 1012, snapshot: false });
}

/** The longest gap between a zero-delay timer's runs from now until `stop`, the longest turn anything held the event loop. */
function longestTurn(): { stop: () => number } {
  let turn = 0;
  let done = false;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    turn = Math.max(turn, now - last);
    last = now;
    if (!done) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return {
    stop: () => {
      done = true;
      return Math.max(turn, performance.now() - last);
    },
  };
}

/** Sends a gesture's asks from the DM back to back under a group of their own and times the longest synchronous turn and the whole time to the last one's answer. */
async function askTimed(table: Table, ops: readonly Op[]): Promise<{ turn: number; total: number }> {
  const conn = table.dm;
  const group = uuidv7();
  const parts: Op[] = [];
  for (let k = 0; k < ops.length; k += MAX_ASK_OPS) parts.push({ t: "build.ask", sceneId: SCENE, ops: ops.slice(k, k + MAX_ASK_OPS) as never, part: parts.length, ...(k + MAX_ASK_OPS < ops.length ? { more: true as const } : {}) });
  table.sent.sender = conn;
  table.sent.senderText = "";
  const sampler = longestTurn();
  const t0 = performance.now();
  let n = 0;
  for (const part of parts) {
    n = (table.n.get(conn) ?? 0) + 1;
    table.n.set(conn, n);
    await table.actor.op(conn, n, part, group);
  }
  const answered = () => {
    if (!table.sent.senderText) return false;
    const answer = JSON.parse(table.sent.senderText) as { t: string; acks?: number[]; rejects?: { n: number }[] };
    return answer.t === "ev" && (answer.acks?.includes(n) === true || answer.rejects?.some((r) => r.n === n) === true);
  };
  for (let wait = 0; wait < 20_000 && !answered(); wait++) await new Promise((resolve) => setTimeout(resolve, 1));
  const total = performance.now() - t0;
  const turn = sampler.stop();
  if (!answered()) throw new Error("the ask got no answer");
  const answer = JSON.parse(table.sent.senderText) as { rejects?: { n: number; message: string }[] };
  const refused = answer.rejects?.find((r) => r.n === n);
  if (refused) throw new Error(`the ask was refused: ${refused.message}`);
  return { turn, total };
}

export async function runServerBench(): Promise<Row[]> {
  const rows: Row[] = [];
  const untime = timeHolderSight();
  try {
    await runLevel("bright", 5, rows);
    await runLevel("dark", 5, rows);
    // The finest scale the room settings allow, where each light and sense covers the most cells (and so the most walls).
    await runLevel("dark", 1, rows);
    await runFreeLight(5, false, rows);
    await runFreeLight(1, false, rows);
    await runWalk(false, rows);
    // The same per player, at the worst ownership the holder cap allows.
    await runLevel("bright", 5, rows, true);
    await runLevel("dark", 5, rows, true);
    await runFogOff("bright", rows);
    await runFogOff("dark", rows);
    await runFreeLight(5, true, rows);
    await runWalk(true, rows);
    rows.push(...(await runDiscoveryBench()));
  } finally {
    untime();
  }
  return rows;
}

/** Map discovery's rows alone (`--discovery`). */
export async function runDiscoveryBench(): Promise<Row[]> {
  const rows: Row[] = [];
  await runDiscovery(false, rows);
  await runDiscovery(true, rows);
  await runFragmented(rows);
  await runAsk(rows);
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
  const rows: Row[] = [];
  if (argv.includes("--ask")) await runAsk(rows);
  console.log(formatServerBench(argv.includes("--ask") ? rows : argv.includes("--discovery") ? await runDiscoveryBench() : await runServerBench(), argv.includes("--server")));
}
