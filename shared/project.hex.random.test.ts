import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, tileKey } from "./keys.ts";
import type { FogTile, GridShape, Light, RoomState, SightTile, Token, Viewer } from "./model.ts";
import { ownsToken, projectState, stableStringify } from "./project.ts";
import { visionRules } from "./ruleHooks.ts";
import { footprintSubcells, type PlacedToken } from "./rules/footprint.ts";
import { decodeTile, encodeTile, getBit, TILE_BYTES, TILE_SUB } from "./rules/fog.ts";
import { gridOfShape } from "./rules/grid.ts";
import type { HexGrid } from "./rules/hex.ts";
import { sightTileLevels } from "./rules/vision.ts";
import { actor, chance, int, pick, rng, room, scene, token } from "./testutil.ts";

/**
 * The security property of hex grids (docs/design-v1-hex-grids.md HX-D10,
 * beside the square properties in project.test.ts): over random hex
 * scenes, both orientations, whole party and per player, with and without
 * vision, a player's or table display's projection never holds a creature
 * that the footprint test says they cannot see, worked out here from
 * nothing: the fog sub-cells inside its hexes, read from the stored layers
 * the viewer's fog joins, or with vision on the levels of the sight that
 * viewer has. And the sight and fog tiles they get are exactly their own.
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

/** The footprint test from nothing: whether the viewer may see the creature where it stands. */
function mayKnow(c: Case, viewer: Viewer, t: Token): boolean {
  if (ownsToken(c.state, viewer, t)) return true;
  if (t.visibility === "dm") return false;
  if (t.fogExempt || t.partyVision || t.ownerIds.length > 0) return true;
  const subs = footprintSubcells(c.g, t as PlacedToken);
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
