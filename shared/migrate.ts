import type { RoomState } from "./model.ts";
import type { Op } from "./protocol.ts";

/**
 * Snapshot and op versioning (design 16.2). A snapshot row carries the
 * schema version it was written with, and an op row the op version. Loading
 * runs the stored value through every step from its version to the current
 * one. Steps are pure functions and get tests of their own when they exist.
 *
 * A deploy writes snapshots on shutdown, so a version bump normally replays
 * no old ops at all. The op pipeline is here for the crash case.
 */
export const SNAPSHOT_VERSION = 8;
export const OP_VERSION = 4;

export type MigrationStep = {
  from: number;
  to: number;
  apply: (value: unknown) => unknown;
};

export const snapshotMigrations: MigrationStep[] = [
  // v1 had no custom monsters (design section 6). Rooms and backups from before them start with none.
  {
    from: 1,
    to: 2,
    apply: (state) => (state !== null && typeof state === "object" && !("monsters" in state) ? { ...state, monsters: {} } : state),
  },
  // v2 had no default images for SRD monsters (design section 6). Rooms and backups from before them start with none.
  {
    from: 2,
    to: 3,
    apply: (state) => (state !== null && typeof state === "object" && !("srdImages" in state) ? { ...state, srdImages: {} } : state),
  },
  // v3 had a switch for moving any token where v4 names who may (RoomSettings.playersMoveAny). On meant every player.
  {
    from: 3,
    to: 4,
    apply: (state) => {
      if (state === null || typeof state !== "object" || !("meta" in state)) return state;
      const meta = (state as { meta: unknown }).meta;
      if (meta === null || typeof meta !== "object" || !("settings" in meta)) return state;
      const settings = (meta as { settings: unknown }).settings;
      const next = moveAnyFromSwitch(settings, true);
      return next === settings ? state : { ...state, meta: { ...meta, settings: next } };
    },
  },
  // v4 had no saved encounters (design section 6). Rooms and backups from before them start with none.
  {
    from: 4,
    to: 5,
    apply: (state) => (state !== null && typeof state === "object" && !("savedEncounters" in state) ? { ...state, savedEncounters: {} } : state),
  },
  // v5 had no stamps or lights (docs/design-v1-maps-vision.md section 2.3). Rooms and backups from before them start with
  // none. Every other wave 3 addition is an optional field whose absence reads as before, so nothing else changes.
  {
    from: 5,
    to: 6,
    apply: (state) => {
      if (state === null || typeof state !== "object" || ("stamps" in state && "lights" in state)) return state;
      return { stamps: {}, lights: {}, ...state };
    },
  },
  // v6 had no explored layer (docs/design-v1-maps-vision.md sections 2.3 and 4.3.3). Rooms and backups from before it start
  // with none. Every other wave 4 addition is an optional field or a new op whose absence reads as before.
  {
    from: 6,
    to: 7,
    apply: (state) => (state !== null && typeof state === "object" && !("exploredTiles" in state) ? { ...state, exploredTiles: {} } : state),
  },
  // v7 had no journal pages, map pins or roll requests (docs/design-v1-dm-tools.md 2.3). Rooms and backups from before
  // them start with none. Every other wave 5 addition is an optional field, a new image variant or a new op whose absence
  // reads as before: everyone may draw, no token links a room monster, and no image is an icon.
  {
    from: 7,
    to: 8,
    apply: (state) => {
      if (state === null || typeof state !== "object" || ("journal" in state && "pins" in state && "rolls" in state)) return state;
      return { journal: {}, pins: {}, rolls: {}, ...state };
    },
  },
];

/**
 * Settings from before RoomSettings.playersMoveAny, with the switch turned
 * into who may: every player when it was on, none when it was off. A whole
 * room's settings (`whole`) gain the default when they had neither. A patch
 * without the switch is left as it was.
 */
function moveAnyFromSwitch(settings: unknown, whole: boolean): unknown {
  if (settings === null || typeof settings !== "object") return settings;
  if ("playersMoveAny" in settings && !("playersMoveAnyToken" in settings)) return settings;
  const { playersMoveAnyToken, ...rest } = settings as Record<string, unknown>;
  if ("playersMoveAny" in rest) return rest;
  if (playersMoveAnyToken === undefined) return whole ? { ...rest, playersMoveAny: "none" } : settings;
  return { ...rest, playersMoveAny: playersMoveAnyToken === true ? "all" : "none" };
}

/**
 * Replay checks every stored op with today's protocol schema, after these
 * steps (server/rooms/persistence.ts). So a rule that tightens later, such
 * as a shorter bound or a character newly refused in names, would make the
 * older ops that broke it fail replay and leave their rooms read-only. A
 * change that tightens the protocol therefore bumps OP_VERSION and adds a
 * step here that brings older ops within the new rule: trim, replace, or
 * turn the op into one that changes nothing.
 */
export const opMigrations: MigrationStep[] = [
  {
    // v1 ops name the switch for moving any token (snapshot step 3 to 4). A
    // settings change takes the new setting. An undo that put back the room
    // meta puts back settings in the new shape, and drops its guard, a hash
    // of the meta in the old shape that no replayed state can match now. It
    // matched when the op was first applied, or the op would not be stored.
    //
    // v1 ops also ran before a turn recorded where it began
    // (Encounter.turnStart). Replayed now, a turn advanced, a removal that
    // passes the turn on, or a turn taken back leaves the encounter, and the
    // history that taking a turn back reads, holding a spot they did not hold
    // then. So an undo that put back either drops its guard the same way.
    from: 1,
    to: 2,
    apply: (op) => {
      if (op === null || typeof op !== "object" || !("t" in op)) return op;
      const o = op as { t: unknown; settings?: unknown; entries?: unknown };
      if (o.t === "room.update" && o.settings !== undefined) return { ...o, settings: moveAnyFromSwitch(o.settings, false) };
      if (o.t === "sys.restore" && Array.isArray(o.entries)) {
        return {
          ...o,
          entries: o.entries.map((entry: unknown) => {
            if (entry === null || typeof entry !== "object") return entry;
            const key = (entry as { key?: unknown }).key;
            if (key !== "meta" && key !== "encounter" && key !== "encounterHistory") return entry;
            const { expectHash: _guard, ...rest } = entry as { value?: unknown; expectHash?: unknown };
            const value = rest.value;
            if (key !== "meta" || value === null || typeof value !== "object" || !("settings" in value)) return rest;
            return { ...rest, value: { ...value, settings: moveAnyFromSwitch((value as { settings: unknown }).settings, true) } };
          }),
        };
      }
      return op;
    },
  },
  {
    // v2 ops ran before a creature's moves on its turn were recorded on its
    // token (Token.path), and before a turn's start carried the seq that
    // names the turn (TurnStart.seq). Replayed now, a move of the active
    // creature leaves its token holding a path it did not hold then, a move
    // of any other token drops one, and a turn advanced, passed on by a
    // removal or taken back leaves the encounter and its history holding a
    // seq they did not hold. So an undo that put back a token, the
    // encounter or its history drops its guard, as in step 1 to 2. Its
    // value is what it put back then, without a path, which is what the
    // room held after it then.
    from: 2,
    to: 3,
    apply: (op) => {
      if (op === null || typeof op !== "object" || !("t" in op)) return op;
      const o = op as { t: unknown; entries?: unknown };
      if (o.t !== "sys.restore" || !Array.isArray(o.entries)) return op;
      return {
        ...o,
        entries: o.entries.map((entry: unknown) => {
          if (entry === null || typeof entry !== "object") return entry;
          const key = (entry as { key?: unknown }).key;
          const unguarded = key === "encounter" || key === "encounterHistory" || (typeof key === "string" && key.startsWith("token:"));
          if (!unguarded) return entry;
          const { expectHash: _guard, ...rest } = entry as { expectHash?: unknown };
          return rest;
        }),
      };
    },
  },
  {
    // v3 ops ran while a creature revealed on its turn (`fogExemptAuto`)
    // counted as seen by players wherever it stood. Since the decision of
    // 2026-10-14 it follows the fog and the party's sight like any other
    // creature, which changes the `seen` marks the reducer stores (a turn's
    // start, path stops, log lines and a copied ruler's visibility) and
    // whether a player's guarded Next or Previous finds the acting row in
    // their view. Their shape is unchanged. Replay hands the reducer each
    // row's stored version instead (`Env.opVersion`, see
    // `revealSeenAnywhere`), so a v3 op runs by the old rule and replays to
    // the state it made then, and a later restore's guard still matches.
    from: 3,
    to: 4,
    apply: (op) => op,
  },
];

/**
 * Whether an op marks a creature revealed on its turn as seen wherever it
 * stands, as ops did up to version 3 (step 3 to 4 above). Live ops carry no
 * stored version and take today's rule.
 */
export function revealSeenAnywhere(opVersion: number | undefined): boolean {
  return opVersion !== undefined && opVersion < 4;
}

/** Runs the steps that lead from `from` to `to`, in order, and refuses a version with no path. */
export function runMigrations(value: unknown, from: number, to: number, steps: MigrationStep[]): unknown {
  if (from === to) return value;
  if (from > to) throw new Error(`cannot migrate from version ${from} down to ${to}`);
  let current = value;
  let version = from;
  while (version < to) {
    const step = steps.find((s) => s.from === version);
    if (!step || step.to <= version) throw new Error(`no migration from version ${version}`);
    current = step.apply(current);
    version = step.to;
  }
  if (version !== to) throw new Error(`migrations overshoot version ${to}`);
  return current;
}

export function migrateSnapshot(state: unknown, fromVersion: number, steps: MigrationStep[] = snapshotMigrations): RoomState {
  return runMigrations(state, fromVersion, SNAPSHOT_VERSION, steps) as RoomState;
}

export function migrateOp(op: unknown, fromVersion: number, steps: MigrationStep[] = opMigrations): Op {
  return runMigrations(op, fromVersion, OP_VERSION, steps) as Op;
}
