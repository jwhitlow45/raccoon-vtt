import { chunkOf, fogRoom, paint } from "./discoveryTestutil.ts";
import type { AreaTemplate, RoomState, Stamp, Token } from "./model.ts";
import { seqTwins, type SeqTwinOptions } from "./seqTestutil.ts";
import { SEAT } from "./limits.ts";
import { actor as actorOf, chance, character, drawing, entry as entryOf, int, member, rng, template, token } from "./testutil.ts";

/**
 * Helpers for the twin tests of what a player's device receives
 * (server/rooms/priv.twin.test.ts, priv.random.test.ts, priv.itest.ts):
 * two rooms whose copies for P1 and the table display match, while the
 * rest of each room differs, and checks on the frames each device got.
 * Nothing here runs in the app.
 */

/** Twin names, as seqTwins names its two rooms. */
export type TwinName = "door" | "rock";

/** The side room's corridor runs south from room R's west end and turns east, so nothing in room R sees into it. */
export const SIDE_CORRIDOR = { x: 2, y: 10, w: 1, h: 2 } as const;
/** The side room, 2, 12 to 9, 13. */
export const SIDE_ROOM = { x: 2, y: 12, w: 8, h: 2 } as const;
/** Where Ayla stands to see the whole side room. */
export const IN_SIDE = { x: 5, y: 12 } as const;
/** Where Ayla stands in room R, out of sight of the side room. */
export const IN_R = { x: 4, y: 4 } as const;

/** A stamp of a shipped picture, at a cell's middle. */
export function stampAt(id: string, x: number, y: number, z: number, visibility: Stamp["visibility"] = "all"): Stamp {
  return { id, rev: 0, sceneId: "s1", art: { key: "chest" }, x: x + 0.5, y: y + 0.5, w: 1, h: 1, rotation: 0, z, visibility };
}

/** An id of the production shape, from a seeded source, so two twins pair their ids by drawing alike. */
export function idFrom(r: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => int(r, 0, 15).toString(16)).join("");
  return `0199f0a0-${hex(4)}-7${hex(3)}-8${hex(3)}-${hex(12)}`;
}

/** What one twin holds that neither P1 nor the display may ever be sent: ids and names. */
export type Hidden = { ids: string[]; names: string[] };

export type PrivTwins = {
  door: RoomState;
  rock: RoomState;
  /** Per twin, what no copy of P1's or the display's may hold. */
  hidden: Record<TwinName, Hidden>;
  /** Per twin, the hidden creatures on the players' scene, in room R. */
  creatures: Record<TwinName, string[]>;
  /** Per twin, the hidden stamps, in room R and the side room. */
  hiddenStamps: Record<TwinName, string[]>;
  /** The stamps both twins hold alike for players: room R's, then the side room's. */
  stampsR: string[];
  stampsSide: string[];
  /** The visible area in room R, cast by a hidden creature (a different one in each twin). */
  area: string;
};

/**
 * The room count's twins (seqTwins, the door twin and the twin of rock),
 * each with a side room off room R, and with more drawn apart per twin
 * that P1 and the display never get: hidden stamps between the public
 * ones in room R and in the side room, so the stored orders differ, hidden
 * creatures with names no visible creature has, a visible area whose
 * caster is one of them, and areas only the DM sees. The public stamps
 * are alike in both twins in every field but their stored order.
 */
export function privTwins(seed: number, opts: SeqTwinOptions = {}): PrivTwins {
  const w = seqTwins(opts);
  const shared = rng(seed);
  const stampsR = [idFrom(shared), idFrom(shared), idFrom(shared)];
  const stampsSide = [idFrom(shared), idFrom(shared)];
  const area = idFrom(shared);
  const out: PrivTwins = {
    door: w.door,
    rock: w.rock,
    hidden: { door: { ids: [], names: [] }, rock: { ids: [], names: [] } },
    creatures: { door: [], rock: [] },
    hiddenStamps: { door: [], rock: [] },
    stampsR,
    stampsSide,
    area,
  };
  for (const name of ["door", "rock"] as const) {
    const state = w[name];
    // Each twin draws apart from its own source.
    const r = rng(seed * 2 + (name === "door" ? 1 : 2));
    const hidden = out.hidden[name];
    paint(state, SIDE_CORRIDOR);
    paint(state, SIDE_ROOM);
    const creatures: Token[] = [];
    for (let i = int(r, 1, 3); i > 0; i--) {
      const id = idFrom(r);
      const label = `Shade ${id.slice(-6)}`;
      creatures.push(token(id, { name: label, visibility: "dm", disposition: "hostile", x: int(r, 6, 9), y: int(r, 2, 3) }));
      hidden.ids.push(id);
      hidden.names.push(label);
    }
    for (const c of creatures) state.tokens[c.id] = c;
    out.creatures[name] = creatures.map((c) => c.id);
    // Public stamps keep one order. Hidden ones sit between them, a different number in each twin, and the gaps
    // leave room to move a stamp among the hidden ones without passing a public one.
    const stamps: Stamp[] = [];
    let z = 0;
    const next = () => (z += int(r, 2, 10));
    const between = (x0: number, x1: number, y: number) => {
      for (let i = int(r, 0, 2); i > 0; i--) {
        const id = idFrom(r);
        stamps.push(stampAt(id, int(r, x0, x1), y, next(), "dm"));
        hidden.ids.push(id);
        out.hiddenStamps[name].push(id);
      }
    };
    for (const [i, id] of stampsR.entries()) {
      between(3, 8, 8);
      stamps.push(stampAt(id, 3 + 2 * i, 7, next()));
    }
    between(3, 8, 8);
    for (const [i, id] of stampsSide.entries()) {
      between(4, 9, 13);
      stamps.push(stampAt(id, 6 + 2 * i, 12, next()));
    }
    between(4, 9, 13);
    state.stamps = Object.fromEntries(stamps.map((s) => [s.id, s]));
    const caster = creatures[0]!.id;
    const templates: AreaTemplate[] = [template(area, { origin: { x: 5.5, y: 3.5, z: 0 }, size: 5, ownerId: "dm1", casterId: caster })];
    for (let i = chance(r, 0.5) ? 1 : int(r, 0, 2); i > 0; i--) {
      const id = idFrom(r);
      templates.push(template(id, { origin: { x: int(r, 3, 8) + 0.5, y: int(r, 3, 8) + 0.5, z: 0 }, size: 5, ownerId: "dm1", visibility: "dm" }));
      hidden.ids.push(id);
    }
    state.templates = Object.fromEntries(templates.map((t) => [t.id, t]));
  }
  return out;
}

/** The kinds of frame that carry a copy of the room. */
function copyValues(frame: unknown): Array<[string, unknown]> {
  if (frame === null || typeof frame !== "object") return [];
  const f = frame as { t?: unknown; changes?: unknown; state?: unknown };
  if (f.t === "snapshot") return [["state", f.state]];
  if (f.t === "ev" && Array.isArray(f.changes)) return (f.changes as Array<{ key: string; value?: unknown }>).filter((c) => "value" in c).map((c) => [c.key, c.value]);
  return [];
}

/**
 * Every `rev` other than 0 in the copies the frames carry, as
 * `"<where> rev <n>"`: a snapshot's state and every value an `ev` sends. A
 * player's copy holds none.
 */
export function revsIn(frames: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) walk(item, `${where}[${i}]`);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "rev" && typeof v === "number" && v !== 0) out.push(`${where} rev ${v}`);
      else walk(v, `${where}.${k}`);
    }
  };
  for (const frame of frames) for (const [where, value] of copyValues(frame)) walk(value, where);
  return out;
}

/** Each frame, raw, that names any of the hidden ids or names, as `"<needle> in <frame>"`. Read before any frame is normalized. */
export function hiddenIn(frames: readonly unknown[], hidden: Hidden): string[] {
  const needles = [...hidden.ids, ...hidden.names];
  const out: string[] = [];
  for (const frame of frames) {
    const raw = JSON.stringify(frame);
    for (const needle of needles) if (raw.includes(needle)) out.push(`${needle} in ${raw.slice(0, 300)}`);
  }
  return out;
}

/**
 * The stamps one connection's copy holds, followed frame by frame: a
 * snapshot replaces them, and each `ev` puts or removes the ones it names.
 */
export class StampCopy {
  readonly stamps = new Map<string, Stamp>();

  read(frames: readonly unknown[]): this {
    for (const frame of frames) {
      if (frame === null || typeof frame !== "object") continue;
      const f = frame as { t?: unknown; changes?: Array<{ key: string; value?: unknown }>; state?: { stamps?: Record<string, Stamp> } };
      if (f.t === "snapshot") {
        this.stamps.clear();
        for (const s of Object.values(f.state?.stamps ?? {})) this.stamps.set(s.id, s);
      } else if (f.t === "ev" && Array.isArray(f.changes)) {
        for (const c of f.changes) {
          if (!c.key.startsWith("stamp:")) continue;
          const id = c.key.slice("stamp:".length);
          if ("value" in c && c.value !== null && c.value !== undefined) this.stamps.set(id, c.value as Stamp);
          else this.stamps.delete(id);
        }
      }
    }
    return this;
  }

  /** Each held stamp's `z` by id, per scene. */
  orders(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const s of [...this.stamps.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) (out[s.sceneId] ??= {})[s.id] = s.z;
    return out;
  }

  /** The scenes whose held stamps' `z` are not exactly 0 to n-1, each once, as `"<scene>: <z, in order>"`. */
  notRanks(): string[] {
    const out: string[] = [];
    for (const [scene, zs] of Object.entries(this.orders())) {
      const sorted = Object.values(zs).sort((a, b) => a - b);
      if (sorted.some((z, i) => z !== i)) out.push(`${scene}: ${sorted.join(", ")}`);
    }
    return out;
  }
}

/**
 * A version 7 id dated `ms`, its other bits drawn from `r`, so two twins
 * that mint at the same clock time from sources seeded alike get the same
 * id, as a device minting at send does.
 */
export function idAt(r: () => number, ms: number): string {
  const hex = (n: number) => Array.from({ length: n }, () => int(r, 0, 15).toString(16)).join("");
  const time = Math.floor(ms).toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(3)}-${"89ab"[int(r, 0, 3)]}${hex(3)}-${hex(12)}`;
}

/** Ids and names only one twin of the player limits tests holds carry this, which no frame's text holds by chance. */
export const APART = "zq";

/** The party's room R, where Ayla (P1's) and Bree (P2's) stand with a goblin, and room F, apart from it behind rock. */
export const ROOM_R = { x: 2, y: 2, w: 10, h: 8 } as const;
export const ROOM_F = { x: 24, y: 2, w: 10, h: 8 } as const;

/** A cell in room R or F by column and row inside it. */
export const inRoomR = (i: number, j = 0) => ({ x: 7 + i, y: 3 + j });
export const inRoomF = (i: number, j = 0) => ({ x: 26 + i, y: 3 + j });

/** P1's character Ayla and P2's Bree, each with a token of the same id in room R. */
export const AYLA = "ayla";
export const BREE = "bree";
/** An ogre in room R that every player sees, alone of its name, so it carries no number. */
export const OGRE = "ogre";

/**
 * The room of the player limits twins: party sight on the players' scene
 * s1, rooms R and F painted apart so sight in R never reaches F, P1's
 * Ayla and P2's Bree as characters with tokens in R, and an ogre in R.
 * Each twin adds what P1 never sees.
 */
export function limitsRoom(): RoomState {
  const state = fogRoom({ vision: true });
  paint(state, ROOM_R);
  paint(state, ROOM_F);
  state.characters[AYLA] = character(AYLA, { name: "Ayla", ownerIds: ["p1"] });
  state.characters[BREE] = character(BREE, { name: "Bree", ownerIds: ["p2"] });
  state.tokens[AYLA] = token(AYLA, { kind: "pc", name: "Ayla", disposition: "ally", x: 3, y: 3, actor: { ref: AYLA } });
  state.tokens[BREE] = token(BREE, { kind: "pc", name: "Bree", disposition: "ally", x: 3, y: 7, actor: { ref: BREE } });
  state.tokens[OGRE] = token(OGRE, { name: "Ogre", x: 8, y: 4 });
  return { ...state, playedScenes: { s1: { sceneId: "s1", rev: 0 } } };
}

/** An id only one twin holds, `zq` and a number, padded so no two share a prefix the scan could mistake. */
export const apartId = (what: string, i: number) => `${APART}${what}${String(i).padStart(5, "0")}`;

/** `n` areas only the DM sees on a scene, on its first floor. */
export function dmAreas(state: RoomState, n: number, sceneId = "s1"): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("area", i));
  for (const id of ids) state.templates[id] = template(id, { sceneId, ownerId: "dm1", visibility: "dm", origin: { x: 28.5, y: 5.5, z: 0 }, size: 5 });
  return ids;
}

/** `n` creatures only the DM sees, in room F. */
export function dmTokens(state: RoomState, n: number, sceneId = "s1"): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("tok", i));
  for (const [i, id] of ids.entries()) state.tokens[id] = token(id, { sceneId, name: `${APART}shade`, visibility: "dm", x: 26 + (i % 6), y: 3 + (Math.floor(i / 6) % 6) });
  return ids;
}

/** `n` drawings only the DM sees, of `points` point values each. */
export function dmDrawings(state: RoomState, n: number, points = 4, sceneId = "s1"): string[] {
  const ids = Array.from({ length: n }, (_, i) => apartId("drw", i));
  const values = Array.from({ length: points }, (_, i) => 26 + (i % 6));
  for (const id of ids) state.drawings[id] = drawing(id, { sceneId, ownerId: "dm1", visibility: "dm", points: values });
  return ids;
}

/** Stairs from Ayla's square on s1 up to the Upper floor of s1's scene, and back down. */
export const STAIRS_UP = "l1";
export const STAIRS_DOWN = "l2";

/** Gives the limits room an Upper floor above s1, with room R painted there too, and stairs at a square, Ayla's unless told otherwise. */
export function withUpper(state: RoomState, at: { x: number; y: number } = { x: 3, y: 3 }): RoomState {
  const ground = state.scenes.s1!;
  state.scenes.s1 = { ...ground, floor: { of: "s1", level: 0, name: "Ground floor", height: 10 } };
  state.scenes.up = { ...ground, id: "up", floor: { of: "s1", level: 1, name: "Upper floor", height: 10 } };
  for (let y = ROOM_R.y; y < ROOM_R.y + ROOM_R.h; y++) for (let x = ROOM_R.x; x < ROOM_R.x + ROOM_R.w; x++) chunkOf(state, "up", x, y).cells[`${x},${y}`] = "stone";
  const rect = { ...at, w: 1, h: 1 };
  state.floorLinks = {
    [STAIRS_UP]: { id: STAIRS_UP, rev: 0, sceneId: "s1", to: "up", pair: STAIRS_DOWN, rect, kind: "stairs", ground: 0, made: 1 },
    [STAIRS_DOWN]: { id: STAIRS_DOWN, rev: 0, sceneId: "up", to: "s1", pair: STAIRS_UP, rect, kind: "stairs", ground: 0, made: 1 },
  };
  return state;
}

/** A fixture id of the production shape, by kind letter and number, which no device mints. */
const fixedId = (kind: string, i: number) => `0199f0a0-0000-7000-8${kind}00-${String(i).padStart(12, "0")}`;

export type Seated = { players: string[]; characters: string[]; tokens: string[]; areas: string[]; drawings: string[]; rows: string[] };

/**
 * `players` players, from p1 or `from` on, each playing one character with a token on
 * s1 and every seat there full: 33 tokens (theirs and 32 companions), 20
 * areas on that token, 40 free areas, `drawings` lines of 4 point values
 * and, in a fight, 40 rows. The DM's own things are each test's.
 */
export function seated(state: RoomState, players: number, drawings: number = SEAT.drawings, from = 1): Seated {
  const out: Seated = { players: [], characters: [], tokens: [], areas: [], drawings: [], rows: [] };
  state.encounter ??= { rev: 0, round: 1, activeEntryId: null, entries: [] };
  for (let p = from; p < from + players; p++) {
    const memberId = `p${p}`;
    state.members[memberId] ??= member(memberId);
    const characterId = fixedId("c", p);
    state.characters[characterId] = character(characterId, { name: `Hero ${p}`, ownerIds: [memberId] });
    out.players.push(memberId);
    out.characters.push(characterId);
    const pc = fixedId("a", p * 100);
    state.tokens[pc] = token(pc, { kind: "pc", name: `Hero ${p}`, disposition: "ally", x: p % 40, y: 1, actor: { ref: characterId } });
    out.tokens.push(pc);
    for (let i = 1; i < SEAT.tokens; i++) {
      const id = fixedId("a", p * 100 + i);
      state.tokens[id] = token(id, { kind: "npc", name: "Wolf", disposition: "ally", x: p % 40, y: 2 + (i % 20), companion: { of: characterId, turn: "shared" }, actor: { inline: actorOf({ dmNotes: "" }) } });
      out.tokens.push(id);
    }
    for (let i = 0; i < SEAT.ridingAreas + SEAT.freeAreas; i++) {
      const id = fixedId("b", p * 100 + i);
      state.templates[id] = template(id, { ownerId: memberId, origin: { x: (p % 40) + 0.5, y: 1.5, z: 0 }, size: 5, ...(i < SEAT.ridingAreas ? { attachedTo: pc } : {}) });
      out.areas.push(id);
    }
    for (let i = 0; i < drawings; i++) {
      const id = fixedId("d", p * 1_000 + i);
      state.drawings[id] = drawing(id, { ownerId: memberId, points: [p % 40, 1, (p % 40) + 1, 2] });
      out.drawings.push(id);
    }
    for (let i = 0; i < SEAT.rows; i++) {
      const id = fixedId("e", p * 100 + i);
      state.encounter.entries.push(entryOf(id, { tokenId: pc }));
      out.rows.push(id);
    }
  }
  return out;
}

/**
 * A database pool as the room engine and the HTTP routes use it: pg's Pool,
 * or the room tests' in-memory ones (server/rooms/undoScopeTesting.ts).
 * Statements go through `query`, and a transaction through a client from
 * `connect`.
 */
export type HookablePool = { query: (...args: never[]) => unknown; connect: (...args: never[]) => unknown };

/** Picks statements by their SQL text. */
export type StatementMatch = RegExp | ((sql: string) => boolean);

/** Statements the hooks' callers hold most often, by their SQL text. */
export const STATEMENT = {
  /** A transaction's COMMIT. */
  commit: /^\s*commit\s*$/i,
  /** A grant read of an HTTP route or a socket's admission. */
  grantRead: /^\s*select\b[\s\S]*\bfrom grants\b/i,
  /** A room load's read of its snapshot row, its first statement. */
  roomLoad: /^\s*select\b[\s\S]*\bfrom room_snapshots\b/i,
  /** A read of the receipt rows. */
  receiptRead: /^\s*select\b[\s\S]*\bfrom roll_receipts/i,
  /** A write of a snapshot row. */
  snapshotWrite: /^\s*insert into room_snapshots\b/i,
} as const;

/**
 * Statements held at their start until a test lets them on, in arrival
 * order. `waiting` counts those held now, and `seen` every one the hold
 * picked, let on or not.
 */
export type Hold = {
  readonly waiting: number;
  readonly seen: number;
  /** Resolves once `n` statements in all (`seen`) have reached the hold. */
  reached(n?: number): Promise<void>;
  /** Lets the oldest held statement on. */
  releaseOne(): void;
  /** Lets every held statement on, and stops holding. */
  release(): void;
};

/** How a lost COMMIT answer goes: `committed` commits, `rolledBack` rolls back, and either then fails as a dropped connection does. */
export type LostCommit = "committed" | "rolledBack";

export type PoolHooks = {
  /**
   * From now on each COMMIT waits `ms` before it runs, or `ms(i)` for the
   * i-th from 0. The wait reads the timers as they stand when the COMMIT
   * comes, so under mocked timers it lasts that long on the test's clock.
   * `0` ends it.
   */
  commitLength(ms: number | ((i: number) => number)): void;
  /** The next COMMITs, one mode each in order, lose their answer. */
  loseCommits(modes: readonly LostCommit[]): void;
  /** How many lost answers are still to come. */
  readonly lostToCome: number;
  /** Holds each statement `match` picks at its start until released. */
  hold(match: StatementMatch): Hold;
  /** Holds every COMMIT, so closed batches wait behind the one in flight. */
  holdCommits(): Hold;
  /** Every statement run since the hooks went on, in order. */
  readonly statements: readonly string[];
  /** Ends every hold and puts the pool's own methods back. */
  restore(): void;
};

type Run = (sql: string, args: unknown[]) => Promise<unknown>;

/** Waits `ms` on the timers as they stand now, mocked or real, as no skew moves (skewTimers). */
function waitOn(ms: number): Promise<void> {
  return new Promise((resolve) => {
    ownTimer = true;
    try {
      globalThis.setTimeout(resolve, ms);
    } finally {
      ownTimer = false;
    }
  });
}

/** Set while a hook arms a timer of its own, which skewTimers leaves alone. */
let ownTimer = false;

const picks = (match: StatementMatch, sql: string) => (typeof match === "function" ? match(sql) : match.test(sql));

/**
 * Test hooks on a pool, put on in place so a room or an app that already
 * holds the pool goes through them: how long each COMMIT takes, COMMIT
 * answers lost after it ran or after a rollback, and holds on any
 * statement, the commit (backpressure), a route's grant read, a room's
 * load or a receipt read among them. Only the promise forms the engine
 * uses go through the hooks. pg's callback forms, which its own
 * `pool.query` uses inside, pass through, so no statement is seen twice.
 */
export function hookPool(pool: HookablePool): PoolHooks {
  const target = pool as unknown as { query: (...args: unknown[]) => unknown; connect: (...args: unknown[]) => unknown };
  const ownQuery = Object.prototype.hasOwnProperty.call(target, "query");
  const ownConnect = Object.prototype.hasOwnProperty.call(target, "connect");
  const query = target.query;
  const connect = target.connect;
  let length: (i: number) => number = () => 0;
  let commits = 0;
  const lost: LostCommit[] = [];
  const holds: Array<{ match: StatementMatch; queue: Array<() => void>; seen: number; off: boolean; reached: Array<{ n: number; resolve: () => void }> }> = [];
  const statements: string[] = [];

  const through = async (sql: string, args: unknown[], run: Run): Promise<unknown> => {
    statements.push(sql);
    for (const h of holds) {
      if (h.off || !picks(h.match, sql)) continue;
      h.seen++;
      const reached = h.reached.filter((r) => r.n <= h.seen);
      h.reached = h.reached.filter((r) => r.n > h.seen);
      const held = new Promise<void>((resolve) => h.queue.push(resolve));
      for (const r of reached) r.resolve();
      await held;
    }
    if (!STATEMENT.commit.test(sql)) return run(sql, args);
    const ms = length(commits++);
    if (ms > 0) await waitOn(ms);
    const mode = lost.shift();
    if (mode === undefined) return run(sql, args);
    await run(mode === "committed" ? "commit" : "rollback", []);
    throw Object.assign(new Error("simulated lost commit answer"), { code: "ECONNRESET" });
  };

  const wrapClient = <C extends object>(client: C): C => {
    const run = (client as { query: (...args: unknown[]) => Promise<unknown> }).query.bind(client);
    return new Proxy(client, {
      get(t, prop, receiver) {
        if (prop !== "query") return Reflect.get(t, prop, receiver);
        return (text: unknown, ...rest: unknown[]) => {
          if (typeof text !== "string" || rest.some((a) => typeof a === "function")) return run(text, ...rest);
          return through(text.trim(), rest, (sql, args) => run(sql, ...args));
        };
      },
    });
  };

  target.query = (text: unknown, ...rest: unknown[]) => {
    if (typeof text !== "string" || rest.some((a) => typeof a === "function")) return query.call(pool, text, ...rest);
    return through(text.trim(), rest, (sql, args) => query.call(pool, sql, ...args) as Promise<unknown>);
  };
  target.connect = (...args: unknown[]) => {
    if (typeof args[0] === "function") return connect.call(pool, ...args);
    return (connect.call(pool) as Promise<object>).then(wrapClient);
  };

  const hold = (match: StatementMatch): Hold => {
    const h = { match, queue: [] as Array<() => void>, seen: 0, off: false, reached: [] as Array<{ n: number; resolve: () => void }> };
    holds.push(h);
    return {
      get waiting() {
        return h.queue.length;
      },
      get seen() {
        return h.seen;
      },
      reached: (n = 1) => (h.seen >= n ? Promise.resolve() : new Promise<void>((resolve) => h.reached.push({ n, resolve }))),
      releaseOne: () => h.queue.shift()?.(),
      release: () => {
        h.off = true;
        for (const resolve of h.queue.splice(0)) resolve();
      },
    };
  };

  return {
    commitLength(ms) {
      length = typeof ms === "function" ? ms : () => ms;
    },
    loseCommits(modes) {
      lost.push(...modes);
    },
    get lostToCome() {
      return lost.length;
    },
    hold,
    holdCommits: () => hold(STATEMENT.commit),
    statements,
    restore() {
      for (const h of holds) {
        h.off = true;
        for (const resolve of h.queue.splice(0)) resolve();
      }
      length = () => 0;
      lost.length = 0;
      if (ownQuery) target.query = query;
      else delete (target as { query?: unknown }).query;
      if (ownConnect) target.connect = connect;
      else delete (target as { connect?: unknown }).connect;
    },
  };
}

/**
 * Moves timers off their due time, as a loaded event loop runs them late
 * or a clock set back makes them early: each timer armed through the
 * global setTimeout while the skew is on runs `skew(ms, i)` ms later (less
 * when negative, never before 0), where `ms` is the delay it was armed for
 * and `i` counts the timers armed since. Put it on after mocking the
 * timers and take it off before their reset. A hook's own wait
 * (hookPool's commit length) is not moved.
 */
export function skewTimers(skew: (ms: number, i: number) => number): { readonly armed: number; readonly skewed: number; restore(): void } {
  const armedWith = globalThis.setTimeout;
  let armed = 0;
  let skewed = 0;
  const skewing = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ownTimer) return armedWith(fn, ms, ...args);
    const delay = Math.max(0, ms ?? 0);
    const by = skew(delay, armed++);
    if (by !== 0) skewed++;
    return armedWith(fn, Math.max(0, delay + by), ...args);
  }) as typeof globalThis.setTimeout;
  globalThis.setTimeout = skewing;
  return {
    get armed() {
      return armed;
    },
    get skewed() {
      return skewed;
    },
    restore() {
      if (globalThis.setTimeout === skewing) globalThis.setTimeout = armedWith;
    },
  };
}

/**
 * A skew for skewTimers: `by` ms (negative for early) on the timers whose
 * delay `which` picks, at most `times` of them, and none on the rest. The
 * room's batch timer is armed for at most its batchMs, and a delayed
 * snapshot's waits for 2 s steps and its due time.
 */
export function skewOf(by: number, which: (ms: number) => boolean = () => true, times = Number.POSITIVE_INFINITY): (ms: number) => number {
  let left = times;
  return (ms) => {
    if (left <= 0 || !which(ms)) return 0;
    left--;
    return by;
  };
}
