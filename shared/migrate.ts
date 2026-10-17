import type { RoomSettings, RoomState } from "./model.ts";
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
export const SNAPSHOT_VERSION = 11;
export const OP_VERSION = 7;

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
  // v8 had no PDF handouts (docs/design-v1-pdf-handouts.md 3.8). Rooms and backups from before them start with no
  // documents. A handout without `pages` is one image, so stored handouts and ops read as before.
  {
    from: 8,
    to: 9,
    apply: (state) => (state !== null && typeof state === "object" && !("handoutDocs" in state) ? { ...state, handoutDocs: {} } : state),
  },
  // v9 had no companion stat blocks (docs/design-v1-companion-stat-blocks.md 3.6). Rooms and backups from before them
  // start with none, and no actor links one.
  {
    from: 9,
    to: 10,
    apply: (state) => (state !== null && typeof state === "object" && !("companionBlocks" in state) ? { ...state, companionBlocks: {} } : state),
  },
  // Wave 7's one bump (docs/design-v1-roll-request.md 7.5): dice lines, rolled answers, their provenance and PC stat
  // blocks are optional fields and new log lines whose absence reads as before, so a v10 room is a v11 room as it is.
  // The number moves so that an older build, which would drop or misread them, refuses a v11 snapshot instead.
  { from: 10, to: 11, apply: (state) => state },
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
  {
    // v4 ops ran while healing did nothing to the dead, a set of HP left a
    // dead creature dead, and the DM's Revive kept whatever HP a dead
    // creature held (docs/design-v1-combat-flow.md 3.4 and 3.5). Their shape
    // is unchanged. As in step 3 to 4, replay hands the reducer the stored
    // version (`healRevivesDead`, `reviveToOne`), so a v4 op makes the state
    // it made then, and a later restore's guard still matches.
    //
    // Deploy: nothing to run. The first op after it is stored at version 5.
    // Rollback: an older build refuses to migrate a version 5 op down
    // (runMigrations), so a room whose log holds one would not load there.
    // Rolling back past this build needs a snapshot taken after the last op,
    // which a clean shutdown writes, or a backup from before the deploy.
    // An older build reads such a snapshot without checking its schema
    // (server/rooms/persistence.ts) and ignores the new fields: companions
    // act as plain tokens, `healRevives` does nothing, Revive keeps the HP
    // it found, and a party companion's HP follows its own `hpVisibility`.
    // Nothing new reaches players there, since the older token projection
    // lists the fields it sends and saved steps are the DM's. An export from
    // this build is refused by an older build's import, whose schema is strict.
    from: 4,
    to: 5,
    apply: (op) => op,
  },
  {
    // v5 ops ran under two rules that version 6 changes, at one boundary.
    //
    // A size change on the acting creature's turn was a move: a token
    // update with a size and a place recorded a counted stop on its path,
    // and one with a size alone recorded nothing. From v6 a resize is not
    // movement: the old size goes on every earlier stop (PathStop.footprint)
    // and the resize appends an uncounted stop
    // (docs/design-v1-token-window.md 8.7).
    //
    // A patch that set an actor's `srdId` alone kept a `monsterId` it held.
    // From v6 an actor links one stat block, and setting any of `srdId`,
    // `monsterId` and `blockId` clears the other two
    // (docs/design-v1-companion-stat-blocks.md 3.2, rule 1).
    //
    // The shape of every op is unchanged, so as in step 4 to 5, replay hands
    // the reducer the stored version (`resizeStop`, `oneLinkPerActor`), and
    // a v5 op makes the state it made then.
    //
    // Deploy: nothing to run. The first op after it is stored at version 6.
    // Rollback: an older build refuses to migrate a version 6 op down
    // (runMigrations), and a version 10 snapshot too, and its state schema
    // refuses a path stop holding `footprint`, so a room that stored any of
    // them loads only on this build or later. Rolling back past it needs
    // the backup taken before the update.
    from: 5,
    to: 6,
    apply: (op) => op,
  },
  {
    // Wave 7's one bump (docs/design-v1-dice.md 12, docs/design-v1-roll-request.md
    // 7.5), made by the first wave 7 build that landed, the dice's. Its new ops
    // (`sys.dice`, which the server stores in place of each roll) are new
    // shapes, and every older op keeps its shape, so the step is the identity.
    // Every wave 7 rule that must replay older ops by their old rules, such
    // as an answer's provenance, gates on this same number.
    //
    // Deploy: back up the database just before (README, Updating). The first
    // op after it is stored at version 7, and the shutdown writes version 11
    // snapshots. Rollback: an older build refuses to migrate a version 7 op
    // or a version 11 snapshot down (runMigrations), so those rooms would
    // not load there. Going back restores that backup, losing the play since.
    from: 6,
    to: 7,
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

/**
 * Whether healing, or a set of current HP above 0, brings a dead creature
 * back (RoomSettings.healRevives, absent read as on). Ops stored before
 * version 5 never did (step 4 to 5 above), whatever the setting reads now.
 * Every reader asks this, the rules and the client's lines alike, so an
 * absent value means the same everywhere.
 */
export function healRevivesDead(settings: Pick<RoomSettings, "healRevives">, opVersion?: number): boolean {
  if (opVersion !== undefined && opVersion < 5) return false;
  return settings.healRevives !== false;
}

/**
 * Whether the DM's Revive gives a creature that is not alive exactly 1 HP.
 * Ops stored before version 5 kept the HP it held, at least 1 (step 4 to 5).
 */
export function reviveToOne(opVersion: number | undefined): boolean {
  return opVersion === undefined || opVersion >= 5;
}

/**
 * Whether a size change on the acting creature's turn records a resize's
 * stop, uncounted, with the old size on the earlier stops, rather than a
 * move's counted stop (step 5 to 6). Ops stored before version 6 did not.
 */
export function resizeStop(opVersion: number | undefined): boolean {
  return opVersion === undefined || opVersion >= 6;
}

/**
 * Whether a patch that sets one of an actor's stat block links clears the
 * other two (docs/design-v1-companion-stat-blocks.md 3.2, rule 1). Ops
 * stored before version 6 kept the others (step 5 to 6 above). Live ops
 * carry no stored version and take today's rule.
 */
export function oneLinkPerActor(opVersion: number | undefined): boolean {
  return opVersion === undefined || opVersion >= 6;
}

/**
 * Whether an answer records where it came from
 * (docs/design-v1-roll-request.md 7.5): the op's `tag` on the answer and
 * its line, and the DM's `mark` kept apart from what a DC gives. Ops
 * stored before version 7 wrote neither, and a DM's mark there overwrote
 * the result alone (step 6 to 7 above). They replay by that rule, so they
 * rebuild the very entities they made, with the same hashes, and every
 * stored undo guard still matches. Live ops carry no stored version and
 * take today's rule.
 */
export function answerProvenance(opVersion: number | undefined): boolean {
  return opVersion === undefined || opVersion >= 7;
}

/**
 * Whether a shape on a character's own actor keeps the character's AC and
 * speeds to put back when it ends, with the temporary HP Polymorph gave to
 * take away (W7B-P-9). Ops stored before version 7 did neither and replay
 * by that rule. Live ops carry no stored version and take today's rule.
 */
export function shapeKeepsOwnNumbers(opVersion: number | undefined): boolean {
  return opVersion === undefined || opVersion >= 7;
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
