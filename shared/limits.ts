import { roomHandoutPages } from "./handouts.ts";
import { isWritable } from "./writable.ts";
import { CHUNK_CELLS, HEIGHTS_CHARS, type BuildChunk, type CompanionBlock, type CustomMonster, type JournalPage, type RoomState, type Scene, type Token } from "./model.ts";
import { ownEntry } from "./records.ts";
import { floorsOf, openFloor } from "./rules/floors.ts";
import type { SoundUse } from "./sound.ts";
import { drawnSize, type VideoGeometry, type VideoShape } from "./videoGeometry.ts";

/**
 * Room limits (design section 10.5). Open room creation means every room is
 * bounded, and the actor refuses with `quota` past these. Per-op bounds (2,000
 * cells per build op, 500 draft ops) live in the protocol schemas and the
 * reducer. The byte limits are checked by the server on its own schedule,
 * because serializing 8 MiB on every op would cost more than it protects.
 */
export const LIMITS = {
  scenesPerRoom: 50,
  sceneCells: 200,
  tokensPerScene: 500,
  charactersPerRoom: 50,
  /** Characters one player may own when the room lets players create their own (shared/permissions.ts). */
  charactersPerPlayer: 3,
  /**
   * A character's companions on one scene (docs/design/design-v1-combat-flow.md
   * 3.6.3). Only a player's `token.create` counts them, and only on the
   * scene the new one goes to, so companions left on a scene the party
   * moved away from never block a new one.
   */
  companionsPerCharacter: 10,
  membersPerRoom: 50,
  templatesPerScene: 200,
  drawingsPerScene: 2_000,
  drawingPointValues: 2_000,
  drawingPointValuesPerScene: 100_000,
  labelsPerScene: 500,
  buildCellsPerOp: 2_000,
  fogDraftOpsPerScene: 500,
  handoutsPerRoom: 200,
  /**
   * Pages in one handout (docs/design/design-v1-pdf-handouts.md 3.7). A handout
   * pack is a few pages and a player's guide a few dozen, and the largest
   * show of them, with long ids and every recipient, stays under a quarter
   * of the socket's frame.
   */
  handoutPages: 100,
  /**
   * Handout pages in a room: every page of every document and of every
   * handout showing, one image as one page, so a document shown counts its
   * pages again while it shows (section 3.7). A page entry is about 90
   * bytes in every DM snapshot.
   */
  handoutPagesPerRoom: 2_000,
  monstersPerRoom: 200,
  /**
   * One custom monster, serialized. The longest SRD 5.2.1 stat block is
   * about 4.5 KB, so this leaves room for the biggest creature in any book.
   * The protocol bounds a create op by the same number.
   */
  monsterBytes: 16 * 1024,
  /** Every custom monster together, serialized: they ride in every DM snapshot. */
  monstersBytes: 1024 * 1024,
  /**
   * SRD monsters with a default image. The SRD has 330, and the reducer
   * checks only the shape of an SRD id, so this is what bounds the map: at
   * about 150 bytes each, it stays under 64 KB of every DM snapshot.
   */
  srdImagesPerRoom: 400,
  /**
   * Encounters saved in the builder. One is at most about 2.5 KB (20 kinds
   * of monster and a party of 10 levels), and they ride in every DM
   * snapshot, so this keeps them under 256 KB of it.
   */
  savedEncountersPerRoom: 100,
  /**
   * Rows of the running fight. An op adds at most 100 (MAX_ENTRIES_PER_OP) but
   * nothing else bounded the fight, so a room could outgrow the backup
   * schema and export a file it could not import. The schema's bounds on
   * everything keyed by a row (stateSchema.ts) follow this one, and it is far
   * above any table's fight, so no backup that imports today stops importing.
   */
  encounterRows: 2_000,
  /**
   * Companion stat blocks (docs/design/design-v1-companion-stat-blocks.md 3.4).
   * One block has the monsters' bound. A character keeps at most 100 and
   * 512 KiB of them, so 32 long blocks fill its bytes before its count. A
   * room keeps six characters at their caps, since 50 characters at theirs
   * would pass the state limit three times over. Blocks ride in every DM
   * snapshot on top of its 3 MiB for everything else (`projectedSceneBytes`
   * leaves them out), so a DM's snapshot is at most 6 MiB.
   */
  companionBlockBytes: 16 * 1024,
  companionBlocksPerCharacter: 100,
  companionBlockBytesPerCharacter: 512 * 1024,
  companionBlocksPerRoom: 600,
  companionBlocksBytes: 3 * 1024 * 1024,
  /**
   * A player's block saves (section 3.5): a burst of 10, then one every
   * 6 s. A save is up to 16 KiB and every op is stored, so the socket's 20
   * ops a second alone would let one player write about a quarter of a
   * megabyte a second. The DM's saves are not counted.
   */
  companionBlockWriteBurst: 10,
  companionBlockWriteRefillMs: 6_000,
  /**
   * A player character's stat block, serialized (docs/design/design-v1-pc-stats.md
   * 3.5). It rides on the character, which is sent whole on every HP
   * change, so it stays small: a wizard's 32 rolls take about 6.3 KB, and
   * 50 characters at the cap are 600 KiB of a DM's 3 MiB scene.
   */
  pcStatsBytes: 12 * 1024,
  /**
   * A character's record of its last D&D Beyond sync, serialized
   * (docs/design/design-v1-resync.md 2.1). It rides on the character beside the
   * block, and one at every bound is about 4.8 KB.
   */
  ddbSyncBytes: 6 * 1024,
  stateBytes: 8 * 1024 * 1024,
  projectedSceneBytes: 3 * 1024 * 1024,
  areaFeetMin: 5,
  areaFeetMax: 1_000,
  customTokenCellsMin: 0.5,
  customTokenCellsMax: 20,
  loadedRooms: 50,
  loadedRoomsPerCreatorIp: 10,
  /**
   * Free walls (docs/design/design-v1-maps-vision.md section 2.4). A scene of them
   * is about 300 KB. 500 doors serialize to about 73 KB, past the 64 KiB
   * frame, so the byte bound is the one that binds an op.
   */
  freeWallsPerScene: 4_000,
  freeWallsPerOp: 500,
  freeWallsOpBytes: 48 * 1024,
  /**
   * The split of the derived wall set at every crossing (section 2.1):
   * candidate pairs it may test and pieces it may add, on every scene. The
   * counting pass in shared/rules/segments.ts checks them before anything
   * is built, on every op that writes geometry. The pieces cap came down to
   * 5,000 when scripts/bench-walls.ts put the densest build at every cap
   * past the derive budget: the split's added pieces were its largest part.
   */
  splitPairsPerScene: 100_000,
  splitPiecesPerScene: 5_000,
  /**
   * Pillar cells per scene (docs/design/design-v1-maps-vision.md 2.4). Each is four
   * stored wall segments that every derive of the scene's walls and every
   * counting pass reads, and no other limit bounds how many a build paints:
   * a pillar in every cell is 160,000 segments, well past the geometry
   * budgets. scripts/bench-walls.ts sizes it on the densest grid walls a
   * build can have, with free walls at the split's caps.
   */
  pillarsPerScene: 1_000,
  /**
   * Door and window edges per scene, on the grid or free, secret doors
   * included (docs/design/design-v1-maps-vision.md 2.4). Plain walls merge into
   * runs, but a door or window stays one stored segment and one entry in
   * every derive's lookups, so only the scene's byte size bounded them: tens
   * of thousands fit, past the geometry budgets. A real map has a few
   * hundred. scripts/bench-walls.ts sizes it beside the pillar cap.
   */
  doorsAndWindowsPerScene: 1_000,
  /**
   * Drawn edges per scene: every edge entry a scene's chunks store, walls,
   * doors, windows and removed automatic walls alike, so doors and windows
   * count here too (docs/design/design-v1-maps-vision.md 2.4). Each is an entry the
   * derive merges into its lookups on every derive, whatever it holds, and
   * only the scene's byte size bounded them: a wall on all 80,000 edges of a
   * 200 x 200 scene fits. scripts/bench-walls.ts sizes it beside the pillar
   * and door caps, and 20,000 leaves room for a large imported map whose
   * walls snap to the grid, one edge per cell.
   */
  drawnEdgesPerScene: 20_000,
  stampsPerScene: 500,
  stampsPerOp: 100,
  lightsPerScene: 100,
  lightsPerOp: 100,
  /** Map phases per scene, the active one included (section 3.4). */
  phasesPerScene: 8,
  folderNameChars: 40,
  /**
   * Floors in one scene (docs/design/design-v1-floors.md 11). Every floor is
   * a scene record, so each counts toward scenesPerRoom, and a scene's
   * floors share one scene's byte budget and its token and area caps.
   */
  floorsPerScene: 8,
  floorNameChars: 40,
  /** A scene thumbnail upload, and its stored long side (section 3.3). */
  thumbUploadBytes: 512 * 1024,
  thumbMaxPx: 320,
  /**
   * Party vision (wave 4, docs/design/design-v1-maps-vision.md 2.4). Past the
   * source cap nothing is refused: the first sources in a fixed order lend
   * sight and the rest stay shown (shared/rules/vision.ts). Senses parsed
   * from an actor's senses line stop at the SRD's longest darkvision.
   */
  partySourcesPerScene: 12,
  senseMaxFt: 150,
  /**
   * The cells a sense and each light radius reach at most, beside their caps
   * in feet: 150 ft and 120 ft are 30 and 24 cells at 5 ft per cell, so on
   * any grid of 5 ft or more the feet bind first and these change nothing.
   * On a finer grid a light or a sense would cover more cells, and so sweep
   * more walls, than the server-box gate measured: at 1 ft per cell a
   * room's first snapshot took 368 ms on a laptop, about 550 ms on the
   * reference server against 250 (docs/design/design-v1-maps-vision.md 2.4 and
   * 4.3.6). So there they stop at these, and what they cost is the same at
   * every scale.
   */
  senseMaxCells: 30,
  lightRadiusMaxCells: 24,
  /**
   * Tokens on one scene carrying a light that gives any (Token.light), not
   * counting tokens the DM hid (countsAsLitTokenLight). Only the DM's ops are
   * refused past it. A player's torch and a hidden combatant revealed on its
   * turn can pass it, and sight then lights only this many, in the order of
   * shared/rules/vision.ts.
   */
  litTokenLightsPerScene: 20,
  /**
   * Pieces of the split wall set that could block sight, on a scene with
   * vision on, counted whatever the doors' states (section 2.1). Only build
   * ops and turning vision on can raise it, so a door never gets `quota`.
   * Lowered from 8,000 by the server-box gate (section 4.3.6): at 8,000 a
   * room's first snapshot, which computes sight from nothing, took 267 ms
   * on the reference server against 250. No deployed scene had vision, so
   * lowering it left no scene over it.
   */
  sightPiecesPerScene: 6_000,
  /** Cells one `build.height` or `build.stairs` op paints (section 2.4). */
  heightCellsPerOp: 2_000,
  /**
   * Players who see and remember for themselves on one per-player scene
   * (docs/design/design-v1-per-player-vision.md 6.1): the entries of its holder
   * list that are on. The rest have the shared sight. 6 if the server box
   * passes the design's timing rows at the worst legal ownership, else 5.
   * Only a live op meets it: checkLimits refuses one that turns on more
   * than this, and the server's explore step joins no more. The schemas and
   * the reducer bound lists, picks and joins by MOST_SIGHT_HOLDERS instead,
   * so lowering it never refuses a room or an op stored under it, nor stops
   * one replaying (review PV1-ASTRA-4).
   */
  sightHoldersPerScene: 6,
  /**
   * One layer's memory of one scene (docs/design/design-v1-map-discovery.md 5.5):
   * the party's, or a holder's own, in charged bytes. The size guard
   * reserves each memory at this cap, or at its share of a full room,
   * never at its size, and past it the map step forgets whole fog tiles.
   */
  memoryBytesPerLayer: 64 * 1024,

  // Wave 5 (docs/design/design-v1-dm-tools.md 2.4).

  /**
   * Journal pages (section 3.7). They are room level, so they ride in every
   * DM snapshot beside the monsters, and the size guard counts them in
   * every scene's projected size (server/rooms/sizeGuard.ts).
   */
  journalPagesPerRoom: 200,
  journalBlocksPerPage: 100,
  journalBlockChars: 4_000,
  /** One page, serialized. The protocol bounds an op that carries a page's blocks by the same number. */
  journalPageBytes: 32 * 1024,
  /** Every page together, serialized. */
  journalBytes: 1024 * 1024,
  /** Map pins (section 3.8). */
  pinsPerScene: 200,
  /** Roll requests (section 3.3): open at once in a room, creatures each, and choices each. */
  openRollsPerRoom: 20,
  /** A player's asks for saves (docs/design/design-v1-player-save-spell.md 5.4): waiting at once per member, and in a room. */
  castsPerMember: 3,
  openCastsPerRoom: 20,
  rollTargets: 50,
  rollChoices: 2,
  rollNoteChars: 80,
  rollDcMin: 1,
  rollDcMax: 50,
  rollTotalMin: -50,
  rollTotalMax: 100,
  /** Tokens one `token.updateMany` or `token.deleteMany` names, and adds and removals one `actor.effects` holds (section 3.5). */
  tokensPerManyOp: 100,
  effectsPerManyOp: 100,
  /**
   * One `actor.outcome` (docs/design/design-v1-roll-options.md 8, Appendix A): the
   * most creatures one group save takes, the conditions and removals each
   * may carry, and its serialized bytes, so 100 creatures with two
   * conditions each fit under the socket's 64 KiB frame.
   */
  outcomeTargets: 100,
  outcomeEffectsEach: 3,
  outcomeOpBytes: 56 * 1024,
  /**
   * Table displays (section 3.1): connected per room, live codes per room,
   * how long a code lives, and the wrong codes one address may try in its
   * own bucket before the growing delays. A display session ends 30 days
   * after its last socket closed.
   */
  displaysPerRoom: 4,
  liveDisplayCodesPerRoom: 3,
  displayCodeMinutes: 10,
  displayCodeFailuresPer10Min: 20,
  displaySessionDays: 30,
  /** The X-card (section 3.11), in memory only: taps in one room merge within this window, and one session sends at most so many an hour. */
  xcardMergeMs: 10_000,
  xcardPerSessionPerHour: 6,
  /**
   * Openverse (section 3.13). Server-wide budgets under Openverse's own,
   * anonymous and registered, then per member and room, per room, and a
   * loose per-address flood cap, since the table shares one address.
   */
  openverseAnonPerDay: 150,
  openverseAnonPerMinute: 15,
  openverseAnonPageSize: 20,
  openverseRegisteredPerDay: 5_000,
  openverseRegisteredPerMinute: 80,
  openverseRegisteredPageSize: 40,
  openverseMemberPerDay: 20,
  openverseRoomPerDay: 60,
  openverseIpPerDay: 150,
  /** The longest attribution an Openverse credit keeps. */
  creditAttributionChars: 400,
  /**
   * The session log export (section 3.10): every listing and export request
   * per member and room, one export at a time per room, and a per-address
   * flood cap. A gap this long between two lines starts a new session.
   */
  logExportsPerHour: 10,
  logExportsPerIpPerHour: 60,
  logSessionGapHours: 4,
  /** The admin login (section 3.18): failures per address, and across the site, before it closes. */
  adminLoginFailuresPer15Min: 5,
  adminLoginSiteFailuresPerHour: 50,
  adminSessionHours: 12,
  /** Backups (section 3.17): good dumps kept, and the free space every run leaves on the backups volume. */
  backupDailyKept: 7,
  backupWeeklyKept: 4,
  backupFreeFloorBytes: 2 * 1024 * 1024 * 1024,
  /**
   * Image cleanup (section 3.19): how long a replaced thumbnail and a file no
   * row names wait, how long a deleted file waits in the trash, and the
   * images one library delete names.
   */
  thumbUnusedDays: 1,
  orphanFileDays: 1,
  trashHours: 48,
  libraryDeleteMax: 500,

  // Wave 7: dice (docs/design/design-v1-dice.md 3.2 and 4.4).

  /**
   * One `dice.roll`: its rolls, its dice after every mode, and its size
   * serialized. A 3 KiB op makes a `dice` line of at most about 4.5 KB, near
   * the longest line the log holds today, so a larger group goes in batches.
   */
  diceRollsPerOp: 20,
  diceOpBytes: 3 * 1024,
  dicePerOp: 100,
  /** The batches of one tag, numbered by `part` 0 to 19. */
  diceBatchesPerTag: 20,
  /** One formula: its terms, a die's sides, a number, its canonical text, a label, and `roll.dice`'s extra. */
  diceTermsPerFormula: 20,
  diceSidesMax: 1_000,
  diceNumberMax: 1_000,
  diceFormulaChars: 100,
  diceLabelChars: 60,
  diceExtraChars: 40,
  /**
   * Each member's budget of tagged ops (4.4): a player's 20 then one every
   * 2 s, a DM's 100 then two a second, whose group rolls come in bursts.
   */
  playerRollBurst: 20,
  playerRollRefillMs: 2_000,
  dmRollBurst: 100,
  dmRollRefillMs: 500,
  /**
   * Receipts (1.2): lookups per member and room an hour, receipts a room
   * holds younger than 24 hours, a player's share of them, the share kept
   * for the DMs whatever the players send, and of the older rows, how many
   * a room keeps and for how many days.
   */
  receiptLookupsPerHour: 60,
  receiptsPerDay: 10_000,
  receiptsPerPlayerDay: 2_000,
  receiptsDmFloor: 2_000,
  receiptsKeptOlder: 10_000,
  receiptDays: 7,

  // Attached tokens (docs/design/design-v1-attach.md 5.1).

  /**
   * A chain of carried tokens, counted in tokens: a torch held by a rider
   * on a horse is 3. A token carries at most `carriedPerToken` directly,
   * and a group, a holder with everything under it, is at most
   * `groupTokens`. The DM's attach counts the whole link graph and a
   * player's only what every player sees and the tokens the op names, so a
   * hidden link can let a group pass them. The scene's 500 tokens bound
   * every walk over the links whatever they hold.
   */
  attachDepth: 3,
  carriedPerToken: 8,
  groupTokens: 20,
  /** The mounts sharing one turn (TurnStart.mounts). A chain is 3 deep, so a turn's creature rides at most two. */
  turnMounts: 8,

  // Traps (docs/design/design-v1-traps.md 6.1 and 6.7).

  /** Traps on one scene, and a trap's own fields serialized: everything but what the reducer writes on it. */
  trapsPerScene: 50,
  trapBytes: 9 * 1024,
  /** A squares zone or a set of hit squares: rectangles of whole cells, each side at most 20, at most 400 cells in all. */
  trapRects: 8,
  trapRectSide: 20,
  trapCells: 400,
  /** A trip wire's length in cells. */
  trapWireMin: 0.5,
  trapWireMax: 20,
  /** A trap's actions, find checks, damage parts and conditions (the group save's 3 a creature, outcomeEffectsEach). */
  trapActions: 8,
  trapFindChecks: 2,
  trapDamageParts: 4,
  trapConditions: 3,
  /** Characters of a trap's players' line, its DM note, its disarm line and a check's `what`. */
  trapMessageChars: 200,
  trapNoteChars: 1_000,
  trapDisarmChars: 200,
  trapCheckChars: 80,
  /** Creatures the DM's Set it off names. */
  trapSpringTokens: 50,
  /**
   * Occurrences waiting for the DM: a trap's fourth drops that trap's own
   * oldest, then a room's eleventh the room's oldest. Each names at most 10
   * creatures that set it off and 50 it hits.
   */
  trapDuePerTrap: 3,
  trapDuePerRoom: 10,
  trapBy: 10,
  trapHits: 50,
  /** The DM's trap lines and the players', each log keeping its own newest, every line cut to `trapLineBytes` when written. */
  trapLogLines: 30,
  trapSeenLines: 20,
  trapLineBytes: 1_536,
  /**
   * The room log's lines held in memory beside its newest 200 shared ones
   * (shared/logRings.ts), none of them in the room's measures
   * (server/rooms/sizeGuard.ts), so a line a player cannot read never
   * decides whether their op passes:
   *
   * - The DM's own lines, a party line's own included, their newest 200,
   *   each cut to `apartLineBytes`: 1,600 KiB at most.
   * - Each member's newest whispers and each player's newest copies of
   *   party lines, the lines only some players read: 50 of each, and at
   *   most 640 KiB of each over the whole roster. A member keeps a share of
   *   both by the roster's size, `whispersPerRoom` and `whisperBytesPerRoom`
   *   or `partyLinesPerRoom` and `partyLineBytesPerRoom` over the members,
   *   so a room keeps at most that much of each however many join. A copy
   *   is cut to `apartLineBytes` as well, and the longest whisper fits it.
   *
   * Each byte budget is about what the old single ring could hold: 200
   * lines of the longest text, 1,000 letters of three bytes, about 3.2 KB a
   * line, took about 620 KiB. So the log keeps at most about 2.8 MiB
   * outside the measures, beside the shared lines the measures count.
   *
   * These bounds decide which lines a logged op keeps and drops, so changing
   * one changes how ops replay: it needs a new op version (shared/migrate.ts).
   */
  dmLogLines: 200,
  apartLineBytes: 8 * 1024,
  whispersKept: 50,
  whispersPerRoom: 400,
  whisperBytesPerRoom: 640 * 1024,
  partyLinesKept: 50,
  partyLinesPerRoom: 400,
  partyLineBytesPerRoom: 640 * 1024,
  /**
   * The pairs of area and creature the record of a turn's reminders keeps
   * (shared/reducer/reminded.ts), each audience under a cap of its own, so
   * no audience's reminders decide whether another's repeat. A real turn
   * reminds about a few pairs, and a heavy one about tens: a horde of 30
   * the DM moves on one count through Spirit Guardians and a Web makes 60.
   * Each cap is well past that, and past it an audience records no more new
   * pairs that turn, so only its own readers can be reminded twice.
   *
   * Each audience's pairs are held to their bytes as stored too, since an
   * id may be any 64 letters, which JSON may write as up to 384 bytes. With
   * the ids the app makes, 36 letters, a pair takes at most about 83 bytes,
   * so every count cap fits: 1,000 pairs in 128 KiB and 200 in 24 KiB.
   * Each audience's bytes come from its own reminders alone, so the bounds
   * keep the audiences apart as the counts do. A room of 49 players then
   * holds at most about 1.4 MiB of the record, outside the measures as DM
   * lines are.
   *
   * They decide which reminders a logged op writes, so changing one needs a
   * new op version (shared/migrate.ts).
   */
  remindedShared: 1_000,
  remindedPerPlayer: 200,
  remindedDm: 1_000,
  remindedSharedBytes: 128 * 1024,
  remindedPerPlayerBytes: 24 * 1024,
  remindedDmBytes: 128 * 1024,
  /**
   * Combat uses (docs/design/design-v1-combat-controls.md 2.4): the spent marks an
   * actor holds, the keys a turn record's `due` names, an ability's key and
   * the characters of a mark's name, which a custom stat block's entry name
   * bounds. A spend that would add a mark past the cap is refused.
   */
  usesPerActor: 16,
  dueUses: 16,
  useKeyChars: 64,
  useNameChars: 120,
  /** An ability used X times a day, X at most this. */
  usesPerDay: 9,
  /** A character's class resources, each name's characters, a count's most and a pool's most (7). */
  resourcesPerCharacter: 12,
  resourceNameChars: 40,
  resourceMax: 99,
  resourcePoolMax: 200,
  /** The HP one Regeneration heals. */
  regenerateMax: 999,
  /**
   * The in-game clock (docs/design/design-v1-calendar.md 6.7): a Months
   * calendar's months, each month's days, a year's days, the days of its
   * week, each name's characters and the words after the year. The clock
   * holds `t` within plus or minus `clockSecondsMax` (about 317,000 years of
   * 365 days), one step moves it at most `clockStepMax` (100 such years), and
   * a line's date holds at most `clockDateChars`. Replay recomputes stored
   * lines, and whether an undo writes one, from `clockSecondsMax` and
   * `clockDateChars` (shared/calendar.ts clockNow, lineDate), so changing
   * either changes replayed lines and their ids and needs an op version gate.
   */
  calendarMonths: 24,
  calendarMonthDays: 400,
  calendarYearDays: 1_000,
  calendarWeekDays: 14,
  calendarNameChars: 24,
  calendarEraChars: 12,
  clockSecondsMax: 10_000_000_000_000,
  clockStepMax: 100 * 365 * 86_400,
  clockDateChars: 120,
  /** The longest time span an effect may last, 365 days (docs/design/design-v1-calendar-c2c3.md 4.1). */
  effectSpanMax: 365 * 86_400,
} as const;

const MiB = 1024 * 1024;

/**
 * Animated maps (docs/design/design-v1-animated-maps.md 6.3, D-261102-443
 * and D-261102-512). The server checks every one of these from the file's
 * headers alone, since it never decodes a frame.
 */
export const VIDEO_LIMITS = {
  /** Most 1080p loops of a minute or two fit, under Cloudflare's 100 MB request body and the 95 MB web import. */
  fileBytes: 64 * MiB,
  /**
   * A live upload must leave this much of the room's quota free, since a
   * room at its quota turns read-only mid-session. An import needs only the
   * quota, so a near-full room's backup still imports.
   */
  quotaHeadroomBytes: 32 * MiB,
  /** Under a second stutters. Past 10 minutes is a film. */
  minDurationMs: 1_000,
  maxDurationMs: 10 * 60_000,
  /** Each side and the area, of both the coded and the drawn size (`videoSizeFits`): square and large maps fit by area. */
  minSidePx: 256,
  maxSidePx: 4096,
  maxPixels: 3840 * 2160,
  /**
   * The most frames in any one second of the file and in all, counted over
   * every frame, so a variable rate is allowed within them and a fast
   * stretch cannot hide behind a slow start.
   */
  maxFramesInASecond: 61,
  maxFrames: 36_600,
  /** How long the whole upload body may take: 64 MB on a slow home uplink. */
  uploadDeadlineMs: 15 * 60_000,
  /** How far a sound track may end after the picture: AAC's padding at 48 kHz runs to 21.3 ms, past a 60 fps frame. */
  soundOverrunMs: 50,
  /** A still is the video's shape when its height, scaled to the video's width, is within this of the video's height. */
  shapeTolerancePx: 1,
  /**
   * The header parser's bounds: each value read, an MP4's `moov`, element
   * headers, block and sample headers counted apart, nesting depth and time.
   */
  parseValueBytes: 4 * 1024,
  parseMoovBytes: 8 * MiB,
  parseElementHeaders: 200_000,
  parseVideoFrameHeaders: 36_600,
  parseSoundFrameHeaders: 60_000,
  parseDepth: 8,
  parseBudgetMs: 5_000,
  /**
   * Phone size map detail plays a video only up to 1920 x 1080 (1080 x 1920
   * upright) with at most 31 frames in any second, so a nominal 30 fps
   * passes (D-261102-444).
   */
  phoneLongSidePx: 1920,
  phoneShortSidePx: 1080,
  phoneFramesInASecond: 31,
} as const;

/**
 * Whether a still fits a video's shape (D-261102-445): the still's height,
 * scaled to the video's width, within `shapeTolerancePx` of the video's
 * height. The video's size is the one it is drawn at, turned and stretched
 * (docs/design/design-v1-video-turns.md 6.2), so a portrait phone video
 * takes a portrait still. The permission check, the DM's still pick and an
 * import's refill all use it.
 */
export function stillFitsVideo(still: { widthPx: number; heightPx: number }, video: VideoShape): boolean {
  const shown = drawnSize(video);
  if (!(still.widthPx > 0 && still.heightPx > 0 && shown.widthPx > 0 && shown.heightPx > 0)) return false;
  return Math.abs((still.heightPx * shown.widthPx) / still.widthPx - shown.heightPx) <= VIDEO_LIMITS.shapeTolerancePx;
}

/** Whether a size is inside the header check's caps (6.3): each side and the area. Both the coded and the drawn size must be. */
export function videoSizeFits(size: { widthPx: number; heightPx: number }): boolean {
  const L = VIDEO_LIMITS;
  return Math.min(size.widthPx, size.heightPx) >= L.minSidePx && Math.max(size.widthPx, size.heightPx) <= L.maxSidePx && size.widthPx * size.heightPx <= L.maxPixels;
}

/**
 * Why a video's geometry cannot stand with its coded size, or null
 * (docs/design/design-v1-video-turns.md 6.1). A stretched width is a whole
 * number from half to twice the coded width and never equal to it, and the
 * drawn size is inside the caps. A zod refine would break `mapVideo.omit`,
 * so the row's facts, the stored state's maps and phases, and an import's
 * manifest geometry each call this instead.
 */
export function videoGeometryProblem(facts: VideoShape & VideoGeometry): string | null {
  const { widthPx: w, turn, mirror, displayWidthPx: dw } = facts;
  if (turn !== undefined && turn !== 90 && turn !== 180 && turn !== 270) return "a turn is 90, 180 or 270";
  if (mirror !== undefined && mirror !== true) return "a mirror is true or absent";
  if (dw !== undefined) {
    if (!Number.isInteger(dw)) return "a stretched width is a whole number";
    if (dw === w) return "a stretched width differs from the coded width";
    if (2 * dw < w || dw > 2 * w) return "a stretched width is half to twice the coded width";
  }
  return videoSizeFits(drawnSize(facts)) ? null : "the drawn size is inside the caps";
}

/**
 * Whether Phone size map detail may play a video of this size and peak rate
 * (5.3 rule 3), upright or sideways. It reads the coded size, never the
 * drawn one, since it guards the decoder, which works on coded frames
 * (docs/design/design-v1-video-turns.md 6.3).
 */
export function phoneSizeAllows(video: { widthPx: number; heightPx: number; fps: number }): boolean {
  const long = Math.max(video.widthPx, video.heightPx);
  const short = Math.min(video.widthPx, video.heightPx);
  return long <= VIDEO_LIMITS.phoneLongSidePx && short <= VIDEO_LIMITS.phoneShortSidePx && video.fps <= VIDEO_LIMITS.phoneFramesInASecond;
}

/**
 * Synced music and sound (docs/design/design-v1-music.md 8, D-261102-464 and
 * D-261102-466). The server checks a file by walking its MP3 frames and
 * decodes nothing. The reading caps bind the DM's tab before it decodes.
 */
export const SOUND_LIMITS = {
  /** 15 minutes at 192 kbps is 20.6 MiB. */
  fileBytes: 24 * MiB,
  /** As for videos: a live upload leaves this much of the quota free, and an import needs only the quota. */
  quotaHeadroomBytes: 32 * MiB,
  /** How long the whole upload body may take: 24 MiB at 32 KiB a second, with room to spare. */
  uploadDeadlineMs: 15 * 60_000,
  /** A stored file: MPEG-1 Layer III at one of these rates and one bitrate within these. */
  ratesHz: [44_100, 48_000] as readonly number[],
  minKbps: 64,
  maxKbps: 192,
  /** A stored file's length, frames times 1152 over the rate: the shortest effect to the longest track with its allowance. */
  fileMinMs: 200,
  fileMaxMs: 15 * 60_000 + 1_000,
  /**
   * Each use's lengths. Music's 30 s floor keeps a track longer than two
   * crossfades and the reveal (6.4), and a loop's 2 s its crossing.
   */
  use: {
    music: { minMs: 30_000, maxMs: 15 * 60_000 },
    loop: { minMs: 2_000, maxMs: 15 * 60_000 },
    effect: { minMs: 200, maxMs: 30_000 },
  },
  /**
   * How far the encoded length may run past a use's upper cap: frame
   * rounding and the encoder's delay and padding lengthen a file by up to
   * about 100 ms, and never shorten it, so no lower cap has one.
   */
  encodeAllowanceMs: 100,
  /** The client strips at most one ID3v2 tag this large at the start, and at most this many tags at the end (7.1). */
  id3v2MaxBytes: 16 * MiB,
  endTagsMax: 3,
  /** Sound uploads in an hour, by session and by room. */
  hourlyPerSession: 120,
  hourlyPerRoom: 240,
  /** The library: about 60 KB of DM-only state, and 120 KB of playlists at the worst. */
  soundsPerRoom: 300,
  playlistsPerRoom: 30,
  playlistTracks: 100,
  /** Loops at once, beside one music run. */
  loops: 4,
  /** Each effect list keeps its newest `effectsKept` and, past those, the entries still sounding, `effectsListed` at most. */
  effectsKept: 8,
  effectsListed: 16,
  /** A device plays this many effects at once, from at most this much decoded audio. */
  effectsAtOnce: 6,
  effectsDecodedBytes: 48 * MiB,
  /** A loop this small plays from a blob of its whole file, since Safari's media cache may not keep range answers. */
  blobLoopBytes: 5 * MiB,
  /** A track is revealed to players at most this long before it starts, and at least the shorter. */
  revealMaxMs: 20_000,
  revealMinMs: 10_000,
  /** A room with no member socket open this long stops its sound. */
  membersGoneMs: 15 * 60_000,
  /** A refused tick waits for a commit to `playing`, or this long. */
  tickBackoffMs: 60_000,
  /** The storage line's numbers are recomputed at most this often. */
  storageRecheckMs: 10_000,
  /** An Add button takes this many files a pick. */
  pickFiles: 20,
  /** The DM's tab refuses a larger file unread, and a whole decode past the device's budget (4.2). */
  readFileBytes: 200 * MiB,
  decodeBudgetComputerBytes: 800 * MiB,
  decodeBudgetTouchBytes: 150 * MiB,
  /** A rate the header does not give counts as this for the budget. */
  unknownRateHz: 96_000,
  /** The channel counts a file may have: mono and stereo kept, 4 and 6 mixed to stereo. */
  channels: [1, 2, 4, 6] as readonly number[],
  /** Loudness is evened to this, within the level's bounds, never so high that the peak passes `peakDbfs`. */
  targetLufs: -18,
  peakDbfs: -1,
} as const;

/** Whether a sound of this encoded length may have this use: within the use's lengths, with the encoding allowance past the upper cap only. */
export function soundUseFits(use: SoundUse, ms: number): boolean {
  const range = SOUND_LIMITS.use[use];
  // NaN and both infinities fail one comparison or the other.
  return ms >= range.minMs && ms <= range.maxMs + SOUND_LIMITS.encodeAllowanceMs;
}

export type LimitCheck = { ok: true } | { ok: false; code: "quota"; message: string };

function over(message: string): LimitCheck {
  return { ok: false, code: "quota", message };
}

/** A count as the refusals write it, with thousands separators. */
function n(value: number): string {
  return value.toLocaleString("en-US");
}

/*
 * Refusals say what is full. A room-wide limit says the room is full, a
 * per-scene one speaks of the scene, since the room may have room to
 * spare, and a rule on one thing says the rule. The client shows them as
 * they are, after "Not saved." (client/state/store.ts `refusalText`).
 */
function roomFull(holds: string): LimitCheck {
  return over(`the room is full: it can hold at most ${holds}`);
}

function sceneFull(holds: string): LimitCheck {
  return over(`this scene can hold at most ${holds}`);
}

/**
 * Counts the room and, when given, one scene against the table. Run on the
 * state an op would produce: when it fails, the op is refused with `quota`
 * and the state is discarded.
 *
 * `before` is the state the op started from. The caps on pillars, on doors
 * and windows and on drawn edges came after rooms that may already be over
 * them, so with `before` a scene over one refuses only an op that raises
 * that count, and the room's other edits still work. Without it, as for a
 * room import, the caps are absolute.
 *
 * `by` is who sent the op. The cap on lit token lights answers only the DM
 * (litTokenLightsRefused), so it needs both.
 */
export function checkLimits(state: RoomState, sceneId?: string | null, before?: RoomState, by?: "dm" | "player"): LimitCheck {
  if (Object.keys(state.scenes).length > LIMITS.scenesPerRoom) return roomFull(`${n(LIMITS.scenesPerRoom)} scenes`);
  if (Object.keys(state.characters).length > LIMITS.charactersPerRoom) return roomFull(`${n(LIMITS.charactersPerRoom)} characters`);
  if (Object.keys(state.members).length > LIMITS.membersPerRoom) return roomFull(`${n(LIMITS.membersPerRoom)} members`);
  if (Object.keys(state.handouts).length > LIMITS.handoutsPerRoom) return roomFull(`${n(LIMITS.handoutsPerRoom)} handouts`);
  const monsters = checkMonsters(state);
  if (!monsters.ok) return monsters;
  if (Object.keys(state.srdImages).length > LIMITS.srdImagesPerRoom) return roomFull(`${n(LIMITS.srdImagesPerRoom)} SRD monster images`);
  if (Object.keys(state.savedEncounters).length > LIMITS.savedEncountersPerRoom) return roomFull(`${n(LIMITS.savedEncountersPerRoom)} saved encounters`);
  if (state.encounter && state.encounter.entries.length > LIMITS.encounterRows && (!before || (before.encounter?.entries.length ?? 0) < state.encounter.entries.length)) {
    return roomFull(`${n(LIMITS.encounterRows)} initiative rows`);
  }
  const journal = checkJournal(state);
  if (!journal.ok) return journal;
  const blocks = checkCompanionBlocks(state);
  if (!blocks.ok) return blocks;
  const handoutPages = checkHandoutPages(state, before);
  if (!handoutPages.ok) return handoutPages;
  if (Object.keys(state.rolls).length > LIMITS.openRollsPerRoom) return over(`at most ${n(LIMITS.openRollsPerRoom)} roll requests can be open at once. Close one first`);
  if (Object.keys(state.casts).length > LIMITS.openCastsPerRoom) return over(`at most ${n(LIMITS.openCastsPerRoom)} asks for saves can wait at once. The DM resolves one first`);
  for (const scene of Object.values(state.scenes)) {
    if (scene.bounds.w > LIMITS.sceneCells || scene.bounds.h > LIMITS.sceneCells) {
      return over(`a scene is at most ${n(LIMITS.sceneCells)} cells a side`);
    }
  }
  if (sightHoldersRaised(state, before)) return over(SIGHT_HOLDERS_FULL);
  if (sceneId === undefined || sceneId === null) return { ok: true };
  let tokens = 0;
  let templates = 0;
  let drawings = 0;
  let points = 0;
  let labels = 0;
  // A scene's floors share its token and area caps (docs/design/design-v1-floors.md 9, D-261102-485), so no move between floors meets one.
  const group = new Set(floorsOf(state, sceneId).map((s) => s.id)).add(sceneId);
  for (const t of Object.values(state.tokens)) if (group.has(t.sceneId)) tokens++;
  for (const t of Object.values(state.templates)) if (group.has(t.sceneId)) templates++;
  for (const d of Object.values(state.drawings)) {
    if (d.sceneId !== sceneId) continue;
    drawings++;
    points += d.points.length;
    if (d.points.length > LIMITS.drawingPointValues) return over(`a drawing has at most ${n(LIMITS.drawingPointValues)} point values`);
  }
  for (const l of Object.values(state.labels)) if (l.sceneId === sceneId) labels++;
  if (tokens > LIMITS.tokensPerScene) return sceneFull(`${n(LIMITS.tokensPerScene)} tokens`);
  if (templates > LIMITS.templatesPerScene) return sceneFull(`${n(LIMITS.templatesPerScene)} areas`);
  if (drawings > LIMITS.drawingsPerScene) return sceneFull(`${n(LIMITS.drawingsPerScene)} drawings`);
  if (points > LIMITS.drawingPointValuesPerScene) return sceneFull(`${n(LIMITS.drawingPointValuesPerScene)} drawing point values`);
  if (labels > LIMITS.labelsPerScene) return sceneFull(`${n(LIMITS.labelsPerScene)} labels`);
  const draft = ownEntry(state.fogDrafts, sceneId);
  if (draft && draft.ops.length > LIMITS.fogDraftOpsPerScene) return sceneFull(`${n(LIMITS.fogDraftOpsPerScene)} fog changes in its draft`);
  return checkMapLimits(state, sceneId, before, by);
}

/**
 * The most players the design ever lets see for themselves on one scene
 * (docs/design/design-v1-per-player-vision.md 6.1), the bound of every stored list
 * of who saw, a holder list's entries that are on, and an explore op's
 * holders (reviews SEC-PV1-4, PV1-O4), and the reducer's own bound on a
 * pick and on joins. `LIMITS.sightHoldersPerScene` is the cap in force, at
 * most this, which only a live op meets (checkLimits, review PV1-ASTRA-4).
 */
export const MOST_SIGHT_HOLDERS = 6;

/** The refusal of a seventh player who would see for themselves (docs/design/design-v1-per-player-vision.md 7.1). */
export const SIGHT_HOLDERS_FULL = `At most ${LIMITS.sightHoldersPerScene} players see for themselves here. Untick one first.`;

/**
 * Whether the op turned on more of a scene's sight holders than the cap in
 * force allows (docs/design/design-v1-per-player-vision.md 6.1). Like the caps on
 * pillars, only an op that raises a scene's count past it is refused, and
 * only live: replay never runs this, so a room stored under a higher cap
 * still loads and replays, and takes every other edit (review PV1-ASTRA-4).
 * Without `before`, as for a room import, the cap is absolute.
 */
function sightHoldersRaised(state: RoomState, before?: RoomState): boolean {
  const on = (s: RoomState, sceneId: string) => (ownEntry(s.holders, sceneId)?.entries ?? []).filter((e) => e.on && ownEntry(s.members, e.memberId)?.kind === "player").length;
  for (const sceneId of Object.keys(state.holders ?? {})) {
    const now = on(state, sceneId);
    if (now > LIMITS.sightHoldersPerScene && (!before || on(before, sceneId) < now)) return true;
  }
  return false;
}

/** The refusal of a save past the room's handout pages, with what frees some (docs/design/design-v1-pdf-handouts.md 3.7). */
export const HANDOUT_PAGES_FULL = `the room holds at most ${n(LIMITS.handoutPagesPerRoom)} handout pages. Delete a document or close a handout, then try again`;
/** What a show adds, since showing a document is what passed the limit. */
export const SHOWING_COUNTS_AGAIN = "Showing a document counts its pages again while it shows";

/**
 * The room's handout pages against its limit. A show that passes it says
 * that showing counts the pages again: with `before`, an op that added to
 * the handouts' pages is a show.
 */
function checkHandoutPages(state: RoomState, before?: RoomState): LimitCheck {
  if (roomHandoutPages(state) <= LIMITS.handoutPagesPerRoom) return { ok: true };
  const showing = (s: RoomState) => roomHandoutPages({ handouts: s.handouts, handoutDocs: {} });
  return over(before && showing(state) > showing(before) ? `${HANDOUT_PAGES_FULL}. ${SHOWING_COUNTS_AGAIN}` : HANDOUT_PAGES_FULL);
}

/**
 * The wave 3 counts of one scene (docs/design/design-v1-maps-vision.md 2.4). The
 * split's caps on crossing walls are counted where geometry is written,
 * by the counting pass in shared/rules/segments.ts, which the server's
 * limits step runs after this.
 */
function checkMapLimits(state: RoomState, sceneId: string, before: RoomState | undefined, by: "dm" | "player" | undefined): LimitCheck {
  let stamps = 0;
  let lights = 0;
  let walls = 0;
  let pins = 0;
  for (const s of Object.values(state.stamps)) if (s.sceneId === sceneId) stamps++;
  for (const l of Object.values(state.lights)) if (l.sceneId === sceneId) lights++;
  for (const p of Object.values(state.pins)) if (p.sceneId === sceneId) pins++;
  if (pins > LIMITS.pinsPerScene) return sceneFull(`${n(LIMITS.pinsPerScene)} pins`);
  let traps = 0;
  for (const t of Object.values(state.traps ?? {})) if (t.sceneId === sceneId) traps++;
  if (traps > LIMITS.trapsPerScene) return sceneFull(`${n(LIMITS.trapsPerScene)} traps`);
  if (litTokenLightsRefused(state, sceneId, before, by)) return over(`This scene already has ${n(LIMITS.litTokenLightsPerScene)} lit token lights.`);
  for (const c of Object.values(state.buildChunks)) if (c.sceneId === sceneId) walls += c.walls?.length ?? 0;
  if (stamps > LIMITS.stampsPerScene) return sceneFull(`${n(LIMITS.stampsPerScene)} stamps`);
  if (lights > LIMITS.lightsPerScene) return sceneFull(`${n(LIMITS.lightsPerScene)} lights`);
  if (walls > LIMITS.freeWallsPerScene) return sceneFull(`${n(LIMITS.freeWallsPerScene)} free walls`);
  const counts = buildCounts(state, sceneId);
  let was: BuildCounts | undefined;
  const raised = (key: keyof BuildCounts) => !before || (was ??= buildCounts(before, sceneId))[key] < counts[key];
  if (counts.pillars > LIMITS.pillarsPerScene && raised("pillars")) return sceneFull(`${n(LIMITS.pillarsPerScene)} pillars`);
  if (counts.doorsAndWindows > LIMITS.doorsAndWindowsPerScene && raised("doorsAndWindows")) {
    return sceneFull(`${n(LIMITS.doorsAndWindowsPerScene)} doors and windows`);
  }
  if (counts.drawnEdges > LIMITS.drawnEdgesPerScene && raised("drawnEdges")) return sceneFull(`${n(LIMITS.drawnEdgesPerScene)} walls, doors, windows and No wall marks on the grid`);
  const phases = ownEntry(state.scenes, sceneId)?.phases?.length ?? 0;
  if (phases > LIMITS.phasesPerScene) return sceneFull(`${n(LIMITS.phasesPerScene)} map phases`);
  return { ok: true };
}

/**
 * Whether a token's carried light counts toward the scene's cap on lit
 * token lights and lights the party's sight: it gives any light, and the
 * DM has not hidden the token. A hidden token's light is dark for players
 * (shared/rules/vision.ts), so it costs no sight.
 */
export function countsAsLitTokenLight(token: Pick<Token, "visibility" | "light">): boolean {
  return token.visibility === "all" && token.light !== undefined && (token.light.bright > 0 || token.light.dim > 0);
}

/** Tokens on the scene whose carried light counts toward the cap (countsAsLitTokenLight). */
export function litTokenLights(state: Pick<RoomState, "tokens">, sceneId: string): number {
  let lit = 0;
  for (const t of Object.values(state.tokens)) if (t && t.sceneId === sceneId && countsAsLitTokenLight(t)) lit++;
  return lit;
}

/*
 * Whether the cap on lit token lights refuses an op: only the DM's, and
 * only one that raises the count past it. Sight lights the first lights in
 * the cap's order, the party's own first (shared/rules/vision.ts
 * carriedLights), so what a scene past the cap costs stays bounded. That
 * lets every other way past it through: a player's torch, which a refusal
 * would answer with a count that tells of creatures they have not seen, a
 * hidden combatant revealed on its turn, and a room import of a room that
 * got there so. The DM still learns that a scene is at the cap.
 */
function litTokenLightsRefused(state: RoomState, sceneId: string, before: RoomState | undefined, by: "dm" | "player" | undefined): boolean {
  if (by !== "dm" || !before) return false;
  const lit = litTokenLights(state, sceneId);
  return lit > LIMITS.litTokenLightsPerScene && litTokenLights(before, sceneId) < lit;
}

/** A scene's build geometry that no other limit bounds: pillar cells, door and window edges on the grid or free, and every drawn grid edge. */
type BuildCounts = { pillars: number; doorsAndWindows: number; drawnEdges: number };

/*
 * Counted once per chunk for the life of the chunk object: entities are
 * replaced, never changed (shared/reducer/tx.ts), so an op recounts only
 * the chunks it wrote. A key the wall derive would drop as malformed still
 * counts, which only errs toward the caps, and a malformed entry counts as
 * nothing rather than throwing in the limits step.
 */
const chunkCounts = new WeakMap<BuildChunk, BuildCounts>();

function buildCounts(state: RoomState, sceneId: string): BuildCounts {
  const total: BuildCounts = { pillars: 0, doorsAndWindows: 0, drawnEdges: 0 };
  for (const chunk of Object.values(state.buildChunks)) {
    if (chunk.sceneId !== sceneId) continue;
    let counts = chunkCounts.get(chunk);
    if (!counts) {
      const edges = Object.values(chunk.edges);
      counts = { pillars: 0, doorsAndWindows: 0, drawnEdges: edges.length };
      for (const terrain of Object.values(chunk.cells)) if (terrain === "pillar") counts.pillars++;
      for (const feature of edges) if (feature?.kind === "door" || feature?.kind === "window") counts.doorsAndWindows++;
      for (const wall of chunk.walls ?? []) if (wall?.f?.kind === "door" || wall?.f?.kind === "window") counts.doorsAndWindows++;
      chunkCounts.set(chunk, counts);
    }
    total.pillars += counts.pillars;
    total.doorsAndWindows += counts.doorsAndWindows;
    total.drawnEdges += counts.drawnEdges;
  }
  return total;
}

/**
 * Sizes of monsters already measured. Entities are never mutated, only
 * replaced (shared/reducer/tx.ts), so a monster object keeps its size for
 * life, and the byte limits below cost a serialization only for the
 * monsters an op wrote, not for the whole collection on every op.
 */
const monsterSizes = new WeakMap<CustomMonster, number>();

function monsterBytes(monster: CustomMonster): number {
  let bytes = monsterSizes.get(monster);
  if (bytes === undefined) {
    bytes = serializedBytes(monster);
    monsterSizes.set(monster, bytes);
  }
  return bytes;
}

/**
 * The room's own monsters: a count, and bytes for each one and for all of
 * them. A create op is bounded on its way in, but edits can grow a monster
 * and an undo can bring one back, so the stored result is what counts.
 */
function checkMonsters(state: RoomState): LimitCheck {
  const list = Object.values(state.monsters);
  if (list.length > LIMITS.monstersPerRoom) return roomFull(`${n(LIMITS.monstersPerRoom)} custom monsters`);
  let total = 0;
  for (const monster of list) {
    const bytes = monsterBytes(monster);
    if (bytes > LIMITS.monsterBytes) return over(`a custom monster is at most ${n(LIMITS.monsterBytes / 1024)} KiB`);
    total += bytes;
  }
  if (total > LIMITS.monstersBytes) return roomFull(`${n(LIMITS.monstersBytes / 1024 / 1024)} MiB of custom monsters`);
  return { ok: true };
}

/** Sizes of journal pages already measured, for the same reason as the monsters' (monsterSizes). */
const pageSizes = new WeakMap<JournalPage, number>();

/** A journal page's serialized size, measured once for the life of the page object. */
export function journalPageBytes(page: JournalPage): number {
  let bytes = pageSizes.get(page);
  if (bytes === undefined) {
    bytes = serializedBytes(page);
    pageSizes.set(page, bytes);
  }
  return bytes;
}

/**
 * The journal (docs/design/design-v1-dm-tools.md 3.7): a count, and bytes for each
 * page and for all of them. An op that carries blocks is bounded on its way
 * in, but a stored block keeps its revealed state, which the op does not
 * carry, and an undo can bring a page back, so the stored result is what
 * counts.
 */
function checkJournal(state: RoomState): LimitCheck {
  const pages = Object.values(state.journal);
  if (pages.length > LIMITS.journalPagesPerRoom) return roomFull(`${n(LIMITS.journalPagesPerRoom)} journal pages`);
  let total = 0;
  for (const page of pages) {
    const bytes = journalPageBytes(page);
    if (bytes > LIMITS.journalPageBytes) return over(`a journal page is at most ${n(LIMITS.journalPageBytes / 1024)} KiB`);
    total += bytes;
  }
  if (total > LIMITS.journalBytes) return roomFull(`${n(LIMITS.journalBytes / 1024 / 1024)} MiB of journal pages`);
  return { ok: true };
}

/** The refusal of a player's block save past their save budget (docs/design/design-v1-companion-stat-blocks.md 3.5). The editor knows it by these words. */
export const BLOCK_SAVES_TOO_FAST = "Too many stat block saves at once. Wait a few seconds, then save again.";
/** A block save the room's state limit refuses, in place of the size guard's words (section 3.4). */
export const BLOCKS_ROOM_TOO_FULL = "The room is too full to save this stat block. Ask the DM to free some space, then save again.";
/**
 * The refusal of a `character.update` whose `expect` no longer matches the
 * character (docs/design/design-v1-resync.md 4): one code and these words whatever
 * differed, so a refusal tells nothing of what changed. The re-sync knows
 * it by these words.
 */
export const CHARACTER_CHANGED = "This character changed since you looked. Check it again.";
/** A block save at the room's storage quota, in place of the quota's words (section 3.4). Deleting is still accepted. */
export const BLOCKS_AT_QUOTA = "The room is at its storage limit, so stat blocks cannot be saved until the DM frees space. Deleting a stat block still works.";

/*
 * The admission refusals of a tagged op (docs/design/design-v1-dice.md 1.2 and
 * 4.4), each with no receipt: the member's budget is spent, the room's day
 * of receipts is full, the player's share of it is, or the players' shares
 * together are, which keeps the DMs' floor of the day free whatever the
 * players send. Every surface that rolls or applies reads them as they are.
 */
export const ROLLING_TOO_FAST = "You are going too fast. Wait a few seconds.";
export const ROOM_ROLLED_TOO_MUCH = `This room has rolled and applied ${n(LIMITS.receiptsPerDay)} times in the last day. Wait a while.`;
export const PLAYER_ROLLED_TOO_MUCH = `You have rolled and answered ${n(LIMITS.receiptsPerPlayerDay)} times in the last day. Wait a while.`;
export const PLAYERS_ROLLED_TOO_MUCH = `The players have rolled and answered ${n(LIMITS.receiptsPerDay - LIMITS.receiptsDmFloor)} times in the last day. Wait a while.`;

/** Sizes of companion blocks already measured, for the same reason as the monsters' (monsterSizes). */
const blockSizes = new WeakMap<CompanionBlock, number>();

function companionBlockBytes(block: CompanionBlock): number {
  let bytes = blockSizes.get(block);
  if (bytes === undefined) {
    bytes = serializedBytes(block);
    blockSizes.set(block, bytes);
  }
  return bytes;
}

/*
 * The verdict for each version of the collection. An op that writes a
 * block copies the collection first (shared/writable.ts), so an op that
 * touches no block finds its verdict here and costs a lookup, while one
 * that does totals the blocks by character again, each block's size
 * measured once.
 */
const blockVerdicts = new WeakMap<object, LimitCheck>();

/**
 * Companion stat blocks (docs/design/design-v1-companion-stat-blocks.md 3.4): each
 * at most 16 KiB, each character's at most 100 and 512 KiB, and the room's
 * at most 600 and 3 MiB. Every refusal says what to do about blocks, since
 * the player who meets it can act on their own blocks. Blocks never change
 * character and go with theirs, so absolute caps refuse only an op that
 * adds to them.
 */
function checkCompanionBlocks(state: RoomState): LimitCheck {
  const collection = state.companionBlocks;
  const known = blockVerdicts.get(collection);
  if (known) return known;
  const verdict = companionBlocksVerdict(state);
  if (!isWritable(collection)) blockVerdicts.set(collection, verdict);
  return verdict;
}

function companionBlocksVerdict(state: RoomState): LimitCheck {
  const blocks = Object.values(state.companionBlocks).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (blocks.length > LIMITS.companionBlocksPerRoom) return over(`The room can hold at most ${n(LIMITS.companionBlocksPerRoom)} companion stat blocks. Delete one first.`);
  const perCharacter = new Map<string, { count: number; bytes: number }>();
  let total = 0;
  for (const block of blocks) {
    const bytes = companionBlockBytes(block);
    if (bytes > LIMITS.companionBlockBytes) return over(`A stat block is at most ${n(LIMITS.companionBlockBytes / 1024)} KiB.`);
    total += bytes;
    const held = perCharacter.get(block.characterId) ?? { count: 0, bytes: 0 };
    held.count++;
    held.bytes += bytes;
    perCharacter.set(block.characterId, held);
  }
  for (const [characterId, held] of perCharacter) {
    const name = ownEntry(state.characters, characterId)?.name ?? "A character";
    if (held.count > LIMITS.companionBlocksPerCharacter) return over(`${name} can keep at most ${n(LIMITS.companionBlocksPerCharacter)} stat blocks. Delete one first.`);
    if (held.bytes > LIMITS.companionBlockBytesPerCharacter) {
      return over(`${name}'s stat blocks can take at most ${n(LIMITS.companionBlockBytesPerCharacter / 1024)} KiB together. Delete one first.`);
    }
  }
  if (total > LIMITS.companionBlocksBytes) return over(`The room can hold at most ${n(LIMITS.companionBlocksBytes / 1024 / 1024)} MiB of companion stat blocks. Delete one first.`);
  return { ok: true };
}

/**
 * The refusal of an op that would leave the party no room to explore
 * (docs/design/design-v1-maps-vision.md 2.4): moving players to a vision scene,
 * turning vision or fog on there, or a room import. Only the DM does any
 * of these, so the DM reads it.
 */
export const NO_ROOM_TO_EXPLORE = "The room is too full for the party to explore that scene. Turn vision off there, or delete unused scenes to free space.";

/** The widest rev a stored entity can carry, 16 digits. */
const WIDEST_REV = Number.MAX_SAFE_INTEGER;
const FULL_BITS = "A".repeat(HEIGHTS_CHARS);

/**
 * The scene whose explored layer can grow: the player scene, while it has
 * vision and fog on. A per-player scene explores by each holder's sight
 * and the shared sight (docs/design/design-v1-per-player-vision.md 6.3), which the
 * explore step does not work out yet, so until it does such a scene
 * explores nothing: the party's sight would write ground only some players
 * saw into the layer every player reads, and reserve nothing for the
 * holders' layers.
 */
export function exploringSceneId(state: Pick<RoomState, "meta" | "scenes">): string | null {
  const id = state.meta.playerSceneId;
  const scene = id === null ? undefined : ownEntry(state.scenes, id);
  return scene && explores(scene) ? scene.id : null;
}

function explores(scene: Scene): boolean {
  return scene.vision?.on === true && scene.vision.perPlayer !== true && scene.fogEnabled;
}

/**
 * The floors whose explored layer can grow (docs/design/design-v1-floors.md
 * 8.3): every open floor of the players' scene with vision and fog on, as
 * `exploringSceneId` asks of one scene, each explored on its own. On a
 * scene without floors, exactly `exploringSceneId`.
 */
export function exploringFloors(state: RoomState): string[] {
  const start = state.meta.playerSceneId;
  if (start === null) return [];
  return floorsOf(state, start)
    .filter((floor) => explores(floor) && openFloor(state, floor.id))
    .map((floor) => floor.id);
}

/**
 * The floors the size guard reserves explored room for (9, D-261102-485):
 * every floor of the players' scene with vision and fog on, whatever is
 * open, so a floor the party reaches never finds the room full. On a scene
 * without floors, exactly `exploringSceneId`.
 */
export function reservedExploreFloors(state: Pick<RoomState, "meta" | "scenes">): string[] {
  const start = state.meta.playerSceneId;
  if (start === null) return [];
  return floorsOf(state, start)
    .filter(explores)
    .map((floor) => floor.id);
}

/**
 * The bytes the explored layer may still grow by (docs/design/design-v1-maps-vision.md
 * 2.4), which every size check adds to what the state measures, since a
 * `sys.explore` is never refused. Only the exploring scene has any.
 *
 * For each tile inside the scene's bounds, the most its entry can serialize
 * to under the scene's own key (key, colon, the tile with a 684-character
 * bits string and a 16-digit rev, and a comma), less what the held entry
 * takes now, or all of it when the layer holds none there. A tile entry's
 * size does not depend on which bits are set, so exploring adds exactly what
 * it takes off this, and stored size plus reserve never grows by it. A held
 * tile outside the bounds counts only in the measured state.
 *
 * On a scene with floors every floor `reservedExploreFloors` names has its
 * reserve, and `sceneId` asks for one floor's alone, none for a floor it
 * does not name.
 */
export function exploredReserve(state: Pick<RoomState, "meta" | "scenes" | "exploredTiles">, sceneId?: string): number {
  const floors = reservedExploreFloors(state);
  if (sceneId !== undefined) return floors.includes(sceneId) ? floorExploredReserve(state, sceneId) : 0;
  let reserve = 0;
  for (const floor of floors) reserve += floorExploredReserve(state, floor);
  return reserve;
}

function floorExploredReserve(state: Pick<RoomState, "scenes" | "exploredTiles">, sceneId: string): number {
  const scene = ownEntry(state.scenes, sceneId)!;
  // Every op's size check adds this, so it is arithmetic on two measured lengths rather than a serialization per tile.
  const id = utf8Bytes(JSON.stringify(sceneId));
  const widest = serializedBytes({ sceneId, tx: 0, ty: 0, rev: WIDEST_REV, bits: FULL_BITS });
  const across = Math.ceil(scene.bounds.w / CHUNK_CELLS);
  const down = Math.ceil(scene.bounds.h / CHUNK_CELLS);
  let reserve = 0;
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      // The key is the scene's id with ":tx,ty" inside its quotes, and the value holds tx and ty once more.
      const digits = String(tx).length + String(ty).length;
      const most = id + 2 + digits + 1 + widest - 2 + digits + 1;
      const held = ownEntry(state.exploredTiles, `${sceneId}:${tx},${ty}`);
      reserve += held ? Math.max(0, most - heldEntryBytes(held)) : most;
    }
  }
  return reserve;
}

/** A held tile's entry size, measured once for the life of the tile object, which is replaced and never changed. */
const heldSizes = new WeakMap<object, number>();

/** One map entry as the room's JSON holds it: the key in quotes, a colon, the value and a comma. */
function heldEntryBytes(tile: { sceneId: string; tx: number; ty: number }): number {
  let bytes = heldSizes.get(tile);
  if (bytes === undefined) {
    bytes = utf8Bytes(JSON.stringify(`${tile.sceneId}:${tile.tx},${tile.ty}`)) + 1 + serializedBytes(tile) + 1;
    heldSizes.set(tile, bytes);
  }
  return bytes;
}

/** The serialized size the byte limits talk about: JSON in UTF-8, as it is stored and sent. */
export function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

/**
 * The UTF-8 size of a string, counted without encoding it, so an 8 MiB state
 * is not copied just to be measured. A string's `length` counts UTF-16 code
 * units instead, which puts CJK text at a third of its real size and lets a
 * room pass every byte limit while holding three times as much.
 *
 * A surrogate pair is one 4-byte character. A lone surrogate counts 3 bytes,
 * as the replacement character it becomes, though JSON.stringify escapes
 * those to ASCII anyway.
 */
export function utf8Bytes(text: string): number {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) {
      bytes += 1;
      continue;
    }
    // Three bytes, or four for a surrogate pair, which is already two units long.
    bytes += 2;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
  }
  return bytes;
}
