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
export const SNAPSHOT_VERSION = 21;
export const OP_VERSION = 19;

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
  // The order setting (docs/design-v1-combat-flow.md 11.4): the setting, `InitEntry.hadTurn` and `DiceRoll.hidden` are
  // optional fields whose absence reads as before, so a v11 room is a v12 room as it is. The number moves so that an
  // older build, which would ignore them and send players every row and roll the DM kept from them, refuses a v12
  // snapshot instead.
  { from: 11, to: 12, apply: (state) => state },
  // A Universal VTT import's mark (Scene.gridFromFile, docs/design-v1-grid-detect.md section 6) is an optional field
  // whose absence reads as before, so a v12 room is a v13 room as it is. The number moves so that an older build, whose
  // strict state schema refuses the field, refuses a v13 snapshot instead of failing on the scene.
  { from: 12, to: 13, apply: (state) => state },
  // The dragon turtle's SRD id was `dragon-tur-t-le` until the SRD import took the name from the stat block instead of
  // the index's kerning gaps. Rooms and backups from before name it that way wherever they name an SRD monster, so each
  // of those spots takes today's id (renameSrdIdsInState). An initiative row's group key keeps its spelling, since it
  // may be a name rather than an id (SRD_ID_FIELDS).
  { from: 13, to: 14, apply: (state) => renameSrdIdsInState(state) },
  // A Druid's known forms (Character.knownForms, docs/design-v1-known-forms.md 3.5) are an optional field whose absence
  // reads as before, so a v14 room is a v15 room as it is. The number moves so that an older build, whose strict state
  // schema refuses the field, refuses a v15 snapshot instead of failing on the character.
  { from: 14, to: 15, apply: (state) => state },
  // v15 had no players' asks for saves (docs/design-v1-player-save-spell.md 5.7). Rooms and backups from before them
  // start with none. The `cast` log line and an outcome's `cast` are new, and nothing stored names them.
  {
    from: 15,
    to: 16,
    apply: (state) => (state !== null && typeof state === "object" && !("casts" in state) ? { ...state, casts: {} } : state),
  },
  // Walking routes (docs/design-v1-movement.md 6.6): a path stop's `via`, `moved`, `cost`, `diag` and `routeSeen`, a
  // chunk's `rough` marks, an area's `slows` and a kept ruler's `walk` are optional fields whose absence reads as
  // before, so a v16 room is a v17 room as it is. The number moves so that an older build, whose strict state schema
  // refuses the fields, refuses a v17 snapshot instead of loading it under old rules.
  { from: 16, to: 17, apply: (state) => state },
  // Attached tokens (docs/design-v1-attach.md 8.6): a token's `attached`, a path stop's `carried`, a row's `skipRound`
  // and `markRound` and a turn start's `mounts` are optional fields whose absence reads as before, so a v17 room is a
  // v18 room as it is. The number moves so that an older build, whose strict state schema refuses the fields and whose
  // reducer would move a holder without what it carries, refuses a v18 snapshot instead of loading it under old rules.
  { from: 17, to: 18, apply: (state) => state },
  // v18 had no traps (docs/design-v1-traps.md 6.6). Rooms and backups from before them start with none and both trap
  // logs empty. The number moves so that an older build, whose strict state schema refuses them, refuses a v19
  // snapshot instead of loading it without its traps.
  {
    from: 18,
    to: 19,
    apply: (state) => {
      if (state === null || typeof state !== "object" || ("traps" in state && "trapLog" in state && "trapSeen" in state)) return state;
      return { ...state, ...(!("traps" in state) ? { traps: {} } : {}), ...(!("trapLog" in state) ? { trapLog: [] } : {}), ...(!("trapSeen" in state) ? { trapSeen: [] } : {}) };
    },
  },
  // A character's D&D Beyond sync record (Character.ddbSync, docs/design-v1-resync.md 4) is an optional field whose
  // absence reads as before, so a v19 room is a v20 room as it is. The number moves so that an older build, whose
  // strict state schema refuses the field, refuses a v20 snapshot instead of failing on the character.
  { from: 19, to: 20, apply: (state) => state },
  // The log keeps each audience's lines apart (op version 19, shared/logRings.ts): a party line's copies carry their
  // reader in `to`, and a shared line the readers of its parts in `parts`, a new optional field. A v20 room holds
  // neither and is a v21 room as it is. The number moves so that an older build, which would show a copy and its `to`
  // to whoever plays its creature then, refuses a v21 snapshot instead of loading it.
  { from: 20, to: 21, apply: (state) => state },
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
  {
    // v7 ops ran before a row recorded that its turn had come
    // (`InitEntry.hadTurn`, docs/design-v1-combat-flow.md 11.4). Replayed
    // under a rule that records it, a turn advanced or passed on by a
    // removal would leave the encounter and its history holding a field
    // they did not hold then, and a later restore's guard would no longer
    // match. Their shape is unchanged, so as in step 4 to 5, replay hands
    // the reducer the stored version (`marksHadTurn`), and a v7 op makes the
    // state it made then. The new `initiative` mark on a roll is a field an
    // older build's strict schema refuses in a stored `sys.dice`, which the
    // version makes that build refuse cleanly instead.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 8, and the shutdown writes version 12 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 7,
    to: 8,
    apply: (op) => op,
  },
  {
    // `scene.create` takes a Universal VTT import's mark (`gridFromFile`,
    // docs/design-v1-grid-detect.md section 6). Older ops lack it and
    // replay as they were, so the step is the identity. An older build's
    // strict schema refuses the mark in a stored create, which the version
    // makes that build refuse cleanly instead.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 9, and the shutdown writes version 13 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 8,
    to: 9,
    apply: (op) => op,
  },
  {
    // The dragon turtle's SRD id, as in snapshot step 13 to 14: a v9 op
    // names it `dragon-tur-t-le` wherever it names an SRD monster, and
    // takes today's id there (renameSrdIdsInOp). A group key keeps its
    // spelling, as in the room. A stored restore keeps its guards, though a
    // hash guard may have hashed a value that held the old id, which no
    // migrated room holds. Replay hands the reducer the stored version
    // instead, as in step 3 to 4, and a v9 guard also matches the entity
    // spelled the old way (`oldSrdIdGuards`, `withOldSrdIds`). So a guard
    // still refuses a change that really happened since. A v9 op that keys a
    // new row by its token's SRD id keys it by the old spelling, as its
    // build did (`storedSrdId`), so the rows a later guard hashed come back
    // as they were.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 10, and the shutdown writes version 14 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), and it would not know the new id anyway, so going
    // back restores that backup, losing the play since.
    from: 9,
    to: 10,
    apply: (op) => renameSrdIdsInOp(op),
  },
  {
    // `character.update` takes a Druid's known forms (`knownForms`,
    // docs/design-v1-known-forms.md 3.5). Older ops lack them and replay as
    // they were, so the step is the identity, and no rule gates on it. An
    // older build's strict schema refuses the field in a stored update,
    // which the version makes that build refuse cleanly instead.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 11, and the shutdown writes version 15 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 10,
    to: 11,
    apply: (op) => op,
  },
  {
    // A player's ask for saves (docs/design-v1-player-save-spell.md 5.7):
    // two new ops, `cast.ask` and `cast.close`, and an optional `cast` on
    // `actor.outcome`. No older op names a cast, and an outcome without one
    // applies as before, so the step is the identity and no rule gates on
    // it. An older build's strict schemas refuse the new ops and field,
    // which the version makes that build refuse cleanly instead.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 12, and the shutdown writes version 16 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 11,
    to: 12,
    apply: (op) => op,
  },
  {
    // Walking routes (docs/design-v1-movement.md 6.6): `token.move` may
    // carry a `route`, `build.rough` marks difficult ground, an area may
    // carry `slows`, a kept ruler `walk`, and a restore `routes`. No older op
    // holds any of them, so the step is the identity. What the reducer
    // writes on its own, a path stop's `moved`, `cost`, `diag`, `via` and
    // `routeSeen` and the sums of a join, it writes only from this version
    // (walksRoutes), so an older op's token and its restore guard replay
    // bit for bit as before. So does the area sweep along a leg.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 13, and the shutdown writes version 17 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 12,
    to: 13,
    apply: (op) => op,
  },
  {
    // Attached tokens (docs/design-v1-attach.md 8.6): `token.attach` and
    // `token.detach` are new, and no older op names them, so the step is the
    // identity. What the reducer writes on its own, a holder's group moving
    // with it, the link pass, a carried leg's mark, a mount's path and its
    // turn's `mounts`, `skipRound` and `markRound`, it writes only from this
    // version (`attaches`). Older ops never meet a link, so the gate changes
    // nothing they did and keeps the boundary exact.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 14, and the shutdown writes version 18 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 13,
    to: 14,
    apply: (op) => op,
  },
  {
    // Traps (docs/design-v1-traps.md 6.6): the trap ops, `door.set`'s `by`
    // and `actor.outcome`'s `trap` are new, which an older build's strict
    // schemas refuse. No op stored before can meet a trap, so replay of an
    // older op writes no trap field. The one rule traps change for every
    // move, the area sweep of a teleport, keeps today's straight sweep below
    // this version (`trapsGoOff`). A player's open without `by` is a
    // permission rule, which replay does not run.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 15, and the shutdown writes version 19 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 14,
    to: 15,
    apply: (op) => op,
  },
  {
    // Re-sync from D&D Beyond (docs/design-v1-resync.md 4): `character.update`
    // gains `ddbSync` in its patch and `expect` beside it, which an older
    // build's strict schemas refuse. No op stored before names either, so
    // the step is the identity. What the reducer writes on its own, a
    // record's `at` and the record's removal with the block, it writes only
    // from this version (`syncsFromDdb`). `expect` is checked where ops
    // arrive, never on replay.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 16, and the shutdown writes version 20 snapshots.
    // Rollback: an older build refuses to migrate either down
    // (runMigrations), so going back restores that backup, losing the play
    // since.
    from: 15,
    to: 16,
    apply: (op) => op,
  },
  {
    // Follow-up batch 20 (docs/design-v1-traps.md 6.6, docs/design-v1-attach.md
    // 8.6): no op changes shape, so the step is the identity. Two rules the
    // reducer replays an op by change from this version: a stopping trap
    // stops a walker at the first spot at or after it goes off where it may
    // stand, a pit that opens under one that fits in it once it lies wholly
    // over the opening (`stopsOnTrap`), and a walk that leaves a holder on
    // the ground starts on the ground under its own footprint
    // (`walksOffFromGround`).
    // Older ops replay by the rules they were written under, so a stored
    // restore's hash guards still match.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 17, and the shutdown writes version 20 snapshots, as
    // before. Rollback: an older build refuses to migrate a version 17 op
    // down (runMigrations), so a room whose log holds one after its last
    // snapshot would not load there. A clean shutdown writes a snapshot
    // after the last op, and an older build loads it, since nothing stored
    // changed shape. So only a room with version 17 ops after its last
    // snapshot needs the backup from before the deploy.
    from: 16,
    to: 17,
    apply: (op) => op,
  },
  {
    // Follow-up batch 21 (docs/design-v1-attach.md 7.1 and 8.6, reviews
    // FU21A-OP-1 and FU21A-OP-2): no op changes shape, so the step is the
    // identity. Two rules the reducer replays an op by change from this
    // version: a rider whose initiative row some player cannot see shares
    // no turn with its mount and leads no mount's row, at a controlled ride,
    // at a turn's start and at an undo that puts a ride back
    // (`hiddenRowsShareNoMount`), and a Next that reveals a hidden row
    // writes a new row, so Previous puts back the hidden one
    // (`revealsRowAnew`). Older ops replay by the rules they were written
    // under, so a stored restore's hash guards still match.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 18, and the shutdown writes version 20 snapshots, as
    // before. Rollback: an older build refuses to migrate a version 18 op
    // down (runMigrations), so a room whose log holds one after its last
    // snapshot would not load there. A clean shutdown writes a snapshot
    // after the last op, and an older build loads it, since nothing stored
    // changed shape. So only a room with version 18 ops after its last
    // snapshot needs the backup from before the deploy.
    from: 17,
    to: 18,
    apply: (op) => op,
  },
  {
    // Follow-up batch 23 (design 7.3, Log): no op changes shape, so the
    // step is the identity. The log keeps each audience's lines apart from
    // this version (`logsByAudience`, shared/logRings.ts), each line's
    // readers fixed by the real projection of the room as its op leaves it
    // (lineReach): a line no player could read counts on from DM_LINE_BASE,
    // one only some players could read is such a line, with a copy for each
    // reader in their own run from PARTY_LINE_BASE, and each ring drops only
    // its own oldest, so a line one viewer never receives never moves
    // another's. Older ops replay by the one ring they were written under,
    // so their line ids are the ones the archive holds, and the reducer's
    // reads of the log, such as an area's once a turn, answer as they did.
    //
    // Deploy: back up the database just before. The first op after it is
    // stored at version 19, and the shutdown writes version 21 snapshots
    // (snapshotMigrations). Rollback: restore the backup taken before the
    // deploy, as for any snapshot version bump. An older build refuses a
    // version 21 snapshot and a version 19 op (runMigrations), so it never
    // shows a copy or the readers it names to a player.
    from: 18,
    to: 19,
    apply: (op) => op,
  },
];

/**
 * SRD ids an earlier import spelled wrong, each with the id the SRD data
 * has now (snapshot step 13 to 14, op step 9 to 10). The import took the
 * dragon turtle's name from the SRD's index of stat blocks, whose kerning
 * gaps split it ("Dragon Tur t le").
 */
const RENAMED_SRD_IDS: ReadonlyMap<string, string> = new Map([["dragon-tur-t-le", "dragon-turtle"]]);
/** The other way round, for what a build from before the rename wrote. Today's ids were no SRD id then. */
const OLD_SRD_IDS: ReadonlyMap<string, string> = new Map([...RENAMED_SRD_IDS].map(([old, now]) => [now, old]));

/**
 * The fields that hold an SRD id (shared/model.ts): an actor's `srdId`, a
 * saved encounter monster's and `monster.setSrdImage`'s `srdId`, and a
 * companion block's `fromSrd`. An HP log line's `shapeTemp` names shapes by
 * SRD id too, in `before` and `after`. An SRD image is keyed by its SRD id,
 * and names it as its `id`.
 *
 * An initiative row's `groupKey` is left as it was stored. It is the SRD id
 * that identical monsters share, or else a base name, and a monster named
 * `dragon-turtle` gave its row that key before the rename too. So the old
 * spelling could not be told back from a renamed key, and an older undo's
 * guard over the fight would stop matching. The tracker reads a stored old
 * id as today's instead (`todaysSrdId`, rowGroup in
 * shared/rules/initiative.ts).
 *
 * A character's `knownForms` is a list of SRD ids (SRD_ID_LIST_FIELDS).
 */
const SRD_ID_FIELDS: ReadonlySet<string> = new Set(["srdId", "fromSrd"]);
/** The fields that hold a list of SRD ids, each once: a character's known forms (docs/design-v1-known-forms.md 3.4). */
const SRD_ID_LIST_FIELDS: ReadonlySet<string> = new Set(["knownForms"]);

/** The parts of a room that can name an SRD monster, besides `srdImages`. A fight's rows name none but their group keys. */
const SRD_NAMING_FIELDS = ["tokens", "characters", "savedEncounters", "companionBlocks", "log"] as const;

const SRD_IMAGE_KEY = "srdImage:";

type IdMap = ReadonlyMap<string, string>;

function mappedId(id: unknown, ids: IdMap): unknown {
  return typeof id === "string" ? (ids.get(id) ?? id) : id;
}

/**
 * The value with every SRD id field at any depth mapped, and the very same
 * value where it names none of the ids, so a room or op without one is
 * left as it was.
 */
function withMappedSrdIds(value: unknown, ids: IdMap): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = withMappedSrdIds(item, ids);
      if (next !== item) (out ??= [...value])[i] = next;
    });
    return out ?? value;
  }
  let out: Record<string, unknown> | undefined;
  for (const [field, item] of Object.entries(value)) {
    const next = SRD_ID_FIELDS.has(field)
      ? mappedId(item, ids)
      : SRD_ID_LIST_FIELDS.has(field)
        ? mappedIdList(item, ids)
        : field === "shapeTemp"
          ? mappedShapes(item, ids)
          : withMappedSrdIds(item, ids);
    if (next !== item) (out ??= { ...value })[field] = next;
  }
  return out ?? value;
}

/**
 * A list of SRD ids with each mapped, then repeats dropped in order,
 * keeping the first, so a list that held both spellings of one creature
 * holds it once: the protocol's schema refuses a repeat, and a replayed op
 * that held one would leave its room read-only. A list that names none of
 * the ids is the very same list.
 */
function mappedIdList(list: unknown, ids: IdMap): unknown {
  if (!Array.isArray(list)) return list;
  const mapped = list.map((id: unknown) => mappedId(id, ids));
  if (mapped.every((id, i) => id === list[i])) return list;
  return mapped.filter((id, i) => mapped.indexOf(id) === i);
}

/** An HP log line's `shapeTemp`, which names the shapes before and after by SRD id. An actor's own is `true`. */
function mappedShapes(pool: unknown, ids: IdMap): unknown {
  if (pool === null || typeof pool !== "object" || Array.isArray(pool)) return pool;
  let out: Record<string, unknown> | undefined;
  for (const side of ["before", "after"]) {
    const id = (pool as Record<string, unknown>)[side];
    const next = mappedId(id, ids);
    if (next !== id) (out ??= { ...pool })[side] = next;
  }
  return out ?? pool;
}

function srdImageWithId(image: unknown, id: string): unknown {
  return image !== null && typeof image === "object" && !Array.isArray(image) ? { ...image, id } : image;
}

/**
 * A room's `srdImages` keyed and identified by today's ids. Where a room
 * holds both spellings, the old one's choice wins: the monster browser
 * offered only that one, so the other came from no DM's pick.
 */
function renamedSrdImages(images: unknown): unknown {
  if (images === null || typeof images !== "object" || Array.isArray(images)) return images;
  const entries = Object.entries(images);
  if (!entries.some(([id]) => RENAMED_SRD_IDS.has(id))) return images;
  const out: Record<string, unknown> = {};
  for (const [id, image] of entries) if (!RENAMED_SRD_IDS.has(id)) out[id] = image;
  for (const [id, image] of entries) {
    const to = RENAMED_SRD_IDS.get(id);
    if (to !== undefined) out[to] = srdImageWithId(image, to);
  }
  return out;
}

function renameSrdIdsInState(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const room = state as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const field of SRD_NAMING_FIELDS) {
    const next = withMappedSrdIds(room[field], RENAMED_SRD_IDS);
    if (next !== room[field]) (out ??= { ...room })[field] = next;
  }
  const images = renamedSrdImages(room.srdImages);
  if (images !== room.srdImages) (out ??= { ...room }).srdImages = images;
  return out ?? state;
}

/** An op with its SRD ids renamed. A restore's entry for an SRD image is keyed and identified by the new id too. */
function renameSrdIdsInOp(op: unknown): unknown {
  const renamed = withMappedSrdIds(op, RENAMED_SRD_IDS);
  if (renamed === null || typeof renamed !== "object" || !("t" in renamed)) return renamed;
  const o = renamed as { t: unknown; entries?: unknown };
  if (o.t !== "sys.restore" || !Array.isArray(o.entries)) return renamed;
  const stored: unknown[] = o.entries;
  const entries = stored.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    const e = entry as { key?: unknown; value?: unknown };
    const to = typeof e.key === "string" && e.key.startsWith(SRD_IMAGE_KEY) ? RENAMED_SRD_IDS.get(e.key.slice(SRD_IMAGE_KEY.length)) : undefined;
    return to === undefined ? entry : { ...e, key: `${SRD_IMAGE_KEY}${to}`, value: srdImageWithId(e.value, to) };
  });
  return entries.some((entry, i) => entry !== stored[i]) ? { ...o, entries } : renamed;
}

/**
 * A live op with every retired SRD id it names spelled as today's, and the
 * very same op where it names none. A page left open across op step 9 to
 * 10 still sends the old ids, and an op stored at version 10 never runs
 * that step again, so the room would keep a retired id for good: a token
 * with no stat block and no icon, even after a reload. Renaming rather than
 * refusing keeps the old page's action working.
 */
export function withTodaysSrdIds<T extends Op>(op: T): T {
  return renameSrdIdsInOp(op) as T;
}

/**
 * Whether a stored restore's hash guards were taken over values that named
 * SRD monsters by their ids before op step 9 to 10, so the reducer also
 * matches them against `withOldSrdIds` of what the room holds now. Live ops
 * carry no stored version and take today's rule.
 */
export function oldSrdIdGuards(opVersion: number | undefined): boolean {
  return opVersion !== undefined && opVersion < 10;
}

/** An entity of the room as a build from before op version 10 held it, its SRD ids spelled the old way. Group keys stay as stored. */
export function withOldSrdIds(key: string, value: unknown): unknown {
  if (key.startsWith(SRD_IMAGE_KEY)) {
    const old = OLD_SRD_IDS.get(key.slice(SRD_IMAGE_KEY.length));
    return old === undefined ? value : srdImageWithId(value, old);
  }
  return withMappedSrdIds(value, OLD_SRD_IDS);
}

/** Today's id for an SRD id an earlier import spelled wrong, else the id itself. */
export function todaysSrdId(id: string): string {
  return RENAMED_SRD_IDS.get(id) ?? id;
}

/**
 * An SRD id as the build that stored an op of this version spelled it: the
 * old way before op version 10, today's from it on and for a live op.
 * Replay keys a new initiative row by it (groupKeyFor), so the row is the
 * one that build wrote, since group keys are kept as stored.
 */
export function storedSrdId(id: string, opVersion: number | undefined): string {
  return opVersion !== undefined && opVersion < 10 ? (OLD_SRD_IDS.get(id) ?? id) : id;
}

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

/**
 * Whether a turn that starts marks its row as having had its turn
 * (`InitEntry.hadTurn`, step 7 to 8 above). Ops stored before version 8 did
 * not. Live ops carry no stored version and take today's rule.
 */
export function marksHadTurn(opVersion: number | undefined): boolean {
  return opVersion === undefined || opVersion >= 8;
}

/**
 * Whether a move records what its leg took on the turn's path (`moved`,
 * `cost`, `diag`), its corners (`via`) and whether players saw it whole
 * (`routeSeen`), and joins a full path's legs by those sums
 * (docs/design-v1-movement.md 6.2, 6.6). Ops stored before version 13 wrote
 * none of them and replay by that rule. Live ops carry no stored version
 * and take today's rule.
 */
export function walksRoutes(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 13);
}

/**
 * Whether the reducer writes what attached tokens add on its own
 * (docs/design-v1-attach.md 8.6): a holder's move carrying its group, the
 * link pass, a carried leg's mark, a mount's path, a turn's `mounts`, a
 * row's `skipRound` and `markRound`, and Next's Reaction for a mount. Ops
 * stored before version 14 wrote none of them and replay by that rule.
 * Live ops carry no stored version and take today's rule.
 */
export function attaches(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 14);
}

/**
 * Whether the reducer writes what traps add on its own
 * (docs/design-v1-traps.md 6.6): springings on walks, landings, turns and
 * doors, their stops, occurrences, lines and actions, and an area reminder
 * that sweeps a teleport only where it lands. Ops stored before version 15
 * met no trap and swept a teleport's straight leg, and replay by that rule.
 * Live ops carry no stored version and take today's rule.
 */
export function trapsGoOff(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 15);
}

/**
 * Whether the reducer writes what a D&D Beyond sync record adds on its own
 * (docs/design-v1-resync.md 4): the record's `at` from the op's time, and
 * the record's removal when the block goes. Ops stored before version 16
 * met no record and replay by that rule. Live ops carry no stored version
 * and take today's rule.
 */
export function syncsFromDdb(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 16);
}

/**
 * Whether a stopping trap stops a walker at the first spot at or after it
 * goes off where the walker may stand, what it meets up to there counting,
 * and a pit that opens stops one that fits in it wholly over the opening
 * (docs/design-v1-traps.md 5.5, reviews LP13-TR-2 and FU20A-OP-2). Ops
 * stored before version 17 stopped at the latest such spot at or before it
 * and replay by that rule. Live ops carry no stored version and take
 * today's rule.
 */
export function stopsOnTrap(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 17);
}

/**
 * Whether a walk that leaves a holder on the ground starts on the ground
 * under the walker's own footprint rather than at its seat
 * (docs/design-v1-attach.md 8.0, reviews LP12-AT-4 and FU20A-OP-7). Ops
 * stored before version 17 started at the seat and replay by that rule.
 * Live ops carry no stored version and take today's rule.
 */
export function walksOffFromGround(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 17);
}

/**
 * Whether a controlled mount shares its rider's turn, and follows its
 * rider's row, only while every player's tracker shows that row
 * (docs/design-v1-attach.md 7.1, reviews FU21A-OP-1 and FU21A-OP-2), so a
 * row the DM hid never reaches players through the mount's row. Ops stored
 * before version 18 read the two tokens alone and replay by that rule. Live
 * ops carry no stored version and take today's rule.
 */
export function hiddenRowsShareNoMount(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 18);
}

/**
 * Whether a Next that reveals a hidden row on its turn writes the row anew
 * (review FU21A-OP-8). Ops stored before version 18 changed it in place,
 * and a row that kept its spent Reaction was then the very row the state
 * before held and Previous's snapshot kept, so Previous put it back
 * revealed. They replay by that rule. Live ops carry no stored version and
 * take today's rule.
 */
export function revealsRowAnew(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 18);
}

/**
 * Whether the log keeps each audience's lines apart (shared/logRings.ts):
 * the DM's lines numbered from DM_LINE_BASE, and each ring dropping only
 * its own oldest. Ops stored before version 19 wrote every line into one
 * ring of 200, numbered in order, and replay by that rule. Live ops carry
 * no stored version and take today's rule.
 */
export function logsByAudience(opVersion: number | undefined): boolean {
  return !(opVersion !== undefined && opVersion < 19);
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
