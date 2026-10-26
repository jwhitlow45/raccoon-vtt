import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wallChunk } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import { CHUNK_CELLS, type BuildChunk, type EdgeFeature, type FreeWall, type Light, type RoomState, type Scene, type SightTile, type TerrainId, type Token } from "../model.ts";
import { ownsToken } from "../project.ts";
import { visionRules } from "../ruleHooks.ts";
import { actor, character, rng, room, scene, token } from "../testutil.ts";
import { decodeTile, getBit } from "./fog.ts";
import { footprintRect } from "./footprint.ts";
import { encodeHeights } from "./heights.ts";
import { contact, orient, pointInPolygon, SIGHT, stepOffWalls } from "./segments.ts";
import {
  clearVisionCache,
  coldHolderSight,
  coldPartySight,
  coldSightOf,
  holderSight,
  NO_PARTY_SIGHT,
  parseSenses,
  partyMember,
  partySight,
  RAISED_TAG,
  seenFogBits,
  sightEntryMaxBytes,
  sightFromTiles,
  sightRect,
  sightTileLevels,
  soleSourcesOf,
  sourcePolygon,
  visibleFrom,
  visionCacheReport,
  visionReport,
  type VisionWorld,
} from "./vision.ts";
import { RAISED, sceneWalls, type WallSet } from "./walls.ts";

const world: VisionWorld = { walls: sceneWalls };

// ---------------------------------------------------------------------------
// Fixtures

type Build = {
  cells?: Record<string, TerrainId>;
  edges?: Record<string, EdgeFeature>;
  walls?: FreeWall[];
  /** Ground in feet by cell key. */
  heights?: Record<string, number>;
};

/** A scene's build as stored: 16 x 16 chunks, free walls in their midpoint's chunk, heights encoded per chunk. */
function chunksOf(sceneId: string, build: Build): Record<string, BuildChunk> {
  const out: Record<string, BuildChunk> = {};
  const at = (cx: number, cy: number) => (out[`${sceneId}:${cx},${cy}`] ??= { sceneId, cx, cy, rev: 1, cells: {}, edges: {} });
  for (const [key, terrain] of Object.entries(build.cells ?? {})) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    at(Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS)).cells[key] = terrain;
  }
  for (const [key, feature] of Object.entries(build.edges ?? {})) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    at(Math.floor(x / CHUNK_CELLS), Math.floor(y / CHUNK_CELLS)).edges[key] = feature;
  }
  for (const w of build.walls ?? []) {
    const { cx, cy } = wallChunk(w);
    (at(cx, cy).walls ??= []).push(w);
  }
  const feet = new Map<string, number[]>();
  for (const [key, h] of Object.entries(build.heights ?? {})) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    const cx = Math.floor(x / CHUNK_CELLS);
    const cy = Math.floor(y / CHUNK_CELLS);
    let list = feet.get(`${cx},${cy}`);
    if (!list) feet.set(`${cx},${cy}`, (list = new Array<number>(CHUNK_CELLS * CHUNK_CELLS).fill(0)));
    list[(y - cy * CHUNK_CELLS) * CHUNK_CELLS + (x - cx * CHUNK_CELLS)] = h;
  }
  for (const [key, list] of feet) {
    const [cx, cy] = key.split(",").map(Number) as [number, number];
    const heights = encodeHeights(list);
    if (heights) at(cx, cy).heights = heights;
  }
  return out;
}

let wallIds = 0;
function free(ax: number, ay: number, bx: number, by: number, f: FreeWall["f"] = { kind: "wall" }): FreeWall {
  return { id: `w${String(wallIds++).padStart(11, "0")}`, a: [ax, ay], b: [bx, by], f };
}

const WALL: EdgeFeature = { kind: "wall" };

/** Walls around a rectangle of cells, as drawn edges. */
function roomEdges(x0: number, y0: number, w: number, h: number, edges: Record<string, EdgeFeature> = {}): Record<string, EdgeFeature> {
  for (let x = x0; x < x0 + w; x++) {
    edges[`${x},${y0},n`] = WALL;
    edges[`${x},${y0 + h},n`] = WALL;
  }
  for (let y = y0; y < y0 + h; y++) {
    edges[`${x0},${y},w`] = WALL;
    edges[`${x0 + w},${y},w`] = WALL;
  }
  return edges;
}

function visionRoom(opts: { w?: number; h?: number; light?: "bright" | "dim" | "dark"; build?: Build; tokens?: Token[]; lights?: Light[]; autoWalls?: Scene["autoWalls"] }): RoomState {
  const w = opts.w ?? 32;
  const h = opts.h ?? 32;
  const s = room({ scenes: { s1: scene("s1", { bounds: { w, h }, fogEnabled: true, vision: { on: true, light: opts.light ?? "bright" }, autoWalls: opts.autoWalls ?? "off" }) } });
  s.buildChunks = chunksOf("s1", opts.build ?? {});
  for (const t of opts.tokens ?? []) s.tokens[t.id] = t;
  for (const l of opts.lights ?? []) s.lights[l.id] = l;
  return s;
}

/** A player's character token: owned, a creature, alive. */
function pc(id: string, x: number, y: number, overrides: Partial<Token> & { senses?: string } = {}): Token {
  const { senses, ...rest } = overrides;
  return token(id, { kind: "pc", ownerIds: ["p1"], x, y, actor: { inline: actor({ senses: senses ?? "" }) }, ...rest });
}

function light(id: string, x: number, y: number, bright: number, dim: number, overrides: Partial<Light> = {}): Light {
  return { id, rev: 0, sceneId: "s1", x, y, bright, dim, on: true, walls: true, ...overrides };
}

/** The level of every sub-cell of a scene, row by row. */
function levelsOf(tiles: ReadonlyMap<string, SightTile>, w: number, h: number): Uint8Array {
  const W = w * 4;
  const H = h * 4;
  const out = new Uint8Array(W * H);
  for (const [key, tile] of tiles) {
    const [tx, ty] = key.split(",").map(Number) as [number, number];
    const lv = sightTileLevels(tile);
    assert.ok(lv, `tile ${key} reads`);
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < 64; c++) {
        const sx = tx * 64 + c;
        const sy = ty * 64 + r;
        if (sx < W && sy < H) out[sy * W + sx] = lv[r * 64 + c]!;
        else assert.equal(lv[r * 64 + c], 0, "nothing is seen past the scene");
      }
    }
  }
  return out;
}

function sameTiles(a: ReadonlyMap<string, SightTile>, b: ReadonlyMap<string, SightTile>, label: string): void {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const k of keys) assert.deepEqual(a.get(k), b.get(k), `${label}: tile ${k}`);
}

/** Center of sub-cell i, in cells. */
const center = (i: number) => (2 * i + 1) / 8;

// ---------------------------------------------------------------------------
// The independent oracle

/**
 * Whether the straight line from the eye to a point meets any of the
 * stored segments, unsplit and unclipped: an independent brute-force ray
 * cast (section 2.1), with the exact contact test.
 */
function rayClear(ex: number, ey: number, px: number, py: number, stored: Float64Array): boolean {
  for (let k = 0; k < stored.length; k += 4) {
    if (contact(ex, ey, px, py, stored[k]!, stored[k + 1]!, stored[k + 2]!, stored[k + 3]!) !== 0) return false;
  }
  return true;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
}

/** Whether a point lies within `eps` of a polygon's boundary or of any stored segment, where the two answers may differ by rounding alone. */
function degenerate(px: number, py: number, poly: Float64Array, stored: Float64Array, ex: number, ey: number, eps = 1e-9): boolean {
  const n = poly.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) if (distToSeg(px, py, poly[2 * j]!, poly[2 * j + 1]!, poly[2 * i]!, poly[2 * i + 1]!) < eps) return true;
  for (let k = 0; k < stored.length; k += 4) {
    const ax = stored[k]!;
    const ay = stored[k + 1]!;
    const bx = stored[k + 2]!;
    const by = stored[k + 3]!;
    if (distToSeg(px, py, ax, ay, bx, by) < eps) return true;
    // The ray from the eye grazes a wall's end: the shadow's edge.
    for (const [qx, qy] of [
      [ax, ay],
      [bx, by],
    ] as const) {
      if (distToSeg(qx, qy, ex, ey, px, py) < eps) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Random scenes

function lattice(r: () => number, max: number): number {
  return Math.floor(r() * max * 64) / 64;
}

/** A random build over a size x size scene: grid walls and doors, pillars, crossing free walls and raised areas. */
function randomBuild(r: () => number, size: number, opts: { freeWalls?: number; heights?: boolean } = {}): Build {
  const edges: Record<string, EdgeFeature> = {};
  const cells: Record<string, TerrainId> = {};
  for (let k = 0; k < size * 3; k++) {
    const x = Math.floor(r() * size);
    const y = Math.floor(r() * size);
    const side = r() < 0.5 ? "n" : "w";
    const roll = r();
    edges[`${x},${y},${side}`] =
      roll < 0.7 ? WALL : roll < 0.8 ? { kind: "window" } : { kind: "door", state: r() < 0.5 ? "open" : "closed", secret: r() < 0.2, discovered: r() < 0.5 };
  }
  for (let k = 0; k < size / 4; k++) cells[`${Math.floor(r() * size)},${Math.floor(r() * size)}`] = "pillar";
  const walls: FreeWall[] = [];
  for (let k = 0; k < (opts.freeWalls ?? size); k++) {
    const ax = lattice(r, size);
    const ay = lattice(r, size);
    let bx = ax + lattice(r, 8) - 4;
    let by = ay + lattice(r, 8) - 4;
    bx = Math.min(size, Math.max(0, bx));
    by = Math.min(size, Math.max(0, by));
    if (ax === bx && ay === by) continue;
    walls.push(free(ax, ay, bx, by, r() < 0.1 ? { kind: "door", state: "closed", secret: false, discovered: false } : { kind: "wall" }));
  }
  const heights: Record<string, number> = {};
  if (opts.heights !== false) {
    for (let k = 0; k < 3; k++) {
      const x0 = Math.floor(r() * size);
      const y0 = Math.floor(r() * size);
      const top = [5, 10, 20, -10][Math.floor(r() * 4)]!;
      for (let y = y0; y < Math.min(size, y0 + 2 + Math.floor(r() * 5)); y++) for (let x = x0; x < Math.min(size, x0 + 2 + Math.floor(r() * 5)); x++) heights[`${x},${y}`] = top;
    }
  }
  return { cells, edges, walls, heights };
}

// ---------------------------------------------------------------------------

describe("senses", () => {
  test("reads darkvision, blindsight and truesight in feet, the largest of each, capped at 150", () => {
    assert.deepEqual(parseSenses("Darkvision 60 ft., Passive Perception 10"), { darkvision: 60, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses("blindsight 10 ft. (blind beyond this radius), darkvision 120 ft."), { darkvision: 120, blindsight: 10, truesight: 0 });
    assert.deepEqual(parseSenses("TRUESIGHT 120 ft; darkvision 30 ft, darkvision 60 ft"), { darkvision: 60, blindsight: 0, truesight: 120 });
    assert.deepEqual(parseSenses("darkvision 300 ft"), { darkvision: 150, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses("darkvision (60 ft)"), { darkvision: 60, blindsight: 0, truesight: 0 });
  });

  test("tremorsense is not sight, and anything else reads as nothing", () => {
    assert.deepEqual(parseSenses("tremorsense 60 ft."), { darkvision: 0, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses(""), { darkvision: 0, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses(undefined), { darkvision: 0, blindsight: 0, truesight: 0 });
    assert.deepEqual(parseSenses("superdarkvision 60"), { darkvision: 0, blindsight: 0, truesight: 0 });
  });
});

describe("members and sources", () => {
  test("a party member is owned by a player, directly or through its character, or marked by the DM", () => {
    const s = room({ characters: { c1: character("c1") } });
    assert.equal(partyMember(s, token("a", { ownerIds: ["p1"] })), true);
    assert.equal(partyMember(s, token("b", { actor: { ref: "c1" } })), true);
    assert.equal(partyMember(s, token("c", { partyVision: true })), true);
    assert.equal(partyMember(s, token("d")), false);
  });

  test("hidden, objects, the down and those inside the ground lend no sight, and past 12 the rest are over the cap", () => {
    const tokens: Token[] = [
      pc("hidden", 1, 1, { visibility: "dm" }),
      pc("object", 3, 1, { kind: "object" }),
      token("lamp", { kind: "object", partyVision: true, x: 5, y: 1 }),
      pc("dead", 7, 1, { actor: { inline: actor({ life: "dead" }) } }),
      pc("stable", 9, 1, { actor: { inline: actor({ life: "stable" }) } }),
      pc("asleep", 11, 1, { actor: { inline: actor({ effects: [{ id: "e", key: "unconscious" }] }) } }),
      pc("buried", 13, 1, { elevation: 0 }),
    ];
    for (let k = 0; k < 13; k++) tokens.push(pc(`p${String(k).padStart(2, "0")}`, 1 + k, 5));
    // The DM's ally comes after every player-owned creature in the cap's order.
    tokens.push(token("ally", { kind: "npc", partyVision: true, x: 1, y: 9 }));
    const s = visionRoom({ tokens, build: { heights: { "13,1": 10 } } });
    const { members, overCap } = visionReport(s, "s1", world);
    const why = Object.fromEntries(members.map((m) => [m.tokenId, m.reason ?? "lends"]));
    assert.equal(why.hidden, "hidden");
    assert.equal(why.object, "object");
    assert.equal(why.dead, "down");
    assert.equal(why.stable, "down");
    assert.equal(why.asleep, "down");
    assert.equal(why.buried, "ground");
    // Player characters first, by ID: the first 12 lend, and the 13th, the lamp and the ally come after the cap.
    const lending = members.filter((m) => m.lends).map((m) => m.tokenId);
    assert.deepEqual(lending, ["p00", "p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09", "p10", "p11"]);
    assert.equal(why.p12, "cap");
    assert.equal(why.lamp, "cap");
    assert.equal(why.ally, "cap");
    assert.equal(overCap, 3);
  });

  test("companions rank after the DM's marked creatures under the cap, and an effect companion lends no sight (docs/design-v1-combat-flow.md 3.6.5)", () => {
    const tokens: Token[] = [];
    for (let k = 0; k < 11; k++) tokens.push(pc(`p${String(k).padStart(2, "0")}`, 1 + k, 5));
    // A familiar whose ID sorts first, a creature companion a player owns, still comes after the DM's lantern bearer.
    tokens.push(token("a-owl", { kind: "npc", ownerIds: ["p1"], companion: { of: "c1", turn: "shared" }, x: 1, y: 9 }));
    tokens.push(token("lantern", { kind: "npc", partyVision: true, x: 3, y: 9 }));
    tokens.push(token("b-weapon", { kind: "object", ownerIds: ["p1"], companion: { of: "c1", turn: "none" }, x: 5, y: 9, actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0 }) } }));
    const s = visionRoom({ tokens });
    s.characters.c1 = character("c1");
    const { members } = visionReport(s, "s1", world);
    const why = Object.fromEntries(members.map((m) => [m.tokenId, m.reason ?? "lends"]));
    assert.equal(why.lantern, "lends", "the 12th source is the DM's marked creature");
    assert.equal(why["a-owl"], "cap", "the familiar comes after it");
    assert.equal(why["b-weapon"], "object", "an effect lends no sight");
  });

  test("carried lights past the cap light in the cap's order, and a token the DM hid takes no place", () => {
    const candle = { light: { bright: 5, dim: 5 } };
    // A party torch whose ID sorts after every monster's, and a candle on each of 20 monsters along a row.
    const torch = pc("zz-pc", 2, 2, { light: { bright: 20, dim: 20 } });
    const monsters = Array.from({ length: LIMITS.litTokenLightsPerScene }, (_, k) => token(`m${String(k).padStart(2, "0")}`, { x: 1 + k * 2, y: 14, ...candle }));
    const hidden = Array.from({ length: 5 }, (_, k) => token(`a${k}`, { x: 1 + k * 2, y: 24, visibility: "dm", ...candle }));
    const sight = (tokens: Token[]) => coldPartySight(visionRoom({ w: 44, h: 32, light: "dark", tokens }), "s1", world).tiles;
    const { light: _light, ...last } = monsters[monsters.length - 1]!;
    // 21 lights: the monster last by ID lights nothing, and the party's torch still lights.
    sameTiles(sight([torch, ...monsters]), sight([torch, ...monsters.slice(0, -1), last]), "past the cap");
    const { light: _torch, ...dark } = torch;
    assert.notDeepEqual([...sight([torch, ...monsters])], [...sight([dark, ...monsters])], "the party's torch lights");
    // Hidden tokens' lights are dark for players and never push a shown one out.
    sameTiles(sight([torch, ...monsters.slice(0, -1), ...hidden]), sight([torch, ...monsters.slice(0, -1)]), "hidden lights");
  });

  test("a source standing on a wall it cannot step off lends no sight, and the report says so", () => {
    // Eight walls through one point, one along each line the sixteen step directions lie on: every direction slides along one.
    const walls = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
      [1, 2],
      [2, 1],
      [1, -2],
      [2, -1],
    ].map(([a, b]) => free(10 - a!, 10 - b!, 10 + a!, 10 + b!));
    const s = visionRoom({ build: { walls }, tokens: [token("a", { kind: "pc", ownerIds: ["p1"], size: "large", x: 9, y: 9 })] });
    const report = visionReport(s, "s1", world);
    assert.equal(report.members[0]!.reason, "wall");
    assert.equal(partySight(s, "s1", world).tiles.size, 0);
  });
});

describe("the sweep against a brute-force ray cast", () => {
  /*
   * Every sub-cell center the polygon holds is one the ray cast reaches, and
   * the other way round, except where the center lies on the polygon's
   * boundary, a wall, or a ray grazing a wall's end, where the two may differ
   * by rounding alone.
   */
  function checkAgainstOracle(walls: WallSet, ex: number, ey: number, eyeFt: number, box: { x0: number; y0: number; x1: number; y1: number }, w: number, h: number, label: string): number {
    const set = walls.sight(eyeFt);
    const at = stepOffWalls(ex, ey, set.stored, SIGHT);
    if (!at) return 0;
    const poly = visibleFrom(at.x, at.y, set.pieces, box);
    assert.ok(poly, `${label}: the sweep runs`);
    const stored = set.stored.xy;
    let checked = 0;
    for (let sy = 0; sy < h * 4; sy++) {
      const py = center(sy);
      if (py <= box.y0 || py >= box.y1) continue;
      for (let sx = 0; sx < w * 4; sx++) {
        const px = center(sx);
        if (px <= box.x0 || px >= box.x1) continue;
        const swept = pointInPolygon(poly, px, py);
        const cast = rayClear(at.x, at.y, px, py, stored);
        if (swept !== cast && !degenerate(px, py, poly, stored, at.x, at.y)) {
          assert.fail(`${label}: eye (${at.x}, ${at.y}) and (${px}, ${py}): sweep ${swept}, ray cast ${cast}`);
        }
        checked++;
      }
    }
    return checked;
  }

  test("whole-scene sweeps over crossing free walls, pillars, doors and raised edges", () => {
    const r = rng(41);
    let checked = 0;
    for (let trial = 0; trial < 14; trial++) {
      const size = 16;
      const s = visionRoom({ w: size, h: size, build: randomBuild(r, size) });
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      for (let e = 0; e < 3; e++) {
        const ex = 0.5 + Math.floor(r() * size * 2) / 2;
        const ey = 0.5 + Math.floor(r() * size * 2) / 2;
        const eyeFt = [0, 5, 10, 15, 25][Math.floor(r() * 5)]!;
        checked += checkAgainstOracle(walls, Math.min(ex, size - 0.25), Math.min(ey, size - 0.25), eyeFt, { x0: -1, y0: -1, x1: size + 1, y1: size + 1 }, size, size, `trial ${trial}`);
      }
    }
    assert.ok(checked > 50_000, `checked ${checked} centers`);
  });

  test("culled and light boxes, including walls that start outside the box and run into it", () => {
    const r = rng(7);
    let checked = 0;
    for (let trial = 0; trial < 20; trial++) {
      const size = 24;
      const s = visionRoom({ w: size, h: size, build: randomBuild(r, size, { freeWalls: 40 }) });
      const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
      for (let e = 0; e < 3; e++) {
        // Eyes off the grid as well, as a light or a stepped eye may be.
        const ex = 2 + lattice(r, size - 4);
        const ey = 2 + lattice(r, size - 4);
        const rad = 1 + Math.floor(r() * 6);
        const box = { x0: Math.max(-1, Math.floor(ex - rad)), y0: Math.max(-1, Math.floor(ey - rad)), x1: Math.min(size + 1, Math.ceil(ex + rad)), y1: Math.min(size + 1, Math.ceil(ey + rad)) };
        checked += checkAgainstOracle(walls, ex, ey, 5, box, size, size, `trial ${trial}`);
      }
    }
    assert.ok(checked > 10_000, `checked ${checked} centers`);
  });

  test("a wall running from outside a culled box into it still blocks", () => {
    const s = visionRoom({ w: 20, h: 20, build: { walls: [free(1, 8, 8, 8 + 1 / 64)] } });
    const walls = sceneWalls(s.scenes.s1!, s.buildChunks);
    const set = walls.sight(5);
    const poly = visibleFrom(6.5, 6.5, set.pieces, { x0: 4, y0: 4, x1: 9, y1: 9 })!;
    assert.equal(pointInPolygon(poly, 6.5, 7.9), true);
    assert.equal(pointInPolygon(poly, 6.5, 8.2), false);
    assert.equal(pointInPolygon(poly, 4.2, 8.5), false);
  });

  test("a segment through the eye fails closed", () => {
    assert.equal(visibleFrom(2, 2, Float64Array.from([1, 1, 3, 3]), { x0: 0, y0: 0, x1: 5, y1: 5 }), null);
    assert.ok(visibleFrom(2, 2.5, Float64Array.from([1, 1, 3, 3]), { x0: 0, y0: 0, x1: 5, y1: 5 }));
  });

  test("the polygon depends on the set of segments, not their order", () => {
    const r = rng(3);
    const s = visionRoom({ w: 20, h: 20, build: randomBuild(r, 20) });
    const set = sceneWalls(s.scenes.s1!, s.buildChunks).sight(5);
    const at = stepOffWalls(9.5, 9.5, set.stored, SIGHT)!;
    const box = { x0: -1, y0: -1, x1: 21, y1: 21 };
    const a = visibleFrom(at.x, at.y, set.pieces, box)!;
    const n = set.pieces.length / 4;
    const order = Array.from({ length: n }, (_, k) => k).sort(() => r() - 0.5);
    const shuffled = new Float64Array(set.pieces.length);
    order.forEach((k, m) => {
      // Half of them reversed end to end as well.
      const rev = m % 2 === 1;
      shuffled.set(rev ? [set.pieces[4 * k + 2]!, set.pieces[4 * k + 3]!, set.pieces[4 * k]!, set.pieces[4 * k + 1]!] : set.pieces.subarray(4 * k, 4 * k + 4), 4 * m);
    });
    assert.deepEqual(visibleFrom(at.x, at.y, shuffled, box), a);
  });
});

describe("sight levels against an independent computation", () => {
  /*
   * The party's level at every sub-cell, recomputed from scratch with the
   * ray cast: each source's stepped eye, its senses as circles, the light
   * at the center from each lit light's own ray cast, and section 4.3.2's
   * table, then the best over the sources. Centers the oracle calls
   * degenerate for any eye or light are skipped.
   */
  function oracleLevels(s: RoomState): { levels: Uint8Array; skip: Uint8Array } {
    const sc = s.scenes.s1!;
    const { w, h } = sc.bounds;
    const W = w * 4;
    const walls = sceneWalls(sc, s.buildChunks);
    const fpc = s.meta.settings.feetPerCell;
    const base = sc.vision!.light === "bright" ? 3 : sc.vision!.light === "dim" ? 2 : 0;
    const levels = new Uint8Array(W * h * 4);
    const skip = new Uint8Array(W * h * 4);
    const report = visionReport(s, "s1", world);
    const lightAt = new Uint8Array(W * h * 4).fill(base);
    if (base !== 3) {
      const lit: { x: number; y: number; rb: number; rd: number; walls: boolean; eyeFt: number }[] = [];
      for (const l of Object.values(s.lights)) if (l.on && (l.bright > 0 || l.dim > 0)) lit.push({ x: l.x, y: l.y, rb: l.bright / fpc, rd: (l.bright + l.dim) / fpc, walls: l.walls, eyeFt: 5 });
      for (const t of Object.values(s.tokens)) if (t.light && t.visibility === "all") lit.push({ x: t.x + 0.5, y: t.y + 0.5, rb: t.light.bright / fpc, rd: (t.light.bright + t.light.dim) / fpc, walls: true, eyeFt: t.elevation + 5 });
      for (const l of lit) {
        const set = walls.sight(l.eyeFt);
        const at = l.walls ? stepOffWalls(l.x, l.y, set.stored, SIGHT) : { x: l.x, y: l.y };
        if (!at) continue;
        const poly = l.walls ? visibleFrom(at.x, at.y, set.pieces, { x0: Math.floor(l.x - l.rd), y0: Math.floor(l.y - l.rd), x1: Math.ceil(l.x + l.rd), y1: Math.ceil(l.y + l.rd) }) : null;
        for (let sy = 0; sy < h * 4; sy++) {
          for (let sx = 0; sx < W; sx++) {
            const px = center(sx);
            const py = center(sy);
            const d2 = (px - at.x) * (px - at.x) + (py - at.y) * (py - at.y);
            if (d2 > l.rd * l.rd) continue;
            if (l.walls && !rayClear(at.x, at.y, px, py, set.stored.xy)) {
              if (poly && degenerate(px, py, poly, set.stored.xy, at.x, at.y)) skip[sy * W + sx] = 1;
              continue;
            }
            if (poly && degenerate(px, py, poly, set.stored.xy, at.x, at.y)) skip[sy * W + sx] = 1;
            const v = l.rb > 0 && d2 <= l.rb * l.rb ? 3 : 2;
            if (v > lightAt[sy * W + sx]!) lightAt[sy * W + sx] = v;
          }
        }
      }
    }
    for (const m of report.members) {
      if (!m.lends) continue;
      const t = s.tokens[m.tokenId]!;
      const set = walls.sight(t.elevation + 5);
      const at = stepOffWalls(t.x + 0.5, t.y + 0.5, set.stored, SIGHT)!;
      const blind = (t.actor as { inline: { effects: { key: string }[] } }).inline.effects.some((e) => e.key === "blinded");
      const dv = blind ? 0 : m.senses.darkvision / fpc;
      const ts = blind ? 0 : m.senses.truesight / fpc;
      const bs = m.senses.blindsight / fpc;
      const poly = sourcePolygon(s, "s1", t.id, world);
      for (let sy = 0; sy < h * 4; sy++) {
        for (let sx = 0; sx < W; sx++) {
          const px = center(sx);
          const py = center(sy);
          const d2 = (px - at.x) * (px - at.x) + (py - at.y) * (py - at.y);
          const light = lightAt[sy * W + sx]!;
          let v = 0;
          if (!blind) {
            v = light;
            if (d2 <= dv * dv && dv > 0) v = light === 0 ? 1 : 3;
            if (d2 <= ts * ts && ts > 0) v = Math.max(v, light === 3 ? 3 : 2);
          }
          if (d2 <= bs * bs && bs > 0) v = Math.max(v, 1);
          if (v === 0) continue;
          if (!rayClear(at.x, at.y, px, py, set.stored.xy)) {
            if (poly && degenerate(px, py, poly.polygon, set.stored.xy, at.x, at.y)) skip[sy * W + sx] = 1;
            continue;
          }
          if (poly && degenerate(px, py, poly.polygon, set.stored.xy, at.x, at.y)) skip[sy * W + sx] = 1;
          // The source's culled box: in a dark scene, or blind, the oracle's circles already bound what it sees.
          if (v > levels[sy * W + sx]!) levels[sy * W + sx] = v;
        }
      }
    }
    return { levels, skip };
  }

  function compare(s: RoomState, label: string): void {
    const { w, h } = s.scenes.s1!.bounds;
    const got = levelsOf(coldPartySight(s, "s1", world).tiles, w, h);
    const { levels, skip } = oracleLevels(s);
    let differ = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== levels[i] && skip[i] === 0) differ++;
    assert.equal(differ, 0, `${label}: ${differ} sub-cells differ`);
  }

  test("bright, dim and dark scenes with darkvision, truesight, blindsight, Blinded and lights", () => {
    const r = rng(99);
    for (let trial = 0; trial < 12; trial++) {
      const size = 20;
      const light = (["bright", "dim", "dark"] as const)[trial % 3]!;
      const senses = ["", "darkvision 30 ft", "truesight 20 ft", "blindsight 10 ft", "darkvision 60 ft, blindsight 5 ft"];
      const tokens: Token[] = [];
      for (let k = 0; k < 3; k++) {
        const effects = r() < 0.25 ? [{ id: "b", key: "blinded" as const }] : [];
        tokens.push(pc(`t${k}`, Math.floor(r() * size), Math.floor(r() * size), { actor: { inline: actor({ senses: senses[Math.floor(r() * senses.length)]!, effects }) } }));
      }
      if (r() < 0.5) tokens[0] = { ...tokens[0]!, light: { bright: 10, dim: 10 } };
      // A torch-bearer the party cannot see still lights its surroundings.
      tokens.push(token("orc", { x: Math.floor(r() * size), y: Math.floor(r() * size), light: { bright: 15, dim: 15 } }));
      const lights = [light === "bright" ? [] : [light_(r, size, true), light_(r, size, false), light_(r, size, true)]].flat();
      const s = visionRoom({ w: size, h: size, light, build: randomBuild(r, size, { heights: false }), tokens, lights });
      compare(s, `trial ${trial} (${light})`);
    }
  });

  function light_(r: () => number, size: number, walls: boolean): Light {
    return light(`l${Math.floor(r() * 1e9)}`, lattice(r, size), lattice(r, size), [0, 5, 10, 20][Math.floor(r() * 4)]!, [5, 10, 20][Math.floor(r() * 3)]!, { walls });
  }
});

describe("raised edges", () => {
  const platform: Record<string, number> = {};
  for (let y = 4; y < 8; y++) for (let x = 10; x < 14; x++) platform[`${x},${y}`] = 10;
  const ledge: Record<string, number> = {};
  for (let y = 4; y < 8; y++) for (let x = 10; x < 14; x++) ledge[`${x},${y}`] = 5;

  test("a Medium creature on the ground sees over a 5 ft ledge but not onto a 10 ft platform", () => {
    const low = partySight(visionRoom({ w: 20, h: 12, build: { heights: ledge }, tokens: [pc("a", 3, 5)] }), "s1", world);
    assert.equal(low.seesToken({ size: "medium", x: 15, y: 5 }), true);
    const high = partySight(visionRoom({ w: 20, h: 12, build: { heights: platform }, tokens: [pc("a", 3, 5)] }), "s1", world);
    assert.equal(high.seesToken({ size: "medium", x: 11, y: 5 }), false, "the platform's top is hidden");
    assert.equal(high.seesToken({ size: "medium", x: 15, y: 5 }), false, "and so is the ground behind it");
    assert.equal(high.seesToken({ size: "medium", x: 5, y: 1 }), true);
  });

  test("a creature on the platform sees down over its edge, and a creature in a pit cannot see out", () => {
    const up = partySight(visionRoom({ w: 20, h: 12, build: { heights: platform }, tokens: [pc("a", 11, 5, { elevation: 10 })] }), "s1", world);
    assert.equal(up.seesToken({ size: "medium", x: 3, y: 5 }), true);
    const pit: Record<string, number> = {};
    for (let y = 4; y < 7; y++) for (let x = 4; x < 7; x++) pit[`${x},${y}`] = -10;
    const down = partySight(visionRoom({ w: 20, h: 12, build: { heights: pit }, tokens: [pc("a", 5, 5, { elevation: -10 })] }), "s1", world);
    assert.equal(down.seesToken({ size: "medium", x: 5, y: 4 }), true, "the pit itself");
    assert.equal(down.seesToken({ size: "medium", x: 12, y: 5 }), false);
  });

  test("the raised tag vision reads is the wall set's", () => {
    assert.equal(RAISED_TAG, RAISED);
  });
});

describe("the eye on a wall", () => {
  /*
   * The design's case: an eye at (1.5, 0.5) on the stored wall from (0, 0)
   * to (3, 1), which another wall splits at (1.2, 0.4), and an eye 1e-15
   * cell off it. The splitting wall stands on the side the eye does not go
   * to, so it hides nothing from it: sight is the same with and without it.
   */
  test("an eye on a stored wall, or 1e-15 off it, that another wall splits sees the same with or without that wall", () => {
    const main = free(0, 0, 3, 1);
    const north = free(1.2, 0.4, 1.2, 0);
    const south = free(1.2, 0.4, 1.2, 2);
    for (const [y, splitter, sees, hidden] of [
      [0, north, { x: 1.25, y: 3 }, { x: 2.25, y: 0 }],
      [-1e-15, south, { x: 2.5, y: 0 }, { x: 1.25, y: 3 }],
    ] as const) {
      const t = token("a", { kind: "pc", ownerIds: ["p1"], size: "medium", x: 1, y });
      const plain = visionRoom({ w: 12, h: 12, build: { walls: [main] }, tokens: [t] });
      const split = visionRoom({ w: 12, h: 12, build: { walls: [main, splitter] }, tokens: [t] });
      const a = coldPartySight(plain, "s1", world);
      sameTiles(a.tiles, coldPartySight(split, "s1", world).tiles, `eye at y ${y}`);
      assert.equal(a.seesToken({ size: "tiny", ...sees }), true, `eye at y ${y} sees its own side`);
      assert.equal(a.seesToken({ size: "tiny", ...hidden }), false, `eye at y ${y} does not see the other side`);
    }
  });

  test("eyes beside a wall keep their side: (1.0149, 4.5) west of x = 65/64, and a 1.99-cell token at x = 0 beside x = 1", () => {
    const west = visionRoom({ w: 10, h: 10, build: { walls: [free(65 / 64, 0, 65 / 64, 8)] }, tokens: [token("a", { kind: "pc", ownerIds: ["p1"], size: "custom", w: 0.5, h: 0.5, x: 1.0149 - 0.25, y: 4.25 })] });
    const sw = coldPartySight(west, "s1", world);
    assert.equal(sw.seesToken({ size: "tiny", x: 0, y: 4 }), true);
    assert.equal(sw.seesToken({ size: "tiny", x: 3, y: 4 }), false);
    const wide = visionRoom({ w: 10, h: 10, build: { walls: [free(1, 0, 1, 8)] }, tokens: [token("a", { kind: "pc", ownerIds: ["p1"], size: "custom", w: 1.99, h: 1, x: 0, y: 0 })] });
    const ww = coldPartySight(wide, "s1", world);
    assert.equal(ww.seesToken({ size: "tiny", x: 0.25, y: 6 }), true);
    assert.equal(ww.seesToken({ size: "tiny", x: 3, y: 6 }), false);
  });

  test("walls 1/64 cell apart and junctions of three and four walls leave the eye between them", () => {
    const k = 1 / 64;
    const between = visionRoom({ w: 10, h: 10, build: { walls: [free(4, 0, 4, 8), free(4 + k, 0, 4 + k, 8)] }, tokens: [token("a", { kind: "pc", ownerIds: ["p1"], size: "custom", w: 0.5, h: 0.5, x: 4 - 0.25, y: 3.75 })] });
    // The 1/64 step would land on the second wall, so the 1/128 step leaves the eye between them, where no sub-cell center lies.
    assert.equal(coldPartySight(between, "s1", world).tiles.size, 0);
    const cross = visionRoom({ w: 10, h: 10, build: { walls: [free(2, 4, 6, 4), free(4, 2, 4, 6), free(4, 4, 6, 6)] }, tokens: [token("a", { kind: "pc", ownerIds: ["p1"], size: "large", x: 3, y: 3 })] });
    const sc = coldPartySight(cross, "s1", world);
    // Stepped by (1, 2) first, the eye is between the south arm and the diagonal, and sees only that wedge.
    const wedges = [
      sc.seesToken({ size: "tiny", x: 4.5, y: 7 }),
      sc.seesToken({ size: "tiny", x: 5, y: 3 }),
      sc.seesToken({ size: "tiny", x: 3, y: 5 }),
      sc.seesToken({ size: "tiny", x: 7, y: 5 }),
    ];
    assert.deepEqual(wedges, [true, false, false, false]);
  });
});

describe("the footprint predicate", () => {
  test("a Tiny creature behind a free wall in its own cell is not seen", () => {
    // A wall across cell (6, 4) at x = 6.5: the creature in the cell's east half is behind it.
    const s = visionRoom({ w: 12, h: 10, build: { walls: [free(6.5, 0, 6.5, 5), free(6.5, 5, 6.5, 10)] }, tokens: [pc("a", 2, 4)] });
    const sight = coldPartySight(s, "s1", world);
    assert.equal(sight.seesToken({ size: "tiny", x: 6, y: 4 }), true, "the west half");
    assert.equal(sight.seesToken({ size: "tiny", x: 6.5, y: 4 }), false, "the east half, though occupiedCells says the same cell");
  });

  test("a squeezed creature is judged by its squeezed footprint", () => {
    // A corridor along row 4, walled north and south. The party looks from the room to the north, which shows only the north wall.
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 0; x < 12; x++) {
      edges[`${x},4,n`] = WALL;
      edges[`${x},5,n`] = WALL;
    }
    const s = visionRoom({ w: 12, h: 10, build: { edges }, tokens: [pc("a", 5, 1)] });
    const sight = coldPartySight(s, "s1", world);
    const large = { size: "large" as const, x: 4.5, y: 3.5 };
    assert.equal(sight.seesToken(large), true, "full size it reaches into the room");
    assert.equal(sight.seesToken({ ...large, squeeze: true }), false, "squeezed it is in the corridor");
    assert.deepEqual(sightRect({ ...large, squeeze: true }), { x0: 5, y0: 4, x1: 6, y1: 5 });
    const fr = footprintRect({ ...large, squeeze: true });
    assert.deepEqual({ x0: fr.x, y0: fr.y, x1: fr.x + fr.w, y1: fr.y + fr.h }, sightRect({ ...large, squeeze: true }), "the same rectangle footprint.ts gives");
  });

  test("custom sizes and fractional positions read the centers inside the rectangle", () => {
    const s = visionRoom({ w: 12, h: 10, tokens: [pc("a", 2, 2)] });
    const sight = coldPartySight(s, "s1", world);
    assert.equal(sight.seesToken({ size: "custom", w: 1.99, h: 0.6, x: 3.3, y: 7.1 }), true);
    assert.equal(sight.seesToken({ size: "medium", x: -3, y: -3 }), false, "outside the scene nothing is seen");
  });
});

describe("tiles", () => {
  test("a tile all at one level is {f}, and the rest round-trip through their 1,368 characters", () => {
    const s = visionRoom({ w: 40, h: 20, light: "dark", tokens: [pc("a", 3, 3, { senses: "darkvision 60 ft" })], lights: [light("l1", 30, 10, 20, 20)] });
    const sight = coldPartySight(s, "s1", world);
    let sawB = false;
    for (const tile of sight.tiles.values()) {
      if ("b" in tile) {
        sawB = true;
        assert.equal(tile.b.length, 1368);
        const lv = sightTileLevels(tile)!;
        assert.ok(lv.some((v) => v > 0));
      } else assert.ok([1, 2, 3].includes(tile.f));
    }
    assert.ok(sawB);
    const open = coldPartySight(visionRoom({ w: 32, h: 32, tokens: [pc("a", 3, 3)] }), "s1", world);
    assert.deepEqual(open.tiles.get("0,0"), { f: 3 });
  });

  test("the seen bits of a tile are the fog's layout, a bit for every sub-cell above 0", () => {
    const s = visionRoom({ w: 20, h: 20, light: "dark", tokens: [pc("a", 3, 3, { senses: "darkvision 30 ft" })] });
    const sight = coldPartySight(s, "s1", world);
    const tile = sight.tiles.get("0,0")!;
    const lv = sightTileLevels(tile)!;
    const bits = seenFogBits(tile);
    const encoded = Buffer.from(bits).toString("base64");
    const fog = decodeTile(encoded)!;
    for (let sy = 0; sy < 64; sy++) for (let sx = 0; sx < 64; sx++) assert.equal(getBit(fog, sx, sy), lv[sy * 64 + sx]! > 0);
  });

  test("an unreadable tile counts as nothing seen", () => {
    const sight = sightFromTiles({ "s1:0,0": { b: "not base64" }, "s1:1,0": { f: 7 as 1 } }, "s1");
    assert.equal(sight.seesToken({ size: "medium", x: 2, y: 2 }), false);
    assert.equal(sight.seesToken({ size: "medium", x: 18, y: 2 }), false);
  });

  test("a client reading the tiles the server sent answers as the server does", () => {
    const r = rng(5);
    const s = visionRoom({ w: 40, h: 40, light: "dim", build: randomBuild(r, 40), tokens: [pc("a", 5, 5, { senses: "darkvision 60 ft" }), pc("b", 30, 30)], lights: [light("l1", 20, 20, 20, 10)] });
    const server = partySight(s, "s1", world);
    const sent: Record<string, SightTile> = { "other:0,0": { f: 3 } };
    for (const [k, v] of server.tiles) sent[`s1:${k}`] = JSON.parse(JSON.stringify(v)) as SightTile;
    const client = sightFromTiles(sent, "s1");
    for (let k = 0; k < 2000; k++) {
      const probe = { size: (["tiny", "medium", "large", "huge"] as const)[k % 4]!, x: r() * 40, y: r() * 40, squeeze: k % 7 === 0 ? (true as const) : undefined };
      assert.equal(client.seesToken(probe), server.seesToken(probe));
    }
  });

  test("the reserve per tile entry covers the largest entry under any scene ID", () => {
    for (const id of ["0f8fad5b-d9cb-469f-a165-70867728950e", "龍".repeat(64), '"'.repeat(64), "\u0001".repeat(64), "😀".repeat(32)]) {
      const entry = `${JSON.stringify(`${id}:12,12`)}:${JSON.stringify({ b: "A".repeat(1368) })},`;
      assert.equal(sightEntryMaxBytes(id), Buffer.byteLength(entry, "utf8"), id.slice(0, 4));
    }
    assert.equal(sightEntryMaxBytes("0f8fad5b-d9cb-469f-a165-70867728950e"), 1422);
  });
});

describe("the plug-in", () => {
  test("visionRules computes on the server and reads tiles on a client", () => {
    const s = visionRoom({ tokens: [pc("a", 3, 3)] });
    assert.ok(visionRules.partySight(s, "s1").tiles.size > 0);
    assert.equal(visionRules.partySight({ ...s, scenes: { s1: { ...s.scenes.s1!, vision: { on: false, light: "bright" } } } }, "s1").tiles.size, 0);
    assert.equal(visionRules.sightFromTiles({}, "s1").seesToken({ size: "medium", x: 3, y: 3 }), false);
  });
});

// ---------------------------------------------------------------------------
// Random edits, as ops make them

type Edit = (r: () => number, s: RoomState) => RoomState;

const chunkAt = (s: RoomState, cx: number, cy: number): BuildChunk => s.buildChunks[`s1:${cx},${cy}`] ?? { sceneId: "s1", cx, cy, rev: 0, cells: {}, edges: {} };
const withChunk = (s: RoomState, c: BuildChunk): RoomState => ({ ...s, buildChunks: { ...s.buildChunks, [`s1:${c.cx},${c.cy}`]: c } });
const withToken = (s: RoomState, t: Token): RoomState => ({ ...s, tokens: { ...s.tokens, [t.id]: t } });
const pickToken = (r: () => number, s: RoomState): Token | undefined => {
  const all = Object.values(s.tokens).sort((a, b) => (a.id < b.id ? -1 : 1));
  return all[Math.floor(r() * all.length)];
};
const SIZE = 40;

const edits: Record<string, Edit> = {
  move(r, s) {
    const t = pickToken(r, s);
    return t ? withToken(s, { ...t, x: Math.floor(r() * SIZE), y: Math.floor(r() * SIZE) }) : s;
  },
  nudge(r, s) {
    // A step of a cell, the common case at the table.
    const t = pickToken(r, s);
    return t ? withToken(s, { ...t, x: Math.max(0, Math.min(SIZE - 1, t.x + Math.floor(r() * 3) - 1)), y: Math.max(0, Math.min(SIZE - 1, t.y + Math.floor(r() * 3) - 1)) }) : s;
  },
  door(r, s) {
    const x = Math.floor(r() * SIZE);
    const y = Math.floor(r() * SIZE);
    const c = chunkAt(s, Math.floor(x / 16), Math.floor(y / 16));
    const state = (["open", "closed", "locked"] as const)[Math.floor(r() * 3)]!;
    return withChunk(s, { ...c, edges: { ...c.edges, [`${x},${y},${r() < 0.5 ? "n" : "w"}`]: { kind: "door", state, secret: r() < 0.3, discovered: r() < 0.5 } } });
  },
  wall(r, s) {
    // Long walls near chunk borders, so one stored in one chunk closes a room in the next.
    const ax = 16 * Math.floor(r() * 3) + lattice(r, 4) - 2;
    const ay = lattice(r, SIZE);
    const bx = Math.max(0, Math.min(SIZE, ax + lattice(r, 8) - 4));
    const by = Math.max(0, Math.min(SIZE, ay + lattice(r, 8) - 4));
    const w = free(Math.max(0, ax), ay, bx, by);
    if (w.a[0] === w.b[0] && w.a[1] === w.b[1]) return s;
    const { cx, cy } = wallChunk(w);
    const c = chunkAt(s, cx, cy);
    return withChunk(s, { ...c, walls: [...(c.walls ?? []), w] });
  },
  unwall(r, s) {
    const holders = Object.values(s.buildChunks).filter((c) => (c.walls?.length ?? 0) > 0);
    const c = holders[Math.floor(r() * holders.length)];
    if (!c) return s;
    const walls = c.walls!.filter((_, i) => i !== Math.floor(r() * c.walls!.length));
    return withChunk(s, { ...c, walls });
  },
  paint(r, s) {
    const x0 = Math.floor(r() * SIZE);
    const y0 = Math.floor(r() * SIZE);
    const top = [0, 5, 10, 20, -10][Math.floor(r() * 5)]!;
    let next = s;
    for (let y = y0; y < Math.min(SIZE, y0 + 1 + Math.floor(r() * 6)); y++) {
      for (let x = x0; x < Math.min(SIZE, x0 + 1 + Math.floor(r() * 6)); x++) {
        const c = chunkAt(next, Math.floor(x / 16), Math.floor(y / 16));
        const feet = new Array<number>(256).fill(0);
        if (c.heights) {
          const bytes = Buffer.from(c.heights, "base64");
          for (let i = 0; i < 256; i++) feet[i] = bytes.readInt16LE(2 * i);
        }
        feet[(y % 16) * 16 + (x % 16)] = top;
        const heights = encodeHeights(feet);
        const { heights: _old, ...rest } = c;
        next = withChunk(next, heights ? { ...rest, heights } : rest);
      }
    }
    return next;
  },
  light(r, s) {
    const ids = Object.keys(s.lights).sort();
    const roll = r();
    if (roll < 0.3 || ids.length === 0) {
      const l = light(`l${Math.floor(r() * 1e9)}`, lattice(r, SIZE), lattice(r, SIZE), [0, 10, 20][Math.floor(r() * 3)]!, [10, 20, 40][Math.floor(r() * 3)]!, { walls: r() < 0.8 });
      return { ...s, lights: { ...s.lights, [l.id]: l } };
    }
    const id = ids[Math.floor(r() * ids.length)]!;
    if (roll < 0.45) {
      const { [id]: _gone, ...rest } = s.lights;
      return { ...s, lights: rest };
    }
    const old = s.lights[id]!;
    return { ...s, lights: { ...s.lights, [id]: roll < 0.7 ? { ...old, on: !old.on } : { ...old, x: lattice(r, SIZE), y: lattice(r, SIZE) } } };
  },
  actor(r, s) {
    const t = pickToken(r, s);
    if (!t || !("inline" in t.actor)) return s;
    const roll = r();
    const a = t.actor.inline;
    const next =
      roll < 0.3
        ? { ...a, senses: ["", "darkvision 60 ft", "blindsight 15 ft", "truesight 30 ft", "darkvision 150 ft"][Math.floor(r() * 5)]! }
        : roll < 0.6
          ? { ...a, effects: a.effects.length > 0 ? [] : [{ id: "e", key: (r() < 0.5 ? "blinded" : "unconscious") as "blinded" }] }
          : { ...a, life: a.life === "alive" ? ("dead" as const) : ("alive" as const) };
    return withToken(s, { ...t, actor: { inline: next } });
  },
  rise(r, s) {
    const t = pickToken(r, s);
    return t ? withToken(s, { ...t, elevation: [0, 5, 10, 30, -10][Math.floor(r() * 5)]! }) : s;
  },
  carry(r, s) {
    const t = pickToken(r, s);
    if (!t) return s;
    if (t.light) {
      const { light: _l, ...rest } = t;
      return withToken(s, rest as Token);
    }
    return withToken(s, { ...t, light: { bright: [0, 20][Math.floor(r() * 2)]!, dim: 20 } });
  },
  join(r, s) {
    const t = pickToken(r, s);
    if (!t) return s;
    return withToken(s, r() < 0.5 ? { ...t, partyVision: !t.partyVision } : { ...t, visibility: t.visibility === "all" ? "dm" : "all" });
  },
  rule(r, s) {
    const sc = s.scenes.s1!;
    return { ...s, scenes: { s1: { ...sc, autoWalls: (["all", "floor", "off"] as const)[Math.floor(r() * 3)] } } };
  },
};

function start(r: () => number, level: "bright" | "dim" | "dark"): RoomState {
  const tokens: Token[] = [];
  for (let k = 0; k < 5; k++) tokens.push(pc(`p${k}`, Math.floor(r() * SIZE), Math.floor(r() * SIZE), { senses: ["", "darkvision 60 ft", "blindsight 10 ft"][k % 3] }));
  tokens.push(token("m1", { x: Math.floor(r() * SIZE), y: Math.floor(r() * SIZE), light: { bright: 20, dim: 20 } }));
  const build = randomBuild(r, SIZE, { freeWalls: 30 });
  for (let x = 0; x < SIZE; x += 3) for (let y = 0; y < SIZE; y += 4) build.cells![`${x},${y}`] ??= "stone";
  const lights = [light("la", 10, 10, 20, 20), light("lb", 30, 25, 0, 30, { walls: false })];
  return visionRoom({ w: SIZE, h: SIZE, light: level, build, tokens, lights, autoWalls: "all" });
}

describe("incremental equals cold", () => {
  /*
   * Random edits, each a new state as ops make them (changed entities
   * replaced, everything else shared), and after each one the cached answer
   * must equal a computation from nothing, bit for bit. Every few steps a
   * staged state is computed and thrown away, as the size guard refuses
   * one, so later answers must not depend on it.
   */
  for (const level of ["bright", "dim", "dark"] as const) {
    test(`random edits on a ${level} scene`, () => {
      clearVisionCache();
      const r = rng(level === "bright" ? 11 : level === "dim" ? 12 : 13);
      let s = start(r, level);
      const names = Object.keys(edits);
      for (let step = 0; step < 70; step++) {
        const name = names[Math.floor(r() * names.length)]!;
        if (step % 9 === 4) {
          // A staged state the size guard refused: computed, then dropped.
          partySight(edits[name]!(r, s), "s1", world);
          continue;
        }
        s = edits[name]!(r, s);
        const got = partySight(s, "s1", world);
        sameTiles(got.tiles, coldPartySight(s, "s1", world).tiles, `step ${step} (${name})`);
      }
    });
  }

  test("a long wall run split far away by a free wall changes nothing the reuse rule misses", () => {
    clearVisionCache();
    // A wall the whole width of the scene along y = 20, seen from far to its west, and a free wall crossing it far to the east.
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 0; x < 60; x++) edges[`${x},20,n`] = WALL;
    let s = visionRoom({ w: 60, h: 40, build: { edges }, tokens: [pc("a", 2, 10)] });
    partySight(s, "s1", world);
    const w = free(55, 18, 55, 22);
    const c = s.buildChunks[`s1:3,1`] ?? { sceneId: "s1", cx: 3, cy: 1, rev: 0, cells: {}, edges: {} };
    s = { ...s, buildChunks: { ...s.buildChunks, "s1:3,1": { ...c, walls: [w] } } };
    sameTiles(partySight(s, "s1", world).tiles, coldPartySight(s, "s1", world).tiles, "after the crossing wall");
  });

  test("a free wall stored in the chunk next to the room it closes", () => {
    clearVisionCache();
    // A room in chunk (0, 0), open to the east at x = 16, and a wall across the opening whose midpoint is in chunk (1, 0).
    const edges: Record<string, EdgeFeature> = {};
    for (let x = 10; x < 16; x++) {
      edges[`${x},4,n`] = WALL;
      edges[`${x},8,n`] = WALL;
    }
    for (let y = 4; y < 8; y++) edges[`10,${y},w`] = WALL;
    const open = visionRoom({ w: 40, h: 16, build: { edges }, tokens: [pc("a", 12, 5)] });
    assert.equal(partySight(open, "s1", world).seesToken({ size: "medium", x: 30, y: 6 }), true);
    const door = free(16, 4, 16.25, 8);
    assert.deepEqual(wallChunk(door), { cx: 1, cy: 0 });
    const closed = { ...open, buildChunks: { ...open.buildChunks, "s1:1,0": { sceneId: "s1", cx: 1, cy: 0, rev: 1, cells: {}, edges: {}, walls: [door] } } };
    const got = partySight(closed, "s1", world);
    sameTiles(got.tiles, coldPartySight(closed, "s1", world).tiles, "closed");
    assert.equal(got.seesToken({ size: "medium", x: 30, y: 6 }), false);
  });

  test("a light on a wall it cannot step off lights nothing", () => {
    const lines = [
      [1, 0],
      [0, 1],
      [1, 1],
      [1, -1],
      [1, 2],
      [2, 1],
      [1, -2],
      [2, -1],
    ];
    const walls = lines.map(([a, b]) => free(10 - a!, 10 - b!, 10 + a!, 10 + b!));
    const lit = visionRoom({ w: 20, h: 20, light: "dark", build: { walls }, tokens: [pc("a", 3, 3)], lights: [light("l", 10, 10, 20, 20)] });
    assert.equal(coldPartySight(lit, "s1", world).tiles.size, 0);
    const off = visionRoom({ w: 20, h: 20, light: "dark", build: { walls }, tokens: [pc("a", 3, 3)], lights: [light("l", 10, 10, 20, 20, { walls: false })] });
    assert.ok(coldPartySight(off, "s1", world).tiles.size > 0, "a light walls do not stop needs no step");
  });

  test("a repeat with the same inputs is the same answer, and an unrelated edit costs no sweep", () => {
    clearVisionCache();
    const s = visionRoom({ tokens: [pc("a", 3, 3)] });
    const a = partySight(s, "s1", world);
    assert.equal(partySight(s, "s1", world), a);
    // A label, a log line or a monster elsewhere changes nothing sight reads.
    const other = { ...s, tokens: { ...s.tokens, m: token("m", { x: 20, y: 20 }) } };
    assert.equal(partySight(other, "s1", world).tiles, a.tiles);
  });
});

describe("golden bits", () => {
  /*
   * Fixed scenes whose tiles are pinned by hash: any change to the sweep,
   * the step, the raster or the encoding that moves a single sub-cell fails
   * here, so the same inputs give the same bits on the server, on replay
   * after a Node upgrade, and on any client.
   */
  function hashTiles(tiles: ReadonlyMap<string, SightTile>): string {
    const text = JSON.stringify([...tiles].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function dungeon(level: "bright" | "dim" | "dark"): RoomState {
    const edges = roomEdges(2, 2, 12, 10);
    roomEdges(14, 2, 10, 14, edges);
    edges["14,6,w"] = { kind: "door", state: "open", secret: false, discovered: false };
    edges["8,12,n"] = { kind: "window" };
    const heights: Record<string, number> = {};
    for (let y = 8; y < 12; y++) for (let x = 18; x < 22; x++) heights[`${x},${y}`] = 10;
    const build: Build = {
      edges,
      cells: { "6,6": "pillar", "20,4": "pillar" },
      walls: [free(4, 3, 9 + 1 / 64, 7 + 3 / 64), free(16, 13, 22.5, 15.25), free(30, 5, 26, 12)],
      heights,
    };
    const tokens = [
      pc("a", 4, 9, { senses: "darkvision 60 ft" }),
      pc("b", 20, 5, { senses: "blindsight 10 ft", actor: { inline: actor({ senses: "blindsight 10 ft", effects: [{ id: "e", key: "blinded" }] }) } }),
      token("c", { kind: "npc", partyVision: true, size: "large", x: 9, y: 13, actor: { inline: actor({ senses: "truesight 30 ft" }) } }),
      pc("d", 19, 9, { elevation: 10, light: { bright: 20, dim: 20 } }),
    ];
    const lights = [light("l1", 25 + 1 / 64, 20, 15, 30), light("l2", 6, 4, 5, 5, { walls: false })];
    return visionRoom({ w: 36, h: 28, light: level, build, tokens, lights });
  }

  const GOLDEN: Record<string, { tiles: number; hash: string }> = {
    bright: { tiles: 5, hash: "fcdc8117" },
    dim: { tiles: 5, hash: "3268c133" },
    dark: { tiles: 5, hash: "0c5f6ab2" },
  };

  for (const level of ["bright", "dim", "dark"] as const) {
    test(`the ${level} dungeon`, () => {
      const tiles = coldPartySight(dungeon(level), "s1", world).tiles;
      const got = { tiles: tiles.size, hash: hashTiles(tiles) };
      assert.deepEqual(got, GOLDEN[level]);
    });
  }

  /*
   * The dark dungeon per player (docs/design-v1-per-player-vision.md 6.1):
   * a is the first player's, d the second's, b a character both play, and
   * c the creature the DM marked to share sight with the party.
   */
  const GOLDEN_PER_PLAYER: Record<string, { tiles: number; hash: string }> = {
    p1: { tiles: 5, hash: "472cbffb" },
    p2: { tiles: 5, hash: "76969b13" },
    shared: { tiles: 4, hash: "a93ebf52" },
  };

  test("the dark dungeon per player", () => {
    clearVisionCache();
    const s = dungeon("dark");
    for (const [id, ownerIds] of [
      ["a", ["p1"]],
      ["b", ["p1", "p2"]],
      ["d", ["p2"]],
    ] as const) {
      s.tokens[id] = { ...s.tokens[id]!, ownerIds: [...ownerIds] };
    }
    const got: Record<string, { tiles: number; hash: string }> = {};
    for (const viewer of ["p1", "p2", null]) {
      const tiles = holderSight(s, "s1", viewer, world).tiles;
      sameTiles(tiles, coldHolderSight(s, "s1", viewer, world).tiles, `${viewer}`);
      got[viewer ?? "shared"] = { tiles: tiles.size, hash: hashTiles(tiles) };
    }
    assert.deepEqual(got, GOLDEN_PER_PLAYER);
    // Every viewer's sight lies within the union's, and the union is the whole-party dungeon's.
    assert.deepEqual({ tiles: partySight(s, "s1", world).tiles.size, hash: hashTiles(partySight(s, "s1", world).tiles) }, GOLDEN.dark);
  });
});

describe("what the vision cache keeps alive", () => {
  /*
   * The cache's entries must not hold a scene's wall set or its sight pieces
   * once the wall cache has let them go (W4-DATA-04): the byte cap counts
   * only what vision itself builds, so geometry it kept would be unbounded.
   * Scenes past the wall cache's 64, each asked about once, and the first
   * scene's wall set must then be collectable.
   */
  test("a scene's wall set goes once the wall cache drops it, whatever vision cached about the scene", async () => {
    const { setFlagsFromString } = await import("node:v8");
    const { runInNewContext } = await import("node:vm");
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    clearVisionCache();
    const weak = ((): WeakRef<WallSet> => {
      let first: WeakRef<WallSet> | undefined;
      for (let k = 0; k < 70; k++) {
        const id = `kept${k}`;
        const walls = [free(2, 2, 9, 3), free(4, 8, 5, 1), free(12, 2, 12, 9)];
        const s = room({ scenes: { [id]: scene(id, { bounds: { w: 20, h: 12 }, vision: { on: true, light: "dark" }, autoWalls: "off" }) } });
        s.buildChunks = chunksOf(id, { walls });
        // A light, so the scene's entry holds a light swept over the scene's sight pieces, and a source to need it.
        s.lights = { l: { ...light("l", 6, 6, 20, 20), sceneId: id } };
        // And a second player's source, so a sight holder's raster is drawn and kept too.
        s.tokens = { a: { ...pc("a", 3, 6), sceneId: id }, b: { ...pc("b", 15, 6, { ownerIds: ["p2"] }), sceneId: id } };
        partySight(s, id, world);
        assert.ok(holderSight(s, id, "p1", world).tiles.size > 0);
        if (k === 0) first = new WeakRef(sceneWalls(s.scenes[id]!, s.buildChunks));
      }
      return first!;
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
    gc();
    assert.equal(weak.deref(), undefined, "the first scene's wall set is collected");
    clearVisionCache();
  });
});

// ---------------------------------------------------------------------------
// Sight holders (docs/design-v1-per-player-vision.md 6.1, lane PV2)

/** The players asked about, and null for the shared sight that every other viewer has. */
const HOLDERS = ["p1", "p2", "p3", "p4"] as const;
const VIEWERS: readonly (string | null)[] = [...HOLDERS, null];

/** Owners drawn at random from the holders, and now and then a player none of them is. */
function someOwners(r: () => number): string[] {
  const owners: string[] = HOLDERS.filter(() => r() < 0.4);
  if (r() < 0.2) owners.push("p5");
  return owners;
}

/*
 * The random edits above, and what decides whose sight a source is part
 * of: who owns it, directly or through a character, whether it shares
 * sight with the party, and the light level.
 */
const holderEdits: Record<string, Edit> = {
  ...edits,
  own(r, s) {
    const t = pickToken(r, s);
    return t ? withToken(s, { ...t, ownerIds: someOwners(r) }) : s;
  },
  share(r, s) {
    const t = pickToken(r, s);
    return t ? withToken(s, { ...t, partyVision: t.partyVision ? undefined : true }) : s;
  },
  hero(r, s) {
    // A token played through a character, whose owners are the character's.
    const t = pickToken(r, s);
    if (!t) return s;
    const id = `c-${t.id}`;
    const a = "inline" in t.actor ? t.actor.inline : (s.characters[t.actor.ref]?.actor ?? actor());
    const c = character(id, { ownerIds: someOwners(r), actor: a });
    return { ...withToken(s, { ...t, ownerIds: r() < 0.5 ? [] : someOwners(r), actor: { ref: id } }), characters: { ...s.characters, [id]: c } };
  },
  level(r, s) {
    const sc = s.scenes.s1!;
    return { ...s, scenes: { s1: { ...sc, vision: { ...sc.vision!, on: true, light: (["bright", "dim", "dark"] as const)[Math.floor(r() * 3)]! } } } };
  },
};

function holderStart(r: () => number, level: "bright" | "dim" | "dark"): RoomState {
  let s = perPlayer(start(r, level));
  for (const t of Object.values(s.tokens)) s = withToken(s, { ...t, ownerIds: t.kind === "pc" ? someOwners(r) : [] });
  // The monster lends its sight to every player.
  return withToken(s, { ...s.tokens.m1!, partyVision: true });
}

/** The room with its scene per player, as the DM's Sight row sets it. */
function perPlayer(s: RoomState): RoomState {
  const sc = s.scenes.s1!;
  return { ...s, scenes: { ...s.scenes, s1: { ...sc, vision: { ...sc.vision!, perPlayer: true } } } };
}

/** The same room with one more member, `extra`, owning every source any of `members` owns. */
function withOwnerOfAll(s: RoomState, extra: string, members: readonly string[]): RoomState {
  const add = (ids: readonly string[]) => (ids.some((id) => members.includes(id)) ? [...ids, extra] : [...ids]);
  const tokens: Record<string, Token> = {};
  for (const [id, t] of Object.entries(s.tokens)) tokens[id] = { ...t, ownerIds: add(t.ownerIds) };
  const characters = Object.fromEntries(Object.entries(s.characters).map(([id, c]) => [id, { ...c, ownerIds: add(c.ownerIds) }]));
  return { ...s, tokens, characters };
}

function maxInto(out: Uint8Array, levels: Uint8Array): void {
  for (let i = 0; i < out.length; i++) if (levels[i]! > out[i]!) out[i] = levels[i]!;
}

const SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan", "custom"] as const;

/** A creature anywhere on or just off a scene of `size` cells, any size, squeezed or not, at fractional spots. */
function randomProbe(r: () => number, size: number): { size: (typeof SIZES)[number]; x: number; y: number; w?: number; h?: number; squeeze?: true } {
  const kind = SIZES[Math.floor(r() * SIZES.length)]!;
  const probe = { size: kind, x: Math.floor(r() * (size + 4) * 8) / 8 - 2, y: Math.floor(r() * (size + 4) * 8) / 8 - 2 };
  const sized = kind === "custom" ? { ...probe, w: 0.25 + Math.floor(r() * 24) / 8, h: 0.25 + Math.floor(r() * 24) / 8 } : probe;
  return r() < 0.3 ? { ...sized, squeeze: true } : sized;
}

/** Whether any sub-cell center in the probe's sight rectangle has a level above 0: the predicate by brute force over a scene's levels. */
function bruteSees(levels: Uint8Array, w: number, h: number, probe: Parameters<typeof sightRect>[0]): boolean {
  const r = sightRect(probe);
  for (let sy = 0; sy < h * 4; sy++) {
    if (center(sy) < r.y0 || center(sy) >= r.y1) continue;
    for (let sx = 0; sx < w * 4; sx++) if (center(sx) >= r.x0 && center(sx) < r.x1 && levels[sy * w * 4 + sx]! > 0) return true;
  }
  return false;
}

describe("sight holders", () => {
  /*
   * Three rooms in a row, walled apart, on a bright scene: the first
   * player's character in the west, the second player's character (played
   * through its character sheet) in the middle, and an NPC the DM marked to
   * share sight with the party in the east. One creature stands in each.
   */
  function rooms(): RoomState {
    const edges: Record<string, EdgeFeature> = {};
    for (let y = 0; y < 10; y++) {
      edges[`10,${y},w`] = WALL;
      edges[`20,${y},w`] = WALL;
    }
    const s = visionRoom({
      w: 30,
      h: 10,
      build: { edges },
      tokens: [
        pc("a", 4, 4, { ownerIds: ["p1", "p4"] }),
        token("b", { kind: "pc", ownerIds: [], x: 14, y: 4, actor: { ref: "hero" } }),
        token("c", { kind: "npc", partyVision: true, x: 24, y: 4, actor: { inline: actor() } }),
      ],
    });
    s.characters.hero = character("hero", { ownerIds: ["p2", "p4"] });
    return s;
  }
  const west = { size: "medium" as const, x: 5, y: 7 };
  const middle = { size: "medium" as const, x: 15, y: 7 };
  const east = { size: "medium" as const, x: 25, y: 7 };
  const seen = (sight: { seesToken(p: typeof west): boolean }) => [west, middle, east].map((p) => sight.seesToken(p));

  test("a holder sees through the sources they own, directly or through a character, and those that share sight, and never another player's", () => {
    clearVisionCache();
    const s = rooms();
    assert.deepEqual(seen(partySight(s, "s1", world)), [true, true, true], "the union, the DM's");
    assert.deepEqual(seen(holderSight(s, "s1", "p1", world)), [true, false, true], "the first player");
    assert.deepEqual(seen(holderSight(s, "s1", "p2", world)), [false, true, true], "the second player, through the character");
    assert.deepEqual(seen(holderSight(s, "s1", null, world)), [false, false, true], "the shared sight");
    assert.deepEqual(seen(holderSight(s, "s1", "p3", world)), [false, false, true], "a player who owns nothing");
    // The same through the tiles, once drawn.
    for (const viewer of ["p1", "p2", null]) {
      const tiles = holderSight(s, "s1", viewer, world).tiles;
      assert.deepEqual(seen(sightFromTiles(Object.fromEntries([...tiles].map(([k, t]) => [`s1:${k}`, t])), "s1")), seen(coldHolderSight(s, "s1", viewer, world)), `${viewer}`);
    }
  });

  test("the sources a holder sees through are those project.ts says they own, and every one marked to share sight", () => {
    const r = rng(41);
    let s = holderStart(r, "bright");
    const names = Object.keys(holderEdits);
    for (let step = 0; step < 60; step++) {
      s = holderEdits[names[Math.floor(r() * names.length)]!]!(r, s);
      const union = Object.values(s.tokens).filter((t) => partySight({ ...s, tokens: { [t.id]: t } }, "s1", world).tiles.size > 0);
      for (const viewer of VIEWERS) {
        // Each source alone on the scene: the viewer sees through it exactly when it lends to them.
        for (const t of union) {
          const alone = { ...s, tokens: { [t.id]: t } };
          const lends = t.partyVision === true || (viewer !== null && ownsToken(s, { memberId: viewer, role: "player" }, t));
          assert.equal(holderSight(alone, "s1", viewer, world).tiles.size > 0, lends, `step ${step}: ${t.id} for ${viewer}`);
        }
      }
    }
  });

  test("viewers with the same sources share one answer, one holding every source gets the union's, and one with none sees nothing", () => {
    clearVisionCache();
    const s = rooms();
    assert.equal(holderSight(s, "s1", "p3", world), holderSight(s, "s1", null, world), "a player who owns nothing has the shared sight");
    assert.equal(holderSight(s, "s1", "p4", world), partySight(s, "s1", world), "the fourth player owns both characters");
    const none = { ...s, tokens: { ...s.tokens, c: { ...s.tokens.c!, partyVision: undefined } } };
    assert.equal(holderSight(none, "s1", null, world), NO_PARTY_SIGHT, "nothing shares sight");
    assert.equal(holderSight({ ...s, scenes: { s1: { ...s.scenes.s1!, vision: { on: false, light: "bright" } } } }, "s1", "p1", world), NO_PARTY_SIGHT, "vision off");
    assert.equal(holderSight(s, "missing", "p1", world), NO_PARTY_SIGHT, "a scene the state lacks");
  });

  for (const level of ["bright", "dim", "dark"] as const) {
    test(`every raster equals a cold computation after random edits, on a ${level} scene`, () => {
      clearVisionCache();
      const r = rng(level === "bright" ? 51 : level === "dim" ? 52 : 53);
      let s = holderStart(r, level);
      const names = Object.keys(holderEdits);
      for (let step = 0; step < 70; step++) {
        const name = names[Math.floor(r() * names.length)]!;
        // Some viewers each step, in a random order, so rasters start from the union, from their own last one or from another set's.
        const asked = VIEWERS.filter(() => r() < 0.7).sort(() => r() - 0.5);
        if (step % 9 === 4) {
          // A staged state the size guard refused: drawn, then dropped.
          const staged = holderEdits[name]!(r, s);
          for (const viewer of asked) void holderSight(staged, "s1", viewer, world).tiles;
          continue;
        }
        s = holderEdits[name]!(r, s);
        for (const viewer of asked) sameTiles(holderSight(s, "s1", viewer, world).tiles, coldHolderSight(s, "s1", viewer, world).tiles, `step ${step} (${name}), ${viewer}`);
        sameTiles(partySight(s, "s1", world).tiles, coldPartySight(s, "s1", world).tiles, `step ${step} (${name}), the union`);
      }
    });
  }

  test("every raster equals a cold computation through lights changing on a dim scene", () => {
    clearVisionCache();
    const r = rng(54);
    let s = holderStart(r, "dim");
    const mix: Edit[] = [edits.light!, edits.light!, edits.light!, edits.carry!, edits.nudge!, holderEdits.own!];
    for (let step = 0; step < 60; step++) {
      s = mix[Math.floor(r() * mix.length)]!(r, s);
      for (const viewer of VIEWERS) sameTiles(holderSight(s, "s1", viewer, world).tiles, coldHolderSight(s, "s1", viewer, world).tiles, `step ${step}, ${viewer}`);
    }
  });

  test("every raster equals a cold computation when each holder lacks one source of many that see the same ground", () => {
    clearVisionCache();
    // Six sources in one open room, so most tiles have each level from two of them, and holder k owns all but the k-th.
    const r = rng(57);
    for (const level of ["bright", "dim", "dark"] as const) {
      const ids = ["q0", "q1", "q2", "q3", "q4", "q5"];
      const tokens = ids.map((id, k) => pc(id, 8 + 4 * k, 10 + (k % 2) * 4, { ownerIds: ids.map((_, h) => `h${h}`).filter((_, h) => h !== k), senses: k % 3 === 0 ? "darkvision 60 ft" : "" }));
      let s = perPlayer(visionRoom({ w: 40, h: 30, light: level, build: { edges: roomEdges(2, 2, 34, 24), cells: { "18,14": "pillar", "26,8": "pillar" } }, tokens, lights: [light("l", 20, 14, 20, 20)] }));
      const viewers = [...ids.map((_, h) => `h${h}`), null];
      // First as a whole-party scene, then per player: the union's computation from before has no marks for its tiles.
      const whole = { ...s, scenes: { s1: { ...s.scenes.s1!, vision: { on: true, light: level } } } };
      void partySight(whole, "s1", world);
      for (let step = 0; step < 25; step++) {
        const t = s.tokens[ids[Math.floor(r() * ids.length)]!]!;
        s = r() < 0.8 ? withToken(s, { ...t, x: Math.max(3, Math.min(34, t.x + Math.floor(r() * 3) - 1)), y: Math.max(3, Math.min(24, t.y + Math.floor(r() * 3) - 1)) }) : holderEdits.light!(r, s);
        for (const viewer of viewers) sameTiles(holderSight(s, "s1", viewer, world).tiles, coldHolderSight(s, "s1", viewer, world).tiles, `${level} step ${step}, ${viewer}`);
      }
    }
  });

  test("a tile that changes when any one source is left out names that source among its sole sources, through random edits", () => {
    clearVisionCache();
    const r = rng(58);
    let s = holderStart(r, "dim");
    const names = Object.keys(holderEdits);
    let checked = 0;
    for (let step = 0; step < 40; step++) {
      s = holderEdits[names[Math.floor(r() * names.length)]!]!(r, s);
      const union = partySight(s, "s1", world).tiles;
      const sole = soleSourcesOf(s, "s1", world);
      assert.ok(sole, "a per-player scene works out its sole sources");
      for (const id of Object.keys(s.tokens)) {
        const without = coldSightOf(s, "s1", (t) => t !== id, world).tiles;
        for (const key of new Set([...union.keys(), ...without.keys()])) {
          const a = union.get(key);
          const b = without.get(key);
          if (a === b || (a && b && JSON.stringify(a) === JSON.stringify(b))) continue;
          const named = sole.get(key);
          checked++;
          assert.ok(named === "unknown" || named?.includes(id), `step ${step}: tile ${key} changes without ${id}, whose sole sources are ${JSON.stringify(named)}`);
        }
      }
    }
    assert.ok(checked > 100, `${checked} tiles checked`);
  });

  test("every holder's raster and the shared sight together are the sight of every source any of them sees through", () => {
    clearVisionCache();
    const r = rng(61);
    let s = holderStart(r, "dark");
    const names = Object.keys(holderEdits);
    for (let step = 0; step < 30; step++) {
      s = holderEdits[names[Math.floor(r() * names.length)]!]!(r, s);
      const { w, h } = s.scenes.s1!.bounds;
      const merged = new Uint8Array(w * h * 16);
      for (const viewer of VIEWERS) maxInto(merged, levelsOf(holderSight(s, "s1", viewer, world).tiles, w, h));
      const together = withOwnerOfAll(s, "all", HOLDERS);
      assert.deepEqual(merged, levelsOf(coldHolderSight(together, "s1", "all", world).tiles, w, h), `step ${step}`);
    }
  });

  test("a raster's in-sight test is a brute force over its sub-cells, squeezed and Tiny footprints included", () => {
    clearVisionCache();
    const r = rng(71);
    let s = holderStart(r, "dim");
    const names = Object.keys(holderEdits);
    for (let step = 0; step < 12; step++) {
      s = holderEdits[names[Math.floor(r() * names.length)]!]!(r, s);
      const { w, h } = s.scenes.s1!.bounds;
      for (const viewer of VIEWERS) {
        const sight = holderSight(s, "s1", viewer, world);
        const levels = levelsOf(sight.tiles, w, h);
        for (let k = 0; k < 150; k++) {
          const probe = randomProbe(r, w);
          assert.equal(sight.seesToken(probe), bruteSees(levels, w, h, probe), `step ${step}, ${viewer}: ${JSON.stringify(probe)}`);
        }
      }
    }
  });

  test("the point query answers as the raster later drawn, and asking it draws no raster", () => {
    const r = rng(81);
    let s = holderStart(r, "dark");
    const names = Object.keys(holderEdits);
    let queried = 0;
    let both = 0;
    for (let step = 0; step < 40; step++) {
      s = holderEdits[names[Math.floor(r() * names.length)]!]!(r, s);
      // A moment's state: the union's computation is there, and no holder's raster.
      clearVisionCache();
      const at = { ...s };
      const sights = VIEWERS.map((viewer) => holderSight(at, "s1", viewer, world));
      const probes = Array.from({ length: 120 }, () => randomProbe(r, SIZE));
      const asked = sights.map((sight) => probes.map((p) => sight.seesToken(p)));
      assert.equal(visionCacheReport().rasters, 0, `step ${step}: seesToken drew a raster`);
      const union = partySight(at, "s1", world);
      for (const [i, sight] of sights.entries()) {
        if (sight !== union && sight !== NO_PARTY_SIGHT) queried++;
        // Reading the tiles draws the raster, and seesToken then reads it.
        void sight.tiles;
        const drawn = probes.map((p) => sight.seesToken(p));
        assert.deepEqual(asked[i], drawn, `step ${step}, ${VIEWERS[i]}`);
        both += drawn.filter(Boolean).length > 0 && drawn.some((d) => !d) ? 1 : 0;
      }
    }
    assert.ok(queried > 80, `the point query answered for ${queried} viewers`);
    assert.ok(both > 40, `${both} viewers saw some probes and not others`);
  });

  test("the cache's running count of bytes is its contents counted again, through random edits and draws", () => {
    clearVisionCache();
    const r = rng(91);
    let s = holderStart(r, "dark");
    const names = Object.keys(holderEdits);
    let most = 0;
    for (let step = 0; step < 40; step++) {
      s = holderEdits[names[Math.floor(r() * names.length)]!]!(r, s);
      for (const viewer of VIEWERS.filter(() => r() < 0.7)) void holderSight(s, "s1", viewer, world).tiles;
      const report = visionCacheReport();
      assert.equal(report.bytes, report.recount, `step ${step}`);
      most = Math.max(most, report.rasters);
    }
    assert.ok(most > 0);
    clearVisionCache();
    assert.deepEqual(visionCacheReport(), { bytes: 0, recount: 0, pinned: 0, scenes: 0, rasters: 0 });
  });

  test("a raster counts its tiles, and the source entries it holds once no computation does", () => {
    clearVisionCache();
    const s = rooms();
    partySight(s, "s1", world);
    const before = visionCacheReport();
    const tiles = holderSight(s, "s1", "p1", world).tiles;
    const drawn = visionCacheReport();
    const varied = [...tiles.values()].filter((t) => "b" in t).length;
    assert.ok(varied > 0);
    assert.ok(drawn.bytes - before.bytes >= varied * 1024, "a varied tile counts its 1,024 levels at least");
    assert.equal(drawn.pinned, 0, "the union's computation holds what the raster read");
    // Every source moves, twice, so neither computation the scene keeps holds the source entries the raster read.
    let next: RoomState = s;
    for (const dx of [1, 2]) {
      next = { ...next, tokens: Object.fromEntries(Object.entries(s.tokens).map(([id, t]) => [id, { ...t, x: t.x + dx }])) };
      partySight(next, "s1", world);
    }
    const kept = visionCacheReport();
    assert.equal(kept.rasters, 1);
    assert.ok(kept.pinned >= 2 * 200, "the raster's two source entries are counted");
    assert.equal(kept.bytes, kept.recount);
  });

  test("a raster counts the light rows it holds once no computation does", () => {
    clearVisionCache();
    // A light over the whole scene keeps every source's sweep box, so a small light moving changes the light rows alone.
    const s = { ...rooms(), scenes: { s1: { ...rooms().scenes.s1!, vision: { on: true, light: "dark" as const } } }, lights: { all: light("all", 15, 5, 60, 60), l: light("l", 5, 5, 10, 10) } };
    void holderSight(s, "s1", "p1", world).tiles;
    assert.equal(visionCacheReport().pinned, 0);
    let next: RoomState = s;
    for (const x of [6, 7]) {
      next = { ...next, lights: { ...next.lights, l: { ...next.lights.l!, x } } };
      partySight(next, "s1", world);
    }
    const kept = visionCacheReport();
    assert.ok(kept.pinned >= 40 * 8, "the raster's light rows are counted, 8 bytes a row at least");
    assert.equal(kept.bytes, kept.recount);
  });

  test("a light that changes where a holder sees redraws their raster from their last one", () => {
    clearVisionCache();
    // A dim hall: the first player's two characters, one by a light that straddles a tile's edge at x = 16, and three of the second player's far away.
    let s = visionRoom({
      w: 40,
      h: 40,
      light: "dim",
      tokens: [pc("a", 14, 6, { ownerIds: ["p1"] }), pc("e", 30, 34, { ownerIds: ["p1"] }), ...["b", "c", "d"].map((id, i) => pc(id, 4 + 12 * i, 36, { ownerIds: ["p2"] }))],
      lights: [light("l", 16, 8, 20, 10)],
    });
    // Walls around the first character's corner, so the far sources do not see where the light moves.
    s.buildChunks = chunksOf("s1", { edges: roomEdges(8, 2, 16, 12) });
    const steps: ((s: RoomState) => RoomState)[] = [
      (s) => ({ ...s, lights: { ...s.lights, l: { ...s.lights.l!, x: 17 } } }),
      (s) => ({ ...s, lights: { ...s.lights, l: { ...s.lights.l!, on: false } } }),
      (s) => ({ ...s, lights: { ...s.lights, l: { ...s.lights.l!, on: true, x: 15.5, y: 9 } } }),
      (s) => ({ ...s, lights: { ...s.lights, m: light("m", 20, 4, 10, 10) } }),
      (s) => ({ ...s, lights: { l: s.lights.l! } }),
    ];
    void holderSight(s, "s1", "p1", world).tiles;
    for (const [i, step] of steps.entries()) {
      s = step(s);
      sameTiles(holderSight(s, "s1", "p1", world).tiles, coldHolderSight(s, "s1", "p1", world).tiles, `step ${i}`);
    }
  });

  test("a holder's source whose senses change, or that walks along the scene's edge, redraws their raster from their last one", () => {
    clearVisionCache();
    // The first player's character alone by the east edge, and two of the second player's that see most of the scene, so the union is a poor start.
    let s = visionRoom({
      w: 40,
      h: 24,
      light: "dim",
      tokens: [pc("a", 37, 10, { ownerIds: ["p1"] }), pc("b", 6, 4, { ownerIds: ["p2"], senses: "darkvision 60 ft" }), pc("c", 6, 18, { ownerIds: ["p2"], senses: "darkvision 60 ft" })],
      lights: [light("all", 20, 12, 0, 120, { walls: false })],
    });
    s.buildChunks = chunksOf("s1", { edges: roomEdges(30, 2, 10, 20) });
    const a = (s: RoomState) => s.tokens.a!;
    const senses = (line: string) => (s: RoomState) => withToken(s, { ...a(s), actor: { inline: actor({ senses: line }) } });
    const steps: [string, (s: RoomState) => RoomState][] = [
      ["darkvision", senses("darkvision 30 ft")],
      ["more darkvision", senses("darkvision 60 ft")],
      ["truesight", senses("truesight 30 ft")],
      ["blindsight", senses("blindsight 10 ft")],
      ["north along the edge", (s) => withToken(s, { ...a(s), y: a(s).y - 1 })],
      ["south along the edge", (s) => withToken(s, { ...a(s), y: a(s).y + 3 })],
      ["darkvision again", senses("darkvision 150 ft")],
      ["to the corner", (s) => withToken(s, { ...a(s), x: 39, y: 21 })],
    ];
    void holderSight(s, "s1", "p1", world).tiles;
    for (const [name, step] of steps) {
      s = step(s);
      sameTiles(holderSight(s, "s1", "p1", world).tiles, coldHolderSight(s, "s1", "p1", world).tiles, name);
      for (const dark of [false, true]) {
        // The same on a dark scene, where the big light keeps the sweep box as senses change.
        const d = dark ? { ...s, scenes: { s1: { ...s.scenes.s1!, vision: { on: true, light: "dark" as const } } } } : s;
        sameTiles(holderSight(d, "s1", "p1", world).tiles, coldHolderSight(d, "s1", "p1", world).tiles, `${name}${dark ? ", dark" : ""}`);
      }
    }
  });

  test("the point query reads Blinded, the senses and the light as the raster does", () => {
    // A Blinded creature with blindsight, one with darkvision and one with truesight, in the dark around lights, each its own player's.
    const s = visionRoom({
      w: 32,
      h: 16,
      light: "dark",
      tokens: [
        pc("blind", 4, 4, { ownerIds: ["p1"], actor: { inline: actor({ senses: "blindsight 10 ft", effects: [{ id: "e", key: "blinded" }] }) } }),
        pc("dark", 14, 8, { ownerIds: ["p2"], senses: "darkvision 30 ft" }),
        pc("true", 26, 8, { ownerIds: ["p3"], senses: "truesight 20 ft" }),
        pc("other", 28, 2, { ownerIds: ["p4"] }),
      ],
      lights: [light("l1", 6, 10, 10, 10), light("l2", 24, 12, 0, 15)],
    });
    const r = rng(111);
    const probes = Array.from({ length: 600 }, () => randomProbe(r, 32));
    for (const viewer of ["p1", "p2", "p3"]) {
      clearVisionCache();
      const sight = holderSight(s, "s1", viewer, world);
      const asked = probes.map((p) => sight.seesToken(p));
      assert.equal(visionCacheReport().rasters, 0);
      const levels = levelsOf(sight.tiles, 32, 16);
      assert.deepEqual(asked, probes.map((p) => bruteSees(levels, 32, 16, p)), `${viewer}`);
      assert.ok(asked.some(Boolean) && asked.some((a) => !a), `${viewer} sees some probes and not others`);
    }
  });

  test("a scene keeps rasters for at most 14 source sets", () => {
    clearVisionCache();
    const r = rng(101);
    const s = holderStart(r, "bright");
    const sources = Object.keys(s.tokens);
    let drawn = 0;
    for (let k = 1; k < 2 ** sources.length - 1; k++) {
      // A player owning the k-th subset of the sources, and nothing that shares sight.
      const owned = { ...s, tokens: Object.fromEntries(Object.entries(s.tokens).map(([id, t], i) => [id, { ...t, partyVision: undefined, ownerIds: k & (1 << i) ? ["q"] : ["p5"] }])) };
      const sight = holderSight(owned, "s1", "q", world);
      if (sight === partySight(owned, "s1", world) || sight === NO_PARTY_SIGHT) continue;
      void sight.tiles;
      drawn++;
      assert.ok(visionCacheReport().rasters <= 14, `after ${drawn} sets`);
    }
    assert.ok(drawn > 14, `${drawn} sets drawn`);
    assert.equal(visionCacheReport().rasters, 14);
  });
});
