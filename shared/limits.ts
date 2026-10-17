import { roomHandoutPages } from "./handouts.ts";
import { isWritable } from "./writable.ts";
import { CHUNK_CELLS, HEIGHTS_CHARS, type BuildChunk, type CompanionBlock, type CustomMonster, type JournalPage, type RoomState, type Token } from "./model.ts";

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
   * A character's companions on one scene (docs/design-v1-combat-flow.md
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
   * Pages in one handout (docs/design-v1-pdf-handouts.md 3.7). A handout
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
   * Companion stat blocks (docs/design-v1-companion-stat-blocks.md 3.4).
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
  logInMemory: 200,
  logStored: 10_000,
  stateBytes: 8 * 1024 * 1024,
  projectedSceneBytes: 3 * 1024 * 1024,
  areaFeetMin: 5,
  areaFeetMax: 1_000,
  customTokenCellsMin: 0.5,
  customTokenCellsMax: 20,
  loadedRooms: 50,
  loadedRoomsPerCreatorIp: 10,
  /**
   * Free walls (docs/design-v1-maps-vision.md section 2.4). A scene of them
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
   * Pillar cells per scene (docs/design-v1-maps-vision.md 2.4). Each is four
   * stored wall segments that every derive of the scene's walls and every
   * counting pass reads, and no other limit bounds how many a build paints:
   * a pillar in every cell is 160,000 segments, well past the geometry
   * budgets. scripts/bench-walls.ts sizes it on the densest grid walls a
   * build can have, with free walls at the split's caps.
   */
  pillarsPerScene: 1_000,
  /**
   * Door and window edges per scene, on the grid or free, secret doors
   * included (docs/design-v1-maps-vision.md 2.4). Plain walls merge into
   * runs, but a door or window stays one stored segment and one entry in
   * every derive's lookups, so only the scene's byte size bounded them: tens
   * of thousands fit, past the geometry budgets. A real map has a few
   * hundred. scripts/bench-walls.ts sizes it beside the pillar cap.
   */
  doorsAndWindowsPerScene: 1_000,
  /**
   * Drawn edges per scene: every edge entry a scene's chunks store, walls,
   * doors, windows and removed automatic walls alike, so doors and windows
   * count here too (docs/design-v1-maps-vision.md 2.4). Each is an entry the
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
  /** A scene thumbnail upload, and its stored long side (section 3.3). */
  thumbUploadBytes: 512 * 1024,
  thumbMaxPx: 320,
  /**
   * Party vision (wave 4, docs/design-v1-maps-vision.md 2.4). Past the
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
   * reference server against 250 (docs/design-v1-maps-vision.md 2.4 and
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

  // Wave 5 (docs/design-v1-dm-tools.md 2.4).

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

  // Wave 7: dice (docs/design-v1-dice.md 3.2 and 4.4).

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
} as const;

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
  const journal = checkJournal(state);
  if (!journal.ok) return journal;
  const blocks = checkCompanionBlocks(state);
  if (!blocks.ok) return blocks;
  const handoutPages = checkHandoutPages(state, before);
  if (!handoutPages.ok) return handoutPages;
  if (Object.keys(state.rolls).length > LIMITS.openRollsPerRoom) return over(`at most ${n(LIMITS.openRollsPerRoom)} roll requests can be open at once. Close one first`);
  for (const scene of Object.values(state.scenes)) {
    if (scene.bounds.w > LIMITS.sceneCells || scene.bounds.h > LIMITS.sceneCells) {
      return over(`a scene is at most ${n(LIMITS.sceneCells)} cells a side`);
    }
  }
  if (sceneId === undefined || sceneId === null) return { ok: true };
  let tokens = 0;
  let templates = 0;
  let drawings = 0;
  let points = 0;
  let labels = 0;
  for (const t of Object.values(state.tokens)) if (t.sceneId === sceneId) tokens++;
  for (const t of Object.values(state.templates)) if (t.sceneId === sceneId) templates++;
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
  const draft = state.fogDrafts[sceneId];
  if (draft && draft.ops.length > LIMITS.fogDraftOpsPerScene) return sceneFull(`${n(LIMITS.fogDraftOpsPerScene)} fog changes in its draft`);
  return checkMapLimits(state, sceneId, before, by);
}

/** The refusal of a save past the room's handout pages, with what frees some (docs/design-v1-pdf-handouts.md 3.7). */
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
 * The wave 3 counts of one scene (docs/design-v1-maps-vision.md 2.4). The
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
  const phases = state.scenes[sceneId]?.phases?.length ?? 0;
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
 * The journal (docs/design-v1-dm-tools.md 3.7): a count, and bytes for each
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

/** The refusal of a player's block save past their save budget (docs/design-v1-companion-stat-blocks.md 3.5). The editor knows it by these words. */
export const BLOCK_SAVES_TOO_FAST = "Too many stat block saves at once. Wait a few seconds, then save again.";
/** A block save the room's state limit refuses, in place of the size guard's words (section 3.4). */
export const BLOCKS_ROOM_TOO_FULL = "The room is too full to save this stat block. Ask the DM to free some space, then save again.";
/** A block save at the room's storage quota, in place of the quota's words (section 3.4). Deleting is still accepted. */
export const BLOCKS_AT_QUOTA = "The room is at its storage limit, so stat blocks cannot be saved until the DM frees space. Deleting a stat block still works.";

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
 * Companion stat blocks (docs/design-v1-companion-stat-blocks.md 3.4): each
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
    const name = state.characters[characterId]?.name ?? "A character";
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
 * (docs/design-v1-maps-vision.md 2.4): moving players to a vision scene,
 * turning vision or fog on there, or a room import. Only the DM does any
 * of these, so the DM reads it.
 */
export const NO_ROOM_TO_EXPLORE = "The room is too full for the party to explore that scene. Turn vision off there, or delete unused scenes to free space.";

/** The widest rev a stored entity can carry, 16 digits. */
const WIDEST_REV = Number.MAX_SAFE_INTEGER;
const FULL_BITS = "A".repeat(HEIGHTS_CHARS);

/** The scene whose explored layer can grow: the player scene, while it has vision and fog on. */
export function exploringSceneId(state: Pick<RoomState, "meta" | "scenes">): string | null {
  const id = state.meta.playerSceneId;
  const scene = id === null ? undefined : state.scenes[id];
  return scene && scene.vision?.on === true && scene.fogEnabled ? scene.id : null;
}

/**
 * The bytes the explored layer may still grow by (docs/design-v1-maps-vision.md
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
 */
export function exploredReserve(state: Pick<RoomState, "meta" | "scenes" | "exploredTiles">): number {
  const sceneId = exploringSceneId(state);
  if (sceneId === null) return 0;
  const scene = state.scenes[sceneId]!;
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
      const held = state.exploredTiles[`${sceneId}:${tx},${ty}`];
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
