import { chunkKey, holderChunkKey, holderTileKey, keys, parseKey, readEntity, tileKey, type EntityKey } from "#shared/keys.ts";
import { lineAudience } from "#shared/logRings.ts";
import { AUTO_CHARS, CHUNK_CELLS, FALL_RIDERS_MOST, KNOWN_CHARS, UP_DIR_CHARS, type Actor, type AreaTemplate, type BuildChunk, type Character, type Effect, type Encounter, type EncounterSnapshot, type Fall, type LifeState, type LogEntry, type Token, type Trap } from "#shared/model.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { DAMAGE_TYPES } from "#shared/rules/damage.ts";
import { trapOwnBytes } from "#shared/reducer/traps.ts";
import { exploredReserve, FAR, farByteLine, farBytesOver, farReading, HARD, keptForPlayers, KEPT_FOR_PLAYERS_FULL, LIMITS, MARKED_POOL, MARKED_SHARE_MOST, MOST_SIGHT_HOLDERS, NO_ROOM_TO_EXPLORE, ownHeld, readingGrew, reservedExploreFloors, ROOM_FULL, SCENE_FULL, SEAT, seatHeld, serializedBytes, tokenFloors, acceptSeats, utf8Bytes, WIDEST_REV, type CopiedKind, type FarLineOf, type LimitCheck, type SeatView } from "#shared/limits.ts";
import { FALL_FEET_MOST, MAX_NAME, MAX_PATH_CORNERS, MAX_PATH_STOPS, SHED_STEPS_MOST, type OpOf } from "#shared/protocol.ts";
import type { RoomState, Scene, Viewer } from "#shared/model.ts";
import { NUMBERS_MOST } from "#shared/numbering.ts";
import { movesAnyToken } from "#shared/permissions.ts";
import { chunkPositions, heldClock, heldGroundMap, perPlayerScene, publicEffects, seatView } from "#shared/project.ts";
import { keepsMemory, type Layer } from "#shared/reducer/memory.ts";
import { floorsOf, onPlayersScene } from "#shared/rules/floors.ts";
import { turnUnderWay } from "#shared/rules/path.ts";
import { encodeTile, fullTileBits, tilesAcross } from "#shared/rules/fog.ts";
import { sightEntryMaxBytes } from "#shared/rules/vision.ts";
import { isWritable } from "#shared/writable.ts";
import { ABSENT, keptPart, markAccepted, newAccepted, releaseAccepted, roomPart, type Part } from "#shared/accepted.ts";
import { keyBytes, MEMORY_CAP, wallLargestBytes } from "./memorySize.ts";

/**
 * The byte limits of design 10.5 (8 MiB of serialized state, 3 MiB per
 * projected scene) without serializing the room on every op.
 *
 * The guard keeps the last exact size plus the most the state can have grown
 * since, and only serializes again when that sum could pass the limit. Each
 * op's growth comes from what it actually wrote (`growthBound`), not from the
 * size of its frame: one small op can write far more than it carries, such
 * as a fog reset over a 200 by 200 scene or an undo that restores a deleted
 * scene. A room far under its limits is therefore measured only at
 * snapshots, while a room near them is measured exactly before every op that
 * could cross.
 *
 * Wave 4 adds two reserves (docs/design/design-v1-maps-vision.md 2.4), both for
 * what can grow without an op that could be refused. The party's explored
 * layer grows by `sys.explore`, which is never refused, so the room check
 * and the exploring scene's projected check add what that layer may still
 * take (`exploredReserve`), and an explore only spends it. Sight is derived
 * and never stored, so every projected check of a vision scene adds the
 * most its sight tiles can take instead of measuring them.
 *
 * Per-player vision (docs/design/design-v1-per-player-vision.md 6.8) adds what a
 * player's own sight decides: on a per-player scene the party's layer and
 * each holder's, and on any scene the lists of who saw a creature's stop
 * or turn start. No measure reads them. Each counts at its widest instead,
 * from the scenes and the roster alone, so the answer an op gets never
 * depends on what another player's creatures saw (security rule 11).
 *
 * Wave 5 (docs/design/design-v1-dm-tools.md 2.4) splits a DM's projected scene into
 * the room-level part every DM projection shares (the monsters, the journal,
 * the roll requests, the characters, the log) and each scene's own part.
 * Journal pages and roll requests are room level, so an op on them touches
 * no scene, yet it grows every scene's projection, a scene nobody is viewing
 * included. So every op is checked against the room-level part plus the
 * largest scene part: the check of every scene and every DM at once.
 *
 * - The room-level part is measured exactly on every op, which costs only
 *   the collections the op wrote: sizes are kept per collection and per
 *   entity object, which are replaced and never changed. It counts the
 *   log's shared lines, which every DM receives.
 * - Each scene's own part is measured once, from one pass over the stored
 *   entities grouped by scene, at the room's first check, and kept with its
 *   growth bound. An op that touches a scene adds its growth there as
 *   before, and a scene whose bound could cross is measured exactly, by a
 *   pass over that scene's entities, never a projection.
 *
 * A DM's projection of a scene is exactly the two parts with the JSON around
 * them (and an empty sight map, whose real tiles the sight reserve covers),
 * and the log's lines and derived undo metadata outside the measure, so
 * the measure is the projection's size less those.
 *
 * Traps (docs/design/design-v1-traps.md 6.7) are counted so that a springing
 * never moves a measure: a trap's own fields exactly and, in place of what
 * the reducer writes on it and around it, fixed reserves from the complete
 * serialized writes (trapReserve, Appendix B), and the room's occurrences
 * and both trap logs at their bounds once it has a trap. So the measure is
 * the same whether or not, and however often, a trap went off, and the
 * actor measures a springing op without its trap step's writes, which the
 * reserves already hold (server/rooms/actor.ts).
 *
 * Companion stat blocks ride in every DM projection too, but outside this
 * measure (docs/design/design-v1-companion-stat-blocks.md 3.4): the measure counts
 * their field as empty, and the room's caps hold them to 3 MiB on their own
 * (shared/limits.ts). So a map, a monster or a journal page never grows
 * into the blocks' room, and a DM's snapshot is at most 3 MiB plus theirs.
 *
 * So do the log's lines that only some viewers or none read
 * (shared/logRings.ts): DM lines, party lines' copies and whispers. Each
 * ring bounds them on its own, by count and by bytes, about 2.8 MiB together
 * (shared/limits.ts), and the measure leaves them out. A hidden area's
 * reminder, another player's aura or a whisper between others then never
 * changes whether a player's op passes.
 *
 * The DM's derived meta.hpUndoLogIds likewise rides outside the measure:
 * it includes private log ids, so charging their actual bytes could reveal
 * hidden HP changes through another player's quota refusal. Only retained
 * shared and DM lines hold undo records, at most MAX_LOG + dmLogLines ids
 * (400). At 25 characters per id plus JSON, this adds less than 12 KiB to
 * a DM snapshot. It never grows stored state or the scene's quota.
 *
 * The DM-only save outcome ledger also stays outside these measures,
 * bounded separately to 100 KiB by its schema and lifecycle writes. A
 * lifecycle-only Apply or restore must not change player admission or how
 * much map memory the room retains.
 */

function roomFull(): LimitCheck {
  return { ok: false, code: "quota", message: ROOM_FULL };
}

function sceneFull(): LimitCheck {
  return { ok: false, code: "quota", message: SCENE_FULL };
}

/** The last exact size, and how much the state may have grown since. */
type Measure = { bytes: number; growth: number };

/**
 * How an op meets the far line (SizeGuard.check): not at all, with today's
 * reserves, or with per-player vision's at their widest. A DM's op that
 * raises those (`widestDm`) and the DM's other adds (`dmAdd`) read the
 * room's line the kept bytes sooner (shared/limits.ts keptForPlayers).
 */
export type FarJudge = "none" | "today" | "widest" | "widestDm" | "dmAdd";

/** The room measure's DM part: less what seats hold and players' companion blocks. */
function dmRoomBytes(state: RoomState, measured: number): number {
  return measured - heldBytes(state) - playerBlockBytes(state);
}

/** Whether the room's near measure with its reserves grows past what it was before the op. Without `before`, any op counts as growing. */
function grewRoom(before: RoomState | undefined, after: number, unreserved?: ReadonlySet<string>): boolean {
  if (before === undefined) return true;
  return after > measuredStateBytes(before) + exploredReserve(before) + memoryReserves(before, unreserved).whole;
}

export class SizeGuard {
  readonly stateLimit: number;
  readonly sceneLimit: number;
  #state: Measure | null = null;
  /** Each scene's own part (sceneOwnBytes), measured at the first check. */
  #scenes: Map<string, Measure> | null = null;
  /**
   * The layer caps the map step last measured every layer against
   * (capsKey), or null before it has: a marked scene's caps move only with
   * its fixed share and the roster, and a room's first step measures every
   * layer once, so a map held above its cap at the update forgets its
   * oldest tiles then.
   */
  #caps: string | null = null;
  #refusedScene: string | null = null;
  /** By how many bytes the room is past the far line at its widest, at the last exact reading (overFarLine). */
  #over = 0;
  /** What the room keeps of its measures over its accepted state (shared/accepted.ts). */
  readonly #accepted = newAccepted();

  constructor(opts: { stateLimit?: number; sceneLimit?: number } = {}) {
    this.stateLimit = opts.stateLimit ?? LIMITS.stateBytes;
    this.sceneLimit = opts.sceneLimit ?? LIMITS.projectedSceneBytes;
  }

  /** An exact measurement from outside, such as the snapshot just written, and with the state it measured, how far it is past the far line. */
  stateMeasured(bytes: number, state?: RoomState): void {
    this.#state = { bytes, growth: 0 };
    if (state) this.#over = Math.max(0, farRoomBytes(state, true, bytes) - FAR.roomBytes);
  }

  /**
   * The room accepted an op or a server op, or loaded: `state` is what it
   * left, and the measures every later state of the room reads move on to
   * it (shared/accepted.ts). A trial an op is checked on never moves them,
   * so what a read costs is the op's own writes, whatever was tried or
   * thrown away before it and whatever other rooms did.
   */
  accept(state: RoomState): void {
    markAccepted(this.#accepted, state);
    // The widths first: a part of facts the room no longer has leaves what it keeps before the others step.
    farWidthsByFloor(state, true);
    storedBytes(state, true);
    numberingAdjust(state, true);
    acceptSeats(state);
  }

  /** The room is gone, and what it kept goes with it. */
  release(): void {
    releaseAccepted(this.#accepted);
  }

  /** By how many bytes the room was past the far line at its widest at the last exact reading, 0 under it (the DM's `over`). */
  get over(): number {
    return this.#over;
  }

  /**
   * The scene whose own budget refused the last check, by its main floor,
   * or null when it passed or the room refused it, so an add of a floor
   * says the scene is full rather than the room (actor.ts,
   * docs/design/design-v1-floors.md 9).
   */
  get refusedScene(): string | null {
    return this.#refusedScene;
  }

  /** The share a reserve reads a sharing layer at beside its own cap (layerCap): a whole cap, since marked scenes' shares are fixed. */
  get share(): number {
    return MEMORY_CAP;
  }

  /** A layer's cap on a scene now (layerCap), the party's when `layer` is null. */
  memoryCap(state: RoomState, scene: Scene, layer: Layer = null): number {
    return layerCap(state, scene, layer);
  }

  /** Whether a layer cap may have fallen since the map step last measured every layer, so it measures every layer now. */
  capsMoved(state: RoomState): boolean {
    return this.#caps !== capsKey(state);
  }

  /** The map step measured every layer against the caps of `state`. */
  capsMeasured(state: RoomState): void {
    this.#caps = capsKey(state);
  }

  /**
   * Checks the state an op would produce, given at most how many bytes the
   * op added. On refusal nothing is recorded, because that state is
   * discarded. On success the growth is counted against the bounds of the
   * room and of each scene the op touched.
   *
   * `before` is the state the op applied to. An op that changes which scene
   * can explore (moving players, turning vision or fog on for the player
   * scene, an undo of either) is checked with the new scene's reserve, and
   * when only that reserve does not fit, the refusal says so in the words
   * the DM can act on (NO_ROOM_TO_EXPLORE).
   *
   * A scene already over its limit, as a room from before whispers counted
   * may be, refuses only an op that grows its whole measure, the room-level
   * part and its reserves included, compared exactly with `before`: a
   * shortened name or a deleted token on it passes, as does every edit
   * elsewhere. Without `before`, any op on the scene counts as growing it.
   *
   * An op that makes a scene per player, whose refusal comes of the room
   * per-player sight needs there (docs/design/design-v1-per-player-vision.md 6.8),
   * says so in the DM's words (PER_PLAYER_FULL). One that reserves players'
   * memory where it does not fit says that (MEMORY_FULL,
   * docs/design/design-v1-map-discovery.md 5.5).
   *
   * `role` is the sender's. Every op counts what players' copies may hold
   * beyond the DM's (discoveryReserve). A DM's growing edit on a scene over
   * its limit only by that gets SCENE_MAPS_FULL.
   *
   * Player limits: these lines, the near ones, answer the DM and the server
   * alone, over the DM's part (what no seat holds, and for the room less
   * players' companion blocks), and refuse only an op that grows the
   * measure's total. A player's op meets none of them: its growth is only
   * counted. `far` says how the op meets the far line (#far): not at all,
   * with today's reserves, or with per-player vision's at their widest, a
   * player's op's always and the DM's that raise them (`widestDm`, refused
   * in PER_PLAYER_FULL's words). An `exempt` kind (shared/farLine.ts
   * opKind) meets no near line, the DM's either, its growth only counted,
   * and reads the far line itself, where an op that meets the line stops
   * BOOKKEEPING_RESERVE short of it (shared/limits.ts farByteLine), so what
   * bookkeeping adds stays within the room's stored bound. The DM's adds
   * (`widestDm` and `dmAdd`) stop the kept bytes (keptForPlayers) sooner
   * on the room's. `player` is a player sender's member id, whose far
   * reading holds only their own copy's own things exactly, over one
   * membership with their op (exactOver).
   */
  check(next: RoomState, sceneIds: readonly string[], growth: number, before?: RoomState, role: Viewer["role"] = "dm", far: FarJudge = "none", exempt = false, player?: string): LimitCheck {
    this.#refusedScene = null;
    const near = role === "player" || exempt ? this.#account(next, sceneIds, growth, before) : this.#near(next, sceneIds, growth, before, role);
    if (!near.ok || far === "none") return near;
    return this.#far(next, before, far, exempt ? "exempt" : "meets", player);
  }

  /**
   * Counts the growth of an op that meets no byte line, a deletion or the
   * server's own op, so the room's and its scenes' bounds stay upper bounds:
   * a join on per-player scenes grows the stored per-player layers, and a
   * later check that read a stale bound would skip the exact read.
   */
  counted(next: RoomState, sceneIds: readonly string[], growth: number, before?: RoomState): void {
    this.#account(next, sceneIds, growth, before);
  }

  #near(next: RoomState, sceneIds: readonly string[], growth: number, before: RoomState | undefined, role: Viewer["role"]): LimitCheck {
    const answer = this.#check(next, sceneIds, growth, before, role);
    if (answer.ok || before === undefined) return answer;
    const switched = Object.values(next.scenes).filter((scene) => perPlayerScene(scene) && !perPlayerScene(before.scenes[scene.id]));
    if (switched.length > 0) {
      const plain = { ...next, scenes: { ...next.scenes } };
      for (const scene of switched) {
        const { perPlayer: _perPlayer, ...vision } = scene.vision!;
        plain.scenes[scene.id] = { ...scene, vision };
      }
      const fits = new SizeGuard({ stateLimit: this.stateLimit, sceneLimit: this.sceneLimit }).#check(plain, sceneIds, growth, before, role).ok;
      if (fits) {
        this.#refusedScene = null;
        return { ok: false, code: "quota", message: PER_PLAYER_FULL };
      }
    }
    const reserving = new Set<string>();
    for (const scene of Object.values(next.scenes)) {
      if (!memoryReserved(next, scene)) continue;
      const was = before.scenes[scene.id];
      if (!was || !memoryReserved(before, was) || memoryLayerCount(next, scene) > memoryLayerCount(before, was)) reserving.add(scene.id);
    }
    // Moving players to a scene the room cannot explore names that remedy, which frees the memory reserve too, unless
    // only the memory reserve grew, as on a move from a played scene to another the room explores at the same cost.
    const memoryGrew = memoryStateReserve(next) > memoryStateReserve(before) && exploredReserve(next) <= exploredReserve(before);
    if (answer.message === NO_ROOM_TO_EXPLORE && !memoryGrew) return answer;
    if (reserving.size > 0) {
      const other = new SizeGuard({ stateLimit: this.stateLimit, sceneLimit: this.sceneLimit });
      const without = other.#check(next, sceneIds, growth, before, role, reserving);
      if (without.ok) {
        this.#refusedScene = null;
        return { ok: false, code: "quota", message: MEMORY_FULL };
      }
      // Moving players to a scene that needs both its memory and its exploring room names exploring's remedy, which frees both.
      if (without.message === NO_ROOM_TO_EXPLORE) {
        this.#refusedScene = other.#refusedScene;
        return without;
      }
    }
    return answer;
  }

  /** The check itself. `unreserved` names scenes whose memory reserves it leaves out, to tell whether they alone refuse. */
  #check(next: RoomState, sceneIds: readonly string[], growth: number, before: RoomState | undefined, role: Viewer["role"], unreserved?: ReadonlySet<string>): LimitCheck {
    const updates: Array<() => void> = [];
    // The floors whose explored layer the op makes the room reserve for, as moving players to a scene does: each
    // floor of the players' scene with fog and party vision (docs/design/design-v1-floors.md 9), that scene alone
    // when it has one floor.
    const exploring = before === undefined ? new Set<string>() : newlyReserved(before, next);
    const newlyExploring = exploring.size > 0;
    const reserve = exploredReserve(next);
    const memory = memoryReserves(next, unreserved);
    const state = this.#state;
    const share = MEMORY_CAP;
    // A sharing layer reserves nothing here: the marked pool counts against the far line alone.
    const held = memory.whole;
    if (!state || state.bytes + state.growth + growth + reserve + held > this.stateLimit) {
      const bytes = measuredStateBytes(next);
      if (bytes + reserve + held > this.stateLimit && dmRoomBytes(next, bytes) + reserve + held > this.stateLimit && grewRoom(before, bytes + reserve + held, unreserved)) {
        return newlyExploring && bytes + held <= this.stateLimit ? { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE } : roomFull();
      }
      updates.push(() => this.stateMeasured(bytes));
    } else {
      updates.push(() => {
        state.growth += growth;
      });
    }
    const room = roomLevelBytes(next);
    const scenes = this.#sceneMeasures(before ?? next);
    const touched = new Set(sceneIds);
    for (const sceneId of scenes.keys()) if (!next.scenes[sceneId]) updates.push(() => scenes.delete(sceneId));
    // A scene's floors share its one budget (docs/design/design-v1-floors.md 9, D-261102-485): the room-level part once, and
    // every floor's own part and reserves, whichever floors players have reached.
    for (const floors of sceneGroups(next)) {
      const main = floors[0]!.floor?.of ?? floors[0]!.id;
      const sight = sum(floors, (scene) => sightReserve(scene) + perPlayerSceneReserve(next, scene));
      const explored = sum(floors, (scene) => exploredReserve(next, scene.id));
      const full = sum(floors, (scene) => discoveryReserve(next, scene, share, !unreserved?.has(scene.id)));
      const measures = floors.map((scene) => scenes.get(scene.id));
      const known = measures.every((measure) => measure !== undefined);
      const measured = sum(measures, (measure) => (measure ? measure.bytes + measure.growth : 0));
      // The op's growth counts once for the scene, on the first of its floors it wrote into.
      const grown = floors.findIndex((scene) => touched.has(scene.id));
      const added = grown >= 0 ? growth : 0;
      const fits = (maps: number) => known && SHELL_BYTES + room + measured + added + sight + explored + maps <= this.sceneLimit;
      // Players count what their copies may hold beyond the DM's too, except on a scene already over with it before
      // the op, whose players' ops go on as before map discovery (5.5, D-261027-03). Read only when the reserve is in the way.
      const lenient = () => role === "player" && full > 0 && before?.scenes[main] !== undefined && neededBefore(before, main, share, "dm") > this.sceneLimit;
      const maps = fits(full) || !lenient() ? full : 0;
      if (fits(maps)) {
        const measure = measures[grown];
        if (measure) updates.push(() => (measure.growth += added));
        continue;
      }
      const owns = floors.map((scene) => sceneOwnBytes(next, scene.id));
      const own = sum(owns, (bytes) => bytes);
      const need = SHELL_BYTES + room + own + sight + explored + maps;
      const judged = maps === full ? "dm" : "player";
      const newHere = floors.some((scene) => exploring.has(scene.id));
      if (need > this.sceneLimit && need - heldBytes(next, [main]) > this.sceneLimit && (before === undefined ? grown >= 0 || newHere : need > neededBefore(before, main, share, judged))) {
        const exploringHere = newHere && SHELL_BYTES + room + own + sight + maps <= this.sceneLimit;
        this.#refusedScene = main;
        if (exploringHere) return { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE };
        // Over only by what players' copies may hold beyond the DM's, which the DM can make room for. A player reads the plain words.
        return role === "dm" && maps > 0 && need - maps <= this.sceneLimit ? { ok: false, code: "quota", message: SCENE_MAPS_FULL } : sceneFull();
      }
      updates.push(() => floors.forEach((scene, i) => scenes.set(scene.id, { bytes: owns[i]!, growth: 0 })));
    }
    for (const update of updates) update();
    return { ok: true };
  }

  /**
   * A player's op against the near lines: never refused, its growth only
   * counted against the room's bound and its scenes', so the bounds stay
   * upper bounds for the next op.
   */
  #account(next: RoomState, sceneIds: readonly string[], growth: number, before: RoomState | undefined): LimitCheck {
    if (this.#state) this.#state.growth += growth;
    const scenes = this.#sceneMeasures(before ?? next);
    for (const sceneId of [...scenes.keys()]) if (!next.scenes[sceneId]) scenes.delete(sceneId);
    const touched = new Set(sceneIds);
    for (const floors of sceneGroups(next)) {
      const grown = floors.findIndex((scene) => touched.has(scene.id));
      if (grown < 0) continue;
      for (const [i, scene] of floors.entries()) {
        const measure = scenes.get(scene.id);
        if (!measure) scenes.set(scene.id, { bytes: sceneOwnBytes(next, scene.id), growth: 0 });
        else if (i === grown) measure.growth += growth;
      }
    }
    return { ok: true };
  }

  /**
   * The far line (shared/limits.ts FAR): the room's and each scene's
   * reading, all but what seats hold (for the room, players' companion
   * blocks included) with its reserves rounded up to FAR.byteStep and what
   * seats hold exactly, refuses an op that grows the measure's total past
   * it. A player's op reads their own reading instead (#farPlayer). Read
   * exactly only once the bound with a step to spare could pass the line.
   * Called after the near check counted the op's growth, so the bounds hold
   * it. The DM's adds read the DM's line, the kept bytes (keptForPlayers)
   * before the players' on the room, and one that only the kept room stops
   * says so (KEPT_FOR_PLAYERS_FULL). The kept bytes follow the room's
   * settings and roster, so on the DM's line an op that raises them grew
   * by as much: a setting turned on at the DM's line is refused, whatever
   * its own bytes.
   */
  #far(next: RoomState, before: RoomState | undefined, far: Exclude<FarJudge, "none">, kind: "meets" | "exempt", player: string | undefined): LimitCheck {
    const widest = far !== "today";
    if (player !== undefined) return this.#farPlayer(next, before, widest, kind, player);
    const dm = far === "widestDm" || far === "dmAdd";
    const kept = dm ? keptForPlayers(next) : 0;
    const line: FarLineOf = dm ? { dmKept: kept } : "players";
    const state = this.#state;
    const reserves = farReserves(next, widest);
    const roomLine = farByteLine(kind, "room", line)!;
    if (!state || state.bytes + state.growth + reserves + FAR.byteStep > roomLine) {
      const bytes = measuredStateBytes(next);
      const held = heldBytes(next, undefined, true);
      const grew = before === undefined || bytes + reserves > measuredStateBytes(before) + farReserves(before, widest);
      const keptGrew = dm && before !== undefined && kept > keptForPlayers(before);
      const dmPart = bytes - held + reserves;
      if (farBytesOver("room", kind, line, dmPart, held, grew || keptGrew)) {
        if (far === "widestDm") return { ok: false, code: "quota", message: PER_PLAYER_FULL };
        return dm && !farBytesOver("room", kind, "players", dmPart, held, grew) ? { ok: false, code: "quota", message: KEPT_FOR_PLAYERS_FULL } : roomFull();
      }
      this.#state = { bytes, growth: 0 };
    }
    const sceneLine = farByteLine(kind, "scene", line)!;
    // Every scene, as the near check reads them: the room-level part (characters, the fight, the shared log) is in each
    // scene's measure, so an op that grows it grows scenes it never touched.
    const room = roomLevelBytes(next);
    const scenes = this.#sceneMeasures(before ?? next);
    for (const floors of sceneGroups(next)) {
      const main = floors[0]!.floor?.of ?? floors[0]!.id;
      const reserved = sceneReserves(next, floors);
      const measures = floors.map((scene) => scenes.get(scene.id));
      const measured = sum(measures, (measure) => (measure ? measure.bytes + measure.growth : 0));
      if (measures.every((measure) => measure !== undefined) && SHELL_BYTES + room + measured + reserved + FAR.byteStep <= sceneLine) continue;
      const need = SHELL_BYTES + room + sum(floors, (scene) => sceneOwnBytes(next, scene.id)) + reserved;
      const held = heldBytes(next, [main], true);
      const widthsBefore = before?.scenes[main] ? farWidths(before, new Set(floorsOf(before, main).map((scene) => scene.id))) : 0;
      const grew = before === undefined || need > neededBefore(before, main, MEMORY_CAP, "dm") + widthsBefore;
      if (!farBytesOver("scene", kind, line, need - held, held, grew)) continue;
      this.#refusedScene = main;
      return far === "widestDm" ? { ok: false, code: "quota", message: PER_PLAYER_FULL } : sceneFull();
    }
    return { ok: true };
  }

  /**
   * A player's op at the far line (D-261121-060, 074, 121): at the room's
   * line and every scene's, refused when it grew and their reading after,
   * over one membership (exactOver), is past the line. It grew when their
   * exact part grew or their whole reading did, its stepped part rounded
   * (shared/limits.ts readingGrew). Both sides read the same membership:
   * what their exact part held before and what the op made that their copy
   * holds after, so nothing that enters their copy and nothing hidden that
   * leaves the room decides an answer, except where hidden bytes carry the
   * stepped part across a step. Every op builds both copies and reads both
   * sides' stepped parts exactly, the room's and every scene's
   * (farReadings), with no bound carried from one op to the next
   * (D-261121-017). The guard's bounds, which the near check keeps
   * counting, serve the DM's ops alone.
   */
  #farPlayer(next: RoomState, before: RoomState | undefined, widest: boolean, kind: "meets" | "exempt", player: string): LimitCheck {
    for (const { scope, before: was, after } of farReadings(before, next, player, widest)) {
      if (!farBytesOver(scope.kind, kind, "players", after.stepped, after.exact, true)) continue;
      if (was !== undefined && !readingGrew(was, after)) continue;
      if (scope.kind === "room") return roomFull();
      this.#refusedScene = scope.main;
      return sceneFull();
    }
    return { ok: true };
  }

  /**
   * Counts growth that is never checked: an explore, which only spends the
   * explored reserve the checks already held (section 2.4), so the room's
   * and the scene's bounds stay upper bounds without refusing it.
   */
  grew(growth: number, sceneIds: readonly string[]): void {
    if (this.#state) this.#state.growth += growth;
    for (const sceneId of sceneIds) {
      const measure = this.#scenes?.get(sceneId);
      if (measure) measure.growth += growth;
    }
  }

  /** Each scene's own part, from one pass over the state the guard first sees. */
  #sceneMeasures(state: RoomState): Map<string, Measure> {
    if (!this.#scenes) {
      this.#scenes = new Map();
      for (const [sceneId, bytes] of allScenesOwnBytes(state)) this.#scenes.set(sceneId, { bytes, growth: 0 });
    }
    return this.#scenes;
  }
}

/**
 * The scenes an op wrote into, from the entity keys the reducer touched:
 * those a written chunk, fog tile, explored tile or draft is keyed under, a
 * written scene itself, and those any written entity stood on before or
 * stands on after. Read from what the op did rather than from its type, so
 * an op that writes into a scene without naming it (conditions on inline
 * actors, a group edit, a member's removal) is never left out of that
 * scene's bound.
 */
export function touchedScenes(before: RoomState, after: RoomState, touched: readonly EntityKey[]): string[] {
  const out = new Set<string>();
  for (const key of touched) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    switch (parsed.kind) {
      case "chunk":
      case "fog":
      case "explored":
      case "fogDraft":
        out.add(parsed.sceneId);
        continue;
      case "scene":
        out.add(parsed.id);
        continue;
      default:
        for (const value of [readEntity(before, key), readEntity(after, key)]) {
          const sceneId = sceneOf(value);
          if (typeof sceneId === "string") out.add(sceneId);
        }
    }
  }
  return [...out];
}

/** What a scene's far reading counts beyond its measures on its floors: sight, explored ground, players' maps and the widths. */
function sceneReserves(state: RoomState, floors: readonly Scene[]): number {
  const sight = sum(floors, (scene) => sightReserve(scene) + perPlayerSceneReserve(state, scene));
  const explored = sum(floors, (scene) => exploredReserve(state, scene.id));
  const maps = sum(floors, (scene) => discoveryReserve(state, scene, MEMORY_CAP));
  return sight + explored + maps + farWidths(state, new Set(floors.map((scene) => scene.id)));
}

/**
 * A scene's whole measure in the state an op started from, reserves
 * included, so an op on a scene already over its limit is refused only when
 * it adds to it. A scene the op made has none. The near check asks it of a
 * scene over its limit, and the DM's far check of a scene whose bound
 * comes within a step of its line. A player's far check reads its own
 * readings (farReadings) and never asks it.
 */
function neededBefore(before: RoomState, sceneId: string, share: number, role: Viewer["role"]): number {
  return before.scenes[sceneId] ? projectedSceneBytes(before, sceneId, share, role) : 0;
}

/**
 * A scene's whole measure (design 10.5): a DM's projection of it as the
 * checks count it, with every reserve, the room-level part included, and
 * for a DM's op what players' copies may hold beyond it
 * (docs/design/design-v1-map-discovery.md 5.5). On a scene with floors it is
 * the whole scene, every floor's own part and reserves, which a DM's
 * projection of any one floor holds (docs/design/design-v1-floors.md 9).
 */
export function projectedSceneBytes(state: RoomState, sceneId: string, share: number = MEMORY_CAP, role: Viewer["role"] = "dm"): number {
  const floors = floorsOf(state, sceneId);
  const explored = sum(floors, (scene) => exploredReserve(state, scene.id));
  const maps = role === "player" ? 0 : sum(floors, (scene) => discoveryReserve(state, scene, share));
  return SHELL_BYTES + roomLevelBytes(state) + explored + maps + sum(floors, (scene) => sceneOwnBytes(state, scene.id) + sightReserve(scene) + perPlayerSceneReserve(state, scene));
}

/**
 * Every scene's floors, each scene once, bottom first as floorsOf gives
 * them, a scene with one floor alone. Grouped by the main floor each floor
 * names, so a floor whose main floor is gone still counts somewhere.
 */
export function sceneGroups(state: RoomState): Scene[][] {
  const out: Scene[][] = [];
  const seen = new Set<string>();
  for (const scene of Object.values(state.scenes)) {
    const main = scene.floor?.of ?? scene.id;
    if (seen.has(main)) continue;
    seen.add(main);
    out.push(scene.floor ? floorsOf(state, scene.id) : [scene]);
  }
  return out;
}

/** The floors the room reserves explored room for after an op that it did not before (reservedExploreFloors). */
function newlyReserved(before: RoomState, next: RoomState): Set<string> {
  const was = new Set(reservedExploreFloors(before));
  return new Set(reservedExploreFloors(next).filter((id) => !was.has(id)));
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += of(item);
  return total;
}

/** The most a vision scene's sight tiles can add to its projection, from its own key (section 4.3.4). */
function sightReserve(scene: Scene): number {
  if (scene.vision?.on !== true) return 0;
  return tilesAcross(scene.bounds.w) * tilesAcross(scene.bounds.h) * sightEntryMaxBytes(scene.id);
}

/*
 * A DM's projection (shared/project.ts projectState) as JSON:
 * `{"meta":…,"members":{…},…,"sight":{}}`. Its room-level collections are
 * the state's own, every one of them, the log as the measures count it
 * (measuredLog). Its scene-level collections hold only the viewed scene's
 * entities.
 */
const ROOM_LEVEL = [
  "meta",
  "members",
  "scenes",
  "characters",
  "encounter",
  "encounterHistory",
  "handouts",
  "log",
  "monsters",
  "srdImages",
  "savedEncounters",
  "journal",
  "rolls",
  "handoutDocs",
  "casts",
  "trapLog",
  "trapSeen",
] as const satisfies readonly (keyof RoomState)[];

const SCENE_LEVEL = [
  "buildChunks",
  "labels",
  "fogTiles",
  "fogDrafts",
  "tokens",
  "templates",
  "drawings",
  "stamps",
  "lights",
  "exploredTiles",
  "pins",
  "traps",
] as const satisfies readonly (keyof RoomState)[];

type SceneLevel = (typeof SCENE_LEVEL)[number];

/** Room-level collections every DM projection holds that the measure counts as empty, with caps of their own. */
const OUTSIDE = ["companionBlocks"] as const satisfies readonly (keyof RoomState)[];

/** `"name":` before a collection. */
function fieldBytes(name: string): number {
  return utf8Bytes(JSON.stringify(name)) + 1;
}

/**
 * The braces, the commas between the top-level fields, the empty sight map
 * and the collections counted as empty: what is around the two parts. A
 * field per collection, plus `sight`.
 */
const SHELL_BYTES = 2 + (ROOM_LEVEL.length + SCENE_LEVEL.length + OUTSIDE.length + 1 - 1) + fieldBytes("sight") + 2 + OUTSIDE.reduce((sum, name) => sum + fieldBytes(name) + 2, 0);

/*
 * Sizes kept per entity object and per collection object, which are
 * replaced and never changed once their op finished (shared/writable.ts),
 * so an op re-measures only what it wrote.
 */
const valueSizes = new WeakMap<object, number>();
const collectionSizes = new WeakMap<object, number>();

/**
 * A record's entries as JSON, without its braces and commas, and how many
 * it holds: what collectionBytes adds around them. Kept per field of the
 * room over its accepted state (shared/accepted.ts).
 */
const ENTRY_BYTES: Part<{ entries: number; count: number }> = {
  whole: (record, keys) => {
    let entries = 0;
    for (const key of keys) entries += fieldBytes(key) + valueBytes(record[key]);
    return { entries, count: keys.length };
  },
  step: ({ entries }, changes, keys) => {
    for (const { key, was, now } of changes) {
      if (was !== ABSENT) entries -= fieldBytes(key) + valueBytes(was);
      if (now !== ABSENT) entries += fieldBytes(key) + valueBytes(now);
    }
    return { entries, count: keys.length };
  },
};

function valueBytes(value: unknown): number {
  if (value === null || typeof value !== "object") return serializedBytes(value);
  let bytes = valueSizes.get(value);
  if (bytes === undefined) {
    bytes = serializedBytes(value);
    if (!isWritable(value)) valueSizes.set(value, bytes);
  }
  return bytes;
}

/**
 * A collection as JSON, a record or an array, from its entries' sizes. A
 * record of the room's `field` in `state` is read from what the room keeps
 * over its accepted state (shared/accepted.ts), and `take` moves that on.
 */
function collectionBytes(collection: unknown, field?: string, state?: RoomState, take = false): number {
  if (collection === null || typeof collection !== "object") return valueBytes(collection);
  let bytes = collectionSizes.get(collection);
  if (bytes !== undefined && !take) return bytes;
  if (Array.isArray(collection)) {
    if (bytes !== undefined) return bytes;
    bytes = 2 + Math.max(0, collection.length - 1);
    for (const item of collection) bytes += valueBytes(item);
  } else {
    const record = collection as Readonly<Record<string, unknown>>;
    const { entries, count } = field !== undefined && state !== undefined ? keptPart(state, field, record, ENTRY_BYTES, take) : ENTRY_BYTES.whole(record, Object.keys(record));
    bytes = 2 + Math.max(0, count - 1) + entries;
  }
  if (!isWritable(collection)) collectionSizes.set(collection, bytes);
  return bytes;
}

/**
 * The room-level part of every DM's projected scene, with its field names:
 * the state's own room-level collections, the log as the measures count it.
 * A singleton the op did not write and a collection it did not copy are the
 * same objects as before, so they cost a lookup.
 */
export function roomLevelBytes(state: RoomState): number {
  let bytes = 0;
  const trapped = hasTraps(state);
  for (const name of ROOM_LEVEL) {
    if ((name === "trapLog" || name === "trapSeen") && trapped) bytes += fieldBytes(name) + (name === "trapLog" ? TRAP_LOG_RESERVE : TRAP_SEEN_RESERVE + DUE_RESERVE);
    else if (name === "log") bytes += fieldBytes(name) + collectionBytes(measuredLog(state.log));
    // Each list of who saw at its widest, whoever it names (docs/design/design-v1-per-player-vision.md 6.8).
    else if (name === "encounter") bytes += fieldBytes(name) + valueBytes(state.encounter) - encounterLists(state.encounter).extra + encounterLists(state.encounter).count * widestListExtra(state.members);
    else if (name === "encounterHistory") bytes += historyBytes(state);
    // Each scene's rev at its widest and its creature numbers left out (numberingAdjust).
    else if (name === "scenes") bytes += fieldBytes(name) + collectionBytes(state.scenes) + scenesNumbering(state);
    else bytes += fieldBytes(name) + (name === "meta" ? valueBytes(state[name]) : collectionBytes(state[name] ?? (name === "trapLog" || name === "trapSeen" ? [] : {})));
  }
  // The clock is the one room-level field a room may lack (docs/design/design-v1-calendar.md 6.7): there, it adds its
  // field, its value and the comma before it, as a DM's projection holds it.
  if (state.clock) bytes += 1 + fieldBytes("clock") + valueBytes(state.clock);
  // A DM's projection holds the library, the playlists and what plays only while each holds something, so a room without
  // sound projects as it always did (shared/project.ts soundFields, docs/design/design-v1-music.md 6.3). An empty record
  // is its two braces.
  if (state.playing) bytes += 1 + fieldBytes("playing") + valueBytes(state.playing);
  for (const name of ["sounds", "playlists"] as const) {
    const entries = collectionBytes(state[name] ?? {});
    if (entries > 2) bytes += 1 + fieldBytes(name) + entries;
  }
  // A DM's projection holds the fall cards, at their widest while the room may hold one (docs/design/design-v1-floors.md
  // phase 4, 4.7), whatever it holds.
  return bytes + fallsMeasure(state);
}

const measuredLogs = new WeakMap<readonly LogEntry[], readonly LogEntry[]>();

/**
 * The log as the measures count it: its shared lines alone. The lines only
 * some viewers or none read, DM lines, party lines' copies and whispers,
 * ride outside the measures under bounds of their own (shared/logRings.ts),
 * so a line a player cannot read never decides whether their op passes.
 * The very list when it holds no other.
 */
export function measuredLog(log: readonly LogEntry[]): readonly LogEntry[] {
  const cached = measuredLogs.get(log);
  if (cached) return cached;
  const kept = log.some((e) => lineAudience(e) !== "shared") ? log.filter((e) => lineAudience(e) === "shared") : log;
  if (!isWritable(log)) measuredLogs.set(log, kept);
  return kept;
}

// ---------------------------------------------------------------------------
// Per-player vision's reserves (docs/design/design-v1-per-player-vision.md 6.8)

/**
 * The refusal of a switch to Per player that the room cannot hold
 * (docs/design/design-v1-per-player-vision.md 6.8): each holder's map and the
 * party's count at their widest from the switch on.
 */
export const PER_PLAYER_FULL = "The room is too full for per-player sight on this scene: each player's map and the paths this fight recorded need room. Delete unused scenes to free space.";

/*
 * Who a list names and what a holder explored depend on that player's
 * sight, so no measure reads them (security rule 11): a measure counts the
 * state without them, every list of who saw as `[]` and no layer of a
 * per-player scene, and reserves each at its widest instead. So the answer
 * an op gets never depends on what another player's creatures saw. Every
 * reserve reads only the roster, the scenes and how many lists there are,
 * which every player's own ops can observe anyway.
 */
const FULL_TILE = encodeTile(fullTileBits());

/** The roster's ids, longest as JSON first, kept per members collection, which is replaced and never changed. */
const longest = new WeakMap<object, { any: number[]; players: string[] }>();

function rosterIds(members: RoomState["members"]): { any: number[]; players: string[] } {
  let hit = longest.get(members);
  if (!hit) {
    const byLength = (ids: string[]) => ids.map((id) => ({ id, bytes: utf8Bytes(JSON.stringify(id)) })).sort((a, b) => b.bytes - a.bytes);
    hit = {
      any: byLength(Object.keys(members)).slice(0, MOST_SIGHT_HOLDERS).map((e) => e.bytes),
      players: byLength(Object.keys(members).filter((id) => members[id]!.kind === "player")).slice(0, MOST_SIGHT_HOLDERS).map((e) => e.id),
    };
    if (!isWritable(members)) longest.set(members, hit);
  }
  return hit;
}

/**
 * What a list of who saw adds beyond `[]` at its widest: the 6 longest
 * encoded ids of the roster, quoted, with their commas. Every member of the
 * roster counts, a DM too, so a list that names a player made DM since is
 * never wider than this.
 */
function widestListExtra(members: RoomState["members"]): number {
  const ids = rosterIds(members).any;
  return ids.length === 0 ? 0 : ids.reduce((sum, b) => sum + b, 0) + ids.length - 1;
}

type Lists = { count: number; extra: number };
const NO_LISTS: Lists = { count: 0, extra: 0 };
const listsKept = new WeakMap<object, Lists>();

/** The lists of who saw an object holds and what they add beyond `[]`, kept per object, which is replaced and never changed. */
function listsOf(value: object, find: () => readonly (readonly string[] | undefined)[]): Lists {
  let hit = listsKept.get(value);
  if (!hit) {
    let count = 0;
    let extra = 0;
    for (const list of find()) {
      if (list === undefined) continue;
      count++;
      extra += serializedBytes(list) - 2;
    }
    hit = count === 0 ? NO_LISTS : { count, extra };
    if (!isWritable(value)) listsKept.set(value, hit);
  }
  return hit;
}

function tokenLists(token: Token): Lists {
  return token.path ? listsOf(token, () => token.path!.stops.map((s) => s.seenBy)) : NO_LISTS;
}

function encounterLists(encounter: Encounter | null): Lists {
  return encounter ? listsOf(encounter, () => [encounter.turnStart?.seenBy]) : NO_LISTS;
}

function historyLists(history: readonly EncounterSnapshot[]): Lists {
  return listsOf(history, () => history.map((snap) => snap.encounter.turnStart?.seenBy));
}

/** The fight's history as the measures count it, with its field name: each step's list of who saw its turn start at its widest. */
function historyBytes(state: RoomState): number {
  const lists = historyLists(state.encounterHistory);
  return fieldBytes("encounterHistory") + collectionBytes(state.encounterHistory) - lists.extra + lists.count * widestListExtra(state.members);
}

/** A layer of a scene at its widest, every tile present: its entries' bytes, key and colon included, and how many. */
type Widest = { bytes: number; entries: number };
const widestLayers = new WeakMap<Scene, Map<string, Widest>>();

function widestLayer(scene: Scene, memberId: string | null): Widest {
  let byLayer = widestLayers.get(scene);
  if (!byLayer) widestLayers.set(scene, (byLayer = new Map()));
  const at = memberId ?? "";
  let hit = byLayer.get(at);
  if (!hit) {
    const across = tilesAcross(scene.bounds.w);
    const down = tilesAcross(scene.bounds.h);
    // A tile's value with one-digit coordinates, which the loop widens by each tile's digits.
    const value = serializedBytes(memberId === null ? { sceneId: scene.id, tx: 0, ty: 0, rev: WIDEST_REV, bits: FULL_TILE } : { sceneId: scene.id, tx: 0, ty: 0, rev: WIDEST_REV, bits: FULL_TILE, memberId });
    let bytes = 0;
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const key = memberId === null ? tileKey(scene.id, tx, ty) : holderTileKey(scene.id, memberId, tx, ty);
        bytes += fieldBytes(key) + value + String(tx).length + String(ty).length - 2;
      }
    }
    byLayer.set(at, (hit = { bytes, entries: across * down }));
  }
  return hit;
}

/** A widest layer as a map's entries, with a comma after each. */
function layerEntries(widest: Widest): number {
  return widest.bytes + widest.entries;
}

/**
 * What per-player vision adds to the stored state at its widest: on each
 * per-player scene the party's layer and a layer for each of up to 6
 * players, the roster's longest ids, every tile present, and every list
 * of who saw as wide as the roster allows. Kept per scenes and members
 * collection, with the lists counted per token, fight and history.
 */
const storedLayers = new WeakMap<object, WeakMap<object, number>>();

export function perPlayerStoredReserve(state: RoomState): number {
  let byMembers = storedLayers.get(state.scenes);
  let layers = byMembers?.get(state.members);
  if (layers === undefined) {
    layers = 0;
    const players = rosterIds(state.members).players;
    for (const scene of Object.values(state.scenes)) {
      if (!perPlayerScene(scene)) continue;
      layers += layerEntries(widestLayer(scene, null));
      for (const id of players) layers += layerEntries(widestLayer(scene, id));
    }
    if (!isWritable(state.scenes) && !isWritable(state.members)) {
      if (!byMembers) storedLayers.set(state.scenes, (byMembers = new WeakMap()));
      byMembers.set(state.members, layers);
    }
  }
  return layers + storedLists(state).count * widestListExtra(state.members);
}

/** The lists of who saw the paths hold, in all and per scene, kept per tokens collection, which is replaced and never changed. */
const pathLists = new WeakMap<object, { all: Lists; byScene: Map<string, number> }>();

function listsInPaths(tokens: RoomState["tokens"]): { all: Lists; byScene: Map<string, number> } {
  let hit = pathLists.get(tokens);
  if (!hit) {
    let count = 0;
    let extra = 0;
    const byScene = new Map<string, number>();
    for (const token of Object.values(tokens)) {
      const l = tokenLists(token);
      if (l.count === 0) continue;
      count += l.count;
      extra += l.extra;
      byScene.set(token.sceneId, (byScene.get(token.sceneId) ?? 0) + l.count);
    }
    hit = { all: { count, extra }, byScene };
    if (!isWritable(tokens)) pathLists.set(tokens, hit);
  }
  return hit;
}

/** Every list of who saw the stored state holds: in paths, the fight's turn start and every saved step's. */
function storedLists(state: RoomState): Lists {
  const paths = listsInPaths(state.tokens).all;
  const fight = encounterLists(state.encounter);
  const history = historyLists(state.encounterHistory);
  return { count: paths.count + fight.count + history.count, extra: paths.extra + fight.extra + history.extra };
}

/**
 * The bytes of the stored state the measures leave out, exactly: every
 * list's names, and each per-player scene's layers, the party's and its
 * holders', with their keys and the commas between entries, so what is
 * left is the state as if they held nothing.
 */
function privateStateBytes(state: RoomState): number {
  const layer = (collection: Record<string, { sceneId: string }>): number => {
    let kept = 0;
    let left = 0;
    let bytes = 0;
    for (const [key, tile] of Object.entries(collection)) {
      if (!perPlayerScene(state.scenes[tile.sceneId])) {
        kept++;
        continue;
      }
      left++;
      bytes += fieldBytes(key) + valueBytes(tile) + 1;
    }
    // A map left with no entry loses one comma fewer than it had entries.
    return kept === 0 && left > 0 ? bytes - 1 : bytes;
  };
  return layer(state.exploredTiles) + layer(state.exploredBy ?? {}) + storedLists(state).extra;
}

/**
 * What a per-player scene adds to its DM projection at its widest, beyond
 * its own part (docs/design/design-v1-per-player-vision.md 6.8): the shared sight
 * beside the union, the shared fog and every holder's layer joined, every
 * tile present, and its holder list as it is, with their fields. On every
 * scene, each list of who saw that its creatures' paths hold, as wide as
 * the roster allows.
 */
function perPlayerSceneReserve(state: RoomState, scene: Scene): number {
  let bytes = (listsInPaths(state.tokens).byScene.get(scene.id) ?? 0) * widestListExtra(state.members);
  if (!perPlayerScene(scene)) return bytes;
  const tiles = layerEntries(widestLayer(scene, null));
  // `"sightAll":{…}`, `"fogAll":{…}` and `"exploredAny":{…}`, each with its comma, and `"holders":{"<scene>":<list>}`.
  bytes += fieldBytes("sightAll") + 3 + tilesAcross(scene.bounds.w) * tilesAcross(scene.bounds.h) * sightEntryMaxBytes(scene.id);
  bytes += fieldBytes("fogAll") + 3 + tiles + fogPastBounds(state.fogTiles, scene) + fieldBytes("exploredAny") + 3 + tiles;
  const list = state.holders?.[scene.id];
  return bytes + fieldBytes("holders") + 3 + (list ? fieldBytes(scene.id) + valueBytes(list) : 0);
}

/*
 * The shared fog's tiles past a per-player scene's bounds, each at its
 * widest with its comma. The fold keeps no layer's tile there (review
 * PV3-ASTRA-1), but the DM's own fog keeps its tiles when the scene
 * shrinks, and the shared fog holds one over each. Only the DM's fog
 * decides how many, which no player's sight does. Kept per fog collection
 * and scene, each replaced and never changed, and read from the fog's
 * tiles grouped by floor once per collection, so every scene's costs one
 * walk of the fog.
 */
const fogPast = new WeakMap<object, WeakMap<Scene, number>>();
type FogEntry = readonly [string, RoomState["fogTiles"][string]];
const fogByFloor = new WeakMap<object, ReadonlyMap<string, readonly FogEntry[]>>();

function fogPastBounds(fogTiles: RoomState["fogTiles"], scene: Scene): number {
  let byScene = fogPast.get(fogTiles);
  let bytes = byScene?.get(scene);
  if (bytes === undefined) {
    bytes = 0;
    const across = tilesAcross(scene.bounds.w);
    const down = tilesAcross(scene.bounds.h);
    for (const [key, t] of fogTilesOn(fogTiles, scene.id)) {
      if (t.tx < across && t.ty < down) continue;
      bytes += fieldBytes(key) + serializedBytes({ sceneId: scene.id, tx: t.tx, ty: t.ty, rev: WIDEST_REV, bits: FULL_TILE }) + 1;
    }
    if (!isWritable(fogTiles)) {
      if (!byScene) fogPast.set(fogTiles, (byScene = new WeakMap()));
      byScene.set(scene, bytes);
    }
  }
  return bytes;
}

/** The fog's tiles on one floor with their keys, from the fog grouped by floor once per collection. */
function fogTilesOn(fogTiles: RoomState["fogTiles"], sceneId: string): readonly FogEntry[] {
  let grouped = isWritable(fogTiles) ? undefined : fogByFloor.get(fogTiles);
  if (!grouped) {
    const out = new Map<string, FogEntry[]>();
    for (const [key, tile] of Object.entries(fogTiles)) {
      const list = out.get(tile.sceneId);
      if (list) list.push([key, tile]);
      else out.set(tile.sceneId, [[key, tile]]);
    }
    if (!isWritable(fogTiles)) fogByFloor.set(fogTiles, out);
    grouped = out;
  }
  return grouped.get(sceneId) ?? [];
}

// ---------------------------------------------------------------------------
// Map discovery's reserves (docs/design/design-v1-map-discovery.md 5.5)

/**
 * The refusal of an op that would reserve players' memory where the room
 * has no room for it (5.5): Players see, a new Explore scene, Move players,
 * the copy sheet and Duplicate with Fog.
 */
export const MEMORY_FULL = "The room is too full to keep players' maps of this scene. Delete unused scenes to free space.";

/**
 * The refusal of a DM's edit that grows a scene already past its limit
 * only by what players' copies of it may hold (5.5): its walls cut into
 * pieces, its chunk positions and players' memory of it.
 */
export const SCENE_MAPS_FULL = "This scene is too full for players' maps of it. Remove walls or stamps to make room.";

/**
 * Whether players' memory of a scene is reserved (5.5, rule 8): fog and
 * party vision on, and the scene a floor of the players' scene, whether
 * players reached it or not (docs/design/design-v1-floors.md 9), or carrying
 * the played mark. Read from the scene and the public marks alone, never
 * from an explored layer or a memory.
 */
export function memoryReserved(state: RoomState, scene: Scene): boolean {
  return keepsMemory(scene) && (state.playedScenes?.[scene.id] !== undefined || onPlayersScene(state, scene.id));
}

/** The layers a reserved scene's memory counts: the party's, and on a per-player scene one for each player on the roster, up to 6. */
function memoryLayerCount(state: RoomState, scene: Scene): number {
  return 1 + (perPlayerScene(scene) ? rosterIds(state.members).players.length : 0);
}

/**
 * Whether a layer of a reserved scene shares the room's free space
 * (`memoryShared`), rather than taking its whole cap: every layer, or the
 * party's alone once the scene folded (ShareMark `party`), so holders'
 * layers a switch back to Per player brings take their whole caps (5.5).
 */
export function sharesRoom(state: RoomState, scene: Scene, holder = false): boolean {
  const mark = state.memoryShared?.[scene.id];
  return mark !== undefined && (!holder || mark.party !== true);
}

/** What players' memory reserves in the stored state: every whole cap, and how many layers share the rest. */
export type MemoryReserves = { whole: number; sharing: number };

export function memoryReserves(state: RoomState, except?: ReadonlySet<string>): MemoryReserves {
  let whole = 0;
  let sharing = 0;
  for (const scene of Object.values(state.scenes)) {
    if (except?.has(scene.id) || !memoryReserved(state, scene)) continue;
    const holders = memoryLayerCount(state, scene) - 1;
    if (sharesRoom(state, scene)) sharing += 1;
    else whole += MEMORY_CAP;
    if (sharesRoom(state, scene, true)) sharing += holders;
    else whole += holders * MEMORY_CAP;
  }
  return { whole, sharing };
}

/**
 * What the room-wide share leaves of a full room's free space (D-261027-03):
 * room for ops to grow before the guard's bound passes the limit, so a
 * near-full room does not measure its whole state and lower the share on
 * every op.
 */
export const SHARE_MARGIN = 64 * 1024;

/**
 * The room-wide share (5.5, MD-O-14): the room's free space without the
 * shared reserves and SHARE_MARGIN, split equally over their layers, at
 * most a whole cap, so no room becomes full at deploy. A pure function of
 * the exact measure and the stored state, so a reload gives the same share.
 */
export function memoryShare(stateLimit: number, measured: number, explored: number, reserves: MemoryReserves): number {
  if (reserves.sharing === 0) return MEMORY_CAP;
  const free = stateLimit - measured - explored - reserves.whole - SHARE_MARGIN;
  return Math.max(0, Math.min(MEMORY_CAP, Math.floor(free / reserves.sharing)));
}

/** A layer's cap on a scene, the party's when `layer` is null: a whole cap, its share where it shares the room's space, or 0 where memory is not reserved, so the map step forgets it all. */
export function memoryCapOf(state: RoomState, scene: Scene, share: number, layer: Layer = null): number {
  if (!memoryReserved(state, scene)) return 0;
  return sharesRoom(state, scene, layer !== null) ? share : MEMORY_CAP;
}

/**
 * One chunk position of a player's copy at its widest beyond what the
 * DM's chunk holds there (5.5): a stub's header and its empty records, the
 * fields only a player's chunk carries at their longest, and `grid` on a
 * hex scene, with its key and comma.
 */
const positionsKept = new WeakMap<Scene, number>();

/** Every chunk position of a scene at its widest (positionBytes), one past its east and south sides included, kept per scene object. */
function positionsReserve(scene: Scene): number {
  let bytes = positionsKept.get(scene);
  if (bytes === undefined) {
    bytes = chunkPositions(scene).length * positionBytes(scene);
    if (!isWritable(scene)) positionsKept.set(scene, bytes);
  }
  return bytes;
}

function positionBytes(scene: Scene): number {
  const most = 99;
  const stub: Record<string, unknown> = { sceneId: scene.id, cx: most, cy: most, rev: 0, cells: {}, edges: {}, walls: [], known: "x".repeat(KNOWN_CHARS), auto: "x".repeat(AUTO_CHARS), upDir: "x".repeat(UP_DIR_CHARS) };
  if (scene.gridShape !== undefined) stub.grid = scene.gridShape;
  return keyBytes(chunkKey(scene.id, most, most)) + serializedBytes(stub);
}

/*
 * What each free wall can add beyond its stored bytes in a player's copy
 * (memorySize.ts wallLargestBytes), kept per chunk object with the scene's
 * shape, and summed per scene once per chunk collection, which the reducer
 * replaces and never changes.
 */
const wallExtras = new WeakMap<BuildChunk, { sig: string; bytes: number }>();
const sceneWallExtras = new WeakMap<object, WeakMap<Scene, number>>();

function chunkWallExtra(scene: Scene, chunk: BuildChunk): number {
  const sig = `${scene.bounds.w}x${scene.bounds.h}|${scene.gridShape ?? "squares"}`;
  const hit = wallExtras.get(chunk);
  if (hit && hit.sig === sig) return hit.bytes;
  let bytes = 0;
  for (const wall of chunk.walls ?? []) bytes += Math.max(0, wallLargestBytes(scene, wall) - serializedBytes(wall) - 1);
  if (!isWritable(chunk)) wallExtras.set(chunk, { sig, bytes });
  return bytes;
}

const chunksByScene = new WeakMap<object, Map<string, BuildChunk[]>>();

function sceneChunks(all: RoomState["buildChunks"], sceneId: string): readonly BuildChunk[] {
  let grouped = isWritable(all) ? undefined : chunksByScene.get(all);
  if (!grouped) {
    grouped = new Map();
    for (const chunk of Object.values(all)) {
      if (!chunk) continue;
      let list = grouped.get(chunk.sceneId);
      if (!list) grouped.set(chunk.sceneId, (list = []));
      list.push(chunk);
    }
    if (!isWritable(all)) chunksByScene.set(all, grouped);
  }
  return grouped.get(sceneId) ?? [];
}

function wallsExtra(state: RoomState, scene: Scene): number {
  let byScene = isWritable(state.buildChunks) ? undefined : sceneWallExtras.get(state.buildChunks);
  const hit = byScene?.get(scene);
  if (hit !== undefined) return hit;
  let bytes = 0;
  for (const chunk of sceneChunks(state.buildChunks, scene.id)) bytes += chunkWallExtra(scene, chunk);
  if (!isWritable(state.buildChunks) && !isWritable(scene)) {
    if (!byScene) sceneWallExtras.set(state.buildChunks, (byScene = new WeakMap()));
    byScene.set(scene, bytes);
  }
  return bytes;
}

/**
 * What players' copies of a scene may hold beyond the DM's (5.5), read
 * from the scene, its walls and the public marks alone: on a scene players
 * get cut from held ground (heldGroundMap: fog on, or a square scene with
 * fog off whose automatic walls are not "off"), each free wall at its
 * largest form and every chunk position at its widest, and where memory is
 * reserved, the memory a copy reads at its cap, the party's and on a
 * per-player scene a holder's own too.
 */
export function discoveryReserve(state: RoomState, scene: Scene, share: number, withMemory = true): number {
  let bytes = 0;
  if (heldGroundMap(scene)) bytes += wallsExtra(state, scene) + positionsReserve(scene);
  // A copy reads the party's memory, and a holder's view their own as well.
  if (withMemory && memoryReserved(state, scene)) {
    const cap = (holder: boolean) => (sharesRoom(state, scene, holder) ? share : MEMORY_CAP);
    bytes += cap(false) + (perPlayerScene(scene) ? cap(true) : 0);
  }
  return bytes;
}

/** What players' memory reserves in the stored state at a share: every whole cap, and each sharing layer's share. */
export function memoryStateReserve(state: RoomState, share: number = MEMORY_CAP): number {
  const reserves = memoryReserves(state);
  return reserves.whole + reserves.sharing * share;
}

/** The bytes the stored state's memory takes, which no measure counts: memory counts at its cap or its share instead (rule 8). */
function memoryStoredBytes(state: RoomState): number {
  const of = (collection: Record<string, unknown> | undefined) => (collection ? collectionBytes(collection) - 2 : 0);
  return of(state.memory) + of(state.memoryBy);
}

// ---------------------------------------------------------------------------
// The traps' reserves (docs/design/design-v1-traps.md 6.7, Appendix B)

/** Per trap, the small fields the reducer writes and `noticedBy` (160), and its actions' and stop's slack (100). */
export const TRAP_RESERVE = 160 + 100;
/** Per scene with a pit trap, the tokens a pit can move: 500 tokens at 8 bytes. */
export const PIT_TOKENS_RESERVE = 4 * 1024;
/** Per room once it has a trap: 10 occurrences, and both trap logs at their bounds. */
export const DUE_RESERVE = 42 * 1024;
export const TRAP_LOG_RESERVE = 45 * 1024;
export const TRAP_SEEN_RESERVE = 30 * 1024;

function hasTraps(state: RoomState): boolean {
  for (const _ in state.traps ?? {}) return true;
  return false;
}

/** A trap as the measures count it: its own fields exactly, and its reserve in place of what the reducer writes on it. */
export function trapMeasure(trap: Trap): number {
  let bytes = trapSizes.get(trap);
  if (bytes === undefined) {
    bytes = trapOwnBytes(trap) + TRAP_RESERVE;
    trapSizes.set(trap, bytes);
  }
  return bytes;
}

const trapSizes = new WeakMap<Trap, number>();

/** The chunks a pit trap's squares touch, each counted once. */
function pitChunks(trap: Trap): Set<string> {
  const out = new Set<string>();
  if (!trap.rig?.pit || !("cells" in trap.zone)) return out;
  for (const r of trap.zone.cells) {
    for (let cy = Math.floor(r.y / CHUNK_CELLS); cy * CHUNK_CELLS < r.y + r.h; cy++) {
      for (let cx = Math.floor(r.x / CHUNK_CELLS); cx * CHUNK_CELLS < r.x + r.w; cx++) out.add(`${cx},${cy}`);
    }
  }
  return out;
}

/**
 * A scene's pit reserve: for every chunk a pit trap's squares touch, a
 * whole new chunk as `buildHeight` fills it, map key and envelope included,
 * `2K + 780` bytes with K the scene id's serialized length, whether or not
 * the chunk exists yet, and 4 KiB for the tokens a pit can move once the
 * scene has a pit trap. A chunk two pits touch counts for each.
 */
export function pitReserve(state: RoomState, sceneId: string): number {
  const chunks = pitChunksByFloor(state.traps ?? {}).get(sceneId);
  if (chunks === undefined) return 0;
  const k = utf8Bytes(JSON.stringify(sceneId));
  return chunks * (2 * k + 780) + PIT_TOKENS_RESERVE;
}

const pitsKept = new WeakMap<object, ReadonlyMap<string, number>>();

/**
 * The chunks the pit traps on each floor touch, each floor with a pit
 * listed even where they touch none, in one pass over the traps and kept
 * per traps collection, which is replaced and never changed. So every
 * scene's pits cost one walk of the traps.
 */
function pitChunksByFloor(traps: RoomState["traps"]): ReadonlyMap<string, number> {
  const hit = pitsKept.get(traps);
  if (hit) return hit;
  const out = new Map<string, number>();
  for (const trap of Object.values(traps)) if (trap.rig?.pit) out.set(trap.sceneId, (out.get(trap.sceneId) ?? 0) + pitChunks(trap).size);
  if (!isWritable(traps)) pitsKept.set(traps, out);
  return out;
}

/** Every reserve and trap measure the room's own bytes count: the traps, the pits, and the room's occurrences and logs. */
function trapsMeasure(state: RoomState): number {
  const traps = Object.entries(state.traps ?? {});
  let bytes = Math.max(0, traps.length - 1);
  const scenes = new Set<string>();
  for (const [key, trap] of traps) {
    bytes += fieldBytes(key) + trapMeasure(trap);
    scenes.add(trap.sceneId);
  }
  for (const sceneId of scenes) bytes += pitReserve(state, sceneId);
  if (traps.length > 0) return bytes + DUE_RESERVE + TRAP_LOG_RESERVE + TRAP_SEEN_RESERVE;
  // A room whose traps were all deleted keeps their lines, which no springing can add to any more.
  return bytes + collectionBytes(state.trapLog ?? []) - 2 + collectionBytes(state.trapSeen ?? []) - 2;
}

// ---------------------------------------------------------------------------
// Fall cards and reached floors (docs/design/design-v1-floors.md phase 4, 4.7)

/** A fall card's id at its widest: the op's seq and its place among the op's cards, each at the id schema's most digits. */
const FALL_ID_MOST = `${"9".repeat(18)}:${"9".repeat(6)}`;
/** An id a device chose at its widest as JSON: 64 characters, each escaped to six bytes. */
const ESCAPED_ID_MOST = "\u0001".repeat(64);

/**
 * The room's fall cards at their widest (D-261119-089): `,"falls":{…}`
 * with LIMITS.fallsPerRoom cards under their ids, each with every rider a
 * card names, every id at its widest, the most feet a fall drops, and its
 * rev and the op it was made in at their widest. Derived from the bounds
 * of the card's schema, so no stored card is wider.
 */
export const FALL_RESERVE =
  1 +
  fieldBytes("falls") +
  2 +
  LIMITS.fallsPerRoom * (fieldBytes(FALL_ID_MOST) + serializedBytes({ id: FALL_ID_MOST, rev: WIDEST_REV, tokenId: ESCAPED_ID_MOST, riders: Array.from({ length: FALL_RIDERS_MOST }, () => ESCAPED_ID_MOST), sceneId: ESCAPED_ID_MOST, from: ESCAPED_ID_MOST, ft: FALL_FEET_MOST, made: WIDEST_REV } satisfies Required<Fall>)) +
  LIMITS.fallsPerRoom -
  1;

/**
 * Whether the room may hold a fall card: it has an opening's end, a
 * trapdoor or a card. Only the DM's ops place or remove an end or a
 * trapdoor, a player's card needs one of them, and a player's dismissal
 * of their companion leaves its card, so no player's op turns this on or
 * off (4.7). An empty record, which the reducer leaves where the last card
 * went, holds none.
 */
export function fallsReserved(state: RoomState): boolean {
  for (const _ in state.falls ?? {}) return true;
  for (const link of Object.values(state.floorLinks ?? {})) if (link.kind === "opening") return true;
  for (const trap of Object.values(state.traps ?? {})) if (trap.rig?.below === true) return true;
  return false;
}

/**
 * What the measures count of the room's fall cards: none of their bytes,
 * and FALL_RESERVE while the room may hold one. So a card's creation, its
 * eviction, its Dismiss or Apply and an undo or redo that takes it away or
 * writes it back move no measure, and how many cards the DM keeps never
 * shows in a player's answer (D-261119-003, D-261119-089).
 */
function fallsMeasure(state: RoomState): number {
  return fallsReserved(state) ? FALL_RESERVE : 0;
}

/**
 * What the measures count of the reached floors' marks (`openFloors`): each
 * floor of the room as if marked, its mark at its widest. A mark is
 * bookkeeping the DM alone receives, written the first time a creature of
 * the party lands on a floor, which a player's own climb, fall or flight
 * does. Counted as stored, it would write its bytes into that player's
 * stepped part. Which scenes are floors only the DM's ops change.
 */
export function openedMeasure(state: RoomState): number {
  let bytes = 0;
  let marks = 0;
  for (const scene of Object.values(state.scenes)) {
    if (scene.floor === undefined) continue;
    marks++;
    bytes += fieldBytes(scene.id) + serializedBytes({ sceneId: scene.id, rev: WIDEST_REV });
  }
  return marks === 0 ? 0 : 1 + fieldBytes("openFloors") + 2 + bytes + marks - 1;
}

/** The stored bytes of a room-level field the measures count otherwise: `,"name":…`, its comma included, or 0 where the room lacks it. */
function storedField(state: RoomState, name: "falls" | "openFloors"): number {
  return state[name] === undefined ? 0 : serializedBytes({ [name]: state[name] }) - 1;
}

// ---------------------------------------------------------------------------
// Creature numbers (shared/numbering.ts)

/*
 * A batch end gives creature numbers with `sys.meet`, after admission and
 * never refused, so no measure counts what the numbers hold. Every monster
 * and NPC counts its number and its group at their widest whether it has
 * them or not, and its rev at its widest, since each write bumps it and a
 * meeting can add a digit. Every scene counts its rev at its widest and
 * its numbers not at all. The room's group count counts nothing. A meeting
 * then moves no measure and no growth bound. The scenes' numbers ride in a
 * DM's snapshot outside the measures, each scene's under the caps that
 * bound it (registerBytesMost).
 */

/** What a monster's or NPC's number and group count as: `,"number":` with the most numbers a name gives and `,"met":` with the widest group id. */
export const TOKEN_NUMBERING = serializedBytes({ number: NUMBERS_MOST, met: WIDEST_REV }) - 2 + 1;

const WIDEST_REV_BYTES = serializedBytes(WIDEST_REV);

/** What a token adds to a measure beyond its stored bytes. Only a monster or NPC is ever given a number, and every other token counts as it is. */
export function tokenNumbering(token: Token): number {
  if (token.kind !== "monster" && token.kind !== "npc") return 0;
  const number = token.number === undefined ? 0 : fieldBytes("number") + 1 + serializedBytes(token.number);
  const met = token.met === undefined ? 0 : fieldBytes("met") + 1 + serializedBytes(token.met);
  return TOKEN_NUMBERING - number - met + WIDEST_REV_BYTES - serializedBytes(token.rev);
}

/** What a scene adds to a measure beyond its stored bytes: its rev widened, its numbers and the comma before them taken out. */
export function sceneNumbering(scene: Scene): number {
  const numbers = scene.numbers === undefined ? 0 : serializedBytes({ numbers: scene.numbers }) - 1;
  return WIDEST_REV_BYTES - serializedBytes(scene.rev) - numbers;
}

/** A part summed over each value of a record, kept per field of the room (shared/accepted.ts). */
function sumOf<T>(part: (value: T) => number): Part<number, T> {
  return {
    whole: (record, keys) => {
      let sum = 0;
      for (const key of keys) sum += part(record[key]!);
      return sum;
    },
    step: (sum, changes) => {
      for (const { was, now } of changes) {
        if (was !== ABSENT) sum -= part(was);
        if (now !== ABSENT) sum += part(now);
      }
      return sum;
    },
  };
}

const TOKENS_NUMBERING = sumOf(tokenNumbering);
const SCENES_NUMBERING = sumOf(sceneNumbering);

const numberingSums = new WeakMap<Part<number, never>, WeakMap<object, number>>();

/** Each value's part summed, kept per part and per record object, which is replaced and never changed, and read from what the room keeps over its accepted state. */
function numberingSum<T>(state: RoomState, field: string, collection: Record<string, T>, part: Part<number, T>, take: boolean): number {
  let sums = numberingSums.get(part as Part<number, never>);
  if (!sums) numberingSums.set(part as Part<number, never>, (sums = new WeakMap()));
  let bytes = sums.get(collection);
  if (bytes !== undefined && !take) return bytes;
  bytes = keptPart(state, field, collection, part, take);
  if (!isWritable(collection)) sums.set(collection, bytes);
  return bytes;
}

/** The scenes' part of the adjust, which the room-level part of every DM's projection holds. */
function scenesNumbering(state: RoomState, take = false): number {
  return numberingSum(state, "scenes", state.scenes, SCENES_NUMBERING, take);
}

/**
 * What the measures count beyond the stored state for creature numbers:
 * the tokens' part, the scenes' part, and the room's group count, with the
 * comma before it, taken out.
 */
export function numberingAdjust(state: RoomState, take = false): number {
  const count = state.numbering === undefined ? 0 : serializedBytes({ numbering: state.numbering }) - 1;
  return numberingSum(state, "tokens", state.tokens, TOKENS_NUMBERING, take) + scenesNumbering(state, take) - count;
}

/** What a scene's measure counts beyond a DM's projection of it for creature numbers: every scene's part, and the tokens' on its floors. */
export function projectionNumbering(state: RoomState, sceneId: string): number {
  const floors = new Set(floorsOf(state, sceneId).map((scene) => scene.id));
  return scenesNumbering(state) + sum(Object.values(state.tokens), (token) => (floors.has(token.sceneId) ? tokenNumbering(token) : 0));
}

/**
 * The scenes, each by its main floor, that creature numbers put over the
 * scene limit: the whole measure a DM's op is checked by (projectedSceneBytes
 * at `share`) is over it, and within it without what numbers count
 * (projectionNumbering). A room saved before creature numbers can hold such
 * a scene, which then refuses every op that grows it. One pass over the
 * state, as a room's load reads it.
 */
export function scenesOverByNumbering(state: RoomState, share: number, sceneLimit: number = LIMITS.projectedSceneBytes): string[] {
  const room = roomLevelBytes(state);
  const owns = allScenesOwnBytes(state);
  const scenesPart = scenesNumbering(state);
  const tokensPart = new Map<string, number>();
  for (const token of Object.values(state.tokens)) tokensPart.set(token.sceneId, (tokensPart.get(token.sceneId) ?? 0) + tokenNumbering(token));
  const out: string[] = [];
  for (const floors of sceneGroups(state)) {
    const need = SHELL_BYTES + room + sum(floors, (scene) => (owns.get(scene.id) ?? 0) + sightReserve(scene) + perPlayerSceneReserve(state, scene) + exploredReserve(state, scene.id) + discoveryReserve(state, scene, share));
    const numbering = scenesPart + sum(floors, (scene) => tokensPart.get(scene.id) ?? 0);
    if (need > sceneLimit && need - numbering <= sceneLimit) out.push(floors[0]!.floor?.of ?? floors[0]!.id);
  }
  return out;
}

/**
 * The room's own bytes as the guard counts them: everything exactly, the
 * traps by their measures and reserves. The log's lines only some viewers
 * or none read and the record of a turn's reminders (RoomState.reminded)
 * ride outside, under bounds of their own, so no player's op ever passes
 * or fails by what they cannot read. So does players' memory, which the
 * guard reserves at its caps and its share (docs/design/design-v1-map-discovery.md
 * 5.5), whatever it holds. Creature numbers count at their widest
 * (numberingAdjust), and fall cards and the reached floors' marks at
 * theirs (fallsMeasure, openedMeasure).
 */
export function measuredStateBytes(state: RoomState): number {
  const memory = state.memory === undefined ? {} : { memory: {} };
  const memoryBy = state.memoryBy === undefined ? {} : { memoryBy: {} };
  return (
    serializedBytes({ ...state, log: measuredLog(state.log), traps: {}, trapLog: [], trapSeen: [], reminded: undefined, saveOutcomes: undefined, dmLogShed: undefined, falls: undefined, openFloors: undefined, ...memory, ...memoryBy }) +
    trapsMeasure(state) +
    fallsMeasure(state) +
    openedMeasure(state) -
    privateStateBytes(state) +
    perPlayerStoredReserve(state) +
    numberingAdjust(state)
  );
}

/**
 * The measure of a state already serialized to `bytes`, such as a snapshot
 * just written, without serializing it again: its traps and their logs,
 * its fall cards and its reached floors' marks swapped for their measures,
 * and the lines and the record outside them taken out.
 */
export function measuredFromStored(bytes: number, state: RoomState): number {
  const traps = state.traps ?? {};
  const log = state.trapLog ?? [];
  const seen = state.trapSeen ?? [];
  const roomLog = measuredLog(state.log);
  // The record's field, `,"reminded":{…}`, is its object's bytes less the braces, and the comma before it.
  const reminded = state.reminded === undefined ? 0 : serializedBytes({ reminded: state.reminded }) - 1;
  const saveOutcomes = state.saveOutcomes === undefined ? 0 : serializedBytes({ saveOutcomes: state.saveOutcomes }) - 1;
  const shed = shedField(state.dmLogShed);
  // The fall cards and the reached floors' marks, swapped for what the measures count of them.
  const floors = storedField(state, "falls") - fallsMeasure(state) + storedField(state, "openFloors") - openedMeasure(state);
  const outside = reminded + saveOutcomes + shed + floors + (roomLog === state.log ? 0 : collectionBytes(state.log) - collectionBytes(roomLog)) + privateStateBytes(state) - perPlayerStoredReserve(state) + memoryStoredBytes(state) - numberingAdjust(state);
  if (Object.keys(traps).length === 0 && log.length === 0 && seen.length === 0) return bytes - outside;
  return bytes - outside - (collectionBytes(traps) - 2) - (collectionBytes(log) - 2) - (collectionBytes(seen) - 2) + trapsMeasure(state);
}

/** A room's `,"dmLogShed":"…"` as stored, its comma included, or 0 where it has none. */
function shedField(id: string | undefined): number {
  return id === undefined ? 0 : 1 + fieldBytes("dmLogShed") + valueBytes(id);
}

/** The room's fields that hold one value rather than a collection of entities, which storedBytes serializes whole. */
const SINGLE_FIELDS: ReadonlySet<string> = new Set(["meta", "encounter", "clock", "playing", "numbering", "reminded", "saveOutcomes", "dmLogShed"] satisfies (keyof RoomState)[]);

/**
 * The bytes of the room as its snapshot stores it (persistence.ts
 * snapshotJson), from the sizes kept per entity and per collection, so a
 * batch's close reads it exactly for about the work of what it wrote
 * (design 1.4).
 */
export function storedBytes(state: RoomState, take = false): number {
  let bytes = 2;
  let fields = 0;
  for (const [name, value] of Object.entries(state)) {
    if (value === undefined) continue;
    fields++;
    bytes += fieldBytes(name) + (value !== null && typeof value === "object" && !SINGLE_FIELDS.has(name) ? collectionBytes(value, name, state, take) : valueBytes(value));
  }
  return bytes + Math.max(0, fields - 1);
}

/** The commas a list of `count` entries loses with `gone` of them. */
function commasGone(count: number, gone: number): number {
  return count === 0 ? 0 : Math.min(gone, count - 1);
}

/**
 * What a batch's close takes out of a room whose stored bytes pass
 * `bound`, HARD.storedBytes but in tests (design 1.4), only until it fits: first the DM's lines
 * from the oldest, while the archive holds every line of the log up to
 * them, so the first line of any audience it lacks stops them, then the
 * fight's oldest history steps that the room held before the batch, never
 * the newest. A line this batch wrote is not archived yet, so it stays. Null
 * when the room fits or nothing may go. The actor and the tests both shed
 * by this, so they agree.
 */
export function shedOf(state: RoomState, stored: number, archived: ReadonlySet<string>, before: RoomState, bound: number = HARD.storedBytes): { lines: string[]; steps: number } | null {
  if (stored <= bound) return null;
  const log = state.log;
  const history = state.encounterHistory;
  const lines: string[] = [];
  let linesFreed = 0;
  let steps = 0;
  let stepsFreed = 0;
  const fits = () => {
    const field = lines.length === 0 ? 0 : shedField(lines.at(-1)) - shedField(state.dmLogShed);
    return stored - linesFreed - commasGone(log.length, lines.length) + field - stepsFreed - commasGone(history.length, steps) <= bound;
  };
  for (const line of log) {
    if (!archived.has(line.id) || lines.length === LIMITS.dmLogLines) break;
    if (lineAudience(line) !== "dm") continue;
    lines.push(line.id);
    linesFreed += valueBytes(line);
    if (fits()) return { lines, steps };
  }
  const held = new Set(before.encounterHistory);
  while (steps < history.length - 1 && steps < SHED_STEPS_MOST && held.has(history[steps]!)) {
    stepsFreed += valueBytes(history[steps]!);
    steps++;
    if (fits()) break;
  }
  return lines.length + steps > 0 ? { lines, steps } : null;
}

/** The scene an entity of a scene-level collection belongs to. */
function sceneOfEntry(name: SceneLevel, key: string, value: unknown): string | undefined {
  if (name === "fogDrafts") return key;
  const sceneId = (value as { sceneId?: unknown } | null)?.sceneId;
  return typeof sceneId === "string" ? sceneId : undefined;
}

/**
 * One scene's own part of a DM's projection: its scene-level collections,
 * filtered to it, with their field names, and its pit reserve. On a
 * per-player scene the party's layer counts at its widest whatever it
 * holds (docs/design/design-v1-per-player-vision.md 6.8).
 */
export function sceneOwnBytes(state: RoomState, sceneId: string): number {
  const commas = commasOf(state, sceneId);
  let bytes = pitReserve(state, sceneId) + (linkBytesByFloor(state).get(sceneId) ?? 0);
  const widest = widestPartyLayer(state, sceneId);
  for (const name of SCENE_LEVEL) {
    let count = 0;
    let inside = 0;
    if (name === "exploredTiles" && widest) {
      count = widest.entries;
      inside = widest.bytes;
    } else {
      for (const [key, value] of Object.entries(state[name] ?? {})) {
        if (sceneOfEntry(name, key, value) !== sceneId) continue;
        count++;
        inside += fieldBytes(key) + entryBytes(name, value);
      }
    }
    bytes += fieldBytes(name) + 2 + inside + commas(count);
  }
  return bytes;
}

/**
 * The commas a scene's collection of `count` entries counts: one between
 * each two, or on a floor of a scene one for each entry (FLR4-FABLE-5). A
 * DM's projection holds a scene's floors' entries in one collection, so
 * where an entry stands among them never moves the scene's measure, and a
 * creature, an area or a ruler crossing floors moves it by nothing, whatever
 * else either floor holds.
 */
function commasOf(state: RoomState, sceneId: string): (count: number) => number {
  return state.scenes[sceneId]?.floor === undefined ? (count) => Math.max(0, count - 1) : (count) => count;
}

/**
 * The stairs and ladders each floor holds, as a DM's projection of its
 * scene holds them (docs/design/design-v1-floors.md phase 2, 2): every end
 * exactly, and the field they share counted on each floor that holds one,
 * which bounds the one field a scene's floors share. A pair's ends lie on
 * two floors of one scene, so the scene's measure counts both. Kept per
 * collection object, which is replaced and never changed.
 */
function linkBytesByFloor(state: RoomState): ReadonlyMap<string, number> {
  const links = state.floorLinks;
  if (links === undefined) return NO_LINKS;
  let hit = linkSizes.get(links);
  if (hit) return hit;
  const counts = new Map<string, number>();
  const sizes = new Map<string, number>();
  for (const [key, end] of Object.entries(links)) {
    counts.set(end.sceneId, (counts.get(end.sceneId) ?? 0) + 1);
    sizes.set(end.sceneId, (sizes.get(end.sceneId) ?? 0) + fieldBytes(key) + valueBytes(end));
  }
  hit = new Map([...counts].map(([sceneId, count]) => [sceneId, 1 + fieldBytes("floorLinks") + 2 + sizes.get(sceneId)! + count - 1]));
  if (!isWritable(links)) linkSizes.set(links, hit);
  return hit;
}

const NO_LINKS: ReadonlyMap<string, number> = new Map();
const linkSizes = new WeakMap<object, ReadonlyMap<string, number>>();

/** A per-player scene's party layer at its widest, or null on any other scene, whose layer counts as it is. */
function widestPartyLayer(state: RoomState, sceneId: string): Widest | null {
  const scene = state.scenes[sceneId];
  return scene && perPlayerScene(scene) ? widestLayer(scene, null) : null;
}

/**
 * An entity as a scene's part counts it: a trap by its measure, a token with
 * every list of who saw in its path as `[]` and its numbering at its widest
 * (tokenNumbering), anything else exactly.
 */
function entryBytes(name: SceneLevel, value: unknown): number {
  if (name === "traps") return trapMeasure(value as Trap);
  if (name === "tokens") return valueBytes(value) - tokenLists(value as Token).extra + tokenNumbering(value as Token);
  return valueBytes(value);
}

/** Every scene's own part, in one pass over the state's scene-level entities. */
function allScenesOwnBytes(state: RoomState): Map<string, number> {
  const counts = new Map<string, number[]>();
  const sizes = new Map<string, number[]>();
  for (const id of Object.keys(state.scenes)) {
    counts.set(id, SCENE_LEVEL.map(() => 0));
    sizes.set(id, SCENE_LEVEL.map(() => 0));
  }
  SCENE_LEVEL.forEach((name, i) => {
    for (const [key, value] of Object.entries(state[name] ?? {})) {
      const sceneId = sceneOfEntry(name, key, value);
      const count = sceneId === undefined ? undefined : counts.get(sceneId);
      if (!count || (name === "exploredTiles" && perPlayerScene(state.scenes[sceneId!]))) continue;
      count[i]! += 1;
      sizes.get(sceneId!)![i]! += fieldBytes(key) + entryBytes(name, value);
    }
  });
  const layer = SCENE_LEVEL.indexOf("exploredTiles");
  for (const id of Object.keys(state.scenes)) {
    const widest = widestPartyLayer(state, id);
    if (!widest) continue;
    counts.get(id)![layer] = widest.entries;
    sizes.get(id)![layer] = widest.bytes;
  }
  const out = new Map<string, number>();
  const links = linkBytesByFloor(state);
  for (const id of Object.keys(state.scenes)) {
    const count = counts.get(id)!;
    const size = sizes.get(id)!;
    let bytes = pitReserve(state, id) + (links.get(id) ?? 0);
    const commas = commasOf(state, id);
    SCENE_LEVEL.forEach((name, i) => (bytes += fieldBytes(name) + 2 + size[i]! + commas(count[i]!)));
    out.set(id, bytes);
  }
  return out;
}

/**
 * Every scene of a room that arrives whole, as a room import stores it, by
 * the projected-scene check every op runs (design 10.5,
 * docs/design/design-v1-maps-vision.md 2.4): the room-level part, the scene's own
 * part, the most its sight tiles can take and, on the player scene, all its
 * explored layer may still take. A room the import accepts then takes the
 * moves and edits its own checks would refuse at once otherwise. The import
 * makes its player scene the one that explores, as moving players there
 * would, so a scene whose explored reserve alone does not fit gets the words
 * the DM can act on (NO_ROOM_TO_EXPLORE). The room's own bytes are the
 * import's to check. At the far lines (`far`) the fight's history and the
 * turn's walks count as empty, as every far reading of a scene counts them
 * (historyWidth, walkPool).
 */
export function checkWholeScenes(state: RoomState, sceneLimit: number = LIMITS.projectedSceneBytes, far = false): LimitCheck {
  const reserved = new Set(reservedExploreFloors(state));
  const room = roomLevelBytes(state) - (far ? historyPastEmpty(state) : 0);
  const owns = allScenesOwnBytes(state);
  // A scene's floors count together against its one budget (docs/design/design-v1-floors.md 9).
  for (const floors of sceneGroups(state)) {
    const walks = far ? sum(floors, (scene) => turnWalks(state).byFloor.get(scene.id) ?? 0) : 0;
    const need = SHELL_BYTES + room + sum(floors, (scene) => (owns.get(scene.id) ?? 0) + sightReserve(scene) + perPlayerSceneReserve(state, scene)) - walks;
    const here = floors.some((scene) => reserved.has(scene.id));
    const explored = sum(floors, (scene) => exploredReserve(state, scene.id));
    if (need + explored <= sceneLimit) continue;
    return here && need <= sceneLimit ? { ok: false, code: "quota", message: NO_ROOM_TO_EXPLORE } : sceneFull();
  }
  return { ok: true };
}

/**
 * At most how many bytes an op added to the serialized state: for every
 * entity it wrote, the new value's size less the old one's, counting only
 * the entities that grew, plus the key that names a new one. A DM's
 * projection of a scene holds those same values, so this also bounds how
 * much any projected scene grew. An entity that changed scene counts in
 * full, as a new one, because the scene it moved into gained all of it even
 * though the room barely changed. Entities that shrank or went away are not
 * subtracted, so the bound errs high and the next exact measurement settles
 * it.
 */
export function growthBound(before: RoomState, after: RoomState, touched: readonly EntityKey[]): number {
  // Per-player vision's reserves move with the roster, the scenes and how many lists there are, none of them an entity
  // whose own size says so (docs/design/design-v1-per-player-vision.md 6.8).
  let growth = Math.max(0, perPlayerStoredReserve(after) - perPlayerStoredReserve(before));
  const trapped = hasTraps(after);
  // A room's first trap brings the room's reserves for occurrences and both trap logs (docs/design/design-v1-traps.md 6.7).
  if (trapped && !hasTraps(before)) growth += DUE_RESERVE + TRAP_LOG_RESERVE + TRAP_SEEN_RESERVE;
  // So does the room's first opening, trapdoor or card for the fall cards, and a new floor for its mark
  // (docs/design/design-v1-floors.md phase 4, 4.7): neither a card nor a mark counts at its own bytes.
  if (fallsReserved(after) && !fallsReserved(before)) growth += FALL_RESERVE;
  growth += Math.max(0, openedMeasure(after) - openedMeasure(before));
  for (const key of touched) {
    const next = readEntity(after, key);
    if (next === null || next === undefined) continue;
    const parsed = parseKey(key);
    // Private lifecycle metadata has its own cap and cannot change player quota answers. Nor does the room's count of
    // creature number groups, which no measure counts.
    if (parsed?.kind === "saveOutcome" || parsed?.kind === "numbering") continue;
    // A trap's line is held by its log's reserve while the room has a trap.
    if ((parsed?.kind === "trapLog" || parsed?.kind === "trapSeen") && trapped) continue;
    // The log's lines only some viewers or none read ride outside the measures.
    if (parsed?.kind === "log" && lineAudience(next as LogEntry) !== "shared") continue;
    // Players' memory counts at its caps and its share, which the reserves hold whatever it writes (docs/design/design-v1-map-discovery.md 5.5).
    if (parsed?.kind === "memory" || parsed?.kind === "memoryBy") continue;
    // Fall cards and reached floors' marks count at their widest, which the reserves above hold.
    if (parsed?.kind === "fall" || parsed?.kind === "opened") continue;
    const prev = readEntity(before, key);
    const added = prev === null || prev === undefined || sceneOf(prev) !== sceneOf(next);
    const size = (value: unknown) => (parsed?.kind === "trap" ? trapMeasure(value as Trap) + pitGrowth(value as Trap) : serializedBytes(value) - namesOf(parsed?.kind, value) + numberingOf(parsed?.kind, value));
    const delta = size(next) + (added ? entryKeyBytes(key) : -size(prev));
    if (delta > 0) growth += delta;
  }
  return growth;
}

/**
 * The bytes a token's, the fight's or the saved steps' lists of who saw
 * hold beyond `[]`, which no measure counts: each list counts at its widest
 * in the reserve instead, whose change the bound adds apart. Counted with
 * them, a move that joins away a corner naming players and adds a stop
 * naming none would shrink the bound below the measure's growth, and the
 * guard's fast path would answer by whom the lists named (review
 * PV3-OPUS-2).
 */
function namesOf(kind: string | undefined, value: unknown): number {
  if (kind === "token") return tokenLists(value as Token).extra;
  if (kind === "encounter") return encounterLists(value as Encounter | null).extra;
  if (kind === "encounterHistory") return historyLists(value as EncounterSnapshot[]).extra;
  return 0;
}

/** A token or scene as the measures count its creature numbers and rev (numberingAdjust), so a meeting's writes grow nothing. */
function numberingOf(kind: string | undefined, value: unknown): number {
  if (kind === "token") return tokenNumbering(value as Token);
  if (kind === "scene") return sceneNumbering(value as Scene);
  return 0;
}

/** The most a trap's pit adds to its scene's reserve: its chunks, and the moved tokens' reserve as if it were the scene's only pit. */
function pitGrowth(trap: Trap): number {
  if (!trap.rig?.pit) return 0;
  const k = utf8Bytes(JSON.stringify(trap.sceneId));
  return pitChunks(trap).size * (2 * k + 780) + PIT_TOKENS_RESERVE;
}

/**
 * What a new entry's key adds to the stored JSON: the key its collection
 * stores it under (an entity's id, or "<scene>:<x>,<y>" for chunks and fog
 * and explored tiles) as JSON writes it, quotes and escapes included, then
 * the colon and the comma after it. A scene ID may be 64 control
 * characters, each escaped to six bytes, so the entity key's own length
 * would undercount it, while the explored layer's reserve counts the
 * escaped key (shared/limits.ts): an explore must take off the guard's
 * bound exactly what it takes off the reserve. A log entry is an array
 * element and adds only its comma, and the singletons are always there,
 * the clock aside.
 */
function entryKeyBytes(key: EntityKey): number {
  const parsed = parseKey(key);
  if (!parsed) return jsonKeyBytes(key);
  switch (parsed.kind) {
    case "meta":
    case "encounter":
    case "encounterHistory":
      return 0;
    // The count of creature number groups is outside every measure, as the save outcomes are.
    case "numbering":
      return 0;
    // The clock's field comes and goes with it, and so does what plays in a room from before sound (docs/design/design-v1-music.md 6.7).
    case "clock":
      return jsonKeyBytes("clock");
    case "playing":
      return jsonKeyBytes("playing");
    // A room from before sound has neither record, so its first entry brings the record's field and braces too.
    case "sound":
      return jsonKeyBytes(parsed.id) + jsonKeyBytes("sounds") + 2;
    case "playlist":
      return jsonKeyBytes(parsed.id) + jsonKeyBytes("playlists") + 2;
    // A DM's projection holds stairs only while its floors hold one, so a floor's first end brings the field too.
    case "floorLink":
      return jsonKeyBytes(parsed.id) + jsonKeyBytes("floorLinks") + 2;
    case "log":
    case "trapLog":
    case "trapSeen":
      return 1;
    case "chunk":
      return jsonKeyBytes(chunkKey(parsed.sceneId, parsed.cx, parsed.cy));
    case "fog":
    case "explored":
    case "sight":
    case "sightAll":
    case "fogAll":
    case "exploredAny":
      return jsonKeyBytes(tileKey(parsed.sceneId, parsed.tx, parsed.ty));
    case "exploredBy":
      return jsonKeyBytes(holderTileKey(parsed.sceneId, parsed.memberId, parsed.tx, parsed.ty));
    case "fogDraft":
    case "holders":
      return jsonKeyBytes(parsed.sceneId);
    default:
      return jsonKeyBytes(parsed.id);
  }
}

function jsonKeyBytes(key: string): number {
  return utf8Bytes(JSON.stringify(key)) + 2;
}

function sceneOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "sceneId" in value ? value.sceneId : undefined;
}

// ---------------------------------------------------------------------------
// Player limits: the DM's part of each measure, the far line, and the fixed
// shares of the marked scenes' pool (shared/limits.ts FAR, MARKED_POOL)

/**
 * The share of MARKED_POOL the room's marked scenes without one take now:
 * what the pool has left after the shares written, split equally, at most
 * MARKED_SHARE_MOST. Written shares never move, so a scene marked later
 * takes its share from what is left.
 */
function unwrittenShare(state: RoomState): number {
  let written = 0;
  let unwritten = 0;
  for (const mark of Object.values(state.memoryShared ?? {})) {
    if (!state.scenes[mark.sceneId]) continue;
    if (mark.share !== undefined) written += mark.share;
    else unwritten++;
  }
  return unwritten === 0 ? 0 : Math.min(MARKED_SHARE_MOST, Math.floor(Math.max(0, MARKED_POOL - written) / unwritten));
}

/** A marked scene's share of the pool: the one written into its mark, or while none is, the one it would take now. */
export function sceneShare(state: RoomState, scene: Scene): number {
  const mark = state.memoryShared?.[scene.id];
  if (mark === undefined) return 0;
  return mark.share ?? unwrittenShare(state);
}

/** How many of a reserved scene's layers share its pool share: the party's, and its holders' unless the mark is the party's alone. */
function sharingLayers(state: RoomState, scene: Scene): number {
  return (sharesRoom(state, scene) ? 1 : 0) + (sharesRoom(state, scene, true) ? memoryLayerCount(state, scene) - 1 : 0);
}

/**
 * A layer's cap on a scene now: a whole cap, or where the layer shares the
 * scene's pool share, that share split over its sharing layers, at most a
 * whole cap. Read from the mark and the roster, which every copy holds,
 * and 0 where memory is not reserved, so the map step forgets it all.
 */
export function layerCap(state: RoomState, scene: Scene, layer: Layer = null): number {
  if (!memoryReserved(state, scene)) return 0;
  if (!sharesRoom(state, scene, layer !== null)) return MEMORY_CAP;
  const layers = sharingLayers(state, scene);
  return layers === 0 ? MEMORY_CAP : Math.min(MEMORY_CAP, Math.floor(sceneShare(state, scene) / layers));
}

/** Every marked scene's layer caps, read as one key, so a change of the roster or of a share shows as a change of caps. */
export function capsKey(state: RoomState): string {
  const parts: string[] = [];
  for (const mark of Object.values(state.memoryShared ?? {}).sort((a, b) => (a.sceneId < b.sceneId ? -1 : 1))) {
    const scene = state.scenes[mark.sceneId];
    if (scene) parts.push(`${scene.id}:${layerCap(state, scene)}:${layerCap(state, scene, "holder")}`);
  }
  return parts.join(",");
}

/** The `sys.share` a room's first load on this format writes: each marked scene without a share takes its share of what the pool has left. */
export function shareOp(state: RoomState): OpOf<"sys.share"> | null {
  const unshared = Object.values(state.memoryShared ?? {})
    .filter((mark) => state.scenes[mark.sceneId] !== undefined && mark.share === undefined)
    .map((mark) => mark.sceneId)
    .sort();
  if (unshared.length === 0) return null;
  const share = unwrittenShare(state);
  return { t: "sys.share", shares: unshared.map((sceneId) => ({ sceneId, share })) };
}

/** Whether any scene keeps the marked pool's mark, so the far line holds the pool whole. */
function marked(state: RoomState): boolean {
  return Object.values(state.memoryShared ?? {}).some((mark) => state.scenes[mark.sceneId] !== undefined);
}

/** A member id as long as the server mints them (shared/ids.ts uuidv7), the shortest a full roster's widest slot holds. */
const WIDEST_ID = "00000000-0000-7000-8000-000000000000";

/**
 * The roster at its widest for per-player vision's reserves: up to six
 * players' ids, the longest first, each no shorter than a minted id, and
 * the rest of the six slots minted ids, so a join, a kind change and a
 * removal never widen it.
 */
function widestPlayerIds(members: RoomState["members"]): string[] {
  const ids = rosterIds(members).players.slice(0, MOST_SIGHT_HOLDERS);
  const out = ids.map((id, i) => (utf8Bytes(id) >= WIDEST_ID.length ? id : `${WIDEST_ID.slice(0, -2)}${String(i).padStart(2, "0")}`));
  for (let i = out.length; i < MOST_SIGHT_HOLDERS; i++) out.push(`${WIDEST_ID.slice(0, -2)}${String(i).padStart(2, "0")}`);
  return out;
}

/**
 * What per-player vision adds to the stored state at its widest for any
 * roster: on each per-player scene the party's layer and six players'
 * layers, and every list of who saw as wide as six such ids. A player's far
 * check holds it whole, so no join moves the answer.
 */
export function widestPerPlayerReserve(state: RoomState): number {
  const players = widestPlayerIds(state.members);
  let layers = 0;
  for (const scene of Object.values(state.scenes)) {
    if (!perPlayerScene(scene)) continue;
    layers += layerEntries(widestLayer(scene, null));
    for (const id of players) layers += layerEntries(widestLayer(scene, id));
  }
  return layers + storedLists(state).count * widestPlayersListExtra(state.members);
}

/** What a list of who saw adds beyond `[]` at the widest roster (widestPlayerIds). */
function widestPlayersListExtra(members: RoomState["members"]): number {
  const players = widestPlayerIds(members);
  return players.reduce((sum, id) => sum + utf8Bytes(JSON.stringify(id)), 0) + players.length - 1;
}

/** An entity's bytes as a map entry, its key and its comma. */
function entityBytes(id: string, value: unknown): number {
  return fieldBytes(id) + valueBytes(value) + 1;
}

/**
 * The stored bytes of what seats hold in each scope (shared/limits.ts
 * seatHeld), every scene's that holds something a player owns, and the
 * rows and asks. Floors of one scene share their tokens and areas, since
 * seatHeld holds them for the scene's every floor, so each counts once.
 * `pooled` leaves out the walks of the turn under way, as the far line's
 * readings do (walkPool).
 */
export function heldBytes(state: RoomState, sceneIds?: readonly string[], pooled = false): number {
  const player = (id: string | undefined) => id !== undefined && state.members[id]?.kind === "player";
  const floors = new Set<string>();
  if (sceneIds) for (const id of sceneIds) for (const floor of floorsOf(state, id)) floors.add(floor.id);
  else {
    for (const t of Object.values(state.templates)) if (player(t.ownerId)) floors.add(t.sceneId);
    for (const d of Object.values(state.drawings)) if (player(d.ownerId)) floors.add(d.sceneId);
    // Any floor with a token: which tokens a seat holds is seatHeld's to say.
    for (const floor of tokenFloors(state.tokens).byFloor.keys()) floors.add(floor);
  }
  const tokens = new Set<string>();
  const templates = new Set<string>();
  const drawings = new Set<string>();
  for (const floor of floors) {
    if (!state.scenes[floor]) continue;
    const held = seatHeld(state, floor);
    for (const id of held.tokens) tokens.add(id);
    for (const id of held.templates) templates.add(id);
    for (const id of held.drawings) drawings.add(id);
  }
  let bytes = 0;
  const seq = pooled ? turnUnderWay(state.encounter)?.seq : undefined;
  for (const id of tokens) {
    const token = state.tokens[id];
    bytes += entityBytes(id, token);
    if (seq !== undefined && token?.path?.turn === seq) bytes -= memberBytes("path", token.path);
  }
  for (const id of templates) bytes += entityBytes(id, state.templates[id]);
  for (const id of drawings) bytes += entityBytes(id, state.drawings[id]);
  if (sceneIds) return bytes;
  const rest = seatHeld(state, null);
  const entries = state.encounter?.entries ?? [];
  for (const entry of entries) if (rest.rows.has(entry.id)) bytes += valueBytes(entry) + 1;
  for (const id of rest.casts) bytes += entityBytes(id, state.casts[id]);
  return bytes;
}

/**
 * A thing's part in a player's exact part (exactCopies): `sub`, the stored
 * bytes the reading takes out of its stepped part, `shown`, the bytes it
 * counts exactly, and `hidden`, what of the thing stays in the stepped part.
 */
export type ExactBytes = { sub: number; shown: number; hidden?: number };

/**
 * What a player's own ops can grow (ownCopyBytes): the parts on each floor, in the room-level part every scene's reading
 * counts, and in their characters' stat blocks for companions, which only the room's reading counts.
 */
export type OwnCopyBytes = { floors: ReadonlyMap<string, ExactBytes>; roomLevel: ExactBytes; blocks: ExactBytes };

/**
 * The room's facts a field's width may read: the player, the creatures
 * they own, the clock their view holds, the roster's ids, whether the room
 * lets players apply damage to any creature they see, and the characters
 * the player plays only through a creature of theirs. Each one moves only
 * with what their copy shows.
 */
type WidthRoom = { readonly memberId: string; readonly clockId: string | undefined; readonly memberIds: readonly string[]; readonly memberIdMost: number; readonly damage: boolean; readonly playsOnly: ReadonlySet<string> };

/**
 * A field a player's own ops write beyond their copy (D-261119-003): its
 * key, under the place `parent` names in the thing (`[]` steps into each
 * element their copy holds), and the bytes it counts at in the exact part,
 * its key and comma included, wherever their copy holds the parent. The
 * width reads only the copy and the room's public facts, so it shows
 * nothing their copy does not. `kept` is what of a stored field stays in
 * the stepped part all the same: things hidden from the player that their
 * op only carried over. A stored field longer than its width keeps the
 * rest in the stepped part too, which no width here is short of in play.
 */
type OwnField = {
  readonly parent: string;
  readonly key: string;
  readonly width: (parent: Readonly<Record<string, unknown>>, room: WidthRoom, thing: Readonly<Record<string, unknown>>, stored: unknown) => number;
  readonly kept?: (stored: unknown, parent: Readonly<Record<string, unknown>>, room: WidthRoom) => number;
  /** Whether the field counts at its width on this thing, always unless given. Where it does not, it counts as any other. */
  readonly applies?: (parent: Readonly<Record<string, unknown>>, room: WidthRoom, thing: Readonly<Record<string, unknown>>) => boolean;
};

/** A number's widest digits: a rev (WIDEST_REV), a clock tick, an HP value. */
const DIGITS = { rev: String(WIDEST_REV).length, hp: 6, tick: String(Number.MAX_SAFE_INTEGER).length } as const;
/** A row's place among ties at its widest: the most rows the far line counts. */
const TIE_ORDER_MOST = String(FAR.rows).length;
/** A coordinate's widest JSON, such as -1.2345678901234567e-300. */
const NUMBER_MOST = 24;
const VITALS_MOST = serializedBytes({ hp: { cur: 100_000, max: 100_000, temp: 100_000 }, life: "stable", deathSaves: { ok: 3, fail: 3 } });
const HP_MOST = serializedBytes({ cur: 100_000, max: 100_000, temp: 100_000 });
/** An id a device chose, at its widest as JSON: 64 characters, each escaped to six bytes at most. */
const ID_MOST = 6 * 64 + 2;
/** An id at 64 single-byte characters, as JSON. A longer one counts at its bytes. */
const ID_BYTES = 66;
/** An id at its widest (ID_MOST), a text of MAX_NAME characters at its widest and a number at its widest, as values. */
const ID_AT_WIDEST = "\u0001".repeat(64);
const TEXT_AT_WIDEST = "\u20ac".repeat(MAX_NAME);
const NUMBER_AT_WIDEST = -1.2345678901234567e-300;
/**
 * An area at its widest as stored, every field present (protocol.ts
 * templateFields): what an area on a creature counts in its owner's exact
 * part while their copy holds neither, whatever it holds then
 * (D-261119-021).
 */
const AREA_MOST = serializedBytes({
  id: ID_AT_WIDEST,
  rev: WIDEST_REV,
  sceneId: ID_AT_WIDEST,
  shape: "emanation",
  size: NUMBER_AT_WIDEST,
  width: NUMBER_AT_WIDEST,
  height: NUMBER_AT_WIDEST,
  origin: { x: NUMBER_AT_WIDEST, y: NUMBER_AT_WIDEST, z: NUMBER_AT_WIDEST },
  yaw: NUMBER_AT_WIDEST,
  pitch: NUMBER_AT_WIDEST,
  faceOffset: { u: NUMBER_AT_WIDEST, v: NUMBER_AT_WIDEST },
  anchor: "bottom",
  attachedTo: ID_AT_WIDEST,
  footprint: { w: NUMBER_AT_WIDEST, h: NUMBER_AT_WIDEST, elevation: NUMBER_AT_WIDEST, height: NUMBER_AT_WIDEST, size: "gargantuan" },
  triggers: ["turnStart", "turnEnd", "enter"],
  oncePerTurn: true,
  slows: { kind: "difficult", foes: true },
  includeOrigin: false,
  color: "#ffffffff",
  label: TEXT_AT_WIDEST,
  spell: TEXT_AT_WIDEST,
  casterId: ID_AT_WIDEST,
  ownerId: ID_AT_WIDEST,
  visibility: "all",
} satisfies Required<AreaTemplate>);
/** A single line of text of `max` characters at its widest as JSON: three bytes a character at most, no control characters. */
const textMost = (max: number) => 3 * max + 2;
/**
 * What an HP change replaced (HpRevert) past the conditions it put on and
 * took off: its two vitals at their widest, the paused anchors of what it
 * ended, a shape's pool and a turn record, with the lists' own brackets.
 */
const REVERT_MOST = 2 * (fieldBytes("before") + VITALS_MOST + 1) + fieldBytes("added") + fieldBytes("removed") + 6 + 512;
/** A creature's marks of what it has used, which a player writes on a character they play only through a creature of theirs. */
const USES_MOST = 4096;
/** A life's widest as JSON. */
const LIFE_MOST = Math.max(...Object.keys({ alive: 0, dying: 0, stable: 0, dead: 0 } satisfies Record<LifeState, 0>).map((life) => serializedBytes(life)));
/** The damage types a creature took (Actor `hurt`) at their widest: every type once. */
const HURT_MOST = serializedBytes([...DAMAGE_TYPES]);
/** The Unconscious that 0 HP puts on (shared/rules/hp.ts withUnconscious). */
const ZERO_UNCONSCIOUS_BYTES = serializedBytes({ id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" });
const field = (parent: string, key: string, width: OwnField["width"], kept?: OwnField["kept"]): OwnField => ({ parent, key, width, kept });
/** A field at a fixed number of value bytes. */
const fixed = (parent: string, key: string, value: number): OwnField => field(parent, key, () => fieldBytes(key) + value + 1);
/** A field the copy holds as stored where it holds it, and at `most` value bytes where it does not. */
const shownOr = (parent: string, key: string, most: number): OwnField => field(parent, key, (p) => (p[key] === undefined ? fieldBytes(key) + most + 1 : memberBytes(key, p[key])));
/** A field of an event line of the given types, as shownOr. */
const lineField = (key: string, types: readonly string[], most: number): OwnField =>
  field("data", key, (d) => (!types.includes(d.type as string) ? memberBytes(key, d[key]) : d[key] === undefined ? fieldBytes(key) + most + 1 : memberBytes(key, d[key])));
/** Whether a chunk's copy holds a door, on a grid edge or off it. */
const holdsDoor = (chunk: Readonly<Record<string, unknown>>) =>
  Object.values((chunk.edges ?? {}) as Record<string, { kind?: string }>).some((f) => f.kind === "door") || ((chunk.walls ?? []) as Array<{ f: { kind?: string } }>).some((w) => w.f.kind === "door");
/** A door's field, on a wall feature that is a door in the copy. */
const doorField = (parent: string, key: string, value: number): OwnField => field(parent, key, (f) => (f.kind === "door" ? fieldBytes(key) + value + 1 : 0));
/** A field the copy itself holds and the stored thing lacks, counted as the copy holds it. */
const copyOnly = (parent: string, key: string): OwnField => field(parent, key, (p) => memberBytes(key, p[key]));
/** A list of readers at every member of the public roster, kept per room's facts. */
const readersWidths = new WeakMap<WidthRoom, number>();
const readersWidth = (room: WidthRoom) => {
  let width = readersWidths.get(room);
  if (width === undefined) readersWidths.set(room, (width = 2 + Math.max(0, room.memberIds.length - 1) + sum(room.memberIds, (id) => utf8Bytes(JSON.stringify(id)))));
  return width;
};
/** The conditions an HP change put on or took off. */
const changed = (revert: unknown): Effect[] => {
  const r = revert as { added?: Effect[]; removed?: Effect[] } | undefined;
  return [...(r?.added ?? []), ...(r?.removed ?? [])];
};
/** Those of them hidden from players, as stored. */
const hiddenConditions = (revert: unknown) => sum(changed(revert), (e) => (e.hiddenFromPlayers ? valueBytes(e) + 1 : 0));
/** What of a condition players may not be shown, at its widest: a save's DC and occurrence, a span's end and clock, a Ready action's trigger. */
const SAVE_UNSHOWN_MOST = fieldBytes("dc") + String(LIMITS.rollDcMax).length + 1 + fieldBytes("due") + serializedBytes({ id: `${"9".repeat(18)}:${"9".repeat(6)}`, state: "dismissed" }) + 1;
const ENDS_UNSHOWN_MOST = fieldBytes("at") + DIGITS.tick + 1 + fieldBytes("clock") + ID_MOST + 1;
const TRIGGER_MOST = fieldBytes("label") + textMost(MAX_NAME) + 1;
/**
 * Those shown to players, as players get them (publicEffects), with what of
 * each they may not be shown at its widest wherever what they are shown
 * leaves room for it, so the width reads only what players see.
 */
const shownConditions = (revert: unknown, room: WidthRoom) =>
  sum(publicEffects(changed(revert), () => false, room.clockId), (e) => valueBytes(e) + 1 + (e.save ? SAVE_UNSHOWN_MOST : 0) + (e.ends && e.ends.clock === undefined ? ENDS_UNSHOWN_MOST : 0) + (e.key === "readied" && e.label === undefined ? TRIGGER_MOST : 0));

/** A key no actor holds, for the automatic Unconscious counted as if present (damageWritten). */
const UNCONSCIOUS_AS_IF = "\u0000unconscious";

/**
 * What a player's damage writes on an actor beyond its HP and damage
 * types, where the room lets players apply damage to any creature they see
 * (D-261121-129): its life at its widest, and the Unconscious 0 HP puts on
 * as if present, its comma judged by the conditions the copy holds. Both
 * read only the copy, so the creature's hidden HP never moves the exact
 * part. HP and damage types count by their own fields (shownOr).
 */
function damageWritten(parent: string): OwnField[] {
  const damage = (_a: unknown, room: WidthRoom) => room.damage;
  const unconscious = (a: Readonly<Record<string, unknown>>) => {
    const effects = (a.effects as readonly Effect[] | undefined) ?? [];
    return effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID) ? 0 : ZERO_UNCONSCIOUS_BYTES + (effects.length > 0 ? 1 : 0);
  };
  return [
    { ...fixed(parent, "life", LIFE_MOST), applies: damage },
    { ...field(parent, UNCONSCIOUS_AS_IF, unconscious), applies: damage },
  ];
}

/**
 * Every field a player's own ops write beyond their copy, by the kind of
 * thing (D-261119-003). Each counts in their exact part at its width, so
 * their own op writes nothing into the stepped part, but for the residuals
 * tracked privately (D-261119-019). Beside what they write past
 * their copy are the fixed differences between copy and stored: the copy
 * holds every rev as 0, an anchored ruler's stops where its creatures
 * stand, and `aboveFog`, `party` and an HP label or bar it adds.
 * sizeGuard.exact.test.ts fails on a player op that moves the stepped part
 * by stored bytes outside these and exactCopies.
 */
export const OWN_WRITTEN: Readonly<Record<CopiedKind, readonly OwnField[]>> = {
  token: [
    fixed("", "rev", DIGITS.rev),
    copyOnly("", "aboveFog"),
    copyOnly("", "party"),
    // HP where the copy holds a label or a bar: a player's damage writes the numbers.
    shownOr("actor.inline", "hp", HP_MOST),
    copyOnly("actor.inline", "hpLabel"),
    copyOnly("actor.inline", "hpBar"),
    // The damage types a player's damage wrote, which only the creature's owners receive (D-261120-061).
    shownOr("actor.inline", "hurt", HURT_MOST),
    // A player's own create stores the DM's notes empty. What the DM writes past that stays stepped.
    fixed("actor.inline", "dmNotes", 2),
    ...damageWritten("actor.inline"),
  ],
  // The creature that cast an area, at its widest, as if present: the copy holds it only while the caster is in sight
  // (D-261119-017). An area on a creature out of their sight counts whole at AREA_MOST (exactCopies).
  template: [fixed("", "rev", DIGITS.rev), fixed("", "casterId", ID_BYTES)],
  // A kept ruler's stops on creatures, and the creatures, at their widest: the copy holds the ruler only while its
  // creatures are in sight, each such stop where its creature stands then (D-261119-017).
  drawing: [fixed("", "rev", DIGITS.rev), field("", "points", (d) => anchoredPoints(d)), field("", "anchors", (d) => anchorsWidth(d))],
  // A row's group, which an add writes from its creature and the DM may change, and its place among ties, which every
  // row's add or new value moves on.
  row: [fixed("", "groupKey", textMost(MAX_NAME)), fixed("", "tieOrder", TIE_ORDER_MOST)],
  // An ask's targets at the most an ask names and its area, at their widest: the copy holds only those in sight
  // (D-261119-017).
  cast: [
    fixed("", "rev", DIGITS.rev),
    // Whether it was made on a floor, which their op writes and their copy never holds.
    fixed("", "onFloor", 4),
    { ...fixed("", "targets", 2 + LIMITS.rollTargets * (ID_BYTES + 1)), applies: (c) => c.targets !== undefined },
    { ...fixed("", "area", ID_BYTES), applies: (c) => c.targets === undefined },
  ],
  companionBlock: [fixed("", "rev", DIGITS.rev)],
  member: [fixed("", "rev", DIGITS.rev)],
  character: [
    fixed("", "rev", DIGITS.rev),
    // A Long Rest's stamp by the room's clock, whoever rests the character.
    fixed("", "longRest", serializedBytes({ at: 0, clock: "" }) - 1 + DIGITS.tick + ID_MOST - 2),
    shownOr("actor", "hp", HP_MOST),
    copyOnly("actor", "hpLabel"),
    copyOnly("actor", "hpBar"),
    shownOr("actor", "hurt", HURT_MOST),
    fixed("actor", "dmNotes", 2),
    // A character played only through a creature of theirs, whose copy holds none of its actor's marks.
    shownOr("actor", "deathSaves", serializedBytes({ ok: 3, fail: 3 })),
    field("actor", "uses", (a, room, c) => (a.uses !== undefined || !room.playsOnly.has(c.id as string) ? memberBytes("uses", a.uses) : fieldBytes("uses") + USES_MOST + 1)),
    ...damageWritten("actor"),
  ],
  roll: [
    fixed("", "rev", DIGITS.rev),
    // An answer's who and hidden result, and the answer a change replaced.
    field("targets[]", "by", (_t, room) => fieldBytes("by") + room.memberIdMost + 1),
    fixed("targets[]", "result", serializedBytes("pass")),
    fixed("targets[]", "previous", serializedBytes({ choice: 1, total: -100_000, result: "pass", tag: "" }) + ID_MOST - 2),
  ],
  log: [
    // Who could read each part of a line their op writes, each list at every member of the roster: an HP, rest,
    // concentration, death save or use line's numbers, an HP or rest line's label, a turn's take-back, and each roll of
    // a dice line of theirs, every roll of which their copy holds. Who could read each roll of another's dice line,
    // which names every roll stored, stays stepped with the rolls it hides.
    field(
      "",
      "parts",
      (line, room) => (PARTS_OF[(line.data as { type?: string } | undefined)?.type ?? ""] ?? 0) * (fieldBytes("label") + readersWidth(room) + 1) + fieldBytes("parts") + 2 + ownRolls(line, room),
      (parts, line, room) => (ownRolls(line, room) > 0 ? 0 : memberBytes("rolls", (parts as { rolls?: unknown } | undefined)?.rolls)),
    ),
    // What an HP change replaced. The conditions it carried over count as players are shown them (D-261120-004), and
    // those hidden from players stay in the stepped part, as they were.
    field("data", "revert", (data, room, _line, stored) => (data.type === "hp" ? fieldBytes("revert") + REVERT_MOST + 1 + shownConditions(stored, room) : 0), (stored) => hiddenConditions(stored)),
    // An HP, rest, concentration or death save line's numbers and label, which only those who read the creature's HP get.
    lineField("amount", ["hp", "rest"], DIGITS.hp),
    lineField("left", ["hp", "rest"], HP_MOST),
    lineField("label", ["hp", "rest"], serializedBytes("Bloodied")),
    lineField("dc", ["concentration"], 2),
    lineField("ok", ["deathSave"], 1),
    lineField("fail", ["deathSave"], 1),
  ],
  // A door's state and whether it was found, in the build's chunk, which a player sets on a door their creature reaches.
  chunk: [field("", "rev", (c) => (holdsDoor(c) ? fieldBytes("rev") + DIGITS.rev + 1 : 0)), doorField("edges.*", "state", serializedBytes("closed")), doorField("edges.*", "discovered", 5), doorField("walls[].f", "state", serializedBytes("closed")), doorField("walls[].f", "discovered", 5)],
};

/** The readers of each roll of a dice line the player rolled, each list at every member of the roster. */
const ownRolls = (line: Readonly<Record<string, unknown>>, room: WidthRoom) => {
  const data = line.data as { type?: string; by?: string; rolls?: unknown[] } | undefined;
  if (data?.type !== "dice" || data.by !== room.memberId) return 0;
  return fieldBytes("rolls") + 2 + (data.rolls?.length ?? 0) * (readersWidth(room) + 1) + 1;
};


/** A ruler's points, each stop on a creature at its widest and the others as kept. */
function anchoredPoints(drawing: Readonly<Record<string, unknown>>): number {
  const points = (drawing.points as number[] | undefined) ?? [];
  const anchors = (drawing.anchors as (string | null)[] | undefined) ?? [];
  let bytes = fieldBytes("points") + 2 + Math.max(0, points.length - 1) + 1;
  for (let i = 0; i < points.length; i++) bytes += anchors[Math.floor(i / 2)] != null ? NUMBER_MOST : serializedBytes(points[i]);
  return bytes;
}

/** A ruler's creatures, each id at its widest. */
function anchorsWidth(drawing: Readonly<Record<string, unknown>>): number {
  const anchors = drawing.anchors as (string | null)[] | undefined;
  if (anchors === undefined) return 0;
  return fieldBytes("anchors") + 2 + Math.max(0, anchors.length - 1) + sum(anchors, (a) => (a === null ? 4 : ID_BYTES)) + 1;
}

/** How many lists of readers a shared event line's parts hold at most, by its type (shared/project.ts partsOf). */
const PARTS_OF: Readonly<Record<string, number>> = { hp: 2, rest: 2, concentration: 1, deathSave: 1, use: 1, turn: 1 };

type FieldIndex = { byParent: ReadonlyMap<string, readonly OwnField[]>; prefixes: ReadonlySet<string>; wild: ReadonlySet<string> };

/**
 * The fields a player's exact part counts at a width on a thing of `kind`:
 * a creature's and an area's FAR_WIDTHS fields that count at one constant
 * width there (WidthField `exact`), and the own-written ones (OWN_WRITTEN)
 * where no such field takes their place (D-261121-121, 129).
 */
function exactFields(kind: CopiedKind): readonly OwnField[] {
  const far = kind === "token" ? FAR_WIDTHS.token : kind === "template" ? FAR_WIDTHS.template : [];
  const widths = far.flatMap((f) => (f.exact === undefined ? [] : [fixed("", f.key, f.exact)]));
  return [...widths, ...OWN_WRITTEN[kind].filter((own) => !widths.some((f) => f.parent === own.parent && f.key === own.key))];
}

const fieldIndexes = new Map<CopiedKind, FieldIndex>();

/** The fields of exactFields by the place they are in, built on first use, after FAR_WIDTHS below is. */
function fieldIndex(kind: CopiedKind): FieldIndex {
  let index = fieldIndexes.get(kind);
  if (index) return index;
  const byParent = new Map<string, OwnField[]>();
  const prefixes = new Set<string>([""]);
  const wild = new Set<string>();
  for (const f of exactFields(kind)) {
    byParent.set(f.parent, [...(byParent.get(f.parent) ?? []), f]);
    let at = "";
    for (const part of f.parent.split(".").filter((p) => p !== "")) {
      const name = part.endsWith("[]") ? part.slice(0, -2) : part;
      if (name === "*") wild.add(at);
      at = at === "" ? name : `${at}.${name}`;
      prefixes.add(at);
      if (part.endsWith("[]")) prefixes.add((at = `${at}[]`));
    }
  }
  fieldIndexes.set(kind, (index = { byParent, prefixes, wild }));
  return index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A record's entry's place: by its key, or `*` where the fields name any entry of the record. */
const childPath = (index: FieldIndex, path: string, key: string) => {
  const name = index.wild.has(path) ? "*" : key;
  return path === "" ? name : `${path}.${name}`;
};
const memberBytes = (key: string, value: unknown) => (value === undefined ? 0 : fieldBytes(key) + valueBytes(value) + 1);

/**
 * What a stored thing holds that its copy does not, element by element and
 * field by field, less the own-written fields (OWN_WRITTEN), which count
 * only what they keep and what runs past their widths: the part of the
 * thing that stays in the stepped part. A list the copy keeps fewer of
 * matches by id, or in order.
 */
function hiddenOf(stored: unknown, copy: unknown, path: string, index: FieldIndex, room: WidthRoom, thing: Readonly<Record<string, unknown>>): number {
  if (stored === copy && !index.prefixes.has(path)) return 0;
  if (isRecord(stored) && isRecord(copy)) {
    const listed = index.byParent.get(path);
    let hidden = 0;
    for (const key of new Set([...Object.keys(stored), ...Object.keys(copy)])) {
      const own = listed?.find((f) => f.key === key && (!f.applies || f.applies(copy, room, thing)));
      if (own) {
        const kept = own.kept?.(stored[key], copy, room) ?? 0;
        hidden += kept + Math.max(0, memberBytes(key, stored[key]) - kept - own.width(copy, room, thing, stored[key]));
      } else if (copy[key] === undefined) hidden += memberBytes(key, stored[key]);
      else if (stored[key] === undefined) hidden -= memberBytes(key, copy[key]);
      else hidden += hiddenOf(stored[key], copy[key], childPath(index, path, key), index, room, thing);
    }
    return hidden;
  }
  if (Array.isArray(stored) && Array.isArray(copy)) {
    const matched = listHidden(stored, copy, `${path}[]`, index, room, thing);
    if (matched !== null) return matched;
  }
  return stored === copy ? 0 : valueBytes(stored) - valueBytes(copy);
}

function listHidden(stored: readonly unknown[], copy: readonly unknown[], path: string, index: FieldIndex, room: WidthRoom, thing: Readonly<Record<string, unknown>>): number | null {
  if (stored.length === copy.length) {
    let hidden = 0;
    for (let i = 0; i < stored.length; i++) hidden += hiddenOf(stored[i], copy[i], path, index, room, thing);
    return hidden;
  }
  const keyOf = (item: unknown) => (isRecord(item) ? (item.id ?? item.tokenId ?? item.characterId) : undefined);
  // Matched by key only where each key names one element, as two rolls of a line for one creature do not.
  const keyed = (items: readonly unknown[]) => items.every((item) => typeof keyOf(item) === "string") && new Set(items.map(keyOf)).size === items.length;
  if (keyed(stored) && keyed(copy)) {
    const copies = new Map(copy.map((item) => [keyOf(item) as string, item]));
    let hidden = 0;
    for (const item of stored) {
      const match = copies.get(keyOf(item) as string);
      if (match === undefined) hidden += valueBytes(item) + 1;
      else {
        hidden += hiddenOf(item, match, path, index, room, thing);
        copies.delete(keyOf(item) as string);
      }
    }
    for (const item of copies.values()) hidden -= valueBytes(item) + 1;
    return hidden;
  }
  // A list the copy keeps some of in order, such as a walk's stops: each kept one by the next stored one it matches.
  let next = 0;
  let hidden = 0;
  for (const item of stored) {
    if (next < copy.length && hiddenOf(item, copy[next], path, index, room, thing) === 0) next++;
    else hidden += valueBytes(item) + 1;
  }
  return next === copy.length ? hidden : null;
}

/**
 * The own-written fields as the copy holds them: their bytes in the copy,
 * which the exact part counts at their widths instead, and with `stored`
 * those widths' stored bytes, what the exact part takes out of the stepped
 * part for a thing it holds only these fields of (a door's chunk).
 */
function ownFields(copy: unknown, stored: unknown, path: string, index: FieldIndex, room: WidthRoom, thing: Readonly<Record<string, unknown>>, out: { stripped: number; widths: number; taken: number }): void {
  if (Array.isArray(copy)) {
    const kept = Array.isArray(stored) && stored.length === copy.length ? stored : [];
    copy.forEach((item, i) => ownFields(item, kept[i], `${path}[]`, index, room, thing, out));
    return;
  }
  if (!isRecord(copy)) return;
  const from = isRecord(stored) ? stored : {};
  const applying = (index.byParent.get(path) ?? []).filter((f) => !f.applies || f.applies(copy, room, thing));
  for (const f of applying) {
    const width = f.width(copy, room, thing, from[f.key]);
    out.widths += width;
    out.stripped += memberBytes(f.key, copy[f.key]);
    out.taken += Math.max(0, Math.min(width, memberBytes(f.key, from[f.key]) - (f.kept?.(from[f.key], copy, room) ?? 0)));
  }
  for (const [key, value] of Object.entries(copy)) {
    const at = childPath(index, path, key);
    if (index.prefixes.has(at) && !applying.some((f) => f.key === key)) ownFields(value, from[key], at, index, room, thing, out);
  }
}

/** A thing in a player's exact part from its stored value and their copy, each at its bytes in the measure. */
function exactBytes(kind: CopiedKind, stored: unknown, storedBytes: number, copy: unknown, copyBytes: number, room: WidthRoom): ExactBytes {
  const index = fieldIndex(kind);
  const thing = isRecord(copy) ? copy : {};
  const fields = { stripped: 0, widths: 0, taken: 0 };
  ownFields(copy, stored, "", index, room, thing, fields);
  const hidden = hiddenOf(stored, copy, "", index, room, thing);
  return { sub: storedBytes - hidden, shown: copyBytes - fields.stripped + fields.widths, hidden };
}

/** The own-written fields alone of a thing the exact part holds nothing else of: the doors of a chunk of the build. */
function fieldsOnly(kind: CopiedKind, stored: unknown, copy: unknown, room: WidthRoom): ExactBytes {
  const index = fieldIndex(kind);
  const fields = { stripped: 0, widths: 0, taken: 0 };
  ownFields(copy, stored, "", index, room, isRecord(copy) ? copy : {}, fields);
  return { sub: fields.taken, shown: fields.widths, hidden: 0 };
}

// ---------------------------------------------------------------------------
// Fields every op may write on what a player does not receive, at fixed widths (D-261119-011)

/**
 * The room's facts the widths of FAR_WIDTHS read, none of which a player's
 * op changes: the longest scene id, a list of the roster at its widest, and
 * whether players may apply damage to any creature they see.
 */
type WidthsRoom = { readonly sceneIdMost: number; readonly listWidth: number; readonly damage: boolean };

/**
 * A field the far line counts at a fixed width: `width` its bytes there,
 * key and comma included, as if present, and `on` the things whose field
 * counts so. `byRoom` marks a width or a choice that reads the room, the
 * rest kept per thing. A stored field longer than its width counts at its
 * bytes. `exact` is the field's value bytes in a player's exact part, a
 * constant (exactFields): there no width reads the stored room, so a field
 * whose width does, or whose `on` test does, gives none, and the stepped
 * side keeps what it counts beyond the measure (D-261121-121, 129).
 */
type WidthField = {
  readonly key: string;
  readonly width: (room: WidthsRoom) => number;
  readonly on?: (thing: Readonly<Record<string, unknown>>, room: WidthsRoom) => boolean;
  readonly byRoom?: true;
  /** What it counts beyond the measure, where that is not its width less what the measure counts. */
  readonly extra?: (thing: Readonly<Record<string, unknown>>, room: WidthsRoom) => number;
  readonly exact?: number;
};

/** A number's widest JSON, NUMBER_MOST bytes. */
const WIDEST_NUMBER = -1.2345678901234567e-300;
/** A link to a holder at its widest, its id at 64 single-byte characters. A longer id counts at its bytes. */
const ATTACHED_MOST = serializedBytes({ to: "x".repeat(64), kind: "perch", steer: true });
/** One stop of a walk at its widest, without its list of who saw it and its corners. */
const STOP_MOST = serializedBytes({
  x: WIDEST_NUMBER,
  y: WIDEST_NUMBER,
  elevation: WIDEST_NUMBER,
  uncounted: true,
  seen: true,
  joinedUnseen: true,
  footprint: { w: WIDEST_NUMBER, h: WIDEST_NUMBER, squeeze: true },
  moved: 100_000,
  cost: 100_000,
  diag: [100_000, 100_000],
  routeSeen: true,
  carried: true,
});
/**
 * A turn's walk at its widest: MAX_PATH_STOPS stops, each with a list of
 * who saw it at the roster's widest, MAX_PATH_CORNERS corners among them,
 * and what the turn took on floors it left.
 */
const pathMost = (listWidth: number) => walkMost(listWidth, MAX_PATH_STOPS, MAX_PATH_CORNERS);
/** A walk at its widest with `stops` stops and `corners` corners among them, as pathMost counts each. */
const walkMost = (listWidth: number, stops: number, corners: number) =>
  serializedBytes({ turn: WIDEST_REV, prior: { moved: 100_000, cost: 100_000, diag: [100_000, 100_000], seenDiag: [100_000, 100_000] }, stops: [] }) +
  stops * (STOP_MOST + fieldBytes("seenBy") + 2 + listWidth + 1 + fieldBytes("via") + 2 + 1 + 1) +
  2 * corners * (NUMBER_MOST + 1);
const atWidth = (key: string, value: number): WidthField => ({ key, width: () => fieldBytes(key) + value + 1, exact: value });

/**
 * What a player who may apply damage to any creature they see writes on an
 * actor they do not own, counted beyond the measure at its widest
 * (D-261120-061): its HP, its life, the damage types it took, and the
 * Unconscious 0 HP puts on, as if present. So none of it moves a stepped
 * part when the creature leaves their copy.
 */
function damageWidths(actor: Actor): number {
  const zero = actor.effects.some((e) => e.id === ZERO_HP_UNCONSCIOUS_ID) ? 0 : ZERO_UNCONSCIOUS_BYTES + (actor.effects.length > 0 ? 1 : 0);
  return (
    Math.max(0, fieldBytes("hp") + HP_MOST + 1 - memberBytes("hp", actor.hp)) +
    Math.max(0, fieldBytes("life") + LIFE_MOST + 1 - memberBytes("life", actor.life)) +
    Math.max(0, fieldBytes("hurt") + HURT_MOST + 1 - memberBytes("hurt", actor.hurt)) +
    zero
  );
}
/**
 * A floor id at the room's longest scene id, and in a player's exact part
 * at ID_BYTES whatever floors the room holds, so a hidden scene's id never
 * moves that part, nor a climb between floors of ids of other lengths
 * (D-261121-130). A longer stored id counts its excess on the stepped side.
 */
const sceneIdAtWidth: WidthField = { key: "sceneId", width: (room) => fieldBytes("sceneId") + room.sceneIdMost + 1, byRoom: true, exact: ID_BYTES };

/**
 * Every field a player's op may write on a creature or an area they do not
 * receive (D-261119-011): on a passenger a walk or a climb takes along, a
 * creature a pit, a fall or a trapdoor drops, a link the link pass lets go.
 * That is where a creature stands and on which floor, its squeeze and its
 * placement between squares, its link to a holder, its rev, and an area's
 * floor and rev. The far line counts each at its width for every creature
 * and area (farWidths), so such a write never moves a player's stepped
 * part, and the DM's line leaves players the same room. A player's exact
 * part counts each creature and area it holds at these widths too
 * (exactFields), so their move to a square of more digits, their climb or
 * their creature's new rev grows nothing. The walks of the turn under way
 * count in the room's walk pool instead (walkPool).
 */
export const FAR_WIDTHS: Readonly<{ token: readonly WidthField[]; template: readonly WidthField[] }> = {
  token: [
    sceneIdAtWidth,
    atWidth("x", NUMBER_MOST),
    atWidth("y", NUMBER_MOST),
    atWidth("elevation", NUMBER_MOST),
    atWidth("squeeze", serializedBytes(true)),
    atWidth("nudge", serializedBytes({ x: WIDEST_NUMBER, y: WIDEST_NUMBER })),
    atWidth("attached", ATTACHED_MOST),
    // Every write moves a rev on. The measure already counts a monster's and an NPC's at its widest (tokenNumbering). An
    // exact part counts every creature's rev at its width (OWN_WRITTEN).
    { key: "rev", width: () => fieldBytes("rev") + DIGITS.rev + 1, on: (token) => token.kind !== "monster" && token.kind !== "npc" },
    // A creature's own actor, which a player's damage writes where the room lets them apply it, from what the stored
    // actor holds. An exact part counts it from the copy instead (damageWritten). A character's is room level
    // (farWidthsRoomLevel).
    {
      key: "actor",
      width: () => 0,
      extra: (token) => {
        const held = token.actor as Token["actor"];
        return "inline" in held ? damageWidths(held.inline) : 0;
      },
      on: (_token, room) => room.damage,
      byRoom: true,
    },
  ],
  template: [sceneIdAtWidth, atWidth("rev", DIGITS.rev)],
};

function widthsRoom(state: RoomState): WidthsRoom {
  return {
    sceneIdMost: Math.max(0, ...Object.keys(state.scenes).map((id) => utf8Bytes(JSON.stringify(id)))),
    listWidth: widestListExtra(state.members),
    damage: state.meta.settings.playersApplyDamage,
  };
}

const widthsKept = new WeakMap<object, number>();

/** What the far line counts of a thing's FAR_WIDTHS fields beyond the measure. */
function widthsOf(fields: readonly WidthField[], thing: Readonly<Record<string, unknown>>, room: WidthsRoom): number {
  const extra = (f: WidthField) => (f.on && !f.on(thing, room) ? 0 : f.extra ? f.extra(thing, room) : Math.max(0, f.width(room) - memberBytes(f.key, thing[f.key])));
  let kept = widthsKept.get(thing);
  if (kept === undefined) {
    kept = sum(fields, (f) => (f.byRoom ? 0 : extra(f)));
    if (!isWritable(thing)) widthsKept.set(thing, kept);
  }
  return kept + sum(fields, (f) => (f.byRoom ? extra(f) : 0));
}

/** Each floor's FAR_WIDTHS bytes, kept per tokens collection, which is replaced and never changed, with what else they read. */
const byFloorKept = new WeakMap<object, { templates: object; room: string; out: Map<string, number> }>();

type Widths = ReadonlyMap<string, number>;

/**
 * A part that sums a kind's FAR_WIDTHS bytes on each floor where they are
 * more than 0, for the room's facts `room` reads: made for each room as its
 * facts are (shared/accepted.ts roomPart).
 */
function widthsPart(fields: readonly WidthField[], room: WidthsRoom): Part<Widths, { sceneId: string }> {
  const extraOf = (thing: { sceneId: string }) => Math.max(0, widthsOf(fields, thing as unknown as Record<string, unknown>, room));
  return {
    whole: (record, keys) => {
      const out = new Map<string, number>();
      for (const key of keys) {
        const thing = record[key]!;
        const extra = extraOf(thing);
        if (extra > 0) out.set(thing.sceneId, (out.get(thing.sceneId) ?? 0) + extra);
      }
      return out;
    },
    step: (widths, changes) => {
      const out = new Map(widths);
      const add = (by: 1 | -1, thing: { sceneId: string }) => {
        const extra = extraOf(thing);
        if (extra === 0) return;
        const sum = (out.get(thing.sceneId) ?? 0) + by * extra;
        if (sum === 0) out.delete(thing.sceneId);
        else out.set(thing.sceneId, sum);
      };
      for (const { was, now } of changes) {
        if (was !== ABSENT) add(-1, was);
        if (now !== ABSENT) add(1, now);
      }
      return out;
    },
  };
}

/**
 * The FAR_WIDTHS bytes of the creatures and areas on each floor: each
 * thing's where it is more than 0, so a floor with none is left out. Read
 * from what the room keeps over its accepted state, and `take` moves that
 * on (shared/accepted.ts).
 */
export function farWidthsByFloor(state: RoomState, take = false): Map<string, number> {
  const room = widthsRoom(state);
  const sign = `${room.sceneIdMost}:${room.listWidth}:${room.damage}`;
  const hit = byFloorKept.get(state.tokens);
  if (!take && hit && hit.templates === state.templates && hit.room === sign) return hit.out;
  const tokens = keptPart(state, "tokens", state.tokens, roomPart(state, "tokens", "widths:tokens", sign, () => widthsPart(FAR_WIDTHS.token, room), take), take);
  const templates = keptPart(state, "templates", state.templates, roomPart(state, "templates", "widths:templates", sign, () => widthsPart(FAR_WIDTHS.template, room), take), take);
  const out = new Map(tokens);
  for (const [floor, extra] of templates) out.set(floor, (out.get(floor) ?? 0) + extra);
  if (!isWritable(state.tokens) && !isWritable(state.templates)) byFloorKept.set(state.tokens, { templates: state.templates, room: sign, out });
  return out;
}

/** farWidthsByFloor worked out whole, in one plain pass over the creatures and areas, as tests read it against the kept one. */
export function farWidthsByFloorWhole(state: RoomState): Map<string, number> {
  const room = widthsRoom(state);
  const out = new Map(widthsPart(FAR_WIDTHS.token, room).whole(state.tokens, Object.keys(state.tokens)));
  for (const [floor, extra] of widthsPart(FAR_WIDTHS.template, room).whole(state.templates, Object.keys(state.templates))) out.set(floor, (out.get(floor) ?? 0) + extra);
  return out;
}

/**
 * A fight's turn start at its widest, with its key and comma: every id at
 * its widest, the floor at the room's longest scene id, the spot at the
 * widest numbers, the list of who saw it at the roster's widest, and as
 * many mounts as a turn shares.
 */
const turnStartMost = (room: WidthsRoom) =>
  fieldBytes("turnStart") +
  serializedBytes({
    entryId: ID_AT_WIDEST,
    tokenId: ID_AT_WIDEST,
    sceneId: "",
    x: WIDEST_NUMBER,
    y: WIDEST_NUMBER,
    elevation: WIDEST_NUMBER,
    seen: true,
    seenBy: [],
    seq: Number.MAX_SAFE_INTEGER,
    mounts: Array.from({ length: LIMITS.turnMounts }, () => ID_AT_WIDEST),
  }) -
  serializedBytes("") +
  room.sceneIdMost +
  room.listWidth +
  1;

/**
 * What the far line counts of the fight's history beyond the measure: less
 * all of it, so the room's reading and every scene's count it as empty
 * (D-261121-066, 125). A turn's end fills it with rows, creatures and
 * conditions a player chose (D-261120-060), and no step a Next keeps or
 * drops, nor one a companion's removal rewrites, moves a reading. Its own
 * bound holds it to HISTORY_BYTES, which the stored bound counts beside the
 * room's line (shared/limits.ts HARD), and a fight's start sets nothing
 * aside for it.
 */
function historyWidth(state: RoomState): number {
  return fieldBytes("encounterHistory") + 2 - historyBytes(state);
}

/** The fight's history as the measures count it, past an empty one: what every far reading leaves out of the measure. */
export function historyPastEmpty(state: RoomState): number {
  return -historyWidth(state);
}

/**
 * What the far line counts beyond the measure of where the turn under way
 * began, which a turn's end copies from the creature that starts, a
 * player's own included: at its widest (D-261120-060).
 */
function turnStartWidth(state: RoomState, encounter: Encounter): number {
  const room = widthsRoom(state);
  const lists = encounterLists(encounter);
  const stored = encounter.turnStart === undefined ? 0 : memberBytes("turnStart", encounter.turnStart) - lists.extra + lists.count * room.listWidth;
  return Math.max(0, turnStartMost(room) - stored);
}

/**
 * What the far line counts beyond the measure of the characters, where
 * players may apply damage to any creature they see: each actor's fields a
 * player's damage writes (damageWidths), and its rev, which each write
 * moves on.
 */
function charactersDamageWidths(state: RoomState): number {
  return sum(Object.values(state.characters), characterDamageWidths);
}

/** One character's part of charactersDamageWidths. */
function characterDamageWidths(c: Character): number {
  return damageWidths(c.actor) + Math.max(0, fieldBytes("rev") + DIGITS.rev + 1 - memberBytes("rev", c.rev));
}

/**
 * What the far line counts beyond the measure in the room-level part: the
 * fight's rev and each row's place among ties (`tieOrder`), which a
 * player's row moves on for rows they do not receive, at their widths
 * (D-261119-011), the fight's turn start at its widest, the history as
 * empty, and what a player's damage writes on characters
 * (charactersDamageWidths).
 */
export function farWidthsRoomLevel(state: RoomState): number {
  const characters = state.meta.settings.playersApplyDamage ? charactersDamageWidths(state) : 0;
  const encounter = state.encounter;
  const history = historyWidth(state);
  if (!encounter) return characters + history;
  let bytes = characters + history + Math.max(0, fieldBytes("rev") + DIGITS.rev + 1 - memberBytes("rev", encounter.rev)) + turnStartWidth(state, encounter);
  for (const row of encounter.entries) bytes += Math.max(0, fieldBytes("tieOrder") + TIE_ORDER_MOST + 1 - memberBytes("tieOrder", row.tieOrder));
  return bytes;
}

/**
 * What the far line counts beyond the measure on the floors given, or the
 * room's: every creature's and area's FAR_WIDTHS fields at their widths
 * (D-261119-011) and the room-level part's (farWidthsRoomLevel), which
 * every scene's measure holds, and each drop scene's headroom
 * (dropReserve) in place of the near measure's reserve for the creatures a
 * pit floor's pits move (PIT_TOKENS_RESERVE). Falls and trapdoors count by
 * the same widths. The walks of the turn under way count in the room's
 * walk pool in place of their stored bytes, and as empty in a scene's
 * reading (walkPool).
 */
export function farWidths(state: RoomState, floors?: ReadonlySet<string>): number {
  let bytes = farWidthsRoomLevel(state);
  for (const [floor, extra] of farWidthsByFloor(state)) if (!floors || floors.has(floor)) bytes += extra;
  const walks = turnWalks(state);
  if (!floors) bytes += walkPool(state) - walks.bytes;
  else for (const floor of floors) bytes -= walks.byFloor.get(floor) ?? 0;
  const pits = new Set(Object.values(state.traps ?? {}).filter((trap) => trap.rig?.pit && (!floors || floors.has(trap.sceneId))).map((trap) => trap.sceneId));
  return bytes - pits.size * PIT_TOKENS_RESERVE + dropReserve(state, floors);
}

/**
 * The walk pool (D-261121-120): nine walks at their widest, the turn's
 * creature's and those of as many mounts as share its turn
 * (LIMITS.turnMounts), each list of who saw a stop at the roster's widest.
 * The room's reading counts it always, fight or not, in place of every
 * walk of the turn under way, which from change format 65 no creature
 * outside the turn holds (shared/reducer/attach.ts strayTurnWalks). So no
 * walk, mount, dismount or fight's start or end moves a reading, and a
 * player's walk on their own turn grows nothing. A walk a room kept from
 * before then, of another turn, counts at its bytes until a turn's end
 * takes it off.
 */
export function walkPool(state: RoomState): number {
  return (1 + LIMITS.turnMounts) * (fieldBytes("path") + pathMost(widestListExtra(state.members)) + 1);
}

/** The walks of the turn under way as the measures count them, in all and on each floor, and their lists of who saw. */
export type TurnWalks = { readonly bytes: number; readonly lists: number; readonly byFloor: ReadonlyMap<string, number> };

const turnWalksKept = new WeakMap<object, { seq: number | undefined; width: number; out: TurnWalks }>();

/**
 * Each walk tagged with the turn under way (shared/rules/path.ts
 * pathThisTurn), as the measures count it, each list of who saw a stop at
 * the roster's widest, its key and comma included. Kept per tokens
 * collection, which is replaced and never changed, with the turn and the
 * width it read.
 */
export function turnWalks(state: RoomState): TurnWalks {
  const seq = turnUnderWay(state.encounter)?.seq;
  const width = widestListExtra(state.members);
  const hit = turnWalksKept.get(state.tokens);
  if (hit && hit.seq === seq && hit.width === width) return hit.out;
  let bytes = 0;
  let lists = 0;
  const byFloor = new Map<string, number>();
  if (seq !== undefined) {
    for (const token of Object.values(state.tokens)) {
      if (token.path?.turn !== seq) continue;
      const held = tokenLists(token);
      const walk = memberBytes("path", token.path) - held.extra + held.count * width;
      bytes += walk;
      lists += held.count;
      byFloor.set(token.sceneId, (byFloor.get(token.sceneId) ?? 0) + walk);
    }
  }
  const out = { bytes, lists, byFloor };
  if (!isWritable(state.tokens)) turnWalksKept.set(state.tokens, { seq, width, out });
  return out;
}

/** A creature's elevation's widest growth: from `0` to the widest whole feet a token may stand at. */
const DROP_ELEVATION_MOST = serializedBytes(-100_000) - serializedBytes(0);
/** The areas on creatures a scene may hold whoever's they are: the DM's cap and every seat's (shared/limits.ts seatHeld). */
const RIDING_AREAS_MOST = LIMITS.templatesPerScene + LIMITS.membersPerRoom * SEAT.ridingAreas;

/** A drop scene's headroom by what it holds (dropReserve): its creatures and the areas on them. */
export type DropHeadroom = { creatures: number; areas: number };

/**
 * Each drop scene's headroom (D-261119-114, D-261119-123): a scene with a
 * pit or a trapdoor on any of its floors. A drop is a trap's write, which
 * the limits read an op without (actor.ts), so what it may add is held
 * ahead. FAR_WIDTHS already holds every field it writes on a creature or
 * an area a reading steps, so this keeps only what it may add to those a
 * reading counts as they are: a player's own, lent and move-any creatures
 * and their areas in their exact part, and every seat's in the DM's.
 * Read from the scenes, the traps' rigs and the roster alone, none of
 * which a player's op changes, so a springing never moves it.
 */
export function dropReserve(state: RoomState, floors?: ReadonlySet<string>): number {
  let bytes = 0;
  for (const part of dropHeadrooms(state, floors).values()) bytes += part.creatures + part.areas;
  return bytes;
}

/**
 * Each drop scene's headroom by its main floor, from the seat-inclusive
 * bounds whatever the scene holds now: FAR.tokens creatures, each with its
 * floor id grown to the scene's longest where a trapdoor may drop it to
 * another floor and its elevation to its widest, and RIDING_AREAS_MOST
 * areas that follow them, their floor ids grown so. The walks a drop folds
 * are the turn's, which the walk pool holds (walkPool), and a scene counts
 * as empty (D-261121-132).
 */
export function dropHeadrooms(state: RoomState, floors?: ReadonlySet<string>): Map<string, DropHeadroom> {
  const drops = new Map<string, boolean>();
  for (const trap of Object.values(state.traps ?? {})) {
    const below = trap.rig?.below === true;
    if (!trap.rig?.pit && !below) continue;
    if (floors && !floors.has(trap.sceneId)) continue;
    const scene = state.scenes[trap.sceneId];
    if (!scene) continue;
    const main = scene.floor?.of ?? scene.id;
    drops.set(main, (drops.get(main) ?? false) || below);
  }
  const out = new Map<string, DropHeadroom>();
  if (drops.size === 0) return out;
  for (const [main, below] of drops) {
    const ids = floorsOf(state, main).map((floor) => utf8Bytes(JSON.stringify(floor.id)));
    const spread = below && ids.length > 0 ? Math.max(...ids) - Math.min(...ids) : 0;
    out.set(main, { creatures: FAR.tokens * (spread + DROP_ELEVATION_MOST), areas: RIDING_AREAS_MOST * spread });
  }
  return out;
}

/**
 * The exact part of a player's far reading: everything their own ops can
 * grow, each as their copy holds it (SeatView `copy`). That is their own
 * things on floors, rows, asks and companion blocks (shared/limits.ts
 * ownHeld), every creature their copy holds while the room lets them move
 * any or apply damage, their member, the characters they own or a creature
 * of theirs plays, the roll requests their copy holds, and the log's shared
 * lines written while they were on the roster, each as they read it then
 * (linesHeld), which their chat and rolls add to and whose oldest drops as
 * they do. Each takes out of the stepped part all of its stored bytes but
 * what the copy hides and their ops never write, with what the far line
 * counts of it beyond the measure (FAR_WIDTHS), and counts the copy, with
 * each field exactFields names at its width. So their own ops write
 * nothing into the stepped part, but for the residuals tracked privately
 * (D-261119-019), the exact part shows nothing their copy does not and
 * reads no width from the stored room (D-261121-129), and the reading never
 * falls below the stored total (D-261116-015 and 026, D-261119-003). A far
 * check reads it over one membership, before and after the op (exactOver).
 */
export function ownCopyBytes(state: RoomState, memberId: string, view: SeatView = seatView(state, memberId)): OwnCopyBytes {
  return copyBytesOf(exactCopies(state, memberId, view));
}

/** The parts of an exact part (exactCopies or exactOver) gathered by where the reading counts them. */
function copyBytesOf(exact: ReadonlyMap<EntityKey, ExactCopy>): OwnCopyBytes {
  const floors = new Map<string, ExactBytes>();
  const roomLevel = { sub: 0, shown: 0 };
  const blocks = { sub: 0, shown: 0 };
  const part = (where: ExactPlace) => {
    if (where.kind === "room") return roomLevel;
    if (where.kind === "blocks") return blocks;
    let floor = floors.get(where.id);
    if (!floor) floors.set(where.id, (floor = { sub: 0, shown: 0 }));
    return floor;
  };
  for (const { on, sub, shown, shownOn } of exact.values()) {
    part(on).sub += sub;
    part(shownOn ?? on).shown += shown;
  }
  return { floors, roomLevel, blocks };
}

/**
 * The room's facts a player's widths read (WidthRoom), and the characters
 * they own or a creature they own plays, whose actor their ops on that
 * creature write, each as `view`, their copy, shows them.
 */
function exactRoom(state: RoomState, memberId: string, view: SeatView): { room: WidthRoom; characters: Set<string> } {
  const owned = new Set(Object.values(state.characters).filter((c) => c.ownerIds.includes(memberId)).map((c) => c.id));
  const characters = new Set(owned);
  for (const token of Object.values(state.tokens)) if (token.ownerIds.includes(memberId) && "ref" in token.actor && view.copy("token", token.id) !== null) characters.add(token.actor.ref);
  const viewer: Viewer = { memberId, role: "player" };
  const room: WidthRoom = {
    memberId,
    clockId: heldClock(state, viewer)?.id,
    memberIds: Object.keys(state.members),
    memberIdMost: Math.max(0, ...Object.keys(state.members).map((id) => utf8Bytes(JSON.stringify(id)))),
    damage: state.meta.settings.playersApplyDamage,
    playsOnly: new Set([...characters].filter((id) => !owned.has(id))),
  };
  return { room, characters };
}

/**
 * Where a thing of a player's exact part counts: the room-level part every
 * scene's reading counts, the companion blocks only the room's reading
 * counts, or a floor by its id. The three are apart by kind, never by id,
 * since a floor's id may be any word, "room" and "blocks" among them.
 */
export type ExactPlace = { readonly kind: "room" } | { readonly kind: "blocks" } | { readonly kind: "floor"; readonly id: string };

const AT_ROOM = { kind: "room" } as const satisfies ExactPlace;
const AT_BLOCKS = { kind: "blocks" } as const satisfies ExactPlace;
const atFloor = (id: string): ExactPlace => ({ kind: "floor", id });

/** Whether two places of an exact part are one. */
export function samePlace(a: ExactPlace, b: ExactPlace): boolean {
  return a.kind === "floor" ? b.kind === "floor" && a.id === b.id : a.kind === b.kind;
}

/**
 * A thing in a player's exact part (exactCopies): where its stored bytes
 * are, a floor, the room-level part every scene counts or only the room's
 * blocks, where it counts what it shows when not there too, and its part.
 */
export type ExactCopy = { on: ExactPlace; shownOn?: { readonly kind: "room" } } & ExactBytes;

/**
 * The log's shared lines a player's exact part holds, each as they read it
 * when it was written (SeatView `written`): every player on the roster then
 * read it (shared/project.ts lineReach), so it counts so whatever its
 * creature, area or row is now. One written while they were not on the
 * roster, which they may never have read, stays in the stepped part, so
 * none of their ops moves it there either (D-261120-010). They are on the
 * roster from the start of the log unless its first line about them is
 * their join, and leave it at a kick or a removal.
 */
export function linesHeld(state: RoomState, memberId: string, view: SeatView = seatView(state, memberId)): Map<LogEntry, unknown> {
  const lines = measuredLog(state.log);
  const about = (line: LogEntry) => (line.data?.type === "member" && line.data.memberId === memberId ? line.data.action : undefined);
  const first = lines.find((line) => about(line) !== undefined);
  let onRoster = first === undefined || about(first) !== "join";
  const out = new Map<LogEntry, unknown>();
  for (const line of lines) {
    const action = about(line);
    if (action === "join") onRoster = true;
    else if (action === "kick" || action === "remove") onRoster = false;
    if (!onRoster) continue;
    const copy = view.written(line.id);
    if (copy !== null) out.set(line, copy);
  }
  return out;
}

/** A creature without its walk, kept per stored creature, which is replaced and never changed. */
const walklessKept = new WeakMap<object, unknown>();

/**
 * A creature as a player's exact part counts it: without its walk. The walk
 * pool holds every walk of the turn under way, and a walk of another turn
 * counts at its stored bytes in the stepped part (walkPool), so no walk is
 * read through a copy.
 */
function walkless(token: unknown): unknown {
  if (!isRecord(token) || token.path === undefined) return token;
  const kept = walklessKept.get(token);
  if (kept !== undefined) return kept;
  const { path: _path, ...rest } = token;
  if (!isWritable(token)) walklessKept.set(token, rest);
  return rest;
}

/** Each thing a player's exact part holds (ownCopyBytes), by its key: where the reading counts it and its part (exactBytes). */
export function exactCopies(state: RoomState, memberId: string, view: SeatView = seatView(state, memberId)): Map<EntityKey, ExactCopy> {
  const out = new Map<EntityKey, ExactCopy>();
  // A character counts as played through a creature of theirs that their copy holds, so a creature's delete or hand-off
  // they cannot see moves nothing (D-261119-021).
  const { room, characters } = exactRoom(state, memberId, view);
  const widths = widthsRoom(state);
  // A thing at its bytes in the measures, a creature with its numbers and rev at their widest, and what the far line
  // counts of it beyond them (FAR_WIDTHS), which the stepped part's widths hold and the exact part counts its own way.
  const measured = (kind: CopiedKind, id: string, stored: unknown) => entityBytes(id, stored) + (kind === "token" ? tokenNumbering(stored as Token) : 0);
  const entity = (kind: CopiedKind, id: string, stored: unknown, copy: unknown, on: ExactPlace, beyond = 0): ExactCopy => {
    const part = exactBytes(kind, stored, measured(kind, id, stored), copy, entityBytes(id, copy), room);
    return { on, ...part, sub: part.sub + beyond };
  };
  const creature = (token: Token, copy: unknown) => entity("token", token.id, walkless(token), walkless(copy), atFloor(token.sceneId), widthsOf(FAR_WIDTHS.token, token as unknown as Record<string, unknown>, widths));
  const own = ownHeld(state, memberId, view, new Set(Object.keys(state.scenes)));
  for (const [id, copy] of own.token) out.set(keys.token(id), creature(state.tokens[id]!, copy));
  // Every creature their copy holds while the room lets them move any, or change any one's HP, and the characters those
  // play, whose actor the change writes.
  if (movesAnyToken(state.meta.settings, memberId) || state.meta.settings.playersApplyDamage) {
    for (const token of Object.values(state.tokens)) {
      const copy = own.token.has(token.id) ? null : view.copy("token", token.id);
      if (copy === null) continue;
      out.set(keys.token(token.id), creature(token, copy));
      if (state.meta.settings.playersApplyDamage && "ref" in token.actor) characters.add(token.actor.ref);
    }
  }
  // An area on a creature out of their sight counts at its widest in every scene's reading, wherever it is stored, so
  // neither a floor it moves to nor the DM's edit unseen moves the exact part (D-261119-021). A ruler never changes.
  for (const [id, copy] of own.template) {
    const area = state.templates[id]!;
    const beyond = widthsOf(FAR_WIDTHS.template, area as unknown as Record<string, unknown>, widths);
    if (!own.unseenAreas.has(id)) out.set(keys.template(id), entity("template", id, area, copy, atFloor(area.sceneId), beyond));
    else {
      const shown = fieldBytes(id) + AREA_MOST + 1;
      out.set(keys.template(id), { on: atFloor(area.sceneId), shownOn: AT_ROOM, sub: Math.min(measured("template", id, area), shown) + beyond, shown, hidden: 0 });
    }
  }
  for (const [id, copy] of own.drawing) out.set(keys.drawing(id), entity("drawing", id, state.drawings[id], copy, atFloor(state.drawings[id]!.sceneId)));
  // A row is an entry of the fight's list, with its comma, and has no key of its own: it goes by `row:` and its id.
  const rows = new Map((state.encounter?.entries ?? []).map((e) => [e.id, e]));
  for (const [id, copy] of own.row) {
    const row = rows.get(id)!;
    const part = exactBytes("row", row, valueBytes(row) + 1, copy, valueBytes(copy) + 1, room);
    out.set(`row:${id}`, { on: AT_ROOM, ...part, sub: part.sub + Math.max(0, fieldBytes("tieOrder") + TIE_ORDER_MOST + 1 - memberBytes("tieOrder", row.tieOrder)) });
  }
  for (const [id, copy] of own.cast) out.set(keys.cast(id), entity("cast", id, state.casts[id], copy, AT_ROOM));
  for (const [id, copy] of own.companionBlock) out.set(keys.companionBlock(id), entity("companionBlock", id, state.companionBlocks[id], copy, AT_BLOCKS));
  const copied = (kind: "member" | "character" | "roll", id: string, stored: unknown, beyond = 0) => {
    const copy = view.copy(kind, id);
    if (copy !== null) out.set(keys[kind](id), entity(kind, id, stored, copy, AT_ROOM, beyond));
  };
  copied("member", memberId, state.members[memberId]);
  for (const id of characters) {
    const c = state.characters[id];
    if (c) copied("character", id, c, widths.damage ? characterDamageWidths(c) : 0);
  }
  for (const [id, roll] of Object.entries(state.rolls)) copied("roll", id, roll);
  for (const [line, copy] of linesHeld(state, memberId, view)) out.set(keys.log(line.id), { on: AT_ROOM, ...exactBytes("log", line, valueBytes(line) + 1, copy, valueBytes(copy) + 1, room) });
  // The doors their copy holds, which they open, close and find: only those fields of the build's chunks.
  for (const [key, chunk] of Object.entries(state.buildChunks)) {
    if (!view.holds(chunk.sceneId)) continue;
    const copy = view.copy("chunk", key);
    if (copy === null || !holdsDoor(copy as Record<string, unknown>)) continue;
    out.set(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy), { on: atFloor(chunk.sceneId), ...fieldsOnly("chunk", chunk, copy, room) });
  }
  return out;
}

/**
 * How many exact parts the far line built for a player's op (exactOver):
 * one for each side of it, on every op that meets the line, whatever the
 * room holds. A test reads it to hold that count alike in twin rooms
 * (sizeGuard.timing.test.ts).
 */
export const exactBuilds = { count: 0 };

/**
 * How many stepped parts the far check has read exactly (farReadings): the
 * room's and each scene's, on each side of a player's op. A test reads it
 * to hold that count alike in twin rooms (sizeGuard.timing.test.ts).
 */
export const exactReads = { count: 0 };

/** Whether a state stores the thing a key in an exact part names (exactCopies). */
function storedIn(state: RoomState, key: EntityKey): boolean {
  if (key.startsWith("row:")) return state.encounter?.entries.some((e) => e.id === key.slice("row:".length)) ?? false;
  if (key.startsWith("log:")) return logIds(state.log).has(key.slice("log:".length));
  return readEntity(state, key) !== null;
}

const logIdsKept = new WeakMap<readonly LogEntry[], ReadonlySet<string>>();

function logIds(log: readonly LogEntry[]): ReadonlySet<string> {
  let ids = logIdsKept.get(log);
  if (!ids) {
    ids = new Set(log.map((line) => line.id));
    if (!isWritable(log)) logIdsKept.set(log, ids);
  }
  return ids;
}

/** Where a state stores the thing a key names, a floor for a creature, an area, a drawing or a chunk, or undefined. */
function storedOn(state: RoomState, key: EntityKey): string | undefined {
  const thing = key.startsWith("row:") ? undefined : (readEntity(state, key) as { sceneId?: unknown } | null);
  return typeof thing?.sceneId === "string" ? thing.sceneId : undefined;
}

/**
 * A player's exact part before and after their op over one membership
 * (D-261121-060, 121): what their exact part held before, and what the op
 * made that their copy holds after. A thing of it the copy holds after
 * counts as the copy holds it, one the copy no longer holds but the room
 * still stores counts as it did before, where it is stored now, its stored
 * change in the stepped part, and one no longer stored counts nothing. A
 * thing that enters the copy without the op making it, as a creature
 * coming into view, stays in the stepped part on both sides. So both sides
 * read only the copy before and after and constants, and the stepped
 * sides differ between twins only by hidden bytes, read rounded. Both
 * copies are built on every op (exactBuilds), with no reuse across ops.
 */
export function exactOver(before: RoomState | undefined, after: RoomState, memberId: string): { before: Map<EntityKey, ExactCopy>; after: Map<EntityKey, ExactCopy> } {
  exactBuilds.count++;
  const now = exactCopies(after, memberId);
  if (before === undefined) return { before: new Map(), after: now };
  exactBuilds.count++;
  const was = exactCopies(before, memberId);
  const out = new Map<EntityKey, ExactCopy>();
  for (const [key, part] of was) {
    const held = now.get(key);
    if (held) out.set(key, held);
    else if (storedIn(after, key)) out.set(key, { ...part, on: part.on.kind === "floor" ? atFloor(storedOn(after, key) ?? part.on.id) : part.on });
  }
  for (const [key, part] of now) if (!was.has(key) && !storedIn(before, key)) out.set(key, part);
  return { before: was, after: out };
}

/** A far reading's two parts before its step: the stepped part with its reserves, and the exact part. */
export type FarParts = { stepped: number; exact: number };

/**
 * Where a far reading is read: the room, or a scene by its main floor. The
 * two are apart by kind, never by id, since a scene's id may be any word,
 * "room" among them.
 */
export type FarScope = { readonly kind: "room" } | { readonly kind: "scene"; readonly main: string };

/** A far reading of one scope before and after an op (farReadings). */
export type ScopeReading = { readonly scope: FarScope; readonly before?: FarParts; readonly after: FarParts };

/** Whether two scopes are one. */
export function sameScope(a: FarScope, b: FarScope): boolean {
  return a.kind === "room" ? b.kind === "room" : b.kind === "scene" && a.main === b.main;
}

/** The reading of `scope` among `readings`, if it holds one. */
export function readingAt(readings: readonly ScopeReading[], scope: FarScope): ScopeReading | undefined {
  return readings.find((reading) => sameScope(reading.scope, scope));
}

/**
 * A player's far readings of the room and of each scene by its main floor,
 * exactly, before and after their op over one membership (exactOver), at
 * the widest per-player reserves unless `widest` is false: what the far
 * check reads (SizeGuard #farPlayer). Each stepped part is read exactly on
 * both sides, the room's from the sizes kept per entity (exactMeasure) and
 * every scene's from one pass over the state a side (floorParts), each
 * scene's floors as sceneGroups gives them. A scene the room did not hold
 * before, or any scope with no state before, has no reading before.
 */
export function farReadings(before: RoomState | undefined, after: RoomState, memberId: string, widest = true): ScopeReading[] {
  const parts = exactOver(before, after, memberId);
  const [was, now] = [copyBytesOf(parts.before), copyBytesOf(parts.after)];
  const room = (state: RoomState, own: OwnCopyBytes): FarParts => {
    const held = heldIn(state, own);
    return { stepped: exactMeasure(state) - held.sub + farReserves(state, widest), exact: held.shown };
  };
  const sceneAfter = sceneReader(after, now);
  const sceneBefore = before === undefined ? undefined : sceneReader(before, was);
  const groupsBefore = new Map((before === undefined ? [] : sceneGroups(before)).map((floors) => [floors[0]!.floor?.of ?? floors[0]!.id, floors]));
  const out: ScopeReading[] = [{ scope: { kind: "room" }, ...(before ? { before: room(before, was) } : {}), after: room(after, now) }];
  for (const floors of sceneGroups(after)) {
    const main = floors[0]!.floor?.of ?? floors[0]!.id;
    const floorsBefore = groupsBefore.get(main);
    out.push({ scope: { kind: "scene", main }, ...(sceneBefore && floorsBefore ? { before: sceneBefore(main, floorsBefore) } : {}), after: sceneAfter(main, floors) });
  }
  return out;
}

/**
 * One side's scene readings (farReadings): a scene's is what every scene
 * counts once and its floors' parts (floorParts), with its main floor's
 * drop headroom, less the player's exact part at the room level and on
 * those floors. Each read counts in exactReads.
 */
function sceneReader(state: RoomState, own: OwnCopyBytes): (main: string, floors: readonly Scene[]) => FarParts {
  const parts = floorParts(state);
  return (main, floors) => {
    exactReads.count++;
    const drop = parts.drops.get(main);
    let stepped = parts.shared + (drop ? drop.creatures + drop.areas : 0) - own.roomLevel.sub;
    let exact = own.roomLevel.shown;
    for (const floor of floors) {
      const held = own.floors.get(floor.id);
      stepped += (parts.floors.get(floor.id) ?? 0) - (held?.sub ?? 0);
      exact += held?.shown ?? 0;
    }
    return { stepped, exact };
  };
}

/** What a scene's far reading counts but a player's exact part: once for every scene, on each floor, and by main floor. */
type FloorParts = { readonly shared: number; readonly floors: ReadonlyMap<string, number>; readonly drops: ReadonlyMap<string, DropHeadroom> };

/**
 * Every scene's far reading but a player's exact part, read in one pass
 * over the state: once for any scene the shell, the room-level part with
 * its widths (farWidthsRoomLevel) and the commas of the room-level
 * collections (roomLevelCommas), on each floor its own part
 * (allScenesOwnBytes), its sight, explored and map reserves, its widths
 * less the turn's walks and its pit's creatures (farWidths) and its
 * commas (floorCommas), and each drop scene's headroom by its main floor
 * (dropHeadrooms). A scene's floors summed read what projectedSceneBytes
 * and farWidths read on them, and reading every scene costs about one walk
 * of the room, as the room's reading does, however many scenes it holds.
 */
function floorParts(state: RoomState): FloorParts {
  const owns = allScenesOwnBytes(state);
  const widths = farWidthsByFloor(state);
  const walks = turnWalks(state).byFloor;
  const pits = pitChunksByFloor(state.traps ?? {});
  const commas = floorCommas(state);
  const explored = new Set(reservedExploreFloors(state));
  const floors = new Map<string, number>();
  for (const scene of Object.values(state.scenes)) {
    const reserves = sightReserve(scene) + perPlayerSceneReserve(state, scene) + (explored.has(scene.id) ? exploredReserve(state, scene.id) : 0) + discoveryReserve(state, scene, MEMORY_CAP);
    const far = (widths.get(scene.id) ?? 0) - (walks.get(scene.id) ?? 0) - (pits.has(scene.id) ? PIT_TOKENS_RESERVE : 0);
    floors.set(scene.id, (owns.get(scene.id) ?? 0) + reserves + far + (commas.get(scene.id) ?? 0));
  }
  return { shared: SHELL_BYTES + roomLevelBytes(state) + farWidthsRoomLevel(state) + roomLevelCommas(state, false), floors, drops: dropHeadrooms(state) };
}

/** farReadings with a state before, as the twin tests read it. */
export function playerReadings(before: RoomState, after: RoomState, memberId: string, widest = true): ScopeReading[] {
  return farReadings(before, after, memberId, widest);
}

/**
 * The room's measure read exactly, as measuredStateBytes counts it, from
 * the sizes kept per entity and per collection (storedBytes), so it costs
 * about what the op wrote. Each read counts in exactReads.
 */
function exactMeasure(state: RoomState): number {
  exactReads.count++;
  return measuredFromStored(storedBytes(state), state);
}

/**
 * One for each collection the exact part draws from that holds anything,
 * in the reading's scope. An entity's comma in its collection counts once
 * the collection holds another, so the stepped part keeps one comma for
 * each such collection, whoever's its entities are, and a player's first
 * add to an empty one never moves it. A floor of a scene counts a comma
 * for every entry (commasOf), so it keeps none.
 */
function collectionCommas(state: RoomState, floors?: ReadonlySet<string>): number {
  if (!floors) return nonEmpty(Object.keys(state.tokens).length) + nonEmpty(Object.keys(state.templates).length) + nonEmpty(Object.keys(state.drawings).length) + roomLevelCommas(state, true);
  const byFloor = floorCommas(state);
  let commas = roomLevelCommas(state, false);
  for (const id of floors) commas += byFloor.get(id) ?? 0;
  return commas;
}

const nonEmpty = (n: number) => (n > 0 ? 1 : 0);

/** collectionCommas of the room-level collections, with the companion blocks in the room's reading alone, which alone counts them. */
function roomLevelCommas(state: RoomState, room: boolean): number {
  return (
    nonEmpty(Object.keys(state.members).length) +
    nonEmpty(Object.keys(state.characters).length) +
    nonEmpty(Object.keys(state.rolls).length) +
    nonEmpty(Object.keys(state.casts).length) +
    nonEmpty(measuredLog(state.log).length) +
    nonEmpty(state.encounter?.entries.length ?? 0) +
    (room ? nonEmpty(Object.keys(state.companionBlocks).length) : 0)
  );
}

/**
 * collectionCommas on each floor, in one pass over each collection: one
 * for each of the creatures, the areas and the drawings that holds
 * anything there, on a scene without floors. A floor of a scene keeps none.
 */
function floorCommas(state: RoomState): Map<string, number> {
  const out = new Map<string, number>();
  for (const things of [state.tokens, state.templates, state.drawings]) {
    const on = new Set<string>();
    for (const thing of Object.values(things)) on.add(thing.sceneId);
    for (const id of on) if (state.scenes[id] && state.scenes[id].floor === undefined) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** The exact part of a player's far reading (ownCopyBytes): on the floors of `sceneIds` with the room-level part each scene's reading counts, or the room's whole. */
export function ownHeldBytes(state: RoomState, memberId: string, sceneIds?: readonly string[], own: OwnCopyBytes = ownCopyBytes(state, memberId)): ExactBytes {
  if (!sceneIds) return heldIn(state, own);
  const floors = new Set<string>();
  for (const id of sceneIds) for (const floor of floorsOf(state, id)) floors.add(floor.id);
  return heldIn(state, own, floors);
}

/** An exact part's bytes in the room's reading, or on `floors` with the room-level part each scene's reading counts. */
function heldIn(state: RoomState, own: OwnCopyBytes, floors?: ReadonlySet<string>): ExactBytes {
  const parts: ExactBytes[] = [own.roomLevel];
  if (!floors) parts.push(own.blocks, ...own.floors.values());
  else for (const id of floors) parts.push(own.floors.get(id) ?? { sub: 0, shown: 0 });
  return { sub: sum(parts, (p) => p.sub) - collectionCommas(state, floors), shown: sum(parts, (p) => p.shown) };
}

/**
 * The companion blocks of characters a player owns, which the DM's near
 * part of the room leaves out (dmRoomBytes), so players' blocks never take
 * the DM's room. The far reading counts them with the rest.
 */
export function playerBlockBytes(state: RoomState): number {
  let bytes = 0;
  for (const [id, block] of Object.entries(state.companionBlocks)) {
    const character = state.characters[block.characterId];
    if (character && character.ownerIds.some((m) => state.members[m]?.kind === "player")) bytes += entityBytes(id, block);
  }
  return bytes;
}

/**
 * The room far line's reading of a state (shared/limits.ts FAR): all but
 * what seats hold, players' companion blocks included, with its reserves
 * rounded up to FAR.byteStep, plus what seats hold exactly. `widest` holds
 * per-player vision's reserves at their widest, a player's op's and a DM
 * op's that raises them. The marked pool counts whole against this line
 * alone, and the walk pool in place of the turn's walks (walkPool). A
 * player's reading passes their own exact part as `held` (ownHeldBytes).
 */
export function farRoomBytes(state: RoomState, widest: boolean, measured: number = measuredStateBytes(state), held: number | ExactBytes = heldBytes(state, undefined, true)): number {
  const reserves = farReserves(state, widest);
  const { sub, shown } = typeof held === "number" ? { sub: held, shown: held } : held;
  return farReading(measured - sub + reserves, shown);
}

/**
 * What the room's far reading counts beyond the measure: the widths, the
 * walk pool in place of the turn's walks, the explored ground and players'
 * memory still to come, the marked pool, and at the widest per-player
 * vision's layers and lists, the turn's walks' lists aside, which the pool
 * holds at the roster's widest.
 */
function farReserves(state: RoomState, widest: boolean): number {
  const reserves = farWidths(state) + exploredReserve(state) + memoryReserves(state).whole + (marked(state) ? MARKED_POOL : 0);
  if (!widest) return reserves;
  const pooled = turnWalks(state).lists * (widestPlayersListExtra(state.members) - widestListExtra(state.members));
  return reserves + Math.max(0, widestPerPlayerReserve(state) - perPlayerStoredReserve(state) - pooled);
}

/** By how many bytes a state is past the room far line at its widest, or 0 under it: the DM's snapshot's `over`. */
export function overFarLine(state: RoomState): number {
  return Math.max(0, farRoomBytes(state, true) - FAR.roomBytes);
}
