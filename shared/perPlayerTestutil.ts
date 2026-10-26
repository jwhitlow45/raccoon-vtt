import { Buffer } from "node:buffer";
import { chunkKey, doorChunk, holderTileKey, tileKey } from "./keys.ts";
import { LIMITS } from "./limits.ts";
import { FOG_SUBCELLS, type Actor, type FogTile, type RoomState, type SightTile, type Token, type Viewer } from "./model.ts";
import type { Op } from "./protocol.ts";
import { orderShown, ownsToken, pageReadableBy, perPlayerScene, pinCells, playerOwned, stampCells } from "./project.ts";
import { visionRules, type PartySight, type SightProbe, type VisionRules } from "./ruleHooks.ts";
import { decodeTile, encodeTile, labelCells, tilesAcross, TILE_CELLS } from "./rules/fog.ts";
import { occupiedCells, type CellRange } from "./rules/footprint.ts";
import { zoneRanges } from "./rules/traps.ts";
import { NO_PARTY_SIGHT, sightFromTiles, sightRect } from "./rules/vision.ts";
import { actor, chance, int, member, pick, randomOp, randomState, token } from "./testutil.ts";

/**
 * Per-player vision's test world (docs/design-v1-per-player-vision.md
 * section 10, lane PV1): stub rules through `visionRules`, a reference
 * explore step, random rooms and ops, and an oracle that works out from
 * nothing what each viewer may be given. Not a test file itself.
 *
 * The stub sees whole cells: each source sees the square of cells around
 * the middle of its footprint, 3 cells out, or in the dark 1, 2 with
 * darkvision. Its sources are vision.ts's rule in small (party members on
 * the scene, shown, alive, awake and not Blinded, the cap's order and
 * number), and a holder's are the shared ones and their own among them. It
 * encodes real sight tiles and reads them back with the real
 * `sightFromTiles`, so the server's answer and a device's agree exactly.
 */

const SUB = FOG_SUBCELLS;
const TILE_SUB = TILE_CELLS * SUB;

function actorOf(state: RoomState, token: Token): Actor | undefined {
  return "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
}

function lends(state: RoomState, token: Token): boolean {
  if (token.partyVision !== true && !playerOwned(state, token)) return false;
  if (token.visibility !== "all") return false;
  if (token.kind === "object" && (token.companion !== undefined || token.partyVision !== true)) return false;
  const actor = actorOf(state, token);
  if (!actor || actor.life !== "alive") return false;
  return !actor.effects.some((e) => e.key === "unconscious" || e.key === "blinded");
}

/** The union's sources on a scene, in the cap's order and number. */
export function lendingSources(state: RoomState, sceneId: string): Token[] {
  const group = (t: Token) => (t.companion ? 3 : playerOwned(state, t) && t.kind === "pc" ? 0 : playerOwned(state, t) ? 1 : 2);
  return Object.values(state.tokens)
    .filter((t) => t.sceneId === sceneId && lends(state, t))
    .sort((a, b) => group(a) - group(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, LIMITS.partySourcesPerScene);
}

/** The sources a viewer's sight reads on a per-player scene: the shared ones, and a holder's own among the union's. */
export function holderSources(state: RoomState, sceneId: string, memberId: string | null): Token[] {
  return lendingSources(state, sceneId).filter((t) => t.partyVision === true || (memberId !== null && ownsToken(state, { memberId, role: "player" }, t)));
}

function darkvision(state: RoomState, token: Token): boolean {
  return /darkvision/i.test(actorOf(state, token)?.senses ?? "");
}

/** The cells the sources see, `"x,y"`, on a scene with vision on. */
export function cellsSeen(state: RoomState, sceneId: string, sources: readonly Token[]): Set<string> {
  const scene = state.scenes[sceneId];
  const out = new Set<string>();
  if (!scene || scene.vision?.on !== true) return out;
  const dark = scene.vision.light === "dark";
  for (const s of sources) {
    const r = sightRect(s);
    const cx = Math.floor((r.x0 + r.x1) / 2);
    const cy = Math.floor((r.y0 + r.y1) / 2);
    const reach = dark ? (darkvision(state, s) ? 2 : 1) : 3;
    for (let y = Math.max(0, cy - reach); y <= Math.min(scene.bounds.h - 1, cy + reach); y++) {
      for (let x = Math.max(0, cx - reach); x <= Math.min(scene.bounds.w - 1, cx + reach); x++) out.add(`${x},${y}`);
    }
  }
  return out;
}

/** Real sight tiles for whole cells seen, all at bright. */
function tilesOf(cells: ReadonlySet<string>, sceneId: string): Record<string, SightTile> {
  const packs = new Map<string, Uint8Array>();
  for (const cell of cells) {
    const [x, y] = cell.split(",").map(Number) as [number, number];
    const tx = Math.floor(x / TILE_CELLS);
    const ty = Math.floor(y / TILE_CELLS);
    const key = `${tx},${ty}`;
    let packed = packs.get(key);
    if (!packed) packs.set(key, (packed = new Uint8Array(TILE_SUB * TILE_SUB / 4)));
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const i = ((y - ty * TILE_CELLS) * SUB + sy) * TILE_SUB + (x - tx * TILE_CELLS) * SUB + sx;
        packed[i >> 2] = packed[i >> 2]! | (3 << ((i & 3) << 1));
      }
    }
  }
  const out: Record<string, SightTile> = {};
  for (const [key, packed] of packs) out[`${sceneId}:${key}`] = packed.every((b) => b === 0xff) ? { f: 3 } : { b: Buffer.from(packed).toString("base64") };
  return out;
}

const sights = new Map<string, PartySight>();

function sightOfSources(state: RoomState, sceneId: string, sources: readonly Token[]): PartySight {
  const scene = state.scenes[sceneId];
  if (!scene || scene.vision?.on !== true) return NO_PARTY_SIGHT;
  const key = JSON.stringify([sceneId, scene.bounds, scene.vision.light, sources.map((s) => [s.id, s.x, s.y, s.size, s.w, s.h, s.squeeze, darkvision(state, s)])]);
  let hit = sights.get(key);
  if (!hit) {
    if (sights.size > 2000) sights.clear();
    sights.set(key, (hit = sightFromTiles(tilesOf(cellsSeen(state, sceneId, sources), sceneId), sceneId)));
  }
  return hit;
}

/** The stub rules: whole-cell sight, the union for `partySight` and each holder's own sources for `holderSight`. */
export const cellVision: VisionRules = {
  partySight: (state, sceneId) => sightOfSources(state, sceneId, lendingSources(state, sceneId)),
  holderSight: (state, sceneId, memberId) => sightOfSources(state, sceneId, holderSources(state, sceneId, memberId)),
  sightFromTiles,
};

/** Runs `body` with the stub rules in place, and puts the real ones back. */
export function withCellVision<T>(body: () => T): T {
  const real = { ...visionRules };
  Object.assign(visionRules, cellVision);
  try {
    return body();
  } finally {
    Object.assign(visionRules, real);
  }
}

// ---------------------------------------------------------------------------
// Fog bits

function bitsOf(tile: FogTile | undefined): Uint8Array | null {
  return tile ? decodeTile(tile.bits) : null;
}

/** The revealed bits a tile gets from whole cells. */
function cellBits(cells: ReadonlySet<string>, tx: number, ty: number): Uint8Array {
  const out = new Uint8Array(TILE_SUB * TILE_SUB / 8);
  for (let y = 0; y < TILE_CELLS; y++) {
    for (let x = 0; x < TILE_CELLS; x++) {
      if (!cells.has(`${tx * TILE_CELLS + x},${ty * TILE_CELLS + y}`)) continue;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const i = (y * SUB + sy) * TILE_SUB + x * SUB + sx;
          out[i >> 3] = out[i >> 3]! | (1 << (i & 7));
        }
      }
    }
  }
  return out;
}

function tilesTouched(cells: ReadonlySet<string>): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const cell of cells) {
    const [x, y] = cell.split(",").map(Number) as [number, number];
    const at = `${Math.floor(x / TILE_CELLS)},${Math.floor(y / TILE_CELLS)}`;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push([Math.floor(x / TILE_CELLS), Math.floor(y / TILE_CELLS)]);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function or(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (!a) return b && new Uint8Array(b);
  const out = new Uint8Array(a);
  if (b) for (let i = 0; i < out.length; i++) out[i] = out[i]! | b[i]!;
  return out;
}

function adds(next: Uint8Array, held: Uint8Array | null): boolean {
  for (let i = 0; i < next.length; i++) if ((next[i]! & ~(held?.[i] ?? 0)) !== 0) return true;
  return false;
}

/**
 * The explore step as the server would make it (docs/design-v1-per-player-vision.md
 * 6.1 and 6.3), from the stub's sight: on the player scene with vision on
 * and no blackout, the players the holder list gains, and with fog on the
 * shared sight's new bits for the party's layer and each holder's own new
 * bits that neither layer holds for theirs. A whole-party scene explores as
 * it always did. Null when there is nothing to write.
 */
export function exploreFor(state: RoomState): Op | null {
  if (state.meta.view?.blackout === true) return null;
  const sceneId = state.meta.playerSceneId;
  const scene = sceneId === null ? undefined : state.scenes[sceneId];
  if (!scene || sceneId === null || scene.vision?.on !== true) return null;
  const partyTiles = (cells: ReadonlySet<string>) => {
    const tiles: { tx: number; ty: number; bits: string }[] = [];
    for (const [tx, ty] of tilesTouched(cells)) {
      const held = bitsOf(state.exploredTiles[tileKey(sceneId, tx, ty)]);
      const seen = cellBits(cells, tx, ty);
      if (adds(seen, held)) tiles.push({ tx, ty, bits: encodeTile(or(seen, held)!) });
    }
    return tiles;
  };
  if (!perPlayerScene(scene)) {
    if (!scene.fogEnabled) return null;
    const tiles = partyTiles(cellsSeen(state, sceneId, lendingSources(state, sceneId)));
    return tiles.length > 0 ? { t: "sys.explore", sceneId, tiles } : null;
  }
  const entries = [...(state.holders[sceneId]?.entries ?? [])];
  const join: { memberId: string; on: boolean }[] = [];
  for (const source of lendingSources(state, sceneId)) {
    const owners = [...source.ownerIds, ...("ref" in source.actor ? (state.characters[source.actor.ref]?.ownerIds ?? []) : [])].sort();
    for (const id of owners) {
      if (state.members[id]?.kind !== "player" || entries.some((e) => e.memberId === id) || join.some((j) => j.memberId === id)) continue;
      const on = entries.filter((e) => e.on).length + join.filter((j) => j.on).length < LIMITS.sightHoldersPerScene;
      join.push({ memberId: id, on });
    }
  }
  const tiles = scene.fogEnabled ? partyTiles(cellsSeen(state, sceneId, holderSources(state, sceneId, null))) : [];
  const members: { memberId: string; tiles: { tx: number; ty: number; bits: string }[] }[] = [];
  if (scene.fogEnabled) {
    const holders = [...entries, ...join].filter((e) => e.on && state.members[e.memberId]?.kind === "player").map((e) => e.memberId);
    for (const id of holders) {
      const own: { tx: number; ty: number; bits: string }[] = [];
      const cells = cellsSeen(state, sceneId, holderSources(state, sceneId, id));
      for (const [tx, ty] of tilesTouched(cells)) {
        const key = tileKey(sceneId, tx, ty);
        const party = or(bitsOf(state.exploredTiles[key]), tiles.find((t) => t.tx === tx && t.ty === ty) ? decodeTile(tiles.find((t) => t.tx === tx && t.ty === ty)!.bits) : null);
        const shared = or(party, bitsOf(state.fogTiles[key]));
        const seen = cellBits(cells, tx, ty);
        if (shared) for (let i = 0; i < seen.length; i++) seen[i] = seen[i]! & ~shared[i]!;
        const held = bitsOf(state.exploredBy[holderTileKey(sceneId, id, tx, ty)]);
        if (adds(seen, held)) own.push({ tx, ty, bits: encodeTile(or(seen, held)!) });
      }
      if (own.length > 0) members.push({ memberId: id, tiles: own });
    }
  }
  if (tiles.length === 0 && members.length === 0 && join.length === 0) return null;
  return { t: "sys.explore", sceneId, tiles, ...(members.length > 0 ? { members } : {}), ...(join.length > 0 ? { join } : {}) };
}

// ---------------------------------------------------------------------------
// Random rooms and ops

const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

/** The players of a room, in id order. */
export function playersOf(state: RoomState): Viewer[] {
  return Object.values(state.members)
    .filter((m) => m.kind === "player")
    .map((m) => ({ memberId: m.id, role: "player" as const }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
}

/**
 * A random room as testutil.ts's, made per player: 1 to 8 players owning
 * characters, shared characters and lent creatures, creatures that share
 * sight, sources down or Blinded, both scenes per player now and then with
 * vision and fog in every state, holder lists past the cap with layers of
 * their own, and the DM's fog and the party's layer as testutil.ts leaves
 * them.
 */
export function perPlayerState(r: () => number): RoomState {
  const state = randomState(r);
  const n = int(r, 1, 8);
  const players = PLAYERS.slice(0, n);
  for (const id of ["p1", "p2"]) if (!players.includes(id)) delete state.members[id];
  for (const id of players) state.members[id] ??= member(id);
  const owners = () => pick(r, [[], [pick(r, players)], [pick(r, players)], [pick(r, players), pick(r, players)].filter((id, i, a) => a.indexOf(id) === i)]);
  for (const character of Object.values(state.characters)) character.ownerIds = owners();
  for (const t of Object.values(state.tokens)) {
    t.ownerIds = t.ownerIds.filter((id) => players.includes(id) || id === "dm1");
    if (chance(r, 0.25)) t.ownerIds = owners();
    t.partyVision = chance(r, 0.08) ? true : undefined;
    if (t.partyVision === undefined) delete t.partyVision;
    const actor = "inline" in t.actor ? t.actor.inline : state.characters[t.actor.ref]?.actor;
    if (actor && chance(r, 0.3)) actor.senses = "Darkvision 60 ft.";
    if (actor && chance(r, 0.1)) actor.effects = [...actor.effects, { id: `blind-${t.id}`, key: pick(r, ["blinded", "unconscious"] as const) }];
  }
  // The DM's own creatures, which only some players' creatures may see.
  for (let i = 0; i < int(r, 2, 6); i++) {
    const id = `mon-${i}`;
    state.tokens[id] = token(id, { sceneId: pick(r, ["s1", "s1", "s2"]), x: int(r, 0, 30), y: int(r, 0, 30), visibility: chance(r, 0.85) ? "all" : "dm", fogExempt: chance(r, 0.1) });
  }
  // More player characters, one per player now and then, so the cap of six holders is met.
  for (const id of players) {
    if (!chance(r, 0.6)) continue;
    const tid = `pc-${id}`;
    state.tokens[tid] = token(tid, { kind: "pc", name: `PC of ${id}`, sceneId: pick(r, ["s1", "s1", "s2"]), x: int(r, 0, 30), y: int(r, 0, 30), ownerIds: [id], actor: { inline: actor({ senses: chance(r, 0.5) ? "Darkvision 60 ft." : "" }) } });
  }
  for (const scene of Object.values(state.scenes)) {
    if (!chance(r, 0.75)) continue;
    scene.vision = { on: chance(r, 0.75), light: pick(r, ["bright", "dim", "dark"] as const), perPlayer: true };
    const across = tilesAcross(scene.bounds.w);
    const down = tilesAcross(scene.bounds.h);
    const entries = players.filter(() => chance(r, 0.5)).map((memberId, i) => ({ memberId, on: i < LIMITS.sightHoldersPerScene && chance(r, 0.85) }));
    if (entries.length > 0) state.holders[scene.id] = { sceneId: scene.id, rev: 0, entries };
    for (const e of entries) {
      if (!e.on) continue;
      for (let i = 0; i < int(r, 0, 3); i++) {
        const tx = int(r, 0, across - 1);
        const ty = int(r, 0, down - 1);
        const cells = new Set<string>();
        const x0 = tx * TILE_CELLS + int(r, 0, 12);
        const y0 = ty * TILE_CELLS + int(r, 0, 12);
        for (let y = y0; y < y0 + int(r, 1, 6); y++) for (let x = x0; x < x0 + int(r, 1, 6); x++) cells.add(`${x},${y}`);
        const bits = cellBits(cells, tx, ty);
        if (bits.some((b) => b !== 0)) state.exploredBy[holderTileKey(scene.id, e.memberId, tx, ty)] = { sceneId: scene.id, tx, ty, rev: 1, bits: encodeTile(bits), memberId: e.memberId };
      }
    }
  }
  return state;
}

/**
 * A random op for a per-player room: testutil.ts's mix, or by the DM one of
 * per-player vision's own: the Sight switch both ways, Party vision and the
 * light without it, the holder pick, ownership and
 * shared sight changing, sources going down or Blinded, moves, the DM's
 * reveals, hides and resets, a phase switch, the players' scene, a
 * blackout, and members joining and leaving.
 */
export function perPlayerOp(r: () => number, state: RoomState, who: Viewer): Op {
  if (who.role === "player" || chance(r, 0.5)) return randomOp(r, state, who);
  const sceneId = pick(r, ["s1", "s1", "s2"]);
  const scene = state.scenes[sceneId];
  const players = playersOf(state).map((p) => p.memberId);
  const tokenIds = Object.keys(state.tokens);
  const anyToken = () => (tokenIds.length > 0 ? pick(r, tokenIds) : "missing-token");
  const subset = (max: number) => players.filter(() => chance(r, 0.6)).slice(0, max);
  const encounter = state.encounter;
  const active = encounter?.turnStart?.tokenId;
  switch (int(r, 0, 21)) {
    case 15:
    case 16:
    case 17:
    case 18: {
      // A fight on the players' scene: one starts, its turns pass and come back, and the creature whose turn it is moves.
      if (!encounter || encounter.entries.length === 0) {
        // The DM's creatures first, so most turns are of creatures only some players may see.
        const here = Object.values(state.tokens)
          .filter((t) => t.sceneId === state.meta.playerSceneId)
          .sort((a, b) => Number(a.ownerIds.length > 0 || a.partyVision === true) - Number(b.ownerIds.length > 0 || b.partyVision === true))
          .slice(0, 8);
        if (here.length === 0) return { t: "log.chat", text: "hi" };
        return { t: "encounter.start", entries: here.map((t, i) => ({ id: `e-${t.id}-${int(r, 0, 1e6)}`, tokenId: t.id, value: 20 - i })) };
      }
      // A spot beside a sight holder's own source, often, so the creature that moves there is seen by some holders and not others.
      const owned = Object.values(state.tokens).filter((t) => t.sceneId === state.meta.playerSceneId && t.ownerIds.some((id) => players.includes(id)));
      const spot = (sceneId: string | undefined) => {
        const sources = Object.values(state.tokens).filter((t) => t.sceneId === sceneId && lends(state, t) && t.ownerIds.some((id) => holds(state, sceneId, id)));
        const by = sources.length > 0 && chance(r, 0.8) ? pick(r, sources) : null;
        const bounds = state.scenes[sceneId ?? ""]?.bounds ?? { w: 30, h: 30 };
        const within = (v: number, n: number) => Math.min(n - 1, Math.max(0, v));
        return by ? { x: within(Math.round(by.x) + int(r, -1, 1), bounds.w), y: within(Math.round(by.y) + int(r, -1, 1), bounds.h) } : { x: int(r, 0, 30), y: int(r, 0, 30) };
      };
      const roll = int(r, 0, 11);
      if (roll < 4) return { t: "encounter.next" };
      if (roll < 5) return { t: "encounter.prev" };
      if (roll < 9) return active && state.tokens[active] ? { t: "token.move", tokenId: active, ...spot(state.tokens[active].sceneId) } : { t: "encounter.next" };
      if (roll < 10 && owned.length > 0) {
        // An aura on a player's creature, which reminds as a creature enters it.
        const on = pick(r, owned);
        const ownerId = chance(r, 0.6) ? pick(r, on.ownerIds) : pick(r, ["dm1", ...players]);
        return { t: "template.create", template: { id: `aura-${int(r, 0, 1e6)}`, sceneId: on.sceneId, shape: "emanation", size: pick(r, [10, 15, 20]), origin: { x: on.x, y: on.y, z: 0 }, yaw: 0, attachedTo: on.id, casterId: on.id, includeOrigin: false, color: "#ff8800", spell: "Spirit Guardians", ownerId, visibility: "all", triggers: ["enter"] } };
      }
      const monsters = Object.values(state.tokens).filter((t) => t.sceneId === state.meta.playerSceneId && t.ownerIds.length === 0 && t.partyVision !== true);
      return monsters.length > 0 ? { t: "token.move", tokenId: pick(r, monsters).id, ...spot(state.meta.playerSceneId ?? undefined) } : { t: "encounter.next" };
    }
    case 19:
      return { t: "actor.hp", target: { tokenId: anyToken() }, change: { kind: "damage", amount: int(r, 1, 6) } };
    case 0:
    case 1:
      return { t: "scene.update", sceneId, patch: { vision: { on: scene?.vision?.on ?? chance(r, 0.7), light: scene?.vision?.light ?? "bright", perPlayer: scene?.vision?.perPlayer !== true } } };
    case 2:
      return { t: "scene.update", sceneId, patch: { vision: { on: chance(r, 0.7), light: pick(r, ["bright", "dim", "dark"] as const) } } };
    case 3:
    case 4:
      return { t: "vision.holders", sceneId, on: subset(LIMITS.sightHoldersPerScene) };
    case 5:
      return { t: "token.update", tokenId: anyToken(), patch: { ownerIds: subset(2) } };
    case 6: {
      const ids = Object.keys(state.characters);
      return ids.length > 0 ? { t: "character.update", characterId: pick(r, ids), patch: { ownerIds: subset(2) } } : { t: "log.chat", text: "hi" };
    }
    case 7:
      return { t: "token.update", tokenId: anyToken(), patch: { partyVision: chance(r, 0.5) } };
    case 8:
      return { t: "actor.effect.add", target: { tokenId: anyToken() }, effect: { id: `fx-${int(r, 0, 1e6)}`, key: pick(r, ["blinded", "unconscious"] as const) } };
    case 9:
      return { t: "token.move", tokenId: anyToken(), x: int(r, 0, 30), y: int(r, 0, 30) };
    case 10:
      return { t: "fog.live", sceneId, ops: [{ id: `f-${int(r, 0, 1e6)}`, mode: pick(r, ["hide", "reveal"] as const), shape: { kind: "rect", x: int(r, 0, 25), y: int(r, 0, 25), w: int(r, 1, 14), h: int(r, 1, 14) } }] };
    case 11:
      return { t: "fog.reset", sceneId, to: pick(r, ["hidden", "revealed"] as const) };
    case 12: {
      const phase = scene?.phases && scene.phases.length > 0 ? pick(r, scene.phases) : undefined;
      return phase ? { t: "scene.setPhase", sceneId, phaseId: phase.id } : { t: "room.setPlayerScene", sceneId };
    }
    case 13:
      return chance(r, 0.5) ? { t: "view.blackout", blackout: chance(r, 0.4) } : { t: "room.setPlayerScene", sceneId };
    case 14:
      return players.length > 1 ? { t: "sys.memberRemove", memberId: pick(r, players) } : { t: "log.chat", text: "hi" };
    default: {
      const id = PLAYERS.find((p) => !state.members[p]) ?? `p${int(r, 9, 99)}`;
      return { t: "sys.memberJoin", member: { id, name: id, color: "#00ff00", kind: "player", createdAt: "2026-10-25T10:00:00.000Z" } };
    }
  }
}

// ---------------------------------------------------------------------------
// The oracle

/**
 * What one viewer may be given of a room, worked out from nothing
 * (docs/design-v1-per-player-vision.md section 10): the creatures, labels,
 * stamps, pins, traps, areas and drawings of the player scene, the
 * tracker's rows, and whether the active creature's turn start.
 */
export type Given = { tokens: string[]; labels: string[]; stamps: string[]; pins: string[]; traps: string[]; templates: string[]; drawings: string[]; rows: string[]; turnStart: boolean };

/** Whether a member sees for themselves on a scene: a player whose entry on its list is on. */
export function holds(state: RoomState, sceneId: string, memberId: string): boolean {
  return perPlayerScene(state.scenes[sceneId]) && state.members[memberId]?.kind === "player" && (state.holders[sceneId]?.entries.some((e) => e.on && e.memberId === memberId) ?? false);
}

/** A viewer's own fog as a cell test: the DM's layer, the party's and, for a holder, theirs, merged. True is fully fogged. */
export function foggedFor(state: RoomState, sceneId: string, memberId: string | null): (x: number, y: number) => boolean {
  const own = memberId !== null && holds(state, sceneId, memberId) ? memberId : null;
  const cache = new Map<string, Uint8Array | null>();
  return (x, y) => {
    const tx = Math.floor(x / TILE_CELLS);
    const ty = Math.floor(y / TILE_CELLS);
    const key = tileKey(sceneId, tx, ty);
    if (!cache.has(key)) {
      const layers = [state.fogTiles[key], state.exploredTiles[key], own === null ? undefined : state.exploredBy[holderTileKey(sceneId, own, tx, ty)]];
      cache.set(key, layers.reduce<Uint8Array | null>((acc, t) => or(acc, bitsOf(t)), null));
    }
    const bits = cache.get(key);
    if (!bits) return true;
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const i = ((y - ty * TILE_CELLS) * SUB + sy) * TILE_SUB + (x - tx * TILE_CELLS) * SUB + sx;
        if ((bits[i >> 3]! >> (i & 7)) & 1) return false;
      }
    }
    return true;
  };
}

function rangeFogged(fogged: (x: number, y: number) => boolean, r: CellRange): boolean {
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (!fogged(x, y)) return false;
  return true;
}

/** Whether whole cells seen cover any sub-cell center of a creature's footprint, as sight judges one. */
export function cellsSee(cells: ReadonlySet<string>, probe: SightProbe): boolean {
  const r = sightRect(probe);
  const first = (v: number) => Math.ceil((2 * SUB * v - 1) / 2);
  for (let sy = Math.max(0, first(r.y0)); sy < first(r.y1); sy++) {
    for (let sx = Math.max(0, first(r.x0)); sx < first(r.x1); sx++) if (cells.has(`${Math.floor(sx / SUB)},${Math.floor(sy / SUB)}`)) return true;
  }
  return false;
}

/** The cells a player's own sight covers on a scene: a holder's own sources and the shared ones, anyone else's the shared ones, on a whole-party scene the union. */
export function cellsFor(state: RoomState, sceneId: string, memberId: string | null): Set<string> {
  if (!perPlayerScene(state.scenes[sceneId])) return cellsSeen(state, sceneId, lendingSources(state, sceneId));
  return cellsSeen(state, sceneId, holderSources(state, sceneId, memberId !== null && holds(state, sceneId, memberId) ? memberId : null));
}

/** Whether a player may know of a creature: the projection's rule, worked out again from the room alone. */
export function playerSees(state: RoomState, memberId: string, token: Token, cells: ReadonlySet<string>, fogged: (x: number, y: number) => boolean): boolean {
  const viewer: Viewer = { memberId, role: "player" };
  if (token.visibility === "dm" && !ownsToken(state, viewer, token)) return false;
  const scene = state.scenes[token.sceneId];
  if (!scene) return true;
  if (token.partyVision === true || playerOwned(state, token) || token.fogExempt) return true;
  if (scene.vision?.on === true) return cellsSee(cells, token);
  if (scene.fogEnabled) return !occupiedCells(token).every((c) => fogged(c.x, c.y));
  return true;
}

/** Everything of the player scene a player or a table display may be given, from the room alone. */
export function givenTo(state: RoomState, memberId: string): Given {
  const out: Given = { tokens: [], labels: [], stamps: [], pins: [], traps: [], templates: [], drawings: [], rows: [], turnStart: false };
  const sceneId = state.meta.view?.blackout === true ? null : state.meta.playerSceneId;
  const scene = sceneId === null ? undefined : state.scenes[sceneId];
  if (!scene || sceneId === null) return out;
  const fogged = foggedFor(state, sceneId, memberId);
  const cells = cellsFor(state, sceneId, memberId);
  const fogOn = scene.fogEnabled;
  for (const t of Object.values(state.tokens)) if (t.sceneId === sceneId && playerSees(state, memberId, t, cells, fogged)) out.tokens.push(t.id);
  for (const l of Object.values(state.labels)) if (l.sceneId === sceneId && !(fogOn && rangeFogged(fogged, labelCells(l)))) out.labels.push(l.id);
  for (const s of Object.values(state.stamps)) if (s.sceneId === sceneId && s.visibility !== "dm" && !(fogOn && rangeFogged(fogged, stampCells(s)))) out.stamps.push(s.id);
  for (const p of Object.values(state.pins)) {
    if (p.sceneId !== sceneId || p.visibility === "dm") continue;
    const page = p.pageId === undefined ? undefined : state.journal[p.pageId];
    if (p.pageId !== undefined && (!page || !pageReadableBy(page, memberId))) continue;
    if (!(fogOn && rangeFogged(fogged, pinCells(p)))) out.pins.push(p.id);
  }
  for (const trap of Object.values(state.traps)) {
    if (trap.sceneId !== sceneId || !trap.found) continue;
    if ("door" in trap.zone) {
      const door = trap.zone.door;
      const { cx, cy } = doorChunk(door);
      const chunk = state.buildChunks[chunkKey(sceneId, cx, cy)];
      const feature = "edge" in door ? chunk?.edges[door.edge] : chunk?.walls?.find((w) => w.id === door.id)?.f;
      if (feature?.kind === "door" && feature.secret && !feature.discovered) continue;
    }
    if (fogOn && zoneRanges(state, sceneId, trap.zone).every((r) => rangeFogged(fogged, r))) continue;
    out.traps.push(trap.id);
  }
  const seen = new Set(out.tokens);
  for (const t of Object.values(state.templates)) {
    if (t.sceneId !== sceneId || t.visibility === "dm") continue;
    if (t.attachedTo !== undefined && !seen.has(t.attachedTo)) continue;
    if (t.ownerId !== memberId && !state.meta.settings.playersSeeAoeOfOthers && state.members[t.ownerId]?.kind !== "dm") continue;
    out.templates.push(t.id);
  }
  for (const d of Object.values(state.drawings)) {
    if (d.sceneId !== sceneId || d.visibility === "dm") continue;
    if ((d.anchors ?? []).some((id) => id !== null && !seen.has(id))) continue;
    out.drawings.push(d.id);
  }
  const encounter = state.encounter;
  if (encounter) {
    const viewer: Viewer = { memberId, role: "player" };
    // The order rule reads no sight, so the oracle takes it as the projection does.
    for (const e of encounter.entries) {
      if (e.hidden || !orderShown(state, e, viewer)) continue;
      if (e.tokenId !== undefined && !seen.has(e.tokenId)) continue;
      if (e.characterId !== undefined && !state.characters[e.characterId]) continue;
      out.rows.push(e.id);
    }
    const start = encounter.turnStart;
    const t = start ? state.tokens[start.tokenId] : undefined;
    out.turnStart =
      start !== undefined &&
      t !== undefined &&
      start.entryId === encounter.activeEntryId &&
      out.rows.includes(start.entryId) &&
      seen.has(t.id) &&
      t.sceneId === start.sceneId &&
      (start.seen === true || start.seenBy?.includes(memberId) === true || ownsToken(state, viewer, t));
  }
  for (const list of Object.values(out)) if (Array.isArray(list)) list.sort();
  return out;
}

/** Whether a player may know of an area, by the oracle: one of `given`'s. */
export function templateGiven(state: RoomState, memberId: string, templateId: string): boolean {
  return givenTo(state, memberId).templates.includes(templateId);
}
