import { cellIndex, decodeHeights, decodeRough, decodeStairs, encodeHeights, encodeRough, encodeStairs } from "../heightCodec.ts";
import { cellOf, chunkKey, doorChunk, holderTileKey, keys, tileKey, wallChunk, wallMidpoint } from "../keys.ts";
import { CHUNK_CELLS, type BuildChunk, type ExploredTile, type FogDraft, type FogOp, type FogTile, type FreeWall, type Label, type Light, type RoomState, type Scene, type SightHolders, type Stamp, type TerrainId, type Token, type WallFeature } from "../model.ts";
import { MOST_SIGHT_HOLDERS, SIGHT_HOLDERS_FULL } from "../limits.ts";
import { MAX_BUILD_CELLS, MAX_FOG_DRAFT_OPS, type OpOf } from "../protocol.ts";
import { allRevealedTiles, decodeTile, encodeTile, isEmptyBits, pointInPolygonFixed, rasterizeFogOps, tilesAcross } from "../rules/fog.ts";
import { occupiedCells } from "../rules/footprint.ts";
import { footprintGround } from "../rules/heights.ts";
import { boxTouchesCell, labelBox } from "../rules/labels.ts";
import { attaches, discoversMap } from "../migrate.ts";
import { carriedIndex, holderOf, onHolder } from "../rules/attach.ts";
import { ridingGroup } from "../rules/moveLeg.ts";
import { sortedById } from "./tokens.ts";
import { Refuse, gone, invalid, type Tx } from "./tx.ts";
import { SQUARES, isHex, sceneGrid, shapeOfGrid } from "../rules/grid.ts";
import { HEX_R, HEX_S, hexAt, hexCenter, hexInScene, hexKey, type HexGrid } from "../rules/hex.ts";
import { forgetLayerMemory, forgetSceneMemory, forgetStamp, keepsMemory, memoryOwners, poolMemory, pruneLostGround, pruneMovedMarks, rememberLayer } from "./memory.ts";

// Fog (design 13.2).

export function fogDraft(tx: Tx, op: OpOf<"fog.draft">): void {
  tx.scene(op.sceneId);
  const draft: FogDraft = tx.state.fogDrafts[op.sceneId] ?? { sceneId: op.sceneId, rev: 0, ops: [] };
  const removing = new Set(op.remove ?? []);
  const adding = new Map((op.add ?? []).map((o) => [o.id, o]));
  const ops: FogOp[] = draft.ops.filter((o) => !removing.has(o.id) && !adding.has(o.id));
  for (const o of adding.values()) ops.push(o);
  if (ops.length > MAX_FOG_DRAFT_OPS) throw new Refuse("quota", `this scene can hold at most ${MAX_FOG_DRAFT_OPS.toLocaleString("en-US")} fog changes in its draft`);
  if (ops.length === 0) {
    if (tx.state.fogDrafts[op.sceneId]) tx.remove(keys.fogDraft(op.sceneId));
    return;
  }
  tx.write(keys.fogDraft(op.sceneId), { ...draft, ops });
}

function applyFogOps(tx: Tx, scene: Scene, ops: FogOp[]): void {
  const changes = rasterizeFogOps(tx.state.fogTiles, scene.id, scene.bounds, ops);
  for (const key of Object.keys(changes).sort()) {
    const tile = changes[key];
    if (tile === undefined) continue;
    const [tx_, ty] = key.slice(scene.id.length + 1).split(",").map(Number) as [number, number];
    if (tile === null) tx.remove(keys.fog(scene.id, tx_, ty));
    else tx.write(keys.fog(scene.id, tile.tx, tile.ty), tile);
  }
  forgetUnderHides(tx, scene, ops);
}

/**
 * A hide also makes players forget what the party explored under it
 * (docs/design-v1-maps-vision.md 4.3.3), except where the party looks now,
 * which the batch's explore records again. Reveals leave the explored layer
 * alone, and so the order of the ops does not matter to it. The clearing is
 * bookkeeping outside any undo step: undoing the hide brings back the DM's
 * fog and not what it cleared. Every sight holder's own layer forgets it
 * too (docs/design-v1-per-player-vision.md 6.3), whatever the scene's mode
 * now, so no layer kept since keeps ground the DM hid. What players
 * remember there goes with it, in keepMemory's pass after the op
 * (docs/design-v1-map-discovery.md 5.4).
 */
function forgetUnderHides(tx: Tx, scene: Scene, ops: FogOp[]): void {
  const hides = ops.filter((o) => o.mode === "hide");
  if (hides.length === 0) return;
  const changes = rasterizeFogOps(tx.state.exploredTiles, scene.id, scene.bounds, hides);
  for (const key of Object.keys(changes).sort()) {
    const tile = changes[key];
    if (tile === undefined) continue;
    const [tx_, ty] = key.slice(scene.id.length + 1).split(",").map(Number) as [number, number];
    tx.writeBookkeeping(keys.explored(scene.id, tx_, ty), tile);
  }
  for (const memberId of layerOwners(tx.state, scene.id)) {
    const layer = layerOf(tx.state, scene.id, memberId);
    const changed = rasterizeFogOps(layer, scene.id, scene.bounds, hides);
    for (const key of Object.keys(changed).sort()) {
      const tile = changed[key];
      if (tile === undefined) continue;
      const held = layer[key]!;
      tx.writeBookkeeping(keys.exploredBy(scene.id, memberId, held.tx, held.ty), tile && { ...tile, memberId });
    }
  }
}

/**
 * Takes away every explored tile of the scene, the holders' layers too, and
 * what every layer remembers (docs/design-v1-map-discovery.md 5.4), as
 * bookkeeping: a reset to hidden, or the scene going.
 */
export function forgetExplored(tx: Tx, sceneId: string): void {
  for (const key of Object.keys(tx.state.exploredTiles).sort()) {
    const tile = tx.state.exploredTiles[key]!;
    if (tile.sceneId === sceneId) tx.writeBookkeeping(keys.explored(sceneId, tile.tx, tile.ty), null);
  }
  for (const memberId of layerOwners(tx.state, sceneId)) forgetHolder(tx, sceneId, memberId);
  forgetSceneMemory(tx, sceneId);
}

/**
 * Takes away one holder's layer of a scene, and their memory with it
 * (docs/design-v1-map-discovery.md 5.4), as bookkeeping: they no longer see
 * for themselves there, or left the room.
 */
export function forgetHolder(tx: Tx, sceneId: string, memberId: string): void {
  for (const tile of Object.values(layerOf(tx.state, sceneId, memberId))) tx.writeBookkeeping(keys.exploredBy(sceneId, memberId, tile.tx, tile.ty), null);
  forgetLayerMemory(tx, sceneId, memberId);
}

/** The members with a layer or a memory of their own on a scene, in id order. */
function layerOwners(state: RoomState, sceneId: string): string[] {
  const out = new Set<string>(memoryOwners(state, sceneId));
  for (const tile of Object.values(state.exploredBy ?? {})) if (tile.sceneId === sceneId) out.add(tile.memberId);
  return [...out].sort();
}

/** One holder's layer of a scene, keyed as fog tiles are, in tile order, as rasterizeFogOps reads a layer. */
function layerOf(state: RoomState, sceneId: string, memberId: string): Record<string, ExploredTile> {
  const out: Record<string, ExploredTile> = {};
  const tiles = Object.values(state.exploredBy ?? {}).filter((t) => t.sceneId === sceneId && t.memberId === memberId);
  for (const tile of tiles.sort((a, b) => a.ty - b.ty || a.tx - b.tx)) out[tileKey(sceneId, tile.tx, tile.ty)] = tile;
  return out;
}

/**
 * What the party saw that the explored layer lacked (section 4.3.3). The
 * bits only ever add: each tile becomes the stored bits joined with what it
 * held, so a replay writes the same layer the live run did, and nothing
 * here ever computes sight. A tile is one of the scene's, inside its bounds.
 */
export function sysExplore(tx: Tx, op: OpOf<"sys.explore">): void {
  const scene = tx.scene(op.sceneId);
  if ((op.members || op.join) && scene.vision?.perPlayer !== true) throw invalid("the scene's sight is the whole party's");
  // Joins first, so a player who joins in this op may get their layer's first tiles in it (docs/design-v1-per-player-vision.md 6.1).
  if (op.join) joinHolders(tx, scene, op.join);
  for (const t of op.tiles) {
    const held = tx.state.exploredTiles[tileKey(scene.id, t.tx, t.ty)];
    const next = joinedBits(scene, t, held);
    if (next !== null) tx.write(keys.explored(scene.id, t.tx, t.ty), { sceneId: scene.id, tx: t.tx, ty: t.ty, rev: held?.rev ?? 0, bits: next });
  }
  const on = new Set(tx.state.holders?.[scene.id]?.entries.flatMap((e) => (e.on ? [e.memberId] : [])) ?? []);
  for (const m of op.members ?? []) {
    // Only a holder whose entry is on has a layer (6.1).
    if (!on.has(m.memberId)) throw invalid("only a player who sees for themselves explores for themselves");
    for (const t of m.tiles) {
      const held = tx.state.exploredBy?.[holderTileKey(scene.id, m.memberId, t.tx, t.ty)];
      const next = joinedBits(scene, t, held);
      if (next !== null) tx.write(keys.exploredBy(scene.id, m.memberId, t.tx, t.ty), { sceneId: scene.id, tx: t.tx, ty: t.ty, rev: held?.rev ?? 0, bits: next, memberId: m.memberId });
    }
  }
}

/**
 * What players remember (docs/design-v1-map-discovery.md 5.3), as the map
 * step found it after a batch: each layer's chunks, the keys each drops and
 * then the entries it sets, and the fog tiles a layer past its cap
 * forgets. A forgotten tile keeps only the sub-cells of its `keep` the
 * layer still held, so forgetting never shows a player anything, and then
 * every entry of the layer whose element it no longer holds goes, in
 * keepMemory's pass after the op. Only a
 * scene with fog and party vision on remembers, and a holder only while
 * they see for themselves. All of it is bookkeeping, replayed as stored.
 */
export function sysRemember(tx: Tx, op: OpOf<"sys.remember">): void {
  const scene = tx.scene(op.sceneId);
  if (!keepsMemory(scene)) throw invalid("players remember a scene only while its fog and party vision are on");
  for (const layer of op.layers) {
    const owner = layer.memberId ?? null;
    if (owner !== null) holderLayer(tx, scene, owner);
    rememberLayer(tx, scene, owner, layer.chunks);
  }
  for (const f of op.forget ?? []) {
    const owner = f.memberId ?? null;
    if (owner !== null) holderLayer(tx, scene, owner);
    for (const t of f.tiles) {
      const key = owner === null ? keys.explored(scene.id, t.tx, t.ty) : keys.exploredBy(scene.id, owner, t.tx, t.ty);
      const held: FogTile | undefined = owner === null ? tx.state.exploredTiles[tileKey(scene.id, t.tx, t.ty)] : tx.state.exploredBy?.[holderTileKey(scene.id, owner, t.tx, t.ty)];
      if (!held) continue;
      const was = decodeTile(held.bits);
      const keep = t.keep === undefined ? null : decodeTile(t.keep);
      const next = was && keep ? was.map((b, i) => b & keep[i]!) : null;
      if (!next || isEmptyBits(next)) tx.writeBookkeeping(key, null);
      else if (encodeTile(next) !== held.bits) tx.writeBookkeeping(key, { ...held, bits: encodeTile(next) });
    }
  }
}

/** Refuses a holder's layer of memory unless the scene is per player and they see for themselves there (6.1). */
function holderLayer(tx: Tx, scene: Scene, memberId: string): void {
  if (scene.vision?.perPlayer !== true) throw invalid("the scene's sight is the whole party's");
  if (!seesForThemselves(tx.state, scene.id, memberId)) throw invalid("only a player who sees for themselves remembers for themselves");
}

/**
 * Memory's bookkeeping after every op's dispatch and the fold
 * (docs/design-v1-map-discovery.md 5.4), so an edit, an undo and a redo
 * keep it alike: a scene that went loses its memory and its marks, one
 * whose fog or party vision went off loses its memory and its share mark,
 * and a grid shape switch, whose cell keys mean other cells now, drops the
 * scene's memory and the ground players explored there, whatever its fog
 * and vision, since what they saw is no longer on the map and the build
 * now would show in its place, once vision is on. Every layer that lost
 * explored ground, by any path, drops what it no longer holds, and so does
 * every layer that remembers a label or stamp the op moved or took away.
 * A stamp made DM only drops from every memory, so its art stops reaching
 * players. Only scenes, explored tiles, labels and stamps the op wrote can
 * have changed.
 */
export function keepMemory(tx: Tx, before: RoomState): void {
  if (tx.state.scenes !== before.scenes) {
    for (const id of Object.keys(before.scenes).sort()) {
      const was = before.scenes[id]!;
      const now = tx.state.scenes[id];
      if (now === was) continue;
      if (!now) {
        forgetSceneMemory(tx, id);
        if (tx.state.playedScenes?.[id]) tx.writeBookkeeping(keys.played(id), null);
        if (tx.state.memoryShared?.[id]) tx.writeBookkeeping(keys.memoryShared(id), null);
        continue;
      }
      if (now.gridShape !== was.gridShape) {
        forgetSceneMemory(tx, id);
        if (discoversMap(tx.env.opVersion)) forgetExplored(tx, id);
      }
      if (!keepsMemory(now)) {
        forgetSceneMemory(tx, id);
        if (tx.state.memoryShared?.[id]) tx.writeBookkeeping(keys.memoryShared(id), null);
      } else if (was.vision?.perPlayer === true && now.vision?.perPlayer !== true) {
        // A fold keeps the share for the party's layer alone (5.5): holders' layers a switch back brings take their whole caps.
        const mark = tx.state.memoryShared?.[id];
        if (mark && mark.party !== true) tx.writeBookkeeping(keys.memoryShared(id), { ...mark, party: true });
      }
    }
  }
  pruneLostGround(tx, before);
  pruneMovedMarks(tx, before);
  if (tx.state.stamps === before.stamps) return;
  for (const key of tx.touched()) {
    if (!key.startsWith("stamp:")) continue;
    const stamp = tx.state.stamps[key.slice("stamp:".length)];
    if (stamp?.visibility === "dm") forgetStamp(tx, stamp.sceneId, stamp.id);
  }
}

/** A layer's tile with an explore's bits joined, encoded, or null when it would hold nothing or nothing new. A tile is one of the scene's. */
function joinedBits(scene: Scene, t: { tx: number; ty: number; bits: string }, held: FogTile | undefined): string | null {
  if (t.tx >= tilesAcross(scene.bounds.w) || t.ty >= tilesAcross(scene.bounds.h)) throw invalid("explored tile outside the scene");
  const bits = decodeTile(t.bits);
  if (!bits) throw invalid("explored tile is not a tile of bits");
  const was = held ? decodeTile(held.bits) : null;
  const next = new Uint8Array(bits);
  if (was) for (let i = 0; i < next.length; i++) next[i] = next[i]! | was[i]!;
  if (isEmptyBits(next)) return null;
  const encoded = encodeTile(next);
  return held && held.bits === encoded ? null : encoded;
}

/**
 * The players the explore step found owning a seeing creature on the scene
 * with no entry (docs/design-v1-per-player-vision.md 6.1), each added at
 * the end as the step decided: the step turns one on only while fewer than
 * the cap in force are. A player already listed, or no longer a player on
 * the roster, is passed over, so the op replays to the same list.
 */
function joinHolders(tx: Tx, scene: Scene, join: readonly { memberId: string; on: boolean }[]): void {
  const list: SightHolders = tx.state.holders?.[scene.id] ?? { sceneId: scene.id, rev: 0, entries: [] };
  const entries = [...list.entries];
  for (const j of join) {
    if (entries.some((e) => e.memberId === j.memberId) || tx.state.members[j.memberId]?.kind !== "player") continue;
    // As the step that wrote it decided, under the cap in force then: replay never clamps a join again (review
    // PV1-ASTRA-4). Only the design's most bounds it, and only players' entries hold a place (review PV1-O5).
    entries.push({ memberId: j.memberId, on: j.on && entries.filter((e) => e.on && tx.state.members[e.memberId]?.kind === "player").length < MOST_SIGHT_HOLDERS });
  }
  if (entries.length !== list.entries.length) tx.write(keys.holders(scene.id), { ...list, entries });
}

/** The refusal of a seventh player who would see for themselves (docs/design-v1-per-player-vision.md 7.1), as the live cap writes it (limits.ts). */
export const HOLDERS_FULL = SIGHT_HOLDERS_FULL;

/**
 * The DM's pick of who sees for themselves on a per-player scene
 * (docs/design-v1-per-player-vision.md 6.1): exactly the players named,
 * each a player on the roster, one with no entry getting one at the end.
 * A holder turned off forgets their map of the scene, outside the undo
 * step, so undoing the pick turns them on again from the party's map.
 */
export function visionHolders(tx: Tx, op: OpOf<"vision.holders">): void {
  const scene = tx.scene(op.sceneId);
  if (scene.vision?.perPlayer !== true) throw invalid("the scene's sight is the whole party's");
  // The design's most, which never changes, so a pick stored under a higher cap than today's replays. The cap in force is
  // a live op's alone (limits.ts checkLimits, review PV1-ASTRA-4).
  if (op.on.length > MOST_SIGHT_HOLDERS) throw invalid(HOLDERS_FULL);
  for (const id of op.on) if (tx.state.members[id]?.kind !== "player") throw invalid("only a player on the roster sees for themselves");
  const list: SightHolders = tx.state.holders?.[scene.id] ?? { sceneId: scene.id, rev: 0, entries: [] };
  const named = new Set(op.on);
  const entries = list.entries.map((e) => ({ memberId: e.memberId, on: named.has(e.memberId) }));
  for (const id of op.on) if (!entries.some((e) => e.memberId === id)) entries.push({ memberId: id, on: true });
  for (const e of list.entries) if (e.on && !named.has(e.memberId)) forgetHolder(tx, scene.id, e.memberId);
  if (entries.some((e, i) => e.memberId !== list.entries[i]?.memberId || e.on !== list.entries[i]?.on) || entries.length !== list.entries.length) tx.write(keys.holders(scene.id), { ...list, entries });
}

/**
 * The fold (docs/design-v1-per-player-vision.md 6.3), after every op's
 * dispatch: a scene that stopped being a per-player one, by any op, an
 * undo's included, pools every holder's layer into the party's and empties
 * its holder list, and a scene that is gone loses both. All of it outside
 * the undo step, so undoing the switch does not split the maps again: each
 * holder then starts from the pooled map. Only scenes the op wrote can have
 * stopped.
 *
 * Then, after an op that changed a holder list or the roster, an entry on
 * for a member who is no player turns off, and every layer of a member who
 * no longer sees for themselves on its scene goes, as bookkeeping too. An
 * undo or a redo of the DM's pick restores the list without passing
 * `visionHolders`, which forgets the layers of the holders it turns off,
 * and would otherwise leave a layer the restored list no longer allows, or
 * an entry on for a player made DM since (reviews PV1-ASTRA-2, PV1-O5).
 *
 * And a per-player scene keeps no layer's tile past its bounds: after an
 * op that shrank one, an undo's included, or made one per player, the
 * party's layer and every holder's forget what lies outside, as
 * bookkeeping too. The size guard counts those layers at their widest
 * inside the bounds and never their contents, so a tile kept outside would
 * count nowhere (review PV3-ASTRA-1). A whole-party scene still remembers
 * past its bounds, for when they grow back.
 */
export function foldSight(tx: Tx, before: RoomState): void {
  for (const sceneId of Object.keys(before.scenes).sort()) {
    const was = before.scenes[sceneId]!;
    const now = tx.state.scenes[sceneId];
    if (now === was || (now?.vision?.perPlayer === true && now !== undefined)) continue;
    const list = tx.state.holders?.[sceneId];
    const owners = layerOwners(tx.state, sceneId);
    if (!list && owners.length === 0) continue;
    // Memory first, while the party's layer is still its own (docs/design-v1-map-discovery.md 5.4).
    if (now) poolMemory(tx, now, inListOrder(list, owners));
    if (now) pool(tx, now, owners);
    for (const memberId of owners) forgetHolder(tx, sceneId, memberId);
    if (list) tx.writeBookkeeping(keys.holders(sceneId), null);
  }
  for (const sceneId of Object.keys(tx.state.scenes).sort()) {
    const now = tx.state.scenes[sceneId]!;
    const was = before.scenes[sceneId];
    if (now === was || now.vision?.perPlayer !== true) continue;
    if (was?.vision?.perPlayer === true && tilesAcross(now.bounds.w) >= tilesAcross(was.bounds.w) && tilesAcross(now.bounds.h) >= tilesAcross(was.bounds.h)) continue;
    forgetPastBounds(tx, now);
  }
  if (tx.state.holders === before.holders && tx.state.members === before.members) return;
  for (const sceneId of Object.keys(tx.state.holders ?? {}).sort()) {
    const list = tx.state.holders[sceneId]!;
    if (!list.entries.some((e) => e.on && tx.state.members[e.memberId]?.kind !== "player")) continue;
    tx.writeBookkeeping(keys.holders(sceneId), { ...list, entries: list.entries.map((e) => (e.on && tx.state.members[e.memberId]?.kind !== "player" ? { memberId: e.memberId, on: false } : e)) });
  }
  const scenes = new Set([...Object.values(tx.state.exploredBy ?? {}), ...Object.values(tx.state.memoryBy ?? {})].map((t) => t.sceneId));
  for (const sceneId of [...scenes].sort()) {
    for (const memberId of layerOwners(tx.state, sceneId)) if (!seesForThemselves(tx.state, sceneId, memberId)) forgetHolder(tx, sceneId, memberId);
  }
}

/** The members with a layer, those on the holder list first in its order, then the rest in id order. */
function inListOrder(list: SightHolders | undefined, owners: readonly string[]): string[] {
  const listed = (list?.entries ?? []).map((e) => e.memberId).filter((m) => owners.includes(m));
  return [...listed, ...owners.filter((m) => !listed.includes(m))];
}

/** Removes, as bookkeeping, every tile of the scene's layers, the party's and its holders', that lies past its bounds. */
function forgetPastBounds(tx: Tx, scene: Scene): void {
  const across = tilesAcross(scene.bounds.w);
  const down = tilesAcross(scene.bounds.h);
  const past = (t: { sceneId: string; tx: number; ty: number }) => t.sceneId === scene.id && (t.tx >= across || t.ty >= down);
  for (const key of Object.keys(tx.state.exploredTiles).sort()) {
    const t = tx.state.exploredTiles[key]!;
    if (past(t)) tx.writeBookkeeping(keys.explored(t.sceneId, t.tx, t.ty), null);
  }
  for (const key of Object.keys(tx.state.exploredBy ?? {}).sort()) {
    const t = tx.state.exploredBy[key]!;
    if (past(t)) tx.writeBookkeeping(keys.exploredBy(t.sceneId, t.memberId, t.tx, t.ty), null);
  }
}

/** Whether a member holds sight on a scene: a player whose entry on its list is on (6.1). */
function seesForThemselves(state: RoomState, sceneId: string, memberId: string): boolean {
  return state.members[memberId]?.kind === "player" && state.holders?.[sceneId]?.entries.some((e) => e.on && e.memberId === memberId) === true;
}

/** ORs each holder's layer into the party's, a tile at a time in tile order, as bookkeeping. */
function pool(tx: Tx, scene: Scene, owners: readonly string[]): void {
  const byTile = new Map<string, ExploredTile[]>();
  for (const memberId of owners) {
    for (const [key, tile] of Object.entries(layerOf(tx.state, scene.id, memberId))) {
      let list = byTile.get(key);
      if (!list) byTile.set(key, (list = []));
      list.push(tile);
    }
  }
  const keysInOrder = [...byTile.keys()].sort((a, b) => {
    const [ax, ay] = a.slice(scene.id.length + 1).split(",").map(Number) as [number, number];
    const [bx, by] = b.slice(scene.id.length + 1).split(",").map(Number) as [number, number];
    return ay - by || ax - bx;
  });
  for (const key of keysInOrder) {
    const tiles = byTile.get(key)!;
    const held = tx.state.exploredTiles[key];
    const bits = held ? (decodeTile(held.bits) ?? new Uint8Array(0)) : null;
    let next: Uint8Array | null = bits && bits.length > 0 ? new Uint8Array(bits) : null;
    for (const tile of tiles) {
      const b = decodeTile(tile.bits);
      if (!b) continue;
      if (!next) next = new Uint8Array(b);
      else for (let i = 0; i < next.length; i++) next[i] = next[i]! | b[i]!;
    }
    if (!next || isEmptyBits(next)) continue;
    const encoded = encodeTile(next);
    if (held && held.bits === encoded) continue;
    const { tx: x, ty: y } = tiles[0]!;
    tx.writeBookkeeping(keys.explored(scene.id, x, y), { sceneId: scene.id, tx: x, ty: y, rev: held?.rev ?? 0, bits: encoded });
  }
}

export function fogPublish(tx: Tx, op: OpOf<"fog.publish">): void {
  const scene = tx.scene(op.sceneId);
  const draft = tx.state.fogDrafts[op.sceneId];
  if (!draft) throw invalid("nothing to publish");
  applyFogOps(tx, scene, draft.ops);
  tx.remove(keys.fogDraft(op.sceneId));
}

export function fogDiscard(tx: Tx, op: OpOf<"fog.discard">): void {
  tx.scene(op.sceneId);
  if (tx.state.fogDrafts[op.sceneId]) tx.remove(keys.fogDraft(op.sceneId));
}

export function fogLive(tx: Tx, op: OpOf<"fog.live">): void {
  applyFogOps(tx, tx.scene(op.sceneId), op.ops);
}

export function fogReset(tx: Tx, op: OpOf<"fog.reset">): void {
  const scene = tx.scene(op.sceneId);
  if (op.to === "hidden") {
    for (const tile of Object.values(tx.state.fogTiles)) {
      if (tile.sceneId === scene.id) tx.remove(keys.fog(tile.sceneId, tile.tx, tile.ty));
    }
    // Players forget the whole scene too (section 4.3.3), outside the reset's undo step.
    forgetExplored(tx, scene.id);
    return;
  }
  for (const tile of allRevealedTiles(scene.id, scene.bounds)) {
    const existing = tx.state.fogTiles[tileKey(scene.id, tile.tx, tile.ty)];
    if (existing && existing.bits === tile.bits) continue;
    tx.write(keys.fog(scene.id, tile.tx, tile.ty), tile);
  }
}

// Builder (design 12).

type Cell = { x: number; y: number };

export function parseCell(key: string): Cell {
  const [xs, ys] = key.split(",");
  return { x: Number(xs), y: Number(ys) };
}

/**
 * Whether a cell of a cell key lies in the scene (docs/design-v1-hex-grids.md
 * 4.3): a square inside the bounds, or on a hex scene, where a key names a
 * hex by its column and row, a hex wholly inside the scene's rectangle.
 */
export function inBounds(scene: Scene, cell: Cell): boolean {
  const g = sceneGrid(scene);
  if (isHex(g)) return hexInScene(g, scene.bounds, { col: cell.x, row: cell.y });
  return cell.x >= 0 && cell.y >= 0 && cell.x < scene.bounds.w && cell.y < scene.bounds.h;
}

export function emptyChunk(sceneId: string, cx: number, cy: number): BuildChunk {
  return { sceneId, cx, cy, rev: 0, cells: {}, edges: {} };
}

/**
 * Whether an edge key names an edge of the scene, its east and south
 * borders included (docs/design-v1-maps-vision.md 3.1): a west edge `x,y,w`
 * runs from x = 0 to the width, a north edge `x,y,n` from y = 0 to the
 * height. Every edge inside the scene was already allowed, so every stored
 * op still applies as it did.
 */
function edgeInBounds(scene: Scene, key: string): boolean {
  const [xs, ys, side] = key.split(",");
  const x = Number(xs);
  const y = Number(ys);
  if (x < 0 || y < 0) return false;
  return side === "w" ? x <= scene.bounds.w && y < scene.bounds.h : x < scene.bounds.w && y <= scene.bounds.h;
}

/** A chunk with its free walls replaced, the field left out when none are left. */
function withWalls(chunk: BuildChunk, walls: FreeWall[]): BuildChunk {
  const { walls: _old, ...rest } = chunk;
  return walls.length > 0 ? { ...rest, walls } : rest;
}

/** Every build change can move a wall, so the rules caches keyed on the walls version drop it. */
function bumpWalls(tx: Tx, sceneId: string): void {
  tx.bumpWalls(sceneId);
}

type ChunkChange = { cx: number; cy: number; cells: Cell[]; edges: string[] };

/**
 * Groups cells by chunk and writes each chunk once. A chunk left with
 * nothing in it is removed.
 *
 * Erasing (a null terrain) clears everything in the cells, not only the
 * floor: the walls, doors, windows and "no wall" marks on all four sides of
 * each cell, and every label whose text covers part of one. Otherwise a
 * door would float in the rock, still block areas, and come back when the
 * floor is painted again. An edge on a cell's south or east side is filed
 * under the neighbor below or to the right, which may sit in another chunk.
 *
 * It also takes the free walls whose midpoint, and the stamps and lights
 * whose center, lie in an erased cell (docs/design-v1-maps-vision.md 2.2,
 * 3.5, 3.6). A free wall lives in its midpoint's chunk, which is the erased
 * cell's own.
 *
 * An edge on the scene's east or south border, which wave 3 lets the
 * builder draw, stays when the cell beside it is erased: erasing it would
 * change what a stored erase did on a scene shrunk since its edges were
 * drawn, and replay must give the same state. The wall tool and Clear
 * remove it.
 */
function setCells(tx: Tx, scene: Scene, cells: Cell[], terrain: TerrainId | null): void {
  const g = sceneGrid(scene);
  // Painted ground stays square (HX-D9), and the server refuses a paint on hexes before it gets here (shared/permissions.ts).
  if (isHex(g) && terrain === null) {
    eraseHexes(tx, scene, g, cells);
    return;
  }
  const byChunk = new Map<string, ChunkChange>();
  const group = (x: number, y: number): ChunkChange => {
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    const key = chunkKey(scene.id, cx, cy);
    let change = byChunk.get(key);
    if (!change) byChunk.set(key, (change = { cx, cy, cells: [], edges: [] }));
    return change;
  };
  for (const cell of cells) {
    if (!inBounds(scene, cell)) throw invalid("cell outside the scene");
    const own = group(cell.x, cell.y);
    own.cells.push(cell);
    if (terrain !== null) continue;
    own.edges.push(`${cell.x},${cell.y},n`, `${cell.x},${cell.y},w`);
    if (cell.y + 1 < scene.bounds.h) group(cell.x, cell.y + 1).edges.push(`${cell.x},${cell.y + 1},n`);
    if (cell.x + 1 < scene.bounds.w) group(cell.x + 1, cell.y).edges.push(`${cell.x + 1},${cell.y},w`);
  }
  // Erasing takes the cells' heights, so the tokens standing on that ground land on what is left (landOnGround).
  const standing = terrain === null ? standingOn(tx, scene.id, new Set(cells.map((c) => `${c.x},${c.y}`))) : [];
  for (const key of [...byChunk.keys()].sort()) {
    const change = byChunk.get(key)!;
    const chunk = tx.state.buildChunks[key] ?? emptyChunk(scene.id, change.cx, change.cy);
    const nextCells = { ...chunk.cells };
    for (const cell of change.cells) {
      const id = `${cell.x},${cell.y}`;
      if (terrain === null) delete nextCells[id];
      else nextCells[id] = terrain;
    }
    let edges = chunk.edges;
    for (const id of change.edges) {
      if (!(id in edges)) continue;
      if (edges === chunk.edges) edges = { ...chunk.edges };
      delete edges[id];
    }
    // A chunk reached only for an edge on a neighbor's side is written only when it lost one.
    if (change.cells.length === 0 && edges === chunk.edges) continue;
    let next: BuildChunk = { ...chunk, cells: nextCells, edges };
    if (terrain === null && chunk.walls) {
      const erased = new Set(change.cells.map((c) => `${c.x},${c.y}`));
      next = withWalls(next, chunk.walls.filter((w) => !erased.has(cellOf(...wallMidpoint(w)))));
    }
    if (terrain === null) next = withoutHeights(next, change.cells);
    writeChunk(tx, next);
  }
  if (terrain === null) {
    landOnGround(tx, standing);
    eraseLabels(tx, scene.id, cells);
    eraseByCenter(tx, scene.id, cells);
  }
}

/**
 * The tokens on a scene standing on the ground of some cells, all of the
 * scene's when `cells` is null: their elevation equals the ground under
 * their footprint (rules/heights.ts), the squeezed one while they squeeze.
 * Asked before an op changes the ground, so landOnGround can set them on
 * what the op leaves. A scene holds at most 500 tokens, which bounds it.
 */
export function standingOn(tx: Tx, sceneId: string, cells: ReadonlySet<string> | null): Token[] {
  const out: Token[] = [];
  const groups = attaches(tx.env.opVersion);
  for (const token of sortedById(Object.values(tx.state.tokens))) {
    if (token.sceneId !== sceneId) continue;
    // What sits on its holder stands on the holder, not the floor, and moves only with it (docs/design-v1-attach.md 5.2).
    if (groups && token.attached && onHolder(token.attached.kind) && holderOf(tx.state.tokens, token)) continue;
    if (cells && !occupiedCells(SQUARES, token).some((c) => cells.has(`${c.x},${c.y}`))) continue;
    if (token.elevation === footprintGround(tx.state.buildChunks, token)) out.push(token);
  }
  return out;
}

/**
 * Tokens that stood on the ground, set on the ground under them now, in
 * the same op as the change of ground (docs/design-v1-maps-vision.md 4.2):
 * a height paint, an erase or a clear. Nobody ends up inside a ledge or
 * hanging in the air over cleared ground, which would draw a flight shadow
 * and let the token pass ledges as a flier. A landing, not a move, so it
 * adds no leg to a path. The op's undo puts the tokens back with the
 * ground, and refuses if one of them changed since, as any restore does.
 */
export function landOnGround(tx: Tx, standing: readonly Token[]): void {
  // Links do not change here, so one index, read before any token is written, says which tokens carry anything.
  const links = attaches(tx.env.opVersion) ? tx.state.tokens : null;
  const holders = links ? carriedIndex(links) : null;
  for (const was of standing) {
    const token = tx.token(was.id);
    const ground = footprintGround(tx.state.buildChunks, token);
    if (ground === token.elevation) continue;
    const rise = ground - token.elevation;
    // From op version 14 what sits on it rises or sinks with it, down its chain, while a dragged creature keeps to its
    // own ground. The link pass at the end of the op lets loose one left out of reach (docs/design-v1-attach.md 5.2).
    const riding = links && holders?.has(token.id) ? ridingGroup(links, token.id).slice(1) : [];
    tx.write(keys.token(token.id), { ...token, elevation: ground });
    for (const id of riding) {
      const rider = tx.token(id);
      tx.write(keys.token(id), { ...rider, elevation: rider.elevation + rise });
    }
  }
}

/**
 * A chunk with the heights and stair marks of these cells cleared (wave 4,
 * section 4.2), as erase clears everything else in them. A chunk from
 * before wave 4 has neither, so a stored erase replays as it did.
 */
function withoutHeights(chunk: BuildChunk, cells: readonly Cell[]): BuildChunk {
  if (chunk.heights === undefined && chunk.up === undefined && chunk.rough === undefined) return chunk;
  const heights = decodeHeights(chunk.heights);
  const marks = decodeStairs(chunk.up);
  const rough = decodeRough(chunk.rough);
  for (const c of cells) {
    const i = cellIndex(chunk, c.x, c.y);
    heights[i] = 0;
    marks[i] = ".";
    rough[i] = false;
  }
  // Difficult ground marks go with the rest of a cell (docs/design-v1-movement.md 6.3). No older chunk holds any.
  return withRough(withHeightFields(chunk, encodeHeights(heights), encodeStairs(marks)), encodeRough(rough));
}

/** A chunk with its difficult ground marks replaced, the field left out when it holds none. */
export function withRough(chunk: BuildChunk, rough: string | undefined): BuildChunk {
  const { rough: _rough, ...rest } = chunk;
  return rough === undefined ? rest : { ...rest, rough };
}

/** A chunk with its heights and stair marks replaced, each field left out when it holds nothing. */
export function withHeightFields(chunk: BuildChunk, heights: string | undefined, up: string | undefined): BuildChunk {
  const { heights: _heights, up: _up, ...rest } = chunk;
  const out: BuildChunk = rest;
  if (heights !== undefined) out.heights = heights;
  if (up !== undefined) out.up = up;
  return out;
}

/** Removes the stamps and lights whose center lies in one of the cells. */
function eraseByCenter(tx: Tx, sceneId: string, cells: Cell[]): void {
  const erased = new Set(cells.map((c) => `${c.x},${c.y}`));
  for (const stamp of sortedById(Object.values(tx.state.stamps))) {
    if (stamp.sceneId === sceneId && erased.has(cellOf(stamp.x, stamp.y))) tx.remove(keys.stamp(stamp.id));
  }
  for (const light of sortedById(Object.values(tx.state.lights))) {
    if (light.sceneId === sceneId && erased.has(cellOf(light.x, light.y))) tx.remove(keys.light(light.id));
  }
}

/**
 * Removes the labels whose text covers any part of the cells, wherever their
 * anchor sits. Each label's box is tested against the erased cells, at most
 * 2,000 per op, so the work stays bounded however large a label is. The box
 * around all the cells first skips every label nowhere near them.
 */
function eraseLabels(tx: Tx, sceneId: string, cells: Cell[]): void {
  if (cells.length === 0) return;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const c of cells) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + 1);
    y1 = Math.max(y1, c.y + 1);
  }
  const erased: string[] = [];
  for (const [id, label] of Object.entries(tx.state.labels)) {
    if (label.sceneId !== sceneId) continue;
    const box = labelBox(label);
    if (box.x1 <= x0 || box.x0 >= x1 || box.y1 <= y0 || box.y0 >= y1) continue;
    if (cells.some((c) => boxTouchesCell(box, c.x, c.y))) erased.push(id);
  }
  for (const id of erased.sort()) tx.remove(keys.label(id));
}

/**
 * Erase on a hex scene (HX-D9), each key a hex: everything in the hexes, as
 * on squares. Their difficult ground marks go from their chunks of 16 by 16
 * hexes by key. A free wall lives in the world chunk of its midpoint, not
 * a hex's chunk, so the world chunks each hex covers are read for the free
 * walls whose midpoint lies in an erased hex, and so are the stamps and
 * lights whose center does and the labels whose text touches one. Hexes
 * hold no painted ground, edges or heights in H2, so no token's ground
 * changes.
 */
function eraseHexes(tx: Tx, scene: Scene, g: HexGrid, cells: readonly Cell[]): void {
  const erased = new Set<string>();
  const byChunk = new Map<string, { cx: number; cy: number; cells: Cell[] }>();
  const worldChunks = new Map<string, { cx: number; cy: number }>();
  for (const cell of cells) {
    if (!inBounds(scene, cell)) throw invalid("cell outside the scene");
    const id = hexKey({ col: cell.x, row: cell.y });
    if (erased.has(id)) continue;
    erased.add(id);
    const cx = Math.floor(cell.x / CHUNK_CELLS);
    const cy = Math.floor(cell.y / CHUNK_CELLS);
    const key = chunkKey(scene.id, cx, cy);
    let group = byChunk.get(key);
    if (!group) byChunk.set(key, (group = { cx, cy, cells: [] }));
    group.cells.push(cell);
    const box = hexBox(g, cell);
    for (let wy = Math.floor(box.y0 / CHUNK_CELLS); wy <= Math.floor(box.y1 / CHUNK_CELLS); wy++) {
      for (let wx = Math.floor(box.x0 / CHUNK_CELLS); wx <= Math.floor(box.x1 / CHUNK_CELLS); wx++) worldChunks.set(chunkKey(scene.id, wx, wy), { cx: wx, cy: wy });
    }
  }
  const inErased = (x: number, y: number) => erased.has(hexKey(hexAt(g, { x, y })));
  const touched = new Set([...byChunk.keys(), ...worldChunks.keys()]);
  for (const key of [...touched].sort()) {
    const stored = tx.state.buildChunks[key];
    const group = byChunk.get(key);
    if (!stored) continue;
    let next = stored;
    if (group) {
      const nextCells = { ...stored.cells };
      for (const c of group.cells) delete nextCells[`${c.x},${c.y}`];
      next = withoutHeights({ ...stored, cells: nextCells }, group.cells);
    }
    if (worldChunks.has(key) && stored.walls) next = withWalls(next, stored.walls.filter((w) => !inErased(...wallMidpoint(w))));
    if (!sameChunk(stored, next)) writeChunk(tx, next);
  }
  for (const stamp of sortedById(Object.values(tx.state.stamps))) {
    if (stamp.sceneId === scene.id && inErased(stamp.x, stamp.y)) tx.remove(keys.stamp(stamp.id));
  }
  for (const light of sortedById(Object.values(tx.state.lights))) {
    if (light.sceneId === scene.id && inErased(light.x, light.y)) tx.remove(keys.light(light.id));
  }
  const hexes = [...byChunk.values()].flatMap((group) => group.cells);
  const labels: string[] = [];
  for (const [id, label] of Object.entries(tx.state.labels)) {
    if (label.sceneId !== scene.id) continue;
    const box = labelBox(label);
    if (hexes.some((h) => boxTouchesHex(g, box, h))) labels.push(id);
  }
  for (const id of labels.sort()) tx.remove(keys.label(id));
}

/** Whether an erase left a chunk as it was. It only takes things away, so a count says whether it took any. */
function sameChunk(a: BuildChunk, b: BuildChunk): boolean {
  return a.rough === b.rough && a.heights === b.heights && a.up === b.up && (a.walls?.length ?? 0) === (b.walls?.length ?? 0) && Object.keys(a.cells).length === Object.keys(b.cells).length;
}

/** A hex's box in world cells, a key's column and row: its center less and plus half its width and its corner's reach, mirrored on hex columns. */
function hexBox(g: HexGrid, cell: Cell): { x0: number; y0: number; x1: number; y1: number } {
  const c = hexCenter(g, { col: cell.x, row: cell.y });
  const hx = g.orient === "rows" ? 0.5 : HEX_R;
  const hy = g.orient === "rows" ? HEX_R : 0.5;
  return { x0: c.x - hx, y0: c.y - hy, x1: c.x + hx, y1: c.y + hy };
}

/**
 * Whether a label's box overlaps a hex, by the separating axis test: the
 * hex is the meeting of three bands half a cell either side of its center,
 * across its flat sides, and the box's own two axes are the hex's box. Only
 * `+`, `-`, `*` and comparisons, so every device agrees on replay.
 */
function boxTouchesHex(g: HexGrid, box: { x0: number; y0: number; x1: number; y1: number }, cell: Cell): boolean {
  const h = hexBox(g, cell);
  if (!(box.x0 < h.x1 && box.x1 > h.x0 && box.y0 < h.y1 && box.y1 > h.y0)) return false;
  const c = hexCenter(g, { col: cell.x, row: cell.y });
  // On hex rows the flat sides face east and west and the two sloped pairs face 60 degrees from them. Hex columns swap x and y.
  const [ax, ay, bx, by] = g.orient === "rows" ? [box.x0 - c.x, box.y0 - c.y, box.x1 - c.x, box.y1 - c.y] : [box.y0 - c.y, box.x0 - c.x, box.y1 - c.y, box.x1 - c.x];
  for (const sign of [1, -1]) {
    // The normal (1/2, sign * HEX_S): a band from -1/2 to 1/2 across the hex.
    const s = sign * HEX_S;
    const p = [ax * 0.5 + ay * s, bx * 0.5 + ay * s, ax * 0.5 + by * s, bx * 0.5 + by * s];
    if (Math.min(...p) >= 0.5 || Math.max(...p) <= -0.5) return false;
  }
  return true;
}

/**
 * The hex shape a chunk's grid-keyed content stands on (HX-D14): a chunk
 * of a hex scene that holds cells, edges, heights, stairs or difficult
 * ground carries its scene's shape, and one left with none of them, or
 * free walls only, carries none. A square scene's chunks are left as they
 * are, so their stored form never changes.
 */
function stamped(tx: Tx, chunk: BuildChunk): BuildChunk {
  const scene = tx.state.scenes[chunk.sceneId];
  const g = scene ? sceneGrid(scene) : SQUARES;
  if (!isHex(g)) return chunk;
  const keyed = Object.keys(chunk.cells).length > 0 || Object.keys(chunk.edges).length > 0 || chunk.heights !== undefined || chunk.up !== undefined || chunk.rough !== undefined;
  const { grid: _grid, ...rest } = chunk;
  const shape = shapeOfGrid(g);
  return keyed && shape !== undefined ? { ...rest, grid: shape } : rest;
}

/** Writes a chunk, or removes it when nothing is left in it: no floor, edges, free walls, heights or stairs. On a hex scene it carries the stamp of its content (`stamped`). */
export function writeChunk(tx: Tx, written: BuildChunk): void {
  const chunk = stamped(tx, written);
  const empty =
    Object.keys(chunk.cells).length === 0 &&
    Object.keys(chunk.edges).length === 0 &&
    (chunk.walls?.length ?? 0) === 0 &&
    chunk.heights === undefined &&
    chunk.up === undefined &&
    chunk.rough === undefined;
  if (empty) {
    if (tx.state.buildChunks[chunkKey(chunk.sceneId, chunk.cx, chunk.cy)]) tx.remove(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy));
    return;
  }
  tx.write(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy), chunk);
}

export function buildPaint(tx: Tx, op: OpOf<"build.paint">): void {
  setCells(tx, tx.scene(op.sceneId), op.cells.map(parseCell), op.terrain);
  bumpWalls(tx, op.sceneId);
}

export function buildErase(tx: Tx, op: OpOf<"build.erase">): void {
  setCells(tx, tx.scene(op.sceneId), op.cells.map(parseCell), null);
  bumpWalls(tx, op.sceneId);
}

export function buildRect(tx: Tx, op: OpOf<"build.rect">): void {
  const scene = tx.scene(op.sceneId);
  if (op.w * op.h > MAX_BUILD_CELLS) throw new Refuse("quota", `at most ${MAX_BUILD_CELLS} cells per op`);
  const cells: Cell[] = [];
  for (let y = op.y; y < op.y + op.h; y++) for (let x = op.x; x < op.x + op.w; x++) cells.push({ x, y });
  setCells(tx, scene, cells, op.terrain);
  bumpWalls(tx, scene.id);
}

/** Cells whose centers lie inside the polygon, in the same fixed point as the fog so both agree on edges. */
export function buildPoly(tx: Tx, op: OpOf<"build.poly">): void {
  const scene = tx.scene(op.sceneId);
  const pts = op.points.map((v) => Math.round(v * 8));
  const n = Math.floor(pts.length / 2);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[2 * i]!);
    maxX = Math.max(maxX, pts[2 * i]!);
    minY = Math.min(minY, pts[2 * i + 1]!);
    maxY = Math.max(maxY, pts[2 * i + 1]!);
  }
  const x0 = Math.max(0, Math.floor(minX / 8));
  const y0 = Math.max(0, Math.floor(minY / 8));
  const x1 = Math.min(scene.bounds.w, Math.ceil(maxX / 8));
  const y1 = Math.min(scene.bounds.h, Math.ceil(maxY / 8));
  const cells: Cell[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (pointInPolygonFixed(pts, n, x * 8 + 4, y * 8 + 4)) cells.push({ x, y });
      if (cells.length > MAX_BUILD_CELLS) throw new Refuse("quota", `at most ${MAX_BUILD_CELLS} cells per op`);
    }
  }
  setCells(tx, scene, cells, op.terrain);
  bumpWalls(tx, scene.id);
}

export function buildEdge(tx: Tx, op: OpOf<"build.edge">): void {
  const scene = tx.scene(op.sceneId);
  const byChunk = new Map<string, OpOf<"build.edge">["edges"]>();
  for (const edge of op.edges) {
    if (!edgeInBounds(scene, edge.key)) throw invalid("edge outside the scene");
    const [xs, ys] = edge.key.split(",");
    const cell = { x: Number(xs), y: Number(ys) };
    const key = chunkKey(scene.id, Math.floor(cell.x / CHUNK_CELLS), Math.floor(cell.y / CHUNK_CELLS));
    const list = byChunk.get(key);
    if (list) list.push(edge);
    else byChunk.set(key, [edge]);
  }
  for (const key of [...byChunk.keys()].sort()) {
    const group = byChunk.get(key)!;
    const first = parseCell(group[0]!.key);
    const cx = Math.floor(first.x / CHUNK_CELLS);
    const cy = Math.floor(first.y / CHUNK_CELLS);
    const chunk = tx.state.buildChunks[key] ?? emptyChunk(scene.id, cx, cy);
    const edges = { ...chunk.edges };
    for (const edge of group) {
      if (edge.feature === null) delete edges[edge.key];
      else edges[edge.key] = edge.feature;
    }
    writeChunk(tx, { ...chunk, edges });
  }
  bumpWalls(tx, scene.id);
}

export function buildLabel(tx: Tx, op: OpOf<"build.label">): void {
  tx.scene(op.sceneId);
  const existing = tx.state.labels[op.labelId];
  if (op.label === null) {
    if (existing) tx.remove(keys.label(op.labelId));
    return;
  }
  if (existing && existing.sceneId !== op.sceneId) throw invalid("label belongs to another scene");
  const label: Label = { id: op.labelId, rev: existing?.rev ?? 0, sceneId: op.sceneId, ...op.label };
  tx.write(keys.label(label.id), label);
}

/** Removes the scene's whole build: floor, walls free or not, labels, stamps and lights. */
export function buildClear(tx: Tx, op: OpOf<"build.clear">): void {
  const scene = tx.scene(op.sceneId);
  const standing = standingOn(tx, scene.id, null);
  for (const key of Object.keys(tx.state.buildChunks).sort()) {
    const chunk = tx.state.buildChunks[key]!;
    if (chunk.sceneId === scene.id) tx.remove(keys.chunk(chunk.sceneId, chunk.cx, chunk.cy));
  }
  landOnGround(tx, standing);
  for (const id of Object.keys(tx.state.labels).sort()) {
    if (tx.state.labels[id]!.sceneId === scene.id) tx.remove(keys.label(id));
  }
  for (const id of Object.keys(tx.state.stamps).sort()) {
    if (tx.state.stamps[id]!.sceneId === scene.id) tx.remove(keys.stamp(id));
  }
  for (const id of Object.keys(tx.state.lights).sort()) {
    if (tx.state.lights[id]!.sceneId === scene.id) tx.remove(keys.light(id));
  }
  bumpWalls(tx, scene.id);
}

/**
 * Free walls (docs/design-v1-maps-vision.md 2.2). Removals apply first,
 * each naming its chunk, then each put lands in its midpoint's chunk and
 * replaces a wall of the same id there. Ends must lie in the scene, its
 * border included. The protocol already holds them to the 1/64 lattice and
 * 8 cells, and the room limits count them per scene.
 */
export function buildWalls(tx: Tx, op: OpOf<"build.walls">): void {
  const scene = tx.scene(op.sceneId);
  // Only the chunks whose walls change are written.
  const lists = new Map<string, { cx: number; cy: number; walls: FreeWall[] }>();
  const listOf = (cx: number, cy: number) => {
    const key = chunkKey(scene.id, cx, cy);
    let entry = lists.get(key);
    if (!entry) lists.set(key, (entry = { cx, cy, walls: [...(tx.state.buildChunks[key]?.walls ?? [])] }));
    return entry.walls;
  };
  for (const r of op.remove ?? []) {
    if (!tx.state.buildChunks[chunkKey(scene.id, r.cx, r.cy)]?.walls?.some((w) => w.id === r.id)) continue;
    const walls = listOf(r.cx, r.cy);
    const i = walls.findIndex((w) => w.id === r.id);
    if (i >= 0) walls.splice(i, 1);
  }
  const placed = new Set<string>();
  const onScene = (p: readonly [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= scene.bounds.w && p[1] <= scene.bounds.h;
  for (const input of op.put ?? []) {
    if (!onScene(input.a) || !onScene(input.b)) throw invalid("wall outside the scene");
    const { cx, cy } = wallChunk(input);
    const where = `${cx},${cy},${input.id}`;
    if (placed.has(where)) throw invalid("a wall appears twice");
    placed.add(where);
    const wall: FreeWall = { id: input.id, a: [input.a[0], input.a[1]], b: [input.b[0], input.b[1]], f: input.f };
    const walls = listOf(cx, cy);
    const i = walls.findIndex((w) => w.id === wall.id);
    if (i >= 0) walls[i] = wall;
    else walls.push(wall);
  }
  for (const key of [...lists.keys()].sort()) {
    const { cx, cy, walls } = lists.get(key)!;
    writeChunk(tx, withWalls(tx.state.buildChunks[key] ?? emptyChunk(scene.id, cx, cy), walls));
  }
  bumpWalls(tx, scene.id);
}

/**
 * Stamps (section 3.5). Removals apply first, then each put creates a
 * stamp or replaces the one of its id. A stamp stays on its scene: an id
 * that names one elsewhere is refused, as a label's is.
 */
export function buildStamps(tx: Tx, op: OpOf<"build.stamps">): void {
  const scene = tx.scene(op.sceneId);
  for (const id of op.remove ?? []) {
    const stamp = tx.state.stamps[id];
    if (!stamp) continue;
    if (stamp.sceneId !== scene.id) throw invalid("stamp belongs to another scene");
    tx.remove(keys.stamp(id));
  }
  const seen = new Set<string>();
  for (const input of op.put ?? []) {
    if (seen.has(input.id)) throw invalid("a stamp appears twice");
    seen.add(input.id);
    const existing = tx.state.stamps[input.id];
    if (existing && existing.sceneId !== scene.id) throw invalid("stamp belongs to another scene");
    const stamp: Stamp = { ...input, rev: existing?.rev ?? 0, sceneId: scene.id };
    tx.write(keys.stamp(stamp.id), stamp);
  }
}

/**
 * Lights (section 3.6), DM only in every wave. As stamps, plus each light
 * must stand in the scene, border included, since sight places it there.
 */
export function buildLights(tx: Tx, op: OpOf<"build.lights">): void {
  const scene = tx.scene(op.sceneId);
  for (const id of op.remove ?? []) {
    const light = tx.state.lights[id];
    if (!light) continue;
    if (light.sceneId !== scene.id) throw invalid("light belongs to another scene");
    tx.remove(keys.light(id));
  }
  const seen = new Set<string>();
  for (const input of op.put ?? []) {
    if (seen.has(input.id)) throw invalid("a light appears twice");
    seen.add(input.id);
    if (input.x > scene.bounds.w || input.y > scene.bounds.h) throw invalid("light outside the scene");
    const existing = tx.state.lights[input.id];
    if (existing && existing.sceneId !== scene.id) throw invalid("light belongs to another scene");
    const light: Light = { ...input, rev: existing?.rev ?? 0, sceneId: scene.id };
    tx.write(keys.light(light.id), light);
  }
}

/**
 * One door's state (docs/design-v1-maps-vision.md 4.1): open, closed or
 * locked, and for a secret door, found or hidden again. It writes only that
 * door, in its chunk, so a player's tap and its second tap need no undo,
 * and the walls version moves as for any build change. Who may set what is
 * shared/permissions.ts's.
 */
export function doorSet(tx: Tx, op: OpOf<"door.set">): void {
  const scene = tx.scene(op.sceneId);
  const { cx, cy } = doorChunk(op.door);
  const chunk = tx.state.buildChunks[chunkKey(scene.id, cx, cy)];
  const set = (f: WallFeature): WallFeature | null => {
    if (f.kind !== "door") return null;
    const next = { ...f, state: op.state, discovered: op.found ?? f.discovered };
    return next.state === f.state && next.discovered === f.discovered ? f : next;
  };
  if ("edge" in op.door) {
    const edge = op.door.edge;
    const feature = chunk?.edges[edge];
    const next = feature && feature.kind !== "none" ? set(feature) : null;
    if (!chunk || !next) throw gone("door");
    if (next === feature) return;
    writeChunk(tx, { ...chunk, edges: { ...chunk.edges, [edge]: next } });
  } else {
    const id = op.door.id;
    const wall = chunk?.walls?.find((w) => w.id === id);
    const next = wall ? set(wall.f) : null;
    if (!chunk || !wall || !next) throw gone("door");
    if (next === wall.f) return;
    writeChunk(tx, withWalls(chunk, (chunk.walls ?? []).map((w) => (w.id === id ? { ...w, f: next } : w))));
  }
  bumpWalls(tx, scene.id);
}
