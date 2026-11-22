import { FAR, HISTORY_BYTES, LIMITS, MARKED_POOL, MOST_SIGHT_HOLDERS, exploredReserve, roundUp, seatHeld, serializedBytes } from "#shared/limits.ts";
import { holderTileKey, tileKey } from "#shared/keys.ts";
import { DM_LINE_BASE, MAX_LOG, PARTY_LINE_BASE, PARTY_SLOT, memberRing, ringed, rosterRanks } from "#shared/logRings.ts";
import { SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { CompanionBlock, DiceRoll, Effect, EncounterSnapshot, InitEntry, LogEntry, Member, RemindedPairs, RoomSettings, RoomState, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { MAX_CHAT, MAX_EFFECT_LEVEL, MAX_NAME, MAX_NOTES, MAX_PATH_CORNERS, MAX_PATH_STOPS } from "#shared/protocol.ts";
import { encodeTile, fullTileBits } from "#shared/rules/fog.ts";
import { EFFECTS_PER_CLASS } from "#shared/rules/effects.ts";
import { ZERO_HP_UNCONSCIOUS_ID } from "#shared/rules/hp.ts";
import { SAVE_OUTCOME_LEDGER_BYTES, SAVE_OUTCOME_RECORD_BYTES, SAVE_OUTCOME_RECORDS, type SaveOutcomeLedger, type SaveOutcomeRecord } from "#shared/saveOutcomeContract.ts";
import { actor, castAsk, character, companionBlock, drawing, entry, room, scene, token } from "#shared/testutil.ts";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "./exportRoom.ts";
import { remapState } from "./remap.ts";
import { floorsOf } from "#shared/rules/floors.ts";
import { farRoomBytes, measuredLog, measuredStateBytes, memoryReserves, memoryShare, projectedSceneBytes, turnWalks, walkPool } from "./sizeGuard.ts";

/*
 * The full fixture of the player limits' bounds (design section 8): a room
 * at the far lines with every ring full and a full roster, from which the
 * stored, snapshot and import bounds are measured rather than assumed. It
 * writes the state straight, never through ops, since the far counts lie
 * past what one room's ops reach today. Every part outside the measures is
 * filled to its own byte bound, so what the room stores is the most any
 * room at the line stores.
 */

/** A 64-character id, the longest the schema takes, unique per tag and index. */
export function longId(tag: string, i: number): string {
  return `${tag}-${i}-`.padEnd(64, "0");
}

/**
 * A 64-character id at its most bytes: JSON writes a control character as
 * six, so an id an old device minted can take 384 bytes. The parts outside
 * the measures bound their bytes, and only ids like these reach those
 * bounds before their counts.
 */
export function widestId(tag: string, i: number): string {
  return `${tag}-${i}-`.padEnd(64, "\u0001");
}

/** A member id as the server mints them: a version 7 UUID, in roster order. */
export function memberIdAt(i: number): string {
  return `0190f000-0000-7000-8000-${String(i).padStart(12, "0")}`;
}

const AT = "2026-11-10T20:00:00.000Z";
/** Text of three-byte letters, so a text at its character cap is at its widest in bytes. */
const wide = (chars: number) => "€".repeat(chars);

export type FullRoom = {
  state: RoomState;
  /** The players' scene, at the scene far line. */
  sceneId: string;
  dms: string[];
  players: string[];
};

export type FullRoomOptions = {
  /** Members on the roster, two of them DMs. 50 unless set. */
  members?: number;
  /** The room line companion blocks fill the room to, with its reserves, or that line as the filled room's own facts set it. */
  roomBytes?: number | ((state: RoomState) => number);
  /** The scene line drawings fill the players' scene to. */
  sceneBytes?: number;
  /** Whether a fight runs, its history at its bound and nine walks at their widest on its turn. Yes unless set. */
  fight?: boolean;
  /**
   * The room's settings while it fills, as the DM's change of one meets
   * the DM's line: Players apply damage counts widths on every creature
   * and character, so a room filled with it off may hold no room to turn
   * it on.
   */
  settings?: Partial<RoomSettings>;
  /**
   * Who wrote the shared log's lines: each a player's roll in turn (the
   * default), every one the first player's, or each the DM's HP change on
   * a creature every player sees.
   */
  lines?: "spread" | "one" | "hp";
};

function roster(count: number): { members: Record<string, Member>; dms: string[]; players: string[] } {
  const members: Record<string, Member> = {};
  const dms: string[] = [];
  const players: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = memberIdAt(i);
    const kind = i < 2 ? "dm" : "player";
    (kind === "dm" ? dms : players).push(id);
    members[id] = { id, rev: 0, name: wide(MAX_NAME), color: "#ff8800", kind, createdAt: AT };
  }
  return { members, dms, players };
}

/**
 * The room at the far lines: one scene at the scene line holding the far
 * tokens, the far rows, asks and open rolls with every answer, the fight's
 * history at its byte bound and nine walks at their widest on its turn
 * (or no fight), the shared log at 200 of its longest lines, every ring
 * outside the measures full, and companion blocks filling the room to its
 * line. The roster is full, so every reserve sized by it is at its widest.
 */
export function fullRoom(opts: FullRoomOptions = {}): FullRoom {
  const { members, dms, players } = roster(opts.members ?? LIMITS.membersPerRoom);
  const sceneId = longId("scene", 0);
  const state = room({
    meta: { ...room().meta, name: wide(MAX_NAME), playerSceneId: sceneId, settings: { ...room().meta.settings, ...opts.settings } },
    members,
    scenes: { [sceneId]: scene(sceneId, { name: wide(MAX_NAME), bounds: { w: LIMITS.sceneCells, h: LIMITS.sceneCells } }) },
  });
  addCharacters(state, players);
  addTokens(state, sceneId);
  if (opts.fight !== false) {
    addFight(state, sceneId);
    addWalks(state);
  }
  addAsks(state, sceneId);
  addRolls(state);
  addLog(state, dms, players, opts.lines ?? "spread");
  addReminded(state, players);
  addSaveOutcomes(state);
  if (opts.fight !== false) addHistory(state);
  fillScene(state, sceneId, players, opts.sceneBytes ?? FAR.sceneBytes);
  const roomBytes = typeof opts.roomBytes === "function" ? opts.roomBytes(state) : (opts.roomBytes ?? FAR.roomBytes);
  trimScene(state, roomBytes);
  fillBlocks(state, roomBytes);
  return { state, sceneId, dms, players };
}

/** Every character the room may hold, each a player's. */
function addCharacters(state: RoomState, players: readonly string[]): void {
  for (let i = 0; i < LIMITS.charactersPerRoom; i++) {
    const id = longId("char", i);
    state.characters[id] = character(id, { ownerIds: [players[i % players.length]!], name: wide(MAX_NAME), actor: actor({ dmNotes: "" }) });
  }
}

/** The far tokens on one scene: each character's, then the DM's creatures, every other one hidden. */
function addTokens(state: RoomState, sceneId: string): void {
  const characters = Object.keys(state.characters);
  for (let i = 0; i < FAR.tokens; i++) {
    const id = longId("tok", i);
    const at = { sceneId, name: "Goblin", x: i % LIMITS.sceneCells, y: Math.floor(i / LIMITS.sceneCells) };
    const pc = characters[i];
    const t: Token = pc
      ? token(id, { ...at, kind: "pc", ownerIds: [], actor: { ref: pc } })
      : token(id, { ...at, visibility: i % 2 === 0 ? "dm" : "all", actor: { inline: actor({ notes: "", dmNotes: "" }) } });
    state.tokens[id] = t;
  }
}

/** The far rows, one for each token and then rows of their own. */
function addFight(state: RoomState, sceneId: string): void {
  const tokens = Object.keys(state.tokens);
  const entries: InitEntry[] = [];
  for (let i = 0; i < FAR.rows; i++) {
    const tokenId = tokens[i];
    entries.push(entry(longId("row", i), tokenId ? { tokenId } : { label: "Lair" }));
  }
  const first = entries[0]!;
  const t = state.tokens[first.tokenId!]!;
  state.encounter = { rev: 0, round: 1, activeEntryId: first.id, entries, turnStart: { entryId: first.id, tokenId: t.id, sceneId, x: t.x, y: t.y, elevation: 0 } };
  // The rows stop where the far count does: the DM's own rows, last, are cut to the step beside the players' held ones.
  state.encounter.entries = entries.slice(0, atFarCount(FAR.rows, seatHeld(state, null).rows.size));
}

/**
 * Nine walks at their widest on the turn under way, as the walk pool holds
 * them (server/rooms/sizeGuard.ts walkPool): the turn's creature's and
 * eight mounts' sharing its turn, each of MAX_PATH_STOPS stops at their
 * widest, every list of who saw a stop naming six of the roster, and a
 * whole walk's corners on its first stop.
 */
function addWalks(state: RoomState): void {
  const fight = state.encounter!;
  const rider = fight.turnStart!.tokenId!;
  const mounts = Object.keys(state.tokens).filter((id) => id !== rider).slice(0, LIMITS.turnMounts);
  const seq = 7;
  fight.turnStart = { ...fight.turnStart!, seq, mounts };
  const seenBy = Object.keys(state.members).slice(0, MOST_SIGHT_HOLDERS);
  const feet = 999_999.9999999999;
  const stop = (i: number) => ({
    x: WIDE_COORD,
    y: WIDE_COORD,
    elevation: -100_000,
    uncounted: true as const,
    seen: true as const,
    seenBy,
    joinedUnseen: true as const,
    footprint: { w: 19.999999999999996, h: 19.999999999999996, squeeze: true as const },
    ...(i === 0 ? { via: Array.from({ length: 2 * MAX_PATH_CORNERS }, () => WIDE_COORD) } : {}),
    moved: feet,
    cost: feet,
    diag: [feet, feet] as [number, number],
    routeSeen: true as const,
    carried: true as const,
  });
  const path = { turn: seq, prior: { moved: feet, cost: feet, diag: [feet, feet] as [number, number], seenDiag: [feet, feet] as [number, number] }, stops: Array.from({ length: MAX_PATH_STOPS }, (_, i) => stop(i)) };
  for (const id of [rider, ...mounts]) state.tokens[id] = { ...state.tokens[id]!, path };
}

/** The most things the far count takes beside `held` of the players': the DM's part in whole steps (shared/limits.ts farLimits). */
function atFarCount(line: number, held: number): number {
  return held + Math.floor((line - held) / FAR.countStep) * FAR.countStep;
}

/**
 * The fight's 20 history steps within its byte budget: steps from earlier
 * in the fight, each holding the rows it had then, as many as keep 20
 * steps inside the budget. Every reading counts the history as empty, so
 * no line takes it from the room's content (D-261121-066).
 */
function addHistory(state: RoomState): void {
  const fight = state.encounter!;
  const budget = HISTORY_BYTES;
  const stepOf = (rows: number): EncounterSnapshot => ({ encounter: { ...fight, entries: fight.entries.slice(0, rows) }, effects: {}, revealed: [], at: AT });
  let rows = fight.entries.length;
  while (rows > 1 && serializedBytes(Array.from({ length: 20 }, () => stepOf(rows))) > budget) rows = Math.floor(rows * 0.95);
  state.encounterHistory = Array.from({ length: 20 }, () => stepOf(rows));
}

/**
 * The asks at their far line as its check reads them: each by its caster's
 * owner, as many as the far count takes, the DM's part in its steps of 50
 * beside the players' held asks.
 */
function addAsks(state: RoomState, sceneId: string): void {
  const pcs = Object.values(state.tokens).filter((t) => t.kind === "pc");
  const ids: string[] = [];
  for (let i = 0; i < FAR.asks; i++) {
    const id = longId("ask", i);
    const caster = pcs[i % pcs.length]!;
    const by = "ref" in caster.actor ? state.characters[caster.actor.ref]!.ownerIds[0]! : "";
    state.casts[id] = castAsk(id, { by, caster: caster.id, sceneId, spell: "Fireball", area: undefined, targets: [caster.id], at: AT });
    ids.push(id);
  }
  const held = seatHeld(state, null).casts;
  const rest = ids.filter((id) => !held.has(id));
  for (const id of rest.slice(atFarCount(FAR.asks, held.size) - held.size)) delete state.casts[id];
}

/** The open rolls a room may hold, each with every target answered. */
function addRolls(state: RoomState): void {
  const tokens = Object.keys(state.tokens);
  for (let r = 0; r < LIMITS.openRollsPerRoom; r++) {
    const id = longId("roll", r);
    const targets = Array.from({ length: LIMITS.rollTargets }, (_, i) => ({ tokenId: tokens[(r * LIMITS.rollTargets + i) % tokens.length]!, total: LIMITS.rollTotalMax, result: "pass" as const }));
    state.rolls[id] = { id, rev: 0, test: { kind: "save", choices: [{ ability: "dex" }] }, dc: 15, dcShown: false, resultShown: false, note: wide(MAX_NAME), at: AT, targets };
  }
}

/** A dice line's rolls at the widest a roll op writes: `rolls` rolls sharing its `dice`, each with its longest label and formula. */
function widestRolls(tokenId: string, rolls: number, dice: number): DiceRoll[] {
  return Array.from({ length: rolls }, (_, i) => ({
    formula: wide(LIMITS.diceFormulaChars),
    faces: Array.from({ length: Math.floor(dice / rolls) + (i < dice % rolls ? 1 : 0) }, () => LIMITS.diceSidesMax),
    total: -200_000,
    label: wide(LIMITS.diceLabelChars),
    tokenId,
  }));
}

/** Lines of `make(text)` whose bytes together come to the most `bytes` holds, at most `lines` of them. */
function filling(bytes: number, lines: number, make: (text: string) => LogEntry): LogEntry[] {
  const out: LogEntry[] = [];
  let left = bytes;
  while (out.length < lines && serializedBytes(make("")) <= left) {
    let lo = 0;
    let hi = MAX_CHAT;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (serializedBytes(make(wide(mid))) <= left) lo = mid;
      else hi = mid - 1;
    }
    const line = make(wide(lo));
    out.push(line);
    left -= serializedBytes(line);
  }
  return out;
}

/**
 * The log at every ring: 200 shared lines of the longest roll line, the
 * DM's lines at their count and each at the cut's bytes, each player's
 * party copies and each member's whispers filled to their ring's bytes. A
 * whisper from a member who left counts in its one reader's ring alone.
 * The DM's lines and the DMs' whispers, side by side, follow the oldest
 * shared line, so a DM's live log, which starts where the later of their
 * own rings fills, holds nearly every line the room keeps.
 */
function addLog(state: RoomState, dms: readonly string[], players: readonly string[], lines: NonNullable<FullRoomOptions["lines"]>): void {
  const log: LogEntry[] = [];
  let seq = 1;
  const tokenId = Object.keys(state.tokens)[0]!;
  // A creature every player sees: past the characters' own, every other one is shown.
  const seen = Object.keys(state.tokens)[LIMITS.charactersPerRoom + 1]!;
  const vitals = { hp: { cur: 5, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } };
  const hp = (): LogEntry =>
    ({ id: `${seq++}:0`, at: AT, kind: "event", data: { type: "hp", change: "damage", amount: 3, label: "Bloodied", left: vitals.hp, revert: { before: vitals, after: vitals, added: [], removed: [] }, tokenId: seen, seen: true } }) as never;
  const shared = (): LogEntry =>
    lines === "hp" ? hp() : { id: `${seq++}:0`, at: AT, kind: "event", data: { type: "dice", by: lines === "one" ? players[0]! : players[seq % players.length]!, to: "all", rolls: widestRolls(tokenId, LIMITS.diceRollsPerOp, LIMITS.dicePerOp) } };
  log.push(shared());
  const dmLine = (id: string, rolls: number): LogEntry => ({ id, at: AT, kind: "event", data: { type: "dice", by: dms[0]!, to: "dm", rolls: widestRolls(tokenId, rolls, LIMITS.dicePerOp) } });
  const dmLineAt = (at: number): LogEntry => {
    const id = `${at}:${DM_LINE_BASE}`;
    let rolls = LIMITS.diceRollsPerOp;
    while (rolls > 1 && serializedBytes(dmLine(id, rolls)) > LIMITS.apartLineBytes) rolls--;
    return dmLine(id, rolls);
  };
  const size = Object.keys(state.members).length;
  const whisper = memberRing("whisper", size);
  const whispers = (reader: string, k: number) => filling(whisper.bytes, whisper.lines, (text) => ({ id: `${seq++}:0`, at: AT, kind: "whisper", from: memberIdAt(1_000 + k), to: [reader], text }));
  const dmLines = [dmLineAt(seq++)];
  log.push(dmLines[0]!);
  for (const [k, dm] of dms.entries()) log.push(...whispers(dm, k));
  while (dmLines.length < LIMITS.dmLogLines) {
    const line = dmLineAt(seq++);
    dmLines.push(line);
    log.push(line);
  }
  for (let i = 1; i < MAX_LOG; i++) log.push(shared());
  const ranks = rosterRanks(state.members);
  const party = memberRing("party", size);
  for (const [k, reader] of players.entries()) {
    const copyOf = dmLines[k % dmLines.length]!.id;
    const at = seq++;
    const first = PARTY_LINE_BASE + ranks.get(reader)! * PARTY_SLOT;
    const copies = filling(party.bytes, party.lines, (text) => ({ id: `${at}:${first}`, at: AT, kind: "chat", from: dms[0]!, to: [reader], text, copyOf }));
    copies.forEach((copy, n) => log.push({ ...copy, id: `${at}:${first + n}` }));
  }
  for (const [k, player] of players.entries()) log.push(...whispers(player, dms.length + k));
  state.log = ringed(log, state.members);
}

/** Each audience's record of a turn's reminders at its bytes, its areas named by ids at their widest. */
function addReminded(state: RoomState, players: readonly string[]): void {
  const tokens = Object.keys(state.tokens);
  const pairs = (cap: number, bytes: number, salt: string): RemindedPairs => {
    const out: RemindedPairs = {};
    for (let n = 0; n < cap; n++) {
      const area = widestId(salt, n);
      out[area] = { [tokens[n % tokens.length]!]: 7 };
      if (serializedBytes(out) > bytes) {
        delete out[area];
        break;
      }
    }
    return out;
  };
  state.reminded = {
    shared: pairs(LIMITS.remindedShared, LIMITS.remindedSharedBytes, "s"),
    dm: pairs(LIMITS.remindedDm, LIMITS.remindedDmBytes, "d"),
    players: Object.fromEntries(players.map((p, i) => [p, pairs(LIMITS.remindedPerPlayer, LIMITS.remindedPerPlayerBytes, `p${i}-`)])),
  };
}

/** The group saves' ledger at its bytes, its members named by ids at their widest. */
function addSaveOutcomes(state: RoomState): void {
  const ledger: SaveOutcomeLedger = {};
  for (let i = 0; i < SAVE_OUTCOME_RECORDS; i++) {
    const id = memberIdAt(10_000 + i);
    // The member's id as wide as one record's bytes allow.
    let memberId = widestId("m", i);
    const record = (memberId: string): SaveOutcomeRecord => ({ memberId, plan: memberIdAt(20_000 + i), revision: Number.MAX_SAFE_INTEGER, state: "applied", firstAppliedAt: AT, seq: Number.MAX_SAFE_INTEGER });
    while (serializedBytes(record(memberId)) > SAVE_OUTCOME_RECORD_BYTES) memberId = memberId.replace("\u0001", "0");
    ledger[id] = record(memberId);
    if (serializedBytes(ledger) > SAVE_OUTCOME_LEDGER_BYTES) {
      delete ledger[id];
      break;
    }
  }
  state.saveOutcomes = ledger;
}

/**
 * The DM's measure of the scene with the fight's history and the turn's
 * walks as empty, as the guard's far scene line counts them (sizeGuard.ts
 * farWidths). The fixture's history steps hold no list of who saw, so the
 * measure counts them at their bytes.
 */
export function sceneMeasure(state: RoomState, sceneId: string): number {
  const walks = sum(floorsOf(state, sceneId), (floor) => turnWalks(state).byFloor.get(floor.id) ?? 0);
  return projectedSceneBytes(state, sceneId) - (serializedBytes(state.encounterHistory) - 2) - walks;
}

const sum = <T>(items: readonly T[], of: (item: T) => number) => items.reduce((total, item) => total + of(item), 0);

/** The players' scene filled with players' drawings at their point values' cap until the next would pass the scene line. */
function fillScene(state: RoomState, sceneId: string, players: readonly string[], limit: number): void {
  const points = Array.from({ length: LIMITS.drawingPointValues }, (_, i) => (i * 7) % 1000);
  let left = limit - sceneMeasure(state, sceneId);
  for (let i = 0; ; i++) {
    const id = longId("draw", i);
    const d = drawing(id, { sceneId, ownerId: players[i % players.length]!, points });
    const bytes = serializedBytes({ [id]: d }) - 1;
    if (bytes > left) break;
    state.drawings[id] = d;
    left -= bytes;
  }
}

/**
 * The scene's drawings off, the last first, until the room's far reading
 * is at `limit`: a line under what the room holds without them, such as
 * the DM's where the kept bytes are large, is reached with the scene less
 * full.
 */
function trimScene(state: RoomState, limit: number): void {
  const drawn = Object.keys(state.drawings).filter((id) => id.startsWith("draw-"));
  let over = farRoomBytes(state, true) - limit;
  while (over > 0 && drawn.length > 0) {
    for (let freed = 0; freed < over && drawn.length > 0; ) {
      const id = drawn.pop()!;
      freed += serializedBytes({ [id]: state.drawings[id] }) - 1;
      delete state.drawings[id];
    }
    state.drawings = { ...state.drawings };
    over = farRoomBytes(state, true) - limit;
  }
}

/** The room as its line measures it: the state with its explored and memory reserves. */
export function roomMeasure(state: RoomState, stateLimit: number = FAR.roomBytes): number {
  const bytes = measuredStateBytes(state);
  const explored = exploredReserve(state);
  const memory = memoryReserves(state);
  return bytes + explored + memory.whole + memory.sharing * memoryShare(stateLimit, bytes, explored, memory);
}

/**
 * Companion blocks of the players' characters, each near its byte cap,
 * until the room's far reading (farRoomBytes, the measure a player's op
 * meets) is at its line or the blocks at theirs. Each character's stay
 * within its own caps.
 */
function fillBlocks(state: RoomState, limit: number): void {
  const characters = Object.keys(state.characters);
  const text = wide(1_200);
  const traits = [1, 2, 3].map(() => ({ name: wide(MAX_NAME), text }));
  let measured = measuredStateBytes(state);
  let blocksLeft = FAR.blockBytes - serializedBytes(state.companionBlocks);
  // As many to a character as its own caps take, then the next character's.
  const perCharacter = Math.min(LIMITS.companionBlocksPerCharacter, Math.floor(LIMITS.companionBlockBytesPerCharacter / serializedBytes(companionBlock(longId("block", 0), characters[0]!, { name: wide(MAX_NAME), traits }))));
  const added: string[] = [];
  for (let i = 0; i < FAR.blocks; i++) {
    const id = longId("block", i);
    const characterId = characters[Math.floor(i / perCharacter) % characters.length]!;
    const block: CompanionBlock = companionBlock(id, characterId, { name: wide(MAX_NAME), traits });
    const bytes = serializedBytes({ [id]: block }) - 1;
    if (bytes > blocksLeft || farRoomBytes(state, true, measured + bytes) > limit) break;
    state.companionBlocks[id] = block;
    added.push(id);
    measured += bytes;
    blocksLeft -= bytes;
  }
  // The running measure counts each block's bytes to within the comma between entries: the exact reading settles the last.
  while (added.length > 0 && farRoomBytes(state, true) > limit) delete state.companionBlocks[added.pop()!];
}

export type Bounds = {
  /** The state as its snapshot row and an export write it. */
  stored: number;
  /** The room far line's reading at its widest (farRoomBytes), the measure a player's op meets. */
  room: number;
  /** The players' scene as the scene line measures it. */
  scene: number;
  /** The log's lines outside the measures: the DM's lines, party copies and whispers. */
  privateLines: number;
  sharedLines: number;
  reminded: number;
  saveOutcomes: number;
  blocks: number;
  history: number;
  /** A DM's snapshot frame of the players' scene. */
  snapshot: number;
  /** `room.json` of the room's export. */
  exportJson: number;
  /** The state after an import's remap, before the importer joins. */
  remapped: number;
};

/** Every bound of the room, measured. */
export function measureBounds(full: FullRoom): Bounds {
  const { state, sceneId } = full;
  const viewer = { memberId: full.dms[0]!, role: "dm" as const };
  const frame = { t: "snapshot", seq: Number.MAX_SAFE_INTEGER, state: projectState(state, viewer, { sceneId }), you: { memberId: viewer.memberId, role: "dm", sceneId }, watermark: Number.MAX_SAFE_INTEGER };
  const exported = { format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, schemaVersion: SNAPSHOT_VERSION, exportedAt: AT, roomId: "ABCDEFGHJK", seq: Number.MAX_SAFE_INTEGER, state, dmMemberIds: full.dms };
  const shared = measuredLog(state.log);
  return {
    stored: serializedBytes(state),
    room: farRoomBytes(state, true),
    scene: sceneMeasure(state, sceneId),
    privateLines: serializedBytes(state.log) - serializedBytes(shared),
    sharedLines: serializedBytes(shared),
    reminded: serializedBytes(state.reminded ?? {}),
    saveOutcomes: serializedBytes(state.saveOutcomes ?? {}),
    blocks: serializedBytes(state.companionBlocks),
    history: serializedBytes(state.encounterHistory),
    snapshot: serializedBytes(frame),
    exportJson: serializedBytes(exported),
    remapped: serializedBytes(remapState(state, { assets: new Map() })),
  };
}

/** A coordinate at its most characters: the schema takes any number from -1,000 to 1,000. */
const WIDE_COORD = -999.9999999999999;

/**
 * The bytes the exempt kinds of the far line (shared/farLine.ts) can add
 * to one creature beyond what it holds when made (design 5.3): its path
 * record at the stored schema's widths, its HP at its widest digits, its
 * use marks at their count and widths, and its conditions at both classes'
 * counts and the automatic one, each at a condition's widths. Each part is
 * measured against the fixture's own creature.
 */
export type CreatureGrowth = { path: number; hp: number; uses: number; effects: number; total: number };

export function creatureGrowth(state: RoomState, holders: readonly string[]): CreatureGrowth {
  const base = Object.values(state.tokens).find((t) => "inline" in t.actor)!;
  const inline = (t: Token) => ("inline" in t.actor ? t.actor.inline : actor());
  const sized = (t: Token) => serializedBytes(t);
  const seenBy = [...holders].sort().slice(0, MOST_SIGHT_HOLDERS);
  const stop = {
    x: WIDE_COORD,
    y: WIDE_COORD,
    elevation: -100_000,
    uncounted: true as const,
    seen: true as const,
    seenBy,
    joinedUnseen: true as const,
    footprint: { w: 19.999999999999996, h: 19.999999999999996, squeeze: true as const },
    via: Array.from({ length: 2 * MAX_PATH_CORNERS }, () => WIDE_COORD),
    moved: 999_999.9999999999,
    cost: 999_999.9999999999,
    diag: [999_999.9999999999, 999_999.9999999999] as [number, number],
    routeSeen: true as const,
    carried: true as const,
  };
  const widePrior = { moved: 999_999.9999999999, cost: 999_999.9999999999, diag: [999_999.9999999999, 999_999.9999999999] as [number, number], seenDiag: [999_999.9999999999, 999_999.9999999999] as [number, number] };
  const withPath: Token = { ...base, path: { turn: Number.MAX_SAFE_INTEGER, prior: widePrior, stops: Array.from({ length: MAX_PATH_STOPS }, () => stop) } };
  const withHp: Token = { ...base, actor: { inline: { ...inline(base), hp: { cur: 100_000, max: 100_000, temp: 100_000 } } } };
  const mark = { kind: "day" as const, name: wide(LIMITS.useNameChars), used: LIMITS.usesPerDay, max: LIMITS.usesPerDay, short: true as const };
  const uses = Object.fromEntries(Array.from({ length: LIMITS.usesPerActor }, (_, i) => [widestId("use", i).slice(0, LIMITS.useKeyChars), mark]));
  const withUses: Token = { ...base, actor: { inline: { ...inline(base), uses } } };
  const effect = (i: number, hidden: boolean): Effect => ({
    id: widestId("effect", i),
    key: "custom",
    label: wide(MAX_NAME),
    glyph: wide(8),
    color: "#ffffffff",
    level: MAX_EFFECT_LEVEL,
    spell: wide(MAX_NAME),
    hiddenFromPlayers: hidden,
    triggerShown: true,
    save: { ability: "wis", dc: LIMITS.rollDcMax, spell: true },
    duration: { remaining: 100_000, boundary: "turnStart", anchor: { entryId: widestId("row", i) } },
    due: { id: "999999999999999999:999999", state: "dismissed" },
  });
  const effects = [...Array.from({ length: EFFECTS_PER_CLASS }, (_, i) => effect(i, false)), ...Array.from({ length: EFFECTS_PER_CLASS }, (_, i) => effect(EFFECTS_PER_CLASS + i, true)), { id: ZERO_HP_UNCONSCIOUS_ID, key: "unconscious" as const }];
  const withEffects: Token = { ...base, actor: { inline: { ...inline(base), effects } } };
  const growth = { path: sized(withPath) - sized(base), hp: sized(withHp) - sized(base), uses: sized(withUses) - sized(base), effects: sized(withEffects) - sized(base) };
  return { ...growth, total: growth.path + growth.hp + growth.uses + growth.effects };
}

/**
 * Astra's marked room of design 6.4, on scenes of `cells` squares a side:
 * 20 marked per-player scenes, the DM and two players, each scene played
 * with both players holding sight, every layer at its widest, and the DM's
 * journal filling the measured state to the 7,832,678 bytes Astra's room
 * measured. `far` is the far line's read of it, the marked pool and the
 * walk pool whole and every per-player reserve at six players, rounded to
 * its step.
 */
export type MarkedRoom = { state: RoomState; measured: number; sixPlayers: number; far: number; under: boolean };

export function markedRoom(cells: number, measured = 7_832_678): MarkedRoom {
  const dm = memberIdAt(0);
  const players = [memberIdAt(1), memberIdAt(2)];
  const members = Object.fromEntries([dm, ...players].map((id, i) => [id, { id, rev: 0, name: `Member ${i}`, color: "#ff8800", kind: i === 0 ? ("dm" as const) : ("player" as const), createdAt: AT }]));
  const state = room({ members, meta: { ...room().meta, playerSceneId: null } });
  state.scenes = {};
  const bits = encodeTile(fullTileBits());
  const across = Math.ceil(cells / 16);
  for (let k = 0; k < 20; k++) {
    const id = longId("marked", k);
    state.scenes[id] = scene(id, { order: k, bounds: { w: cells, h: cells }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
    state.playedScenes![id] = { sceneId: id, rev: 0 };
    state.memoryShared![id] = { sceneId: id, rev: 0 };
    state.holders[id] = { sceneId: id, rev: 0, entries: players.map((memberId) => ({ memberId, on: true })) };
    for (let ty = 0; ty < across; ty++) {
      for (let tx = 0; tx < across; tx++) {
        state.exploredTiles[tileKey(id, tx, ty)] = { sceneId: id, tx, ty, rev: 0, bits };
        for (const memberId of players) state.exploredBy[holderTileKey(id, memberId, tx, ty)] = { sceneId: id, memberId, tx, ty, rev: 0, bits };
      }
    }
  }
  // The DM's hidden creatures with notes as long as they take, the last one's cut to land on `measured`. Each adds its
  // entry and a comma to the measure, and a note's letters one byte each.
  const sceneIds = Object.keys(state.scenes);
  let bytes = measuredStateBytes(state);
  for (let k = 0; ; k++) {
    const id = longId("note", k);
    const make = (chars: number) => token(id, { sceneId: sceneIds[k % sceneIds.length]!, visibility: "dm", notes: "x".repeat(chars), x: k % cells, y: 0 });
    const entry = serializedBytes({ [id]: make(0) }) - 2 + (k > 0 ? 1 : 0);
    if (bytes + entry > measured) break;
    const chars = Math.min(MAX_NOTES, measured - bytes - entry);
    state.tokens[id] = make(chars);
    bytes += entry + chars;
  }
  const at = measuredStateBytes(state);
  // A full roster's six players, so the per-player reserve reads at its widest, as the far line reads it for a player's op.
  const six = { ...state, members: { ...members, ...Object.fromEntries([3, 4, 5, 6].map((i) => [memberIdAt(i), { ...members[players[0]!]!, id: memberIdAt(i) }])) } };
  const sixPlayers = measuredStateBytes(six) - at;
  const far = roundUp(at + sixPlayers + MARKED_POOL + walkPool(state), FAR.byteStep);
  return { state, measured: at, sixPlayers, far, under: far <= FAR.roomBytes };
}
