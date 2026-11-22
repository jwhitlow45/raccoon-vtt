import { roomHandoutPages } from "./handouts.ts";
import { isWritable } from "./writable.ts";
import { CHUNK_CELLS, HEIGHTS_CHARS, type AreaTemplate, type BuildChunk, type Character, type CompanionBlock, type CustomMonster, type Drawing, type InitEntry, type JournalPage, type RoomState, type Scene, type Token } from "./model.ts";
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
  /**
   * Stairs, ladders and openings between a scene's floors
   * (docs/design/design-v1-floors.md phase 2, phase 4): pairs in one scene,
   * both ends of a pair counted as one, and the longest side of an end's
   * squares for stairs and ladders (an opening keeps to openingSide).
   */
  floorLinksPerScene: 16,
  floorLinkSide: 4,
  /** The longest side of an opening's squares between floors (docs/design/design-v1-floors.md phase 4, 3). Stairs and ladders keep to floorLinkSide. */
  openingSide: 8,
  /** Fall cards a room holds for the DM (docs/design/design-v1-floors.md phase 4, 4.4): a new one past it drops the oldest `made`. */
  fallsPerRoom: 10,
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
export const BLOCKS_ROOM_TOO_FULL = "The room is too full to save this stat block. Ask the DM to delete scenes they are done with, then save again.";
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

/** A count and the bytes of the blocks it counts. */
type BlockTotals = { count: number; bytes: number };

/**
 * What the block caps read of a state: the first refusal of a block past
 * its own size and of a character past its own caps, in the words naming
 * the character as it is named now, and the totals of every block and of
 * the blocks of characters no player owns (BlockRole `dm`).
 */
type BlockSummary = { block: string | null; character: string | null; all: BlockTotals; dm: BlockTotals };

/*
 * The summary for each version of the blocks, the characters and the
 * members, which say whose each block is and its character's name. An op
 * that writes any of them copies it first (shared/writable.ts), so an op
 * that touches none finds its summary here and costs three lookups, while
 * one that does totals the blocks by character again, each block's size
 * measured once.
 */
const blockSummaries = new WeakMap<object, WeakMap<object, WeakMap<object, BlockSummary>>>();

/**
 * Whose limits a block verdict reads (player limits). `today` is every
 * cap over every block, as a room import checks it. `player` is the caps
 * on one block and on one character, whose blocks are all in its owners'
 * copies. `dm` is those and the room's totals over the blocks of
 * characters no player owns, since players' characters keep their blocks
 * within their own caps.
 */
type BlockRole = "today" | "player" | "dm";

/**
 * Companion stat blocks (docs/design/design-v1-companion-stat-blocks.md 3.4): each
 * at most 16 KiB, each character's at most 100 and 512 KiB, and the room's
 * at most 600 and 3 MiB. Every refusal says what to do about blocks, since
 * the player who meets it can act on their own blocks. Blocks never change
 * character and go with theirs, so absolute caps refuse only an op that
 * adds to them. The DM's room totals count only blocks of characters no
 * player owns, which a hand-over changes with no block added, so they
 * refuse only an op that adds to the room's blocks, with `before` the
 * state the op started from.
 */
function checkCompanionBlocks(state: RoomState, role: BlockRole = "today", before?: RoomState): LimitCheck {
  const now = blockSummary(state);
  const was = role === "dm" && before ? blockSummary(before).all : null;
  const counted = role === "dm" ? now.dm : now.all;
  const grew = (key: keyof BlockTotals) => was === null || now.all[key] > was[key];
  if (role !== "player" && counted.count > LIMITS.companionBlocksPerRoom && grew("count")) return over(`The room can hold at most ${n(LIMITS.companionBlocksPerRoom)} companion stat blocks. Delete one first.`);
  if (now.block !== null) return over(now.block);
  if (now.character !== null) return over(now.character);
  if (role !== "player" && counted.bytes > LIMITS.companionBlocksBytes && grew("bytes")) return over(`The room can hold at most ${n(LIMITS.companionBlocksBytes / 1024 / 1024)} MiB of companion stat blocks. Delete one first.`);
  return { ok: true };
}

function blockSummary(state: RoomState): BlockSummary {
  const { companionBlocks: blocks, characters, members } = state;
  const kept = !isWritable(blocks) && !isWritable(characters) && !isWritable(members);
  const known = kept ? blockSummaries.get(blocks)?.get(characters)?.get(members) : undefined;
  if (known) return known;
  const summary = summarizeBlocks(state);
  if (kept) {
    let byCharacters = blockSummaries.get(blocks);
    if (!byCharacters) blockSummaries.set(blocks, (byCharacters = new WeakMap()));
    let byMembers = byCharacters.get(characters);
    if (!byMembers) byCharacters.set(characters, (byMembers = new WeakMap()));
    byMembers.set(members, summary);
  }
  return summary;
}

/** Whether a player owns the block's character, so the room's totals leave the block to its character's caps (BlockRole `dm`). */
function playersBlock(state: RoomState, block: CompanionBlock): boolean {
  return (ownEntry(state.characters, block.characterId)?.ownerIds ?? []).some((id) => ownEntry(state.members, id)?.kind === "player");
}

function summarizeBlocks(state: RoomState): BlockSummary {
  const blocks = Object.values(state.companionBlocks).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const all: BlockTotals = { count: 0, bytes: 0 };
  const dm: BlockTotals = { count: 0, bytes: 0 };
  const perCharacter = new Map<string, BlockTotals>();
  let block: string | null = null;
  for (const one of blocks) {
    const bytes = companionBlockBytes(one);
    if (bytes > LIMITS.companionBlockBytes) block ??= `A stat block is at most ${n(LIMITS.companionBlockBytes / 1024)} KiB.`;
    all.count++;
    all.bytes += bytes;
    if (!playersBlock(state, one)) {
      dm.count++;
      dm.bytes += bytes;
    }
    const held = perCharacter.get(one.characterId) ?? { count: 0, bytes: 0 };
    held.count++;
    held.bytes += bytes;
    perCharacter.set(one.characterId, held);
  }
  let character: string | null = null;
  for (const [characterId, held] of perCharacter) {
    const name = ownEntry(state.characters, characterId)?.name ?? "A character";
    if (held.count > LIMITS.companionBlocksPerCharacter) character = `${name} can keep at most ${n(LIMITS.companionBlocksPerCharacter)} stat blocks. Delete one first.`;
    else if (held.bytes > LIMITS.companionBlockBytesPerCharacter) character = `${name}'s stat blocks can take at most ${n(LIMITS.companionBlockBytesPerCharacter / 1024)} KiB together. Delete one first.`;
    if (character !== null) break;
  }
  return { block, character, all, dm };
}

/**
 * The refusal of an op that would leave the party no room to explore
 * (docs/design/design-v1-maps-vision.md 2.4): moving players to a vision scene,
 * turning vision or fog on there, or a room import. Only the DM does any
 * of these, so the DM reads it.
 */
export const NO_ROOM_TO_EXPLORE = "The room is too full for the party to explore that scene. Turn vision off there, or delete unused scenes to free space.";

/** The widest rev a stored entity can carry, 16 digits. */
export const WIDEST_REV = Number.MAX_SAFE_INTEGER;
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

/*
 * Player limits (docs/design/design-v1-player-limits.md). A player's op
 * meets only limits whose every counted thing the player's own copy of the
 * room holds: their seats, recomputed from the state and their own view on
 * each op, and the far line. The room's caps above answer the DM and the
 * server, over what no seat holds.
 */

/** A seat's number, each in its scope: the scene with its floors for tokens and riding areas, the floor for the rest, the fight for rows. */
export const SEAT = {
  tokens: 33,
  ridingAreas: 20,
  freeAreas: 40,
  drawings: 400,
  pointValues: 40_000,
  rows: 40,
} as const;

export type SeatName = keyof typeof SEAT;

/** The words of a refusal past a seat, shown after "Not saved.". They name the limit, never what the room holds. */
export const SEAT_FULL: Record<SeatName, string> = {
  tokens: `You can have ${n(SEAT.tokens)} tokens of your own on this map. Remove a companion first.`,
  ridingAreas: `You can have ${n(SEAT.ridingAreas)} areas of your own on creatures here. Remove one first.`,
  freeAreas: `You can have ${n(SEAT.freeAreas)} areas of your own here. Remove one first.`,
  drawings: `You can have ${n(SEAT.drawings)} drawings of your own here. Remove one first.`,
  pointValues: `Your drawings here can hold ${n(SEAT.pointValues)} point values. Remove one first.`,
  rows: `You can have ${n(SEAT.rows)} rows of your own in this fight. Remove one first.`,
};

/** A player's row for their own creature the DM hid is refused `forbidden` with these words. */
export const HIDDEN_ROW_REFUSED = "The DM adds a hidden creature to the fight.";
/** A member past their ids in 30 minutes (ID_BUDGET). */
export const IDS_TOO_FAST = "You are adding things very fast. Wait a few minutes.";
/** A create still refused for its id's time after the device's one retry with a fresh id. */
export const ID_RETRY_FAILED = "That could not be added. Try again.";
/** The DM's 33rd hidden condition on one creature. */
export const HIDDEN_EFFECTS_FULL = "at most 32 hidden effects per creature";
/** The DM's confirm before deleting the map the players are on, sent as `leavePlayers` on a yes. */
export const LEAVE_PLAYERS_ASK = "The players are on this map. Delete it and leave them with no map?";

/** The DM's notice while the room is over its far line by `mib` MiB, rounded up (the DM's snapshot's `over`). */
export function overNotice(mib: number): string {
  return `This room is over its size limit by ${n(mib)} MiB. New things and edits that add to it are refused until that much is freed.`;
}

/** The most floors a scene holds, so the free areas a member can hold in one scene. */
const FLOORS = LIMITS.floorsPerScene;
/** A member's asks across one scene's floors: 3 a floor. */
export const ASKS_PER_MEMBER_SCENE = LIMITS.castsPerMember * FLOORS;

/**
 * The far line: each room cap plus 50 full seats, in the cap's own scope,
 * and the byte lines that bind before the counts. Every growing op meets
 * it, a player's and the DM's alike, except the kinds shared/farLine.ts
 * exempts. A count reads the DM's part rounded up to FAR.countStep and
 * the players' part exactly, bytes to FAR.byteStep.
 */
export const FAR = {
  tokens: LIMITS.tokensPerScene + LIMITS.membersPerRoom * SEAT.tokens,
  areas: LIMITS.templatesPerScene + LIMITS.membersPerRoom * (SEAT.ridingAreas + FLOORS * SEAT.freeAreas),
  drawings: LIMITS.drawingsPerScene + LIMITS.membersPerRoom * SEAT.drawings,
  pointValues: LIMITS.drawingPointValuesPerScene + LIMITS.membersPerRoom * SEAT.pointValues,
  rows: LIMITS.encounterRows + LIMITS.membersPerRoom * SEAT.rows,
  // The DM's part is read in steps of 50, so the room's 20 asks take a whole step beside full seats.
  asks: roundUp(LIMITS.openCastsPerRoom, 50) + LIMITS.membersPerRoom * ASKS_PER_MEMBER_SCENE,
  sceneBytes: 2 * LIMITS.projectedSceneBytes,
  roomBytes: 11 * MiB,
  blocks: 2 * LIMITS.companionBlocksPerRoom,
  blockBytes: 2 * LIMITS.companionBlocksBytes,
  countStep: 50,
  byteStep: 256 * 1024,
} as const;

/**
 * Bytes inside the far line that only bookkeeping may fill (design 5.3
 * and 8). An op that meets the line stops this much short of it, and an
 * exempt kind, a move, a turn, HP, a condition, a roll or a line of talk,
 * goes on until the line itself, so the table plays on where creates stop.
 * Past the line every growing op is refused, bookkeeping too, so the
 * stored state stays within HARD.storedBytes. Reserving each creature's
 * widest bookkeeping instead (a path, 65 conditions and use marks at the
 * stored schema's widths, about 320 KiB) would fill the room at a few
 * dozen creatures, so the reserve is the room's and each scene's.
 */
export const BOOKKEEPING_RESERVE = { room: 512 * 1024, scene: 256 * 1024 } as const;

/**
 * The most bytes one thing takes in a player's exact part past what the
 * stepped part takes out for it (server/rooms/sizeGuard.ts exactCopies),
 * under any of the room's settings: a creature, a character, an area their
 * copy holds, and an area it holds neither of, nor the creature or floor it
 * is on, which counts at its widest. A shared line not their own counts
 * `line` and its readers lists at every member of the roster, as many as
 * the widest kind holds (an HP line's two, its revert at REVERT_MOST). A
 * roll request counts `rollRequest` and, for each target, `rollTarget` and
 * who answered at the roster's widest id. limits.bounds.test.ts holds each
 * at or above what a thing of its kind takes.
 *
 * Two widths the DM's play puts in every player's exact part are not held
 * here and rest on the margin: what the room keeps past these widths and
 * the 0.75 MiB. Each condition with a save or a span that an HP line's
 * revert carries counts past `line`, about 330 B for a concentration ended
 * with its span and up to about 14 KiB for 32 conditions with both, and a
 * door on a scene the player holds counts a few bytes past what it stores.
 * The floor test holds the margin under a ring of HP lines that each end a
 * concentration with its span, and with 400 doors on the players' scene.
 * Holding every line at the most conditions a revert carries would keep
 * about 2.7 MiB more, leaving the DM's line near 5.5 MiB, so it is not.
 */
export const EXACT_WIDTH = { creature: 256, character: 5 * 1024, area: 256, unseenArea: 3328, line: 640, lineReaderLists: 2, rollRequest: 32, rollTarget: 480 } as const;

/**
 * The shared lines a live log keeps (shared/logRings.ts MAX_LOG, which
 * imports this file, so the number is kept here too and a test holds them
 * equal).
 */
export const KEPT_SHARED_LINES = 200;

/** A list of every member of the roster as JSON, its brackets, commas and ids: what a line's readers count at in an exact part. */
export function rosterListBytes(memberIds: readonly string[]): number {
  return 2 + Math.max(0, memberIds.length - 1) + memberIds.reduce((bytes, id) => bytes + utf8Bytes(JSON.stringify(id)), 0);
}

/** The public facts the room's kept bytes read (keptForPlayers). */
export type KeptRoom = { readonly meta: { readonly settings: Pick<RoomState["meta"]["settings"], "playersMoveAny" | "playersApplyDamage"> }; readonly members: Readonly<Record<string, unknown>> };

/**
 * Bytes under the room's far line that the DM's adds leave to the
 * players' (D-261116-008, D-261121-021): a DM's op that meets the line
 * stops this much before a player's does, read at the same widest
 * reserves. Measured on live play 43's repro (server/rooms/limits.itest.ts),
 * a session of 5 areas and 50 strokes of 200 point values for each of six
 * players takes 418 KiB. It is 1 MiB plus the most that the DM's choices
 * put in every player's exact part past the stored bytes, from the room's
 * public settings and roster: the creatures their copy holds, every one of
 * a scene where Players move any token or Players apply damage is on and
 * else a seat's and as many as the DM may lend, every character, one
 * seat's areas, its riding ones out of sight, the shared lines that are not
 * the player's own, each at the widest kind's readers lists at every
 * member, and the open roll requests' answers. A player's own rolls, asks
 * and rulers are not kept: only their own play grows them, and only their
 * own share pays. A reading rounds its stepped part up by less than a
 * step, so once the DM's adds stop each player keeps more than 0.75 MiB,
 * close to two sessions (D-261116-016), less what their own rolls, asks
 * and rulers count past their stored bytes. It is rounded up to a whole
 * number of steps. Turning either setting on, or a join, moves it, so the
 * DM's change of a setting reads the DM's line at the new reserve, and a
 * join may leave the DM past their line, which refuses only the DM's adds.
 * A scene keeps more already: the DM's own part of it stops at the 3 MiB
 * scene line, half its far line.
 */
export function keptForPlayers(room: KeptRoom): number {
  const { playersMoveAny, playersApplyDamage } = room.meta.settings;
  const ids = Object.keys(room.members);
  const anyCreature = playersApplyDamage || (playersMoveAny !== undefined && playersMoveAny !== "none");
  const creatures = anyCreature ? FAR.tokens : SEAT.tokens + LIMITS.tokensPerScene;
  const idMost = ids.reduce((most, id) => Math.max(most, utf8Bytes(JSON.stringify(id))), 0);
  const lines = KEPT_SHARED_LINES * (EXACT_WIDTH.line + EXACT_WIDTH.lineReaderLists * rosterListBytes(ids));
  const rolls = LIMITS.openRollsPerRoom * (EXACT_WIDTH.rollRequest + LIMITS.rollTargets * (EXACT_WIDTH.rollTarget + idMost));
  const seat = SEAT.ridingAreas * EXACT_WIDTH.unseenArea + FLOORS * SEAT.freeAreas * EXACT_WIDTH.area;
  return roundUp(MiB + creatures * EXACT_WIDTH.creature + LIMITS.charactersPerRoom * EXACT_WIDTH.character + seat + lines + rolls, FAR.byteStep);
}

/**
 * The DM's refusal of an add that only the room kept for the players
 * stops. It names no size: the kept bytes follow the room's settings and
 * roster (keptForPlayers).
 */
export const KEPT_FOR_PLAYERS_FULL = "the room is full: it keeps the rest for what the players add";

/**
 * What a byte line refuses with, before the remedy (`sizeRemedy`). No size
 * is named: the room's lines differ (the DM's own, the players', the far
 * line), and a number that changed with them read as a contradiction of
 * what the docs say a room holds.
 */
export const ROOM_FULL = "the room is full";
export const SCENE_FULL = "this scene is full";

/**
 * A byte-line refusal with what the sender can do about it, in the room's
 * existing voice. The DM's list leads with Per player scenes, which hold
 * the most (each reserves a map for every player). The words depend on the
 * sender's role and which line refused, never on what the sender cannot see.
 */
export function sizeRemedy(message: string, role: "dm" | "player"): string {
  const remedy = SIZE_REMEDY[role][message];
  return remedy === undefined ? message : `${message}. ${remedy}`;
}

const SIZE_REMEDY: Record<"dm" | "player", Record<string, string | undefined>> = {
  dm: {
    [ROOM_FULL]: "Delete scenes you are done with, Per player ones first, or journal pages and drawings you no longer need",
    [KEPT_FOR_PLAYERS_FULL]: "Delete scenes you are done with, Per player ones first, or journal pages and drawings you no longer need",
    [SCENE_FULL]: "Delete drawings, walls or creatures you no longer need from it",
  },
  player: {
    [ROOM_FULL]: "Delete a drawing or area of yours you no longer need, or ask the DM to delete scenes they are done with",
    [SCENE_FULL]: "Delete a drawing or area of yours you no longer need, or ask the DM to clear some of the scene",
  },
};

/**
 * Whose far line an op reads: the players', or the DM's, which stops the
 * kept bytes (keptForPlayers) sooner on the room's.
 */
export type FarLineOf = "players" | { readonly dmKept: number };

/**
 * The far byte line an op of `kind` reads in `scope`, or null for a
 * deletion, which meets none. `whose` is the DM's line for the DM's adds,
 * or the players' line for every other op, the DM's bookkeeping and a
 * move of the players included (server/rooms/actor.ts bytesMeet).
 */
export function farByteLine(kind: LimitKind["far"], scope: "room" | "scene", whose: FarLineOf): number | null {
  if (kind === "deletion") return null;
  const line = scope === "room" ? FAR.roomBytes : FAR.sceneBytes;
  if (kind === "exempt") return line;
  return line - BOOKKEEPING_RESERVE[scope] - (whose !== "players" && scope === "room" ? whose.dmKept : 0);
}

/**
 * Whether the far line refuses an op of `kind` in `scope` on `whose` line
 * (farByteLine): its reading (farReading), the stepped part with its
 * reserves rounded up to FAR.byteStep and the exact part to the byte, is
 * past the line, and the op grew. The DM's op grew when the measure's
 * total did, or the kept bytes. A player's grew when their own reading did
 * (readingGrew). The size guard reads it for the room and for each scene
 * (server/rooms/sizeGuard.ts).
 */
export function farBytesOver(scope: "room" | "scene", kind: LimitKind["far"], whose: FarLineOf, stepped: number, exact: number, grew: boolean): boolean {
  const line = farByteLine(kind, scope, whose);
  return line !== null && grew && farReading(stepped, exact) > line;
}

/** A far reading: its stepped part rounded up to FAR.byteStep, and its exact part to the byte. */
export function farReading(stepped: number, exact: number): number {
  return roundUp(Math.max(0, stepped), FAR.byteStep) + exact;
}

/**
 * Whether a player's op grew their far reading, both sides read over one
 * membership (D-261121-060, 074): their exact part grew, or the whole
 * reading did, its stepped part rounded. Hidden bytes the op takes away
 * lower only the stepped part, so they never hide growth of the player's
 * own, and hidden bytes it adds or moves count only where they carry the
 * stepped part across a step.
 */
export function readingGrew(before: { stepped: number; exact: number }, after: { stepped: number; exact: number }): boolean {
  return after.exact > before.exact || farReading(after.stepped, after.exact) > farReading(before.stepped, before.exact);
}

/** The far line's step: `value` rounded up to a multiple of `step`, so a far check reads the DM's part only in steps. */
export function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/** The room-wide pool for remembered maps on marked scenes, and the most one scene's share takes of it. */
export const MARKED_POOL = 1.5 * MiB;
export const MARKED_SHARE_MOST = 192 * 1024;

/** The fight's history keeps at most this many bytes of steps, besides its 20 steps (reducer/encounter.ts MAX_HISTORY). */
export const HISTORY_BYTES = 1 * MiB;

/**
 * Client-minted ids (shared/protocol.ts mintedIds): how far an id's own
 * time may be ahead of the server's clock and behind it, how long its row
 * answers a reconnect's ask, and how many a member may bring in a window.
 */
export const ID_TIME = { aheadMs: 5_000, behindMs: 30 * 60_000, askMs: 12 * 60 * 60_000 } as const;
export const ID_BUDGET = { windowMs: 30 * 60_000, player: 2_000, dm: 20_000 } as const;

/**
 * Derived bounds (design section 8), held by the full fixture at every far
 * line, with the fight's history at its bound and nine walks at their
 * widest on the turn or no fight (server/rooms/limits.bounds.test.ts).
 * Nothing refuses a player's op by these: tests hold stored states,
 * snapshots and buffers within them, and a batch that leaves the room
 * storing more sheds its oldest archived DM lines and history steps
 * (server/rooms/actor.ts, shared/reducer/shed.ts).
 */
export const HARD = {
  /**
   * The measured state at the room far line with its widest reserves, the
   * walk pool among them, plus the history at its bound and what sits
   * outside the measure.
   */
  storedBytes: 17 * MiB,
  /** The largest room file an import takes (server/rooms/importRoom.ts): the stored bound and the remap's 0.5 MiB. */
  roomJsonBytes: 17.5 * MiB,
  /** A socket's send buffer (server/rooms/ws.ts): the stored bound, which a DM snapshot stays under, and 1 MiB more, rounded up to a whole MiB. */
  sendBufferBytes: 18 * MiB,
  /** Rows of the fight, and every list keyed by a row. */
  rows: FAR.rows,
  /** Conditions on one creature: 32 shown, 32 hidden and the automatic Unconscious. */
  effects: 65,
  /** Creatures one group save selects. */
  groupSaveTokens: FAR.tokens,
  /** Rows of `room_ids` for 48 players and 2 DMs at the budget's full rate all day: gate rows, then recovery rows. */
  gateRows: 272_000,
  recoveryRows: 3_264_000,
} as const;

/**
 * The test of a member's own copy of one state (shared/project.ts
 * seatView): whether it holds a creature, shows a row, and holds a floor.
 * A seat counts only what this view holds, so its count is the copy's.
 * `copy` is one thing as the copy holds it, or null where it holds none: a
 * player's far line holds exactly only these (ownHeld).
 */
export type SeatView = {
  sees(tokenId: string): boolean;
  showsRow(entryId: string): boolean;
  holds(sceneId: string): boolean;
  copy(kind: CopiedKind, id: string): unknown;
  /**
   * A shared line as they read it when it was written, whatever the room
   * shows them now, or null for a line of another audience. Only for one
   * written while they were on the roster, whom every shared line reached
   * then (shared/project.ts lineReach). A clock line, shared whether or not
   * a blackout held players back, is null behind one, as in their copy.
   */
  written(lineId: string): unknown;
  /** The creatures whose turn the copy shows under way: the active row's, and the mounts sharing its turn the copy holds. */
  turn(): ReadonlySet<string>;
  /**
   * The walk a creature of theirs holds, as their copy holds a walk on its
   * own turn, whatever turn is under way now, or null where they do not
   * own it or it holds none.
   */
  walk(tokenId: string): unknown;
};

/**
 * The kinds of thing a player's far line can hold exactly: what their own
 * ops can grow, their creatures, areas, drawings, rows and asks, their
 * characters' stat blocks for companions, their member, their characters,
 * the roll requests their copy holds, the log's lines, and the build's
 * chunks for the doors in them. A chunk goes by its state key,
 * `"<sceneId>:<cx>,<cy>"`.
 */
export type CopiedKind = "token" | "template" | "drawing" | "row" | "cast" | "companionBlock" | "member" | "character" | "roll" | "log" | "chunk";
export type SeatViewOf = (state: RoomState) => SeatView;

/** What one member's seats count in a scope: `sceneId` names the floor, tokens and riding areas count across its scene, and rows across the fight. */
export type SeatCounts = Record<SeatName, number>;

/** The things seats hold in one scene, for every member together, without the view test: the room caps count only the rest. */
export type SeatHeld = {
  tokens: ReadonlySet<string>;
  templates: ReadonlySet<string>;
  drawings: ReadonlySet<string>;
  /** Point values of the held drawings on the floor `sceneId`. */
  pointValues: number;
  rows: ReadonlySet<string>;
  casts: ReadonlySet<string>;
  /**
   * Companion blocks held exactly: their stored bytes, which the blocks' far line takes out of its stepped part, and
   * the bytes it counts them at, their copy's with the rev at its widest (D-261119-003).
   */
  blocks: ReadonlySet<string>;
  blockBytes: number;
  blockShown: number;
};

/** The character whose owners a token's seat belongs to: its own character, or the one it is a companion of. Lent monsters have none. */
function seatCharacter(state: RoomState, token: Token): Character | undefined {
  const of = token.companion?.of ?? ("ref" in token.actor ? token.actor.ref : undefined);
  return of === undefined ? undefined : ownEntry(state.characters, of);
}

/** Whether a creature is one of the member's own: theirs outright, a creature the DM lent them included, or their character's. */
export function ownsSeatToken(state: RoomState, memberId: string, token: Token): boolean {
  return token.ownerIds.includes(memberId) || (seatCharacter(state, token)?.ownerIds.includes(memberId) ?? false);
}

/** Whether the row is one of the member's own: of a creature they own, directly or through its character, or of their character. */
export function ownsRow(state: RoomState, memberId: string, entry: InitEntry): boolean {
  if (entry.characterId !== undefined) {
    if (ownEntry(state.characters, entry.characterId)?.ownerIds.includes(memberId)) return true;
  }
  if (entry.tokenId === undefined) return false;
  const token = ownEntry(state.tokens, entry.tokenId);
  return token !== undefined && ownsSeatToken(state, memberId, token);
}

/** Everyone ownsRow counts the row for: its character's owners, its creature's own and its creature's character's. */
function rowOwners(state: RoomState, entry: InitEntry): string[] {
  const out: string[] = [];
  if (entry.characterId !== undefined) out.push(...(ownEntry(state.characters, entry.characterId)?.ownerIds ?? []));
  const token = entry.tokenId === undefined ? undefined : ownEntry(state.tokens, entry.tokenId);
  if (token) out.push(...token.ownerIds, ...(seatCharacter(state, token)?.ownerIds ?? []));
  return out;
}

/** The scene `sceneId` belongs to with all its floors, the scope of the token and riding area seats. */
function sceneGroup(state: RoomState, sceneId: string): ReadonlySet<string> {
  return new Set(floorsOf(state, sceneId).map((s) => s.id)).add(sceneId);
}

/** Whether the member's view holds a drawing: theirs to see on a held floor, with every creature it is kept on in sight. */
export function drawingHeld(drawing: Drawing, view: SeatView): boolean {
  return drawing.visibility === "all" && view.holds(drawing.sceneId) && (drawing.anchors ?? []).every((id) => id === null || view.sees(id));
}

/** Whether a member's copy holds a token of their seat's: of a character they own, or its companion, and in their sight. */
function ownTokenHeld(state: RoomState, memberId: string, token: Token, view: SeatView): boolean {
  return (seatCharacter(state, token)?.ownerIds.includes(memberId) ?? false) && view.sees(token.id);
}

/** Whether a member's copy holds an area of theirs: on a creature they see, or loose on a floor they hold. */
function ownAreaHeld(template: AreaTemplate, memberId: string, view: SeatView): boolean {
  if (template.ownerId !== memberId || template.visibility !== "all") return false;
  return template.attachedTo !== undefined ? view.sees(template.attachedTo) : view.holds(template.sceneId);
}

/** One member's seat counts in `sceneId`'s scopes, over the things their view of `state` holds. With no scene, only the rows. */
export function seatCounts(state: RoomState, memberId: string, sceneId: string | null, view: SeatView): SeatCounts {
  const counts: SeatCounts = { tokens: 0, ridingAreas: 0, freeAreas: 0, drawings: 0, pointValues: 0, rows: 0 };
  for (const entry of state.encounter?.entries ?? []) if (ownsRow(state, memberId, entry) && view.showsRow(entry.id)) counts.rows++;
  if (sceneId === null) return counts;
  const group = sceneGroup(state, sceneId);
  for (const token of Object.values(state.tokens)) if (group.has(token.sceneId) && ownTokenHeld(state, memberId, token, view)) counts.tokens++;
  for (const template of Object.values(state.templates)) {
    if (!ownAreaHeld(template, memberId, view)) continue;
    if (template.attachedTo !== undefined) {
      if (group.has(template.sceneId)) counts.ridingAreas++;
    } else if (template.sceneId === sceneId) counts.freeAreas++;
  }
  for (const drawing of Object.values(state.drawings)) {
    if (drawing.ownerId !== memberId || drawing.sceneId !== sceneId || !drawingHeld(drawing, view)) continue;
    counts.drawings++;
    counts.pointValues += drawing.points.length;
  }
  return counts;
}

const SEAT_ORDER: readonly SeatName[] = ["tokens", "ridingAreas", "freeAreas", "drawings", "pointValues", "rows"];

/**
 * A player's op against their seats: refused `quota` with that seat's
 * words when it raises a count past its seat. Only an op that puts a
 * thing into a seat's class raises one, so a member over a seat by the
 * DM's doing is refused only their next op into that class. Both counts
 * read the member's own view of their state, so they are the copy's.
 */
export function seatCheck(before: RoomState, after: RoomState, memberId: string, sceneId: string | null, viewOf: SeatViewOf): LimitCheck {
  const now = seatCounts(after, memberId, sceneId, viewOf(after));
  if (SEAT_ORDER.every((seat) => now[seat] <= SEAT[seat])) return { ok: true };
  const was = seatCounts(before, memberId, sceneId, viewOf(before));
  for (const seat of SEAT_ORDER) if (now[seat] > SEAT[seat] && now[seat] > was[seat]) return over(SEAT_FULL[seat]);
  return { ok: true };
}

/** The first player owner by id of a thing several may own: its seat is theirs alone. */
function firstPlayer(state: RoomState, ownerIds: readonly string[]): string | undefined {
  let first: string | undefined;
  for (const id of ownerIds) if (ownEntry(state.members, id)?.kind === "player" && (first === undefined || id < first)) first = id;
  return first;
}

function byId<T extends { id: string }>(list: T[]): T[] {
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Each member's things of one seat's class, first by id, up to `most` each. */
function heldFirst<T extends { id: string }>(things: Iterable<T>, ownerOf: (thing: T) => string | undefined, most: number): T[] {
  const per = new Map<string, number>();
  const out: T[] = [];
  for (const thing of byId([...things])) {
    const owner = ownerOf(thing);
    if (owner === undefined) continue;
    const held = per.get(owner) ?? 0;
    if (held >= most) continue;
    per.set(owner, held + 1);
    out.push(thing);
  }
  return out;
}

/**
 * The things seats hold in `sceneId`'s scopes, or with no scene only the
 * rows and asks: for each member, the first
 * by id of what their seats count, up to each seat's number, with no view
 * test, so a seat-held thing out of its owner's sight for a moment is still
 * that seat's. A thing with several player owners is its first owner's by id.
 */
export function seatHeld(state: RoomState, sceneId: string | null): SeatHeld {
  const group: ReadonlySet<string> = sceneId === null ? new Set() : sceneGroup(state, sceneId);
  const player = (id: string) => (ownEntry(state.members, id)?.kind === "player" ? id : undefined);
  const tokens = heldFirst(
    Object.values(state.tokens).filter((t) => group.has(t.sceneId)),
    (t) => {
      const character = seatCharacter(state, t);
      return character ? firstPlayer(state, character.ownerIds) : undefined;
    },
    SEAT.tokens,
  );
  const riding = heldFirst(
    Object.values(state.templates).filter((t) => t.attachedTo !== undefined && group.has(t.sceneId)),
    (t) => player(t.ownerId),
    SEAT.ridingAreas,
  );
  // A floor's seat, held on every floor of the scene, since the caps count areas across its floors together.
  const freeByFloor = new Map<string, AreaTemplate[]>();
  for (const t of Object.values(state.templates)) {
    if (t.attachedTo !== undefined || !group.has(t.sceneId)) continue;
    const list = freeByFloor.get(t.sceneId);
    if (list) list.push(t);
    else freeByFloor.set(t.sceneId, [t]);
  }
  const free = [...freeByFloor.values()].flatMap((areas) => heldFirst(areas, (t) => player(t.ownerId), SEAT.freeAreas));
  const drawings = heldFirst(
    Object.values(state.drawings).filter((d) => sceneId !== null && d.sceneId === sceneId),
    (d) => player(d.ownerId),
    SEAT.drawings,
  );
  const points = new Map<string, number>();
  for (const d of drawings) points.set(d.ownerId, (points.get(d.ownerId) ?? 0) + d.points.length);
  let pointValues = 0;
  for (const held of points.values()) pointValues += Math.min(held, SEAT.pointValues);
  const rows = heldFirst(
    state.encounter?.entries ?? [],
    (e) => firstPlayer(state, rowOwners(state, e)),
    SEAT.rows,
  );
  const casts = heldFirst(Object.values(state.casts), (c) => player(c.by), ASKS_PER_MEMBER_SCENE);
  return {
    tokens: new Set(tokens.map((t) => t.id)),
    templates: new Set([...riding, ...free].map((t) => t.id)),
    drawings: new Set(drawings.map((d) => d.id)),
    pointValues,
    rows: new Set(rows.map((r) => r.id)),
    casts: new Set(casts.map((c) => c.id)),
    // The DM's reading of the blocks rounds them all, as before seats.
    blocks: new Set(),
    blockBytes: 0,
    blockShown: 0,
  };
}

/**
 * A player's own things that their copy holds (ownHeld), by id, each as the
 * copy holds it, and in `unseenAreas` the areas held while their copy holds
 * neither them nor the creature or floor they are on, as stored.
 */
export type OwnHeld = Record<"token" | "template" | "drawing" | "row" | "cast" | "companionBlock", ReadonlyMap<string, unknown>> & { readonly unseenAreas: ReadonlySet<string> };

/**
 * What a player's own copy holds of their own seat things on `floors`, and
 * of their rows, asks and characters' companion blocks, each as the copy
 * holds it (SeatView `copy`). A player's far counts hold only these
 * exactly, and the far bytes these and the rest their own ops grow
 * (server/rooms/sizeGuard.ts ownCopyBytes). Each rounds all the rest into
 * the stepped part: other players' seat things, and whatever the copy
 * leaves out of their own (LP43-PRIV-1, D-261116-015 and 026).
 * The copy is the projection's own, so every rule it reads applies, a
 * blackout's included, and what the copy leaves out never changes the
 * exact part: twins whose stepped parts round alike give that player equal
 * answers. seatHeld, which the DM's lines read, has no view test and holds
 * every player's stored things, so it would not.
 */
export function ownHeld(state: RoomState, memberId: string, view: SeatView, floors: ReadonlySet<string>): OwnHeld {
  const unseenAreas = new Set<string>();
  const copies = <T extends { id: string }>(kind: CopiedKind, things: Iterable<T>, own: (thing: T) => boolean, follows?: (thing: T) => boolean): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    for (const thing of things) {
      if (!own(thing)) continue;
      const copy = view.copy(kind, thing.id);
      if (copy !== null) out.set(thing.id, copy);
      else if (follows?.(thing)) {
        out.set(thing.id, thing);
        if (kind === "template") unseenAreas.add(thing.id);
      }
    }
    return out;
  };
  // An area of theirs on a creature their copy does not hold, or on a floor they do not hold, stays held while their copy
  // holds neither (D-261119-017, D-261120-010). Its floor, which changes while they cannot see it, is never read
  // (D-261119-021). A drawing or an ask of theirs never changes once made, so one their copy does not hold stays held as
  // stored, wherever it is. An area or a drawing is held only while it is stored shown to players, so one the DM hid
  // reads as a deleted one does, where they see it or not (LP43-PRIV-1, D-261120-012). Behind a blackout their copy holds
  // nothing.
  const blackout = state.meta.view?.blackout === true;
  const onUnseen = (t: AreaTemplate) => !blackout && t.visibility === "all" && (!view.holds(t.sceneId) || (t.attachedTo !== undefined && !view.sees(t.attachedTo)));
  const shownDrawing = (d: Drawing) => !blackout && d.visibility === "all";
  const unchanging = () => !blackout;
  return {
    unseenAreas,
    // Their seat's and any they own outright, a creature the DM lent them included, as every owner may write to theirs.
    token: copies("token", Object.values(state.tokens), (t) => floors.has(t.sceneId) && ownsSeatToken(state, memberId, t)),
    template: copies("template", Object.values(state.templates), (t) => floors.has(t.sceneId) && t.ownerId === memberId, onUnseen),
    drawing: copies("drawing", Object.values(state.drawings), (d) => floors.has(d.sceneId) && d.ownerId === memberId, shownDrawing),
    row: copies("row", state.encounter?.entries ?? [], (e) => ownsRow(state, memberId, e)),
    cast: copies("cast", Object.values(state.casts), (c) => c.by === memberId, unchanging),
    companionBlock: copies("companionBlock", Object.values(state.companionBlocks), (b) => ownEntry(state.characters, b.characterId)?.ownerIds.includes(memberId) ?? false),
  };
}

/** The kinds of a player's own things their far counts hold exactly. */
type OwnKind = "token" | "template" | "drawing" | "row" | "cast" | "companionBlock";
const OWN_KINDS: readonly OwnKind[] = ["token", "template", "drawing", "row", "cast", "companionBlock"];

/**
 * A player's far counts' exact parts in `sceneId`'s scopes before and after
 * their op, over one membership as their far bytes read it
 * (server/rooms/sizeGuard.ts exactOver): what their own copy held of their
 * own things before (ownHeld), and what the op made that it holds after.
 * A thing of it their copy no longer holds counts as it did before while
 * the room still stores it in the count's scope, and one no longer stored
 * there counts nothing, so nothing that enters their copy without their op
 * making it and nothing hidden that leaves the room moves the exact part.
 */
function playerFarHeldOver(before: RoomState, after: RoomState, sceneId: string | null, memberId: string, viewOf: SeatViewOf): { before: SeatHeld; after: SeatHeld } {
  const scope = (state: RoomState) => (sceneId === null ? new Set<string>() : sceneGroup(state, sceneId));
  const was = ownHeld(before, memberId, viewOf(before), scope(before));
  const now = ownHeld(after, memberId, viewOf(after), scope(after));
  const group = scope(after);
  const storedIn = (state: RoomState, kind: OwnKind, id: string, inScope: boolean): boolean => {
    const at = (thing: { sceneId: string } | undefined) => thing !== undefined && (!inScope || group.has(thing.sceneId));
    if (kind === "token") return at(ownEntry(state.tokens, id));
    if (kind === "template") return at(ownEntry(state.templates, id));
    if (kind === "drawing") return at(ownEntry(state.drawings, id));
    if (kind === "row") return state.encounter?.entries.some((e) => e.id === id) ?? false;
    if (kind === "cast") return ownEntry(state.casts, id) !== undefined;
    return ownEntry(state.companionBlocks, id) !== undefined;
  };
  const over = {} as Record<OwnKind, Map<string, unknown>>;
  for (const kind of OWN_KINDS) {
    const out = new Map<string, unknown>();
    for (const [id, copy] of was[kind]) {
      const held = now[kind].get(id);
      if (held !== undefined) out.set(id, held);
      else if (storedIn(after, kind, id, true)) out.set(id, copy);
    }
    for (const [id, copy] of now[kind]) if (!was[kind].has(id) && !storedIn(before, kind, id, false)) out.set(id, copy);
    over[kind] = out;
  }
  return { before: seatHeldOf(before, sceneId, was), after: seatHeldOf(after, sceneId, over) };
}

/** A player's far counts' exact part in `sceneId`'s scopes, as seatHeld's, from their own things each as their copy holds it. */
function seatHeldOf(state: RoomState, sceneId: string | null, own: Readonly<Record<OwnKind, ReadonlyMap<string, unknown>>>): SeatHeld {
  const drawings = [...own.drawing].filter(([id]) => state.drawings[id]!.sceneId === sceneId);
  const pointValues = drawings.reduce((sum, [, copy]) => sum + (copy as Drawing).points.length, 0);
  const ids = (copies: ReadonlyMap<string, unknown>) => new Set(copies.keys());
  // A player's own block update writes its rev, which their copy holds as 0: the stored block comes out of the
  // stepped part, and the copy counts with the rev at its widest.
  let blockBytes = 0;
  let blockShown = 0;
  for (const [id, copy] of own.companionBlock) {
    blockBytes += companionBlockBytes(state.companionBlocks[id]!);
    blockShown += companionBlockBytes(copy as CompanionBlock) - serializedBytes((copy as CompanionBlock).rev) + String(WIDEST_REV).length;
  }
  return { tokens: ids(own.token), templates: ids(own.template), drawings: new Set(drawings.map(([id]) => id)), pointValues, rows: ids(own.row), casts: ids(own.cast), blocks: ids(own.companionBlock), blockBytes, blockShown };
}

/** Who sent an op, as the live limits read it: a player's seats need their member id and their own view. */
export type LimitSender = { role: "dm" } | { role: "player"; memberId: string; viewOf: SeatViewOf };

/**
 * What kind of op the live limits judge (shared/farLine.ts opKind): a
 * deletion meets no count, an exempt op no far line, and `seats` an op
 * that can put a thing into a seat's class (a create, a restore, an area
 * attached or detached).
 */
export type LimitKind = { far: "deletion" | "exempt" | "meets"; seats: boolean };

/**
 * The live limits on the state an op would produce, for one scene (or
 * none), as the actor admits it. A player's op meets the public counts,
 * the rules on one thing and their seats. The DM's meets the room caps
 * over the rest, what no seat holds, and only when it adds to the total
 * the cap counts. Both meet the far line unless the kind is exempt. A
 * deletion meets nothing. `checkLimits` stays today's rules, which a room
 * import may pass instead of the far line.
 */
export function admitLimits(state: RoomState, sceneId: string | null, before: RoomState, sender: LimitSender, kind: LimitKind): LimitCheck {
  if (kind.far === "deletion") return { ok: true };
  if (sender.role === "player") sender = { ...sender, viewOf: viewsOnce(sender.viewOf) };
  const near = sender.role === "player" ? playerLimits(state, sceneId, before, sender, kind) : restLimits(state, sceneId, before);
  if (!near.ok || kind.far !== "meets") return near;
  // A player's far counts hold exactly only their own copy's own things, the DM's every seat's (LP43-PRIV-1).
  if (sender.role === "dm") return farLimits(state, sceneId, before, seatHeld(state, sceneId));
  const held = playerFarHeldOver(before, state, sceneId, sender.memberId, sender.viewOf);
  return farLimits(state, sceneId, before, held.after, held.before);
}

/** A view of each state built at most once, since a player's seats and far counts read the same one. */
function viewsOnce(viewOf: SeatViewOf): SeatViewOf {
  const views = new WeakMap<RoomState, SeatView>();
  return (state) => {
    let view = views.get(state);
    if (!view) views.set(state, (view = viewOf(state)));
    return view;
  };
}

/** The limits a player's op meets besides the far line: the counts every copy holds, the rules on one thing, and their own seats. */
function playerLimits(state: RoomState, sceneId: string | null, before: RoomState, sender: Extract<LimitSender, { role: "player" }>, kind: LimitKind): LimitCheck {
  if (Object.keys(state.characters).length > LIMITS.charactersPerRoom) return roomFull(`${n(LIMITS.charactersPerRoom)} characters`);
  if (Object.keys(state.members).length > LIMITS.membersPerRoom) return roomFull(`${n(LIMITS.membersPerRoom)} members`);
  const blocks = checkCompanionBlocks(state, "player");
  if (!blocks.ok) return blocks;
  for (const scene of Object.values(state.scenes)) {
    if (scene.bounds.w > LIMITS.sceneCells || scene.bounds.h > LIMITS.sceneCells) return over(`a scene is at most ${n(LIMITS.sceneCells)} cells a side`);
  }
  if (sceneId !== null) {
    for (const d of Object.values(state.drawings)) {
      if (d.sceneId === sceneId && d.points.length > LIMITS.drawingPointValues) return over(`a drawing has at most ${n(LIMITS.drawingPointValues)} point values`);
    }
  }
  return kind.seats ? seatCheck(before, state, sender.memberId, sceneId, sender.viewOf) : { ok: true };
}

/** The counts one scene's caps read: tokens and areas across its floors, drawings and their point values on the floor. */
type SceneCounts = { tokens: number; templates: number; drawings: number; points: number };

function sceneCounts(state: RoomState, sceneId: string): SceneCounts {
  const group = sceneGroup(state, sceneId);
  const counts: SceneCounts = { tokens: 0, templates: 0, drawings: 0, points: 0 };
  for (const t of Object.values(state.tokens)) if (group.has(t.sceneId)) counts.tokens++;
  for (const t of Object.values(state.templates)) if (group.has(t.sceneId)) counts.templates++;
  for (const d of Object.values(state.drawings)) {
    if (d.sceneId !== sceneId) continue;
    counts.drawings++;
    counts.points += d.points.length;
  }
  return counts;
}

/** The counts no seat holds: the DM's part, which the room caps read. */
function restOf(counts: SceneCounts, held: SeatHeld): SceneCounts {
  return { tokens: counts.tokens - held.tokens.size, templates: counts.templates - held.templates.size, drawings: counts.drawings - held.drawings.size, points: counts.points - held.pointValues };
}

function rowCount(state: RoomState): number {
  return state.encounter?.entries.length ?? 0;
}

/**
 * Today's room caps for the DM and the server, over the rest: a count
 * refuses only when the op adds to the total it counts and the rest is
 * past the cap, so a hide, a hand-over or a roster change
 * never meets one, and a move into a full scene still does.
 */
function restLimits(state: RoomState, sceneId: string | null, before: RoomState): LimitCheck {
  if (Object.keys(state.scenes).length > LIMITS.scenesPerRoom) return roomFull(`${n(LIMITS.scenesPerRoom)} scenes`);
  if (Object.keys(state.characters).length > LIMITS.charactersPerRoom) return roomFull(`${n(LIMITS.charactersPerRoom)} characters`);
  if (Object.keys(state.members).length > LIMITS.membersPerRoom) return roomFull(`${n(LIMITS.membersPerRoom)} members`);
  if (Object.keys(state.handouts).length > LIMITS.handoutsPerRoom) return roomFull(`${n(LIMITS.handoutsPerRoom)} handouts`);
  const monsters = checkMonsters(state);
  if (!monsters.ok) return monsters;
  if (Object.keys(state.srdImages).length > LIMITS.srdImagesPerRoom) return roomFull(`${n(LIMITS.srdImagesPerRoom)} SRD monster images`);
  if (Object.keys(state.savedEncounters).length > LIMITS.savedEncountersPerRoom) return roomFull(`${n(LIMITS.savedEncountersPerRoom)} saved encounters`);
  const roomHeld = seatHeld(state, sceneId);
  const rows = rowCount(state);
  if (rows > rowCount(before) && rows - roomHeld.rows.size > LIMITS.encounterRows) return roomFull(`${n(LIMITS.encounterRows)} initiative rows`);
  const journal = checkJournal(state);
  if (!journal.ok) return journal;
  const blocks = checkCompanionBlocks(state, "dm", before);
  if (!blocks.ok) return blocks;
  const handoutPages = checkHandoutPages(state, before);
  if (!handoutPages.ok) return handoutPages;
  if (Object.keys(state.rolls).length > LIMITS.openRollsPerRoom) return over(`at most ${n(LIMITS.openRollsPerRoom)} roll requests can be open at once. Close one first`);
  const casts = Object.keys(state.casts).length;
  if (casts > Object.keys(before.casts).length && casts - roomHeld.casts.size > LIMITS.openCastsPerRoom) {
    return over(`at most ${n(LIMITS.openCastsPerRoom)} asks for saves can wait at once. The DM resolves one first`);
  }
  for (const scene of Object.values(state.scenes)) {
    if (scene.bounds.w > LIMITS.sceneCells || scene.bounds.h > LIMITS.sceneCells) return over(`a scene is at most ${n(LIMITS.sceneCells)} cells a side`);
  }
  if (sightHoldersRaised(state, before)) return over(SIGHT_HOLDERS_FULL);
  if (sceneId === null) return { ok: true };
  const now = sceneCounts(state, sceneId);
  const was = sceneCounts(before, sceneId);
  const rest = restOf(now, roomHeld);
  for (const d of Object.values(state.drawings)) {
    if (d.sceneId === sceneId && d.points.length > LIMITS.drawingPointValues) return over(`a drawing has at most ${n(LIMITS.drawingPointValues)} point values`);
  }
  if (now.tokens > was.tokens && rest.tokens > LIMITS.tokensPerScene) return sceneFull(`${n(LIMITS.tokensPerScene)} tokens`);
  if (now.templates > was.templates && rest.templates > LIMITS.templatesPerScene) return sceneFull(`${n(LIMITS.templatesPerScene)} areas`);
  if (now.drawings > was.drawings && rest.drawings > LIMITS.drawingsPerScene) return sceneFull(`${n(LIMITS.drawingsPerScene)} drawings`);
  if (now.points > was.points && rest.points > LIMITS.drawingPointValuesPerScene) return sceneFull(`${n(LIMITS.drawingPointValuesPerScene)} drawing point values`);
  let labels = 0;
  for (const l of Object.values(state.labels)) if (l.sceneId === sceneId) labels++;
  if (labels > LIMITS.labelsPerScene) return sceneFull(`${n(LIMITS.labelsPerScene)} labels`);
  const draft = ownEntry(state.fogDrafts, sceneId);
  if (draft && draft.ops.length > LIMITS.fogDraftOpsPerScene) return sceneFull(`${n(LIMITS.fogDraftOpsPerScene)} fog changes in its draft`);
  return checkMapLimits(state, sceneId, before, "dm");
}

/** A far count: the DM's part rounded up to its step and the players' part exactly, so nothing reads the DM's part closer than a step. */
function farCount(total: number, held: number): number {
  return roundUp(total - held, FAR.countStep) + held;
}

/** The room's companion blocks, their count and bytes. The far line reads each rounded up to its step. */
function blockTotals(state: RoomState): { count: number; bytes: number } {
  let bytes = 0;
  const blocks = Object.values(state.companionBlocks);
  for (const block of blocks) bytes += companionBlockBytes(block);
  return { count: blocks.length, bytes };
}

/**
 * The far line's counts (FAR), for one scene or none, every room alike: a
 * count refuses an op that adds to it while the far count is past the line,
 * with the cap's own words. Without `before`, as for a room import, the line
 * is absolute. `held` is the exact part: every seat's (seatHeld) for the DM
 * and an import, whose op adds when the total grows. For a player's op it is
 * their own copy's over one membership, with `heldBefore` the same before
 * the op, and the op adds when their exact count grew or their whole far
 * count did, the rest read in steps, as their far bytes read it
 * (readingGrew). The byte lines are the size guard's
 * (server/rooms/sizeGuard.ts).
 */
export function farLimits(state: RoomState, sceneId: string | null, before?: RoomState, held: SeatHeld = seatHeld(state, sceneId), heldBefore?: SeatHeld): LimitCheck {
  const grows = (now: number, nowHeld: number, was: number, wasHeld: number) => (heldBefore === undefined ? now > was : nowHeld > wasHeld || farCount(now, nowHeld) > farCount(was, wasHeld));
  const rows = rowCount(state);
  if ((!before || grows(rows, held.rows.size, rowCount(before), heldBefore?.rows.size ?? 0)) && farCount(rows, held.rows.size) > FAR.rows) return roomFull(`${n(FAR.rows)} initiative rows`);
  const casts = Object.keys(state.casts).length;
  if ((!before || grows(casts, held.casts.size, Object.keys(before.casts).length, heldBefore?.casts.size ?? 0)) && farCount(casts, held.casts.size) > FAR.asks) {
    return over(`at most ${n(FAR.asks)} asks for saves can wait at once. The DM resolves one first`);
  }
  const blocks = blockTotals(state);
  const blocksBefore = before && before.companionBlocks !== state.companionBlocks ? blockTotals(before) : before ? blocks : undefined;
  if ((!blocksBefore || grows(blocks.count, held.blocks.size, blocksBefore.count, heldBefore?.blocks.size ?? 0)) && farCount(blocks.count, held.blocks.size) > FAR.blocks) {
    return over(`The room can hold at most ${n(FAR.blocks)} companion stat blocks. Delete one first.`);
  }
  const blockReading = { stepped: blocks.bytes - held.blockBytes, exact: held.blockShown };
  const blocksGrew = () =>
    !blocksBefore || (heldBefore === undefined ? blocks.bytes > blocksBefore.bytes : readingGrew({ stepped: blocksBefore.bytes - heldBefore.blockBytes, exact: heldBefore.blockShown }, blockReading));
  if (farReading(blockReading.stepped, blockReading.exact) > FAR.blockBytes && blocksGrew()) {
    return over(`The room can hold at most ${n(FAR.blockBytes / MiB)} MiB of companion stat blocks. Delete one first.`);
  }
  if (sceneId === null) return { ok: true };
  const now = sceneCounts(state, sceneId);
  const was = before ? sceneCounts(before, sceneId) : undefined;
  const heldOf = (counts: SeatHeld): SceneCounts => ({ tokens: counts.tokens.size, templates: counts.templates.size, drawings: counts.drawings.size, points: counts.pointValues });
  const nowHeld = heldOf(held);
  const wasHeld = heldBefore ? heldOf(heldBefore) : undefined;
  const grew = (key: keyof SceneCounts) => !was || grows(now[key], nowHeld[key], was[key], wasHeld?.[key] ?? 0);
  if (grew("tokens") && farCount(now.tokens, held.tokens.size) > FAR.tokens) return sceneFull(`${n(FAR.tokens)} tokens`);
  if (grew("templates") && farCount(now.templates, held.templates.size) > FAR.areas) return sceneFull(`${n(FAR.areas)} areas`);
  if (grew("drawings") && farCount(now.drawings, held.drawings.size) > FAR.drawings) return sceneFull(`${n(FAR.drawings)} drawings`);
  if (grew("points") && farCount(now.points, held.pointValues) > FAR.pointValues) return sceneFull(`${n(FAR.pointValues)} drawing point values`);
  return { ok: true };
}
