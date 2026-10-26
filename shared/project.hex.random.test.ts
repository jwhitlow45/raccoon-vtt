import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, tileKey } from "./keys.ts";
import { lineAudience } from "./logRings.ts";
import type { FogTile, GridShape, LogEntry, Light, PathStop, RoomState, SightTile, Token, Viewer } from "./model.ts";
import { isPartyMember, ownsToken, projectState, stableStringify } from "./project.ts";
import type { Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { visionRules } from "./ruleHooks.ts";
import { occupiedHexes, placedOnHex, tokenRefHex, type PlacedToken } from "./rules/footprint.ts";
import { decodeTile, encodeTile, getBit, TILE_BYTES, TILE_SUB } from "./rules/fog.ts";
import { gridOfShape } from "./rules/grid.ts";
import { hexAt, hexCenter, hexInScene, hexLine, sameHex, type Hex, type HexGrid } from "./rules/hex.ts";
import { sightTileLevels } from "./rules/vision.ts";
import { actor, chance, DM, env, int, member, pick, rng, room, scene, token } from "./testutil.ts";

/**
 * The security property of hex grids (docs/design-v1-hex-grids.md HX-D10,
 * beside the square properties in project.test.ts): over random hex
 * scenes, both orientations, whole party and per player, with and without
 * vision, a player's or table display's projection never holds a creature
 * that the footprint test says they cannot see, worked out here from
 * nothing: the fog sub-cells inside its hexes, each found by `hexAt` alone,
 * read from the stored layers the viewer's fog joins, or with vision on the
 * levels of the sight that viewer has. And the sight and fog tiles they get
 * are exactly their own. Over random walks, a turn's path, its start and
 * its turn line reach a player only where that test allows, the corners of
 * a path compacted past its stop limit included.
 */

const P1: Viewer = { memberId: "p1", role: "player" };
const P2: Viewer = { memberId: "p2", role: "player" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const;

/** Random revealed bits over a scene: rects of sub-cells, as reveals and explores leave them. */
function randomLayer(r: () => number, w: number, h: number, sceneId: string, key: (tx: number, ty: number) => string): Record<string, FogTile> {
  const bits = new Map<string, { tx: number; ty: number; b: Uint8Array }>();
  for (let n = int(r, 0, 6); n > 0; n--) {
    const x0 = int(r, 0, w * 4 - 1);
    const y0 = int(r, 0, h * 4 - 1);
    const x1 = Math.min(w * 4, x0 + int(r, 1, 40));
    const y1 = Math.min(h * 4, y0 + int(r, 1, 40));
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const tx = Math.floor(sx / TILE_SUB);
        const ty = Math.floor(sy / TILE_SUB);
        const k = key(tx, ty);
        let e = bits.get(k);
        if (!e) bits.set(k, (e = { tx, ty, b: new Uint8Array(TILE_BYTES) }));
        const i = (sy - ty * TILE_SUB) * TILE_SUB + (sx - tx * TILE_SUB);
        e.b[i >> 3] = e.b[i >> 3]! | (1 << (i & 7));
      }
    }
  }
  return Object.fromEntries([...bits].map(([k, e]) => [k, { sceneId, tx: e.tx, ty: e.ty, rev: 1, bits: encodeTile(e.b) }]));
}

function randomToken(r: () => number, id: string, w: number, h: number, extra: Partial<Token> = {}): Token {
  const size = pick(r, SIZES);
  const custom = size === "custom" ? { w: 0.5 + int(r, 0, 30) / 8, h: 0.5 + int(r, 0, 30) / 8 } : {};
  return token(id, { size, ...custom, x: r() * (w - 1), y: r() * (h - 1), ...extra });
}

type Case = { state: RoomState; g: HexGrid; perPlayer: boolean; vision: boolean; fog: boolean };

function randomHexRoom(seed: number): Case {
  const r = rng(seed);
  const shape: GridShape = chance(r, 0.5) ? "hexRows" : "hexColumns";
  const w = int(r, 12, 40);
  const h = int(r, 12, 40);
  const vision = chance(r, 0.6);
  const fog = vision || chance(r, 0.7);
  const perPlayer = chance(r, 0.5);
  const state = room({
    scenes: { s1: scene("s1", { gridShape: shape, bounds: { w, h }, fogEnabled: fog, ...(vision || perPlayer ? { vision: { on: vision, light: pick(r, ["bright", "dim", "dark"] as const), ...(perPlayer ? { perPlayer: true } : {}) } } : {}) }), s2: scene("s2", { order: 1 }) },
  });
  // The players' creatures, seeing in the dark, and an ally lending the party its sight.
  for (let i = 0; i < int(r, 1, 3); i++) {
    const owner = pick(r, ["p1", "p2"]);
    state.tokens[`pc${i}`] = randomToken(r, `pc${i}`, w, h, { kind: "pc", ownerIds: [owner], actor: { inline: actor({ senses: `darkvision ${int(r, 2, 8) * 5} ft` }) } });
  }
  if (chance(r, 0.4)) state.tokens.ally = randomToken(r, "ally", w, h, { kind: "npc", partyVision: true, actor: { inline: actor({ senses: "darkvision 30 ft" }) } });
  for (let i = 0; i < int(r, 4, 14); i++) {
    state.tokens[`m${i}`] = randomToken(r, `m${i}`, w, h, { ...(chance(r, 0.1) ? { fogExempt: true } : {}), ...(chance(r, 0.1) ? { visibility: "dm" as const } : {}) });
  }
  for (let i = 0; i < int(r, 0, 2); i++) {
    const light: Light = { id: `l${i}`, rev: 0, sceneId: "s1", x: r() * w, y: r() * h, bright: int(r, 1, 4) * 5, dim: int(r, 4, 8) * 5, on: true, walls: true };
    state.lights[light.id] = light;
  }
  state.fogTiles = randomLayer(r, w, h, "s1", (tx, ty) => tileKey("s1", tx, ty));
  state.exploredTiles = randomLayer(r, w, h, "s1", (tx, ty) => tileKey("s1", tx, ty));
  if (perPlayer) {
    state.holders = { s1: { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] } };
    state.exploredBy = Object.fromEntries(Object.entries(randomLayer(r, w, h, "s1", (tx, ty) => holderTileKey("s1", "p1", tx, ty))).map(([k, t]) => [k, { ...t, memberId: "p1" }]));
  }
  return { state, g: gridOfShape(shape) as HexGrid, perPlayer, vision, fog };
}

/** Whether a sub-cell is revealed in any of the layers, read from their stored bits. */
function revealedIn(layers: readonly (FogTile | undefined)[], sx: number, sy: number): boolean {
  return layers.some((t) => {
    if (!t) return false;
    const bits = decodeTile(t.bits);
    return bits !== null && getBit(bits, sx - t.tx * TILE_SUB, sy - t.ty * TILE_SUB);
  });
}

/** The fog layers a viewer's fog joins: the DM's and the party's, and on a per-player scene a holder's own. */
function layersFor(c: Case, viewer: Viewer, tx: number, ty: number): (FogTile | undefined)[] {
  const out = [c.state.fogTiles[tileKey("s1", tx, ty)], c.state.exploredTiles[tileKey("s1", tx, ty)]];
  if (c.perPlayer && viewer.memberId === "p1") out.push(c.state.exploredBy[holderTileKey("s1", "p1", tx, ty)]);
  return out;
}

/** The sight a viewer has: the party's, or on a per-player scene the holder's own and everyone else's the shared one. */
function sightFor(c: Case, viewer: Viewer) {
  if (!c.perPlayer) return visionRules.partySight(c.state, "s1");
  return visionRules.holderSight(c.state, "s1", viewer.memberId === "p1" ? "p1" : null);
}

function levelAt(tiles: ReadonlyMap<string, SightTile>, sx: number, sy: number): number {
  const t = tiles.get(`${Math.floor(sx / 64)},${Math.floor(sy / 64)}`);
  const lv = t ? sightTileLevels(t) : null;
  return lv ? lv[(sy % 64) * 64 + (sx % 64)]! : 0;
}

/**
 * A hex's fog sub-cells found from nothing: every sub-cell near it whose
 * center `hexAt` puts in it, so a wrong `hexSubcells` cannot agree with
 * itself here (review HX2-OPUS-08).
 */
function subcellsOf(g: HexGrid, h: Hex): [number, number][] {
  const c = hexCenter(g, h);
  const out: [number, number][] = [];
  for (let sy = Math.floor((c.y - 1) * 4); sy <= Math.ceil((c.y + 1) * 4); sy++) {
    for (let sx = Math.floor((c.x - 1) * 4); sx <= Math.ceil((c.x + 1) * 4); sx++) {
      if (sameHex(hexAt(g, { x: (sx + 0.5) / 4, y: (sy + 0.5) / 4 }), h)) out.push([sx, sy]);
    }
  }
  assert.ok(out.length >= 12 && out.length <= 16, `hex ${h.col},${h.row} holds ${out.length} sub-cells`);
  return out;
}

/** The fog sub-cells inside a creature's hexes, each hex's found from nothing. */
function footprintFromNothing(g: HexGrid, t: PlacedToken): [number, number][] {
  return occupiedHexes(g, t).flatMap((h) => subcellsOf(g, h));
}

/** The footprint test from nothing: whether the viewer may see the creature where it stands. */
function mayKnow(c: Case, viewer: Viewer, t: Token): boolean {
  if (ownsToken(c.state, viewer, t)) return true;
  if (t.visibility === "dm") return false;
  if (t.fogExempt || t.partyVision || t.ownerIds.length > 0) return true;
  const subs = footprintFromNothing(c.g, t as PlacedToken);
  if (c.vision) {
    const tiles = sightFor(c, viewer).tiles;
    return subs.some(([sx, sy]) => sx >= 0 && sy >= 0 && levelAt(tiles, sx, sy) > 0);
  }
  if (!c.fog) return true;
  return subs.some(([sx, sy]) => sx >= 0 && sy >= 0 && revealedIn(layersFor(c, viewer, Math.floor(sx / TILE_SUB), Math.floor(sy / TILE_SUB)), sx, sy));
}

describe("hex scenes over random rooms: no player gets a creature or a tile the footprint test keeps from them", () => {
  test("in either vision mode, for each player and a table display, and every creature the test allows reaches them", () => {
    let shown = 0;
    let kept = 0;
    for (let seed = 1; seed <= 160; seed++) {
      const c = randomHexRoom(seed);
      for (const viewer of [P1, P2, DISPLAY]) {
        const p = projectState(c.state, viewer, { sceneId: "s1" });
        for (const t of Object.values(c.state.tokens)) {
          const allowed = mayKnow(c, viewer, t);
          assert.equal(p.tokens[t.id] !== undefined, allowed, `seed ${seed} ${viewer.memberId} ${t.id} ${JSON.stringify({ size: t.size, x: t.x, y: t.y })}`);
          if (!ownsToken(c.state, viewer, t) && !t.partyVision && t.ownerIds.length === 0 && t.visibility !== "dm" && !t.fogExempt) {
            if (allowed) shown++;
            else kept++;
          }
        }
        // The sight it holds is its own, tile for tile, and nothing more.
        const sight = (p as unknown as { sight?: Record<string, SightTile> }).sight ?? {};
        const own = c.vision ? sightFor(c, viewer).tiles : new Map<string, SightTile>();
        assert.deepEqual(Object.keys(sight).sort(), [...own.keys()].map((k) => `s1:${k}`).sort(), `seed ${seed} ${viewer.memberId} sight tiles`);
        for (const [k, tile] of own) assert.equal(stableStringify(sight[`s1:${k}`]), stableStringify(tile), `seed ${seed} ${viewer.memberId} sight ${k}`);
        // Its fog is its own layers joined, sub-cell for sub-cell where it holds a tile.
        for (const [key, tile] of Object.entries(p.fogTiles)) {
          if (!key.startsWith("s1:")) continue;
          const bits = decodeTile(tile.bits)!;
          const layers = layersFor(c, viewer, tile.tx, tile.ty);
          for (let i = 0; i < TILE_SUB * TILE_SUB; i += 7) {
            const sx = tile.tx * TILE_SUB + (i % TILE_SUB);
            const sy = tile.ty * TILE_SUB + Math.floor(i / TILE_SUB);
            assert.equal(getBit(bits, i % TILE_SUB, Math.floor(i / TILE_SUB)), revealedIn(layers, sx, sy), `seed ${seed} ${viewer.memberId} fog ${key} ${i}`);
          }
        }
      }
    }
    assert.ok(shown > 100 && kept > 100, `${shown} creatures shown and ${kept} kept`);
  });
});

const P3: Viewer = { memberId: "p3", role: "player" };

type WalkCase = { state: RoomState; g: HexGrid; perPlayer: boolean; holders: string[] };

/**
 * Every sub-cell of the scene revealed but those of some hexes picked at
 * random, so a hex lies wholly under the fog beside a revealed part of a
 * cell it shares with its neighbors, the case a cell's reading misses.
 */
function wholeLayer(r: () => number, g: HexGrid, w: number, h: number, sceneId: string, key: (tx: number, ty: number) => string): Record<string, FogTile> {
  const bits = new Map<string, { tx: number; ty: number; b: Uint8Array }>();
  for (let ty = 0; ty * TILE_SUB < h * 4; ty++) {
    for (let tx = 0; tx * TILE_SUB < w * 4; tx++) bits.set(`${tx},${ty}`, { tx, ty, b: new Uint8Array(TILE_BYTES).fill(255) });
  }
  for (let n = int(r, 4, 20); n > 0; n--) {
    for (const [sx, sy] of subcellsOf(g, { col: int(r, 0, w), row: int(r, 0, h) })) {
      const e = bits.get(`${Math.floor(sx / TILE_SUB)},${Math.floor(sy / TILE_SUB)}`);
      if (!e || sx < 0 || sy < 0) continue;
      const i = (sy - e.ty * TILE_SUB) * TILE_SUB + (sx - e.tx * TILE_SUB);
      e.b[i >> 3] = e.b[i >> 3]! & ~(1 << (i & 7));
    }
  }
  return Object.fromEntries([...bits.values()].map((e) => [key(e.tx, e.ty), { sceneId, tx: e.tx, ty: e.ty, rev: 1, bits: encodeTile(e.b) }]));
}

/** A hex the creature stands wholly inside the scene on, near `around` and away from where it stands when given. */
function spotNear(r: () => number, g: HexGrid, state: RoomState, t: Token, around: Hex | null): { x: number; y: number } {
  const { w, h } = state.scenes.s1!.bounds;
  for (;;) {
    const hex = around ? { col: around.col + int(r, -4, 4), row: around.row + int(r, -4, 4) } : { col: int(r, 0, w), row: int(r, 0, h) };
    const p = placedOnHex(g, t as PlacedToken, hex);
    const moves = !around || p.x !== t.x || p.y !== t.y;
    if (moves && occupiedHexes(g, { ...(t as PlacedToken), ...p }).every((x) => hexInScene(g, state.scenes.s1!.bounds, x))) return p;
  }
}

/** A hex scene with random fog layers, per player in most rooms with p1 and perhaps p3 holding sight, a creature p1 and p2 own and a DM's creature. */
function randomWalkRoom(r: () => number): WalkCase {
  const shape: GridShape = chance(r, 0.5) ? "hexRows" : "hexColumns";
  const g = gridOfShape(shape) as HexGrid;
  const w = int(r, 16, 30);
  const h = int(r, 16, 30);
  const perPlayer = chance(r, 0.75);
  const state = room({ scenes: { s1: scene("s1", { gridShape: shape, bounds: { w, h }, fogEnabled: true, ...(perPlayer ? { vision: { on: false, light: "bright", perPlayer: true } } : {}) }), s2: scene("s2", { order: 1 }) } });
  state.members.p3 = member("p3");
  const hero = randomToken(r, "hero", w, h, { kind: "pc", ownerIds: ["p1", "p2"] });
  state.tokens.hero = { ...hero, ...spotNear(r, g, state, hero, null) };
  const monster = randomToken(r, "m", w, h);
  state.tokens.m = { ...monster, ...spotNear(r, g, state, monster, null) };
  state.fogTiles = chance(r, 0.4) ? wholeLayer(r, g, w, h, "s1", (tx, ty) => tileKey("s1", tx, ty)) : randomLayer(r, w, h, "s1", (tx, ty) => tileKey("s1", tx, ty));
  state.exploredTiles = randomLayer(r, w, h, "s1", (tx, ty) => tileKey("s1", tx, ty));
  const holders = perPlayer ? ["p1", ...(chance(r, 0.5) ? ["p3"] : [])] : [];
  if (perPlayer) state.holders = { s1: { sceneId: "s1", rev: 1, entries: holders.map((memberId) => ({ memberId, on: true })) } };
  for (const id of holders) {
    // A holder who has explored the whole scene keeps corners over ground the shared fog hides.
    const layer = id === "p1" && chance(r, 0.4) ? wholeLayer(r, g, w, h, "s1", (tx, ty) => holderTileKey("s1", id, tx, ty)) : randomLayer(r, w, h, "s1", (tx, ty) => holderTileKey("s1", id, tx, ty));
    for (const [k, t] of Object.entries(layer)) state.exploredBy[k] = { ...t, memberId: id };
  }
  return { state, g, perPlayer, holders };
}

/** Whether a sub-cell is revealed in the layers a viewer's fog joins, read from the stored bits, each tile decoded once. */
function revealedFor(c: WalkCase, viewer: Viewer | null): (sx: number, sy: number) => boolean {
  const bits = new Map<string, (Uint8Array | null)[]>();
  const own = viewer !== null && c.holders.includes(viewer.memberId) ? viewer.memberId : null;
  return (sx, sy) => {
    if (sx < 0 || sy < 0) return false;
    const tx = Math.floor(sx / TILE_SUB);
    const ty = Math.floor(sy / TILE_SUB);
    const key = `${tx},${ty}`;
    let layers = bits.get(key);
    if (!layers) {
      const tiles = [c.state.fogTiles[tileKey("s1", tx, ty)], c.state.exploredTiles[tileKey("s1", tx, ty)], own ? c.state.exploredBy[holderTileKey("s1", own, tx, ty)] : undefined];
      bits.set(key, (layers = tiles.map((t) => (t ? decodeTile(t.bits) : null))));
    }
    return layers.some((b) => b !== null && getBit(b, sx - tx * TILE_SUB, sy - ty * TILE_SUB));
  };
}

/** Whether the creature at a spot shows on that ground: some sub-cell inside its hexes revealed. */
function shows(g: HexGrid, t: PlacedToken, revealed: (sx: number, sy: number) => boolean): boolean {
  return footprintFromNothing(g, t).some(([sx, sy]) => revealed(sx, sy));
}

/** Whether every hex of the creature at a spot holds a revealed sub-cell. */
function onGround(g: HexGrid, t: PlacedToken, revealed: (sx: number, sy: number) => boolean): boolean {
  return occupiedHexes(g, t).every((h) => subcellsOf(g, h).some(([sx, sy]) => revealed(sx, sy)));
}

/** The spots a leg with corners passes on hexes, worked out from the hex lines between its parts' ends: the start, then each part's hexes past its start, its end where it ends. */
function legSpots(g: HexGrid, t: PlacedToken, from: PathStop, to: PathStop): PlacedToken[] {
  const via = to.via ?? [];
  const ends = [{ x: from.x, y: from.y }];
  for (let k = 0; k + 1 < via.length; k += 2) ends.push({ x: via[k]!, y: via[k + 1]! });
  ends.push({ x: to.x, y: to.y });
  const out: PlacedToken[] = [{ ...t, ...ends[0]! }];
  for (let i = 1; i < ends.length; i++) {
    const line = hexLine(g, tokenRefHex(g, { ...t, ...ends[i - 1]! }), tokenRefHex(g, { ...t, ...ends[i]! }));
    for (let k = 1; k < line.length - 1; k++) out.push({ ...t, ...placedOnHex(g, t, line[k]!) });
    out.push({ ...t, ...ends[i]! });
  }
  return out;
}

describe("hex scenes over random walks: a turn's path, its start and its turn line reach a player only where the footprint test allows (reviews HX2-ASTRA-01, HX2-SEC-04)", () => {
  test("51 or more plain moves of a creature two players own and of a DM's creature, so each path compacts", () => {
    const tally = { ownerKept: 0, ownerDropped: 0, othersCorners: 0, stopsKept: 0, stopsShown: 0, turnLines: 0 };
    for (let seed = 1; seed <= 120; seed++) {
      const r = rng(5000 + seed);
      const c = randomWalkRoom(r);
      let seq = 0;
      const run = (op: Op): LogEntry[] => {
        const res = applyOp(c.state, op, DM, env(++seq));
        assert.ok(res.ok, `seed ${seed} ${op.t}: ${res.ok ? "" : res.message}`);
        c.state = res.state;
        return res.log;
      };
      run({ t: "encounter.start", entries: [{ id: "n1", tokenId: "hero", value: 20 }, { id: "n2", tokenId: "m", value: 10 }] });
      for (const tokenId of ["hero", "m"]) {
        const lines = run({ t: "encounter.next" });
        assert.equal(c.state.encounter!.turnStart!.tokenId, tokenId);
        for (let i = int(r, 51, 58); i > 0; i--) {
          const t = c.state.tokens[tokenId]!;
          run({ t: "token.move", tokenId, ...spotNear(r, c.g, c.state, t, tokenRefHex(c.g, t as PlacedToken)) });
        }
        const real = c.state.tokens[tokenId]!;
        const stored = real.path!.stops;
        assert.ok(stored.some((s) => s.via !== undefined), `seed ${seed} ${tokenId}: the path compacted`);
        const party = isPartyMember(c.state, real);
        const shared = revealedFor(c, null);
        const start = c.state.encounter!.turnStart!;
        const startSpot = { ...(real as PlacedToken), x: start.x, y: start.y };
        for (const viewer of [P1, P2, P3, DISPLAY]) {
          const where = `seed ${seed} ${tokenId} ${viewer.memberId}`;
          const own = revealedFor(c, viewer);
          const p = projectState(c.state, viewer, { sceneId: "s1" });
          const stops = p.tokens[tokenId]?.path?.stops ?? [];
          if (ownsToken(c.state, viewer, real)) {
            assert.equal(stops.length, stored.length, where);
            stops.forEach((stop, i) => {
              if (stored[i]!.via === undefined) return;
              if (stop.via === undefined) return void tally.ownerDropped++;
              // On a per-player scene an owner's corners cross only hexes their own fog reveals a sub-cell of.
              if (c.perPlayer) assert.ok(legSpots(c.g, real as PlacedToken, stored[i - 1]!, stored[i]!).every((t) => onGround(c.g, t, own)), `${where}: corners of stop ${i} off their ground`);
              if (stored[i]!.routeSeen !== true) tally.ownerKept++;
            });
            continue;
          }
          const sees = (t: PlacedToken) => party || shows(c.g, t, own);
          // Every stop they get shows the creature to them, and so do its start and its turn line.
          const got = stored.flatMap((s, i) => (s.seen === true || s.seenBy?.includes(viewer.memberId) ? [i] : []));
          // A creature, or a row, they do not see now sends no path at all.
          if (p.tokens[tokenId]?.path !== undefined) assert.equal(stops.length, got.length, `${where}: stops`);
          tally.stopsKept += stored.length - got.length;
          tally.stopsShown += got.length;
          stops.forEach((stop, k) => {
            const i = got[k]!;
            assert.ok(sees({ ...(real as PlacedToken), x: stop.x, y: stop.y }), `${where}: stop ${i} where they cannot see it`);
            if (stop.via === undefined) return;
            tally.othersCorners++;
            // Corners reach them only over ground every player shares: every hex of it on a per-player scene, and in sight on a whole-party one.
            const ok = (t: PlacedToken) => (c.perPlayer ? onGround(c.g, t, shared) : party || shows(c.g, t, shared));
            assert.ok(legSpots(c.g, real as PlacedToken, stored[i - 1]!, stored[i]!).every(ok), `${where}: corners of stop ${i} off shared ground`);
          });
          if (p.encounter?.turnStart) assert.ok(sees(startSpot), `${where}: the turn's start where they could not see it`);
        }
        for (const line of lines) {
          if (line.kind !== "event" || line.data?.type !== "turn" || line.data.entryId !== (tokenId === "hero" ? "n1" : "n2")) continue;
          const audience = lineAudience(line);
          const readers = audience === "party" ? [line.to![0]!] : audience === "shared" ? ["p1", "p2", "p3"] : [];
          for (const reader of readers) {
            if (ownsToken(c.state, { memberId: reader, role: "player" }, real)) continue;
            tally.turnLines++;
            assert.ok(party || shows(c.g, startSpot, revealedFor(c, { memberId: reader, role: "player" })), `seed ${seed} ${tokenId}: the turn line reaches ${reader}, who could not see it begin`);
          }
        }
      }
    }
    assert.ok(tally.ownerDropped > 5 && tally.ownerKept > 5 && tally.othersCorners > 5 && tally.stopsKept > 50 && tally.stopsShown > 50 && tally.turnLines > 5, JSON.stringify(tally));
  });
});
