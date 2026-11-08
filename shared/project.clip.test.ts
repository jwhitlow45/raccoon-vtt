import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertMembership, checkPair } from "./differential.ts";
import { liftSubs, remember, wall } from "./discoveryTestutil.ts";
import { keys, tileKey, wallChunk } from "./keys.ts";
import type { FreeWall, GridShape, InitEntry, LogEntry, RoomState, Token, Viewer } from "./model.ts";
import {
  activeRowShownTo,
  areaSeenMark,
  dependents,
  heldSightClip,
  inSightOfNonOwners,
  lineReader,
  projectEntityForOp,
  projectState,
  projectStateForOp,
  rowSeenMark,
  seenAtEvery,
  seenByNonOwners,
  seenMark,
  stableStringify,
  withheldFromViewer,
  withheldWhereItStands,
} from "./project.ts";
import { walkerFor } from "./rules/attach.ts";
import { occupiedHexes, storedCenter } from "./rules/footprint.ts";
import { wallSpans } from "./rules/held.ts";
import { hexAt, hexCenter, hexKey, hexNeighbors, hexSubcells, sceneHexes, HEX_R, type Hex, type HexGrid } from "./rules/hex.ts";
import { COLUMNS, onHex, ROWS, sideWall } from "./rules/hexWalls.testkit.ts";
import { clipFootprint, sightClipOf } from "./rules/vision.ts";
import { publicToken } from "./rules/walkWorld.ts";
import { sceneWalls } from "./rules/walls.ts";
import { chance, DM, int, member, P1, pick, rng, room, scene, template } from "./testutil.ts";

/**
 * A creature's outline on hexes, clipped by the walls the viewer holds
 * (docs/design/design-v1-hex-grids.md HX-D10). Each fog class's copy of the
 * sight walls is built from its own chunks with their remembered versions,
 * where ops stored before op version 37 read the build's walls.
 * Seen by all on a per-player hex scene is what the shared class's copy
 * shows, and every screen shows it (docs/design/design-v1-per-player-vision.md
 * decision 10). Devices read it from the `seenAll` mark.
 */

const SHAPES = [
  ["hex rows", ROWS],
  ["hex columns", COLUMNS],
] as const;
const P2: Viewer = { memberId: "p2", role: "player" };
const P3: Viewer = { memberId: "p3", role: "player" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const q = (v: number) => Math.round(v * 64) / 64;
const shapeOf = (g: HexGrid): GridShape => (g.orient === "rows" ? "hexRows" : "hexColumns");
const subsOf = (g: HexGrid, hexes: readonly Hex[]) => hexes.flatMap((h) => hexSubcells(g, h));

type RoomOpts = { vision?: boolean; perPlayer?: boolean; holders?: readonly string[] };

/** A 20 by 16 hex scene with fog on and no automatic walls, three players, and on a per-player scene these sight holders. */
function hexRoom(g: HexGrid, opts: RoomOpts = {}): RoomState {
  const vision = opts.vision === true;
  const perPlayer = opts.perPlayer === true || opts.holders !== undefined;
  const s = room({
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") },
    scenes: { s1: scene("s1", { gridShape: shapeOf(g), bounds: { w: 20, h: 16 }, autoWalls: "off", fogEnabled: true, vision: { on: vision, light: vision ? "dark" : "bright", ...(perPlayer ? { perPlayer: true as const } : {}) } }) },
  });
  s.buildChunks = {};
  if (opts.holders) s.holders = { s1: { sceneId: "s1", rev: 1, entries: opts.holders.map((memberId) => ({ memberId, on: true })) } };
  return s;
}

/** The sub-cells of a creature's footprint a clip keeps, as text to compare. */
function keptBy(g: HexGrid, token: Token, clip: ReturnType<typeof sightClipOf>): string {
  return clipFootprint(g, token, clip)
    .kept.map((s) => s.join(","))
    .join(" ");
}

const buildClip = (s: RoomState) => sightClipOf(sceneWalls(s.scenes.s1!, s.buildChunks));
/** The walls a viewer's device clips by: those of its own copy of the room. */
const copyClip = (s: RoomState, viewer: Viewer) => {
  const copy = projectState(s, viewer, { sceneId: "s1" }) as unknown as RoomState;
  return sightClipOf(sceneWalls(copy.scenes.s1!, copy.buildChunks));
};

/** A memory entry for a wall, as the map step writes one: the wall as remembered, or null for one remembered absent. */
function rememberWall(s: RoomState, layer: string | null, w: FreeWall, remembered: FreeWall | null): void {
  const cells = wallSpans(sceneGridOf(s), w).map((span) => span.cell);
  const home = wallChunk(w);
  remember(s, layer, home.cx, home.cy, { walls: { [w.id]: [{ wall: remembered, cells }] } });
}

const sceneGridOf = (s: RoomState) => (s.scenes.s1!.gridShape === "hexRows" ? ROWS : COLUMNS);

/**
 * A random per-player or whole-party room round a large creature (the
 * design's probes): the DM's, the party's and two holders' layers lifted
 * on random hexes round it, walls near it, on a vision scene a lamp and
 * the holders' torch bearers, and in some vision rooms memory of a wall
 * the DM removed or added.
 */
function randomRoom(n: number, opts: { vision: boolean; perPlayer: boolean; seed: number }): { s: RoomState; g: HexGrid; ogre: Token; holders: string[] } {
  const r = rng(opts.seed + n);
  const g = chance(r, 0.5) ? ROWS : COLUMNS;
  const holders = opts.perPlayer ? ["p1", "p2"] : [];
  const s = hexRoom(g, { vision: opts.vision, ...(opts.perPlayer ? { holders } : {}) });
  const at = { col: int(r, 6, 13), row: int(r, 5, 10) };
  const ogre = onHex(g, "ogre", pick(r, ["huge", "gargantuan", "large"] as const), at, { name: "Ogre", kind: "npc" });
  const mine = occupiedHexes(g, ogre);
  const ring = [...mine, ...mine.flatMap((h) => hexNeighbors(g, h))];
  const c = hexCenter(g, at);
  const nearby = sceneHexes(g, s.scenes.s1!.bounds).filter((h) => {
    const hc = hexCenter(g, h);
    const d = Math.hypot(hc.x - c.x, hc.y - c.y);
    return d < 6 && d > 2.5;
  });
  const torch = () => ({ light: { bright: 5 * int(r, 1, 4), dim: 5 * int(r, 0, 3) } });
  if (opts.vision) {
    s.tokens.lamp = onHex(g, "lamp", "medium", pick(r, nearby), { name: "Lamp", kind: "npc", disposition: "ally", partyVision: true, ...torch() });
    for (const h of holders) if (chance(r, 0.8)) s.tokens[`pc${h}`] = onHex(g, `pc${h}`, "medium", pick(r, nearby), { name: `Hero ${h}`, kind: "pc", disposition: "ally", ownerIds: [h], ...torch() });
  }
  liftSubs(s, "dm", subsOf(g, ring.filter(() => chance(r, opts.vision ? 0.15 : 0.12))));
  liftSubs(s, "party", subsOf(g, ring.filter(() => chance(r, opts.vision ? 0.35 : 0.12))));
  for (const h of holders) liftSubs(s, { holder: h }, subsOf(g, ring.filter(() => chance(r, 0.3))));
  for (let i = int(r, 2, 7); i > 0; i--) {
    const hc = hexCenter(g, pick(r, ring));
    wall(s, `cl${String(n).padStart(5, "0")}${i}000`.slice(0, 12), [q(hc.x + (r() - 0.5) * 2 * HEX_R), q(hc.y + (r() - 0.5) * 2 * HEX_R)], [q(hc.x + (r() - 0.5) * 2 * HEX_R), q(hc.y + (r() - 0.5) * 2 * HEX_R)]);
  }
  if (opts.vision && chance(r, 0.5)) {
    const hc = hexCenter(g, pick(r, ring));
    const w: FreeWall = { id: `cm${String(n).padStart(5, "0")}0000000`.slice(0, 12), a: [q(hc.x + (r() - 0.5) * 2 * HEX_R), q(hc.y - 0.6)], b: [q(hc.x + (r() - 0.5) * 2 * HEX_R), q(hc.y + 0.6)], f: { kind: "wall" } };
    const layer = holders.length === 0 || chance(r, 0.6) ? null : pick(r, holders);
    if (chance(r, 0.5)) rememberWall(s, layer, w, w);
    else {
      wall(s, w.id, w.a, w.b);
      rememberWall(s, layer, w, null);
    }
  }
  s.tokens.ogre = ogre;
  return { s, g, ogre, holders };
}

/**
 * A Huge creature on a whole-party or per-player fog scene with a short
 * wall through its stored center, on its middle hex, which no layer holds.
 * The build's clip steps its eye off that wall to one side, and the hexes
 * the wall then cuts off are the only ground revealed, in `layer`: so the
 * build's walls withhold it and every copy, which holds no wall, shows it.
 */
function middleWallRoom(g: HexGrid, opts: RoomOpts & { layer?: "dm" | "party" | { holder: string } } = {}): { s: RoomState; ogre: Token } {
  const s = hexRoom(g, opts);
  const at = { col: 9, row: 7 };
  const ogre = onHex(g, "ogre", "huge", at, { name: "Ogre", kind: "npc" });
  const c = storedCenter(ogre);
  wall(s, "midwall00001", [q(c.x - 0.25), q(c.y)], [q(c.x + 0.25), q(c.y)]);
  const kept = new Set(clipFootprint(g, ogre, buildClip(s)).kept.map((sub) => sub.join(",")));
  const cut = occupiedHexes(g, ogre).filter((h) => hexKey(h) !== hexKey(at) && hexSubcells(g, h).every((sub) => !kept.has(sub.join(","))));
  assert.ok(cut.length > 0, "the build's clip cuts off some of its hexes");
  liftSubs(s, opts.layer ?? "dm", subsOf(g, cut));
  s.tokens.ogre = ogre;
  return { s, ogre };
}

for (const [name, g] of SHAPES) {
  describe(`a creature's outline is clipped by the walls the viewer holds, ${name}`, () => {
    test("a wall through its middle that no player holds clips nothing: the eye steps off only the walls held", () => {
      const s = hexRoom(g);
      const at = { col: 9, row: 8 };
      const ogre = onHex(g, "ogre", "huge", at, { name: "Ogre", kind: "npc" });
      liftSubs(s, "dm", subsOf(g, occupiedHexes(g, ogre).filter((h) => hexKey(h) !== hexKey(at))));
      const c = hexCenter(g, at);
      wall(s, "k2d000000001", [q(c.x - 0.3), q(c.y)], [q(c.x + 0.3), q(c.y)]);
      const all = clipFootprint(g, ogre, null).subs.length;
      assert.ok(clipFootprint(g, ogre, buildClip(s)).kept.length < all, "the build's walls clip it");
      assert.equal(clipFootprint(g, ogre, heldSightClip(s, s.scenes.s1!, g, null, ogre)).kept.length, all, "the held walls clip nothing");
      assert.equal(keptBy(g, ogre, heldSightClip(s, s.scenes.s1!, g, null, ogre)), keptBy(g, ogre, copyClip(s, P1)), "as the player's own copy clips it");
    });

    test("a wall the DM removed still clips where the party remembers it, and one the DM added where it remembers none does not", () => {
      for (const kind of ["removed", "added"] as const) {
        const s = hexRoom(g, { vision: true });
        const at = { col: 9, row: 8 };
        const ogre = onHex(g, "ogre", "huge", at, { name: "Ogre", kind: "npc" });
        liftSubs(s, "party", subsOf(g, occupiedHexes(g, ogre).flatMap((h) => [h, ...hexNeighbors(g, h)])));
        const c = hexCenter(g, at);
        const w: FreeWall = { id: "k2m000000001", a: [q(c.x + 0.3), q(c.y - 0.6)], b: [q(c.x + 0.3), q(c.y + 0.6)], f: { kind: "wall" } };
        if (kind === "removed") rememberWall(s, null, w, w);
        else {
          wall(s, w.id, w.a, w.b);
          rememberWall(s, null, w, null);
        }
        const all = clipFootprint(g, ogre, null).subs.length;
        const held = clipFootprint(g, ogre, heldSightClip(s, s.scenes.s1!, g, null, ogre)).kept.length;
        const built = clipFootprint(g, ogre, buildClip(s)).kept.length;
        if (kind === "removed") {
          assert.equal(built, all, "the build has no wall");
          assert.ok(held < all, "the remembered wall clips");
        } else {
          assert.ok(built < all, "the build's wall clips");
          assert.equal(held, all, "the wall remembered absent does not");
        }
        assert.equal(keptBy(g, ogre, heldSightClip(s, s.scenes.s1!, g, null, ogre)), keptBy(g, ogre, copyClip(s, P1)), `${kind}: as the party's copy clips it`);
      }
    });

    test("a seen wall between its middle and its revealed hex withholds it, and a Huge creature with its middle unrevealed and no walls is shown, as today", () => {
      const s = hexRoom(g);
      const at = { col: 9, row: 8 };
      const ogre = onHex(g, "ogre", "huge", at, { name: "Ogre", kind: "npc" });
      const outer = occupiedHexes(g, ogre).find((h) => hexKey(h) !== hexKey(at))!;
      liftSubs(s, "dm", hexSubcells(g, outer));
      s.tokens.ogre = ogre;
      assert.equal(withheldWhereItStands(s, ogre), false, "shown by its one revealed hex");
      assert.equal(inSightOfNonOwners(s, ogre, { opVersion: 36 }), true);
      // Walls round the revealed hex, along its six sides, which every player holds.
      for (let d = 0; d < 6; d++) {
        const side = sideWall(g, outer, d);
        wall(s, `k2s00000000${d}`, side.a, side.b);
      }
      assert.equal(withheldWhereItStands(s, ogre), true, "withheld behind the walls players hold");
      assert.equal(inSightOfNonOwners(s, ogre, { opVersion: 36 }), false, "as the build's walls withhold it");
    });

    test("one revealed hex with a wall along its side, and random rooms: each class's clip is the clip of its own copy", () => {
      if (g === ROWS) {
        const s = hexRoom(g);
        liftSubs(s, "dm", hexSubcells(g, { col: 8, row: 8 }));
        wall(s, "k2a000000001", [8, 7.796875], [8, 7.21875]);
        const ogre = onHex(g, "ogre", "huge", { col: 7, row: 8 }, { name: "Ogre", kind: "npc" });
        s.tokens.ogre = ogre;
        assert.equal(keptBy(g, ogre, heldSightClip(s, s.scenes.s1!, g, null, ogre)), keptBy(g, ogre, copyClip(s, P1)));
        assert.equal(withheldWhereItStands(s, ogre), true, "the copy's wall piece withholds it");
      }
      let checked = 0;
      let today = 0;
      for (let n = 0; n < 150; n++) {
        const vision = n % 2 === 1;
        const { s, g: grid, ogre, holders } = randomRoom(n, { vision, perPlayer: n % 3 !== 0, seed: g === ROWS ? 0xc11 : 0xc12 });
        for (const view of [null, ...holders]) {
          const viewer = { memberId: view ?? "p3", role: "player" as const };
          const copy = keptBy(grid, ogre, copyClip(s, viewer));
          assert.equal(keptBy(grid, ogre, heldSightClip(s, s.scenes.s1!, grid, view, ogre)), copy, `room ${n}, ${view ?? "the shared class"}`);
          if (keptBy(grid, ogre, buildClip(s)) !== copy) today++;
          checked++;
        }
      }
      assert.ok(today > 20, `the build's clip differs from a copy's in ${today} of ${checked}, so the rooms test something`);
    });

    test("a warm answer after a scene update that shrinks its bounds is the cold one", () => {
      let shrunkClips = 0;
      for (let n = 0; n < 120; n++) {
        const r = rng((g === ROWS ? 0x5ce : 0x5cf) + n);
        const s = hexRoom(g);
        const at = { col: int(r, 4, 9), row: int(r, 4, 10) };
        const ogre = onHex(g, "ogre", pick(r, ["huge", "gargantuan"] as const), at, { name: "Ogre", kind: "npc" });
        const c = hexCenter(g, at);
        for (let i = int(r, 2, 6); i > 0; i--) {
          const x = c.x + (r() - 0.2) * 6;
          const y = c.y + (r() - 0.5) * 4;
          wall(s, `sc${String(n).padStart(5, "0")}${i}0000`.slice(0, 12), [q(x), q(y)], [q(x + (r() - 0.5) * 2 * HEX_R), q(y + (r() - 0.5) * 2 * HEX_R)]);
        }
        liftSubs(s, "dm", subsOf(g, sceneHexes(g, s.scenes.s1!.bounds).filter(() => chance(r, 0.7))));
        const kept = (st: RoomState) => keptBy(g, ogre, heldSightClip(st, st.scenes.s1!, g, null, ogre));
        const before = kept(s);
        const shrunk = { ...s, scenes: { ...s.scenes, s1: { ...s.scenes.s1!, bounds: { w: int(r, 6, 12), h: 16 } } } };
        const warm = kept(shrunk);
        const cold = kept({ ...shrunk, buildChunks: { ...shrunk.buildChunks }, fogTiles: { ...shrunk.fogTiles } });
        assert.equal(warm, cold, `room ${n}`);
        if (cold !== before) shrunkClips++;
      }
      assert.ok(shrunkClips > 10, `the shrink changes ${shrunkClips} clips, so the cache is tested`);
    });
  });
}

describe("each player's copy and frames, clipped by the walls the viewer holds", () => {
  /**
   * The design's clip pairs: a Huge or Gargantuan creature, a revealed
   * half-plane through it or random revealed hexes or both, with vision a
   * torch bearer near it and ground explored out of sight, short walls
   * through and beside it, and in the second room more walls inside hexes
   * round it that P1 neither holds nor sees.
   */
  function pairOf(n: number, vision: boolean): { a: RoomState; b: RoomState; added: number } {
    const r = rng(0xc11 + n);
    const g = chance(r, 0.5) ? ROWS : COLUMNS;
    const s = hexRoom(g, { vision });
    const at = { col: int(r, 6, 13), row: int(r, 5, 10) };
    const ogre = onHex(g, "ogre", pick(r, ["huge", "gargantuan"] as const), at, { name: "Ogre", kind: "npc" });
    const mine = occupiedHexes(g, ogre);
    const all = sceneHexes(g, s.scenes.s1!.bounds);
    const c = hexCenter(g, at);
    const turn = r() * 2 * Math.PI;
    const off = (r() - 0.5) * 3;
    const revealed = new Set<string>();
    const style = int(r, 0, 2);
    for (const h of all) {
      const hc = hexCenter(g, h);
      const side = (hc.x - c.x) * Math.cos(turn) + (hc.y - c.y) * Math.sin(turn) - off;
      if ((style !== 1 && side > 0) || (style !== 0 && chance(r, 0.35))) revealed.add(hexKey(h));
    }
    if (vision) {
      const nearby = all.filter((h) => {
        const hc = hexCenter(g, h);
        return Math.hypot(hc.x - c.x, hc.y - c.y) < 6 && Math.hypot(hc.x - c.x, hc.y - c.y) > 2.5;
      });
      s.tokens.pc = onHex(g, "pc", "medium", pick(r, nearby), { name: "Hero", kind: "pc", disposition: "ally", ownerIds: ["p1"], light: { bright: 10, dim: 5 * int(r, 0, 3) } });
    }
    liftSubs(s, "dm", subsOf(g, all.filter((h) => revealed.has(hexKey(h)))));
    if (vision) liftSubs(s, "party", subsOf(g, all.filter(() => chance(r, 0.4))));
    const wallsIn = (st: RoomState, pickHex: () => Hex | null, count: number, tag: string) => {
      let made = 0;
      for (let i = 0; i < count; i++) {
        const h = pickHex();
        if (!h) continue;
        const hc = hexCenter(g, h);
        const a: [number, number] = [q(hc.x + (r() - 0.5) * 1.4 * HEX_R), q(hc.y + (r() - 0.5) * 1.4 * HEX_R)];
        const b: [number, number] = [q(hc.x + (r() - 0.5) * 1.4 * HEX_R), q(hc.y + (r() - 0.5) * 1.4 * HEX_R)];
        if (hexKey(hexAt(g, { x: a[0], y: a[1] })) !== hexKey(h) || hexKey(hexAt(g, { x: b[0], y: b[1] })) !== hexKey(h) || (a[0] === b[0] && a[1] === b[1])) continue;
        wall(st, `${tag}${String(n).padStart(5, "0")}${made++}`, a, b);
      }
      return made;
    };
    const ring = [...mine, ...mine.flatMap((h) => hexNeighbors(g, h))];
    wallsIn(s, () => pick(r, ring), int(r, 0, 3), "pub");
    const b = structuredClone(s);
    const hidden = ring.filter((h) => !revealed.has(hexKey(h)));
    const added = wallsIn(b, () => (hidden.length ? pick(r, hidden) : null), int(r, 1, 4), "hid");
    s.tokens.ogre = ogre;
    b.tokens.ogre = structuredClone(ogre);
    return { a: s, b, added };
  }

  for (const vision of [false, true]) {
    test(`give P1 the same copy and the same drag frames, ${vision ? "with vision" : "with fog alone"}, where the build's walls mark some pairs otherwise`, () => {
      let pairs = 0;
      let apart = 0;
      const copyWithout = (st: RoomState) => {
        const t = structuredClone(st);
        delete t.tokens.ogre;
        return stableStringify(projectState(t, P1, { sceneId: "s1" }));
      };
      for (let n = 0; n < (vision ? 300 : 400); n++) {
        const { a, b, added } = pairOf(n, vision);
        if (added === 0 || copyWithout(a) !== copyWithout(b)) continue;
        pairs++;
        assert.equal(stableStringify(projectState(b, P1, { sceneId: "s1" })), stableStringify(projectState(a, P1, { sceneId: "s1" })), `pair ${n}: P1's copy`);
        const ogre = a.tokens.ogre!;
        const r = rng(n);
        for (let k = 0; k < 4; k++) {
          const frame = { ...ogre, x: ogre.x + (r() - 0.5) * 2, y: ogre.y + (r() - 0.5) * 2 };
          for (const t of [frame, { ...frame, squeeze: true as const }]) assert.equal(withheldFromViewer(b, P1, t), withheldFromViewer(a, P1, t), `pair ${n}: frame ${k}`);
        }
        const old = (st: RoomState) => stableStringify(seenMark(st, st.tokens.ogre!, { opVersion: 36 }, "anywhere"));
        if (old(a) !== old(b)) apart++;
      }
      assert.ok(pairs > (vision ? 60 : 350), `${pairs} pairs`);
      assert.ok(apart > 0, `the build's walls mark ${apart} pairs otherwise, so the pairs test something`);
    });
  }

  test("the DM's drag and a player's search the same in both rooms, each device counting seen by all as the server does", () => {
    for (const [, g] of SHAPES) {
      const { s: a } = middleWallRoom(g, { holders: ["p1"] });
      const b = structuredClone(a);
      // A second wall in the dark beside the first, which the DM's copy holds and no player's does.
      const c = storedCenter(a.tokens.ogre!);
      wall(b, "midwall00002", [q(c.x - 0.25), q(c.y + 0.125)], [q(c.x + 0.25), q(c.y + 0.125)]);
      a.tokens.hero = onHex(g, "hero", "medium", { col: 3, row: 3 }, { name: "Hero", kind: "pc", disposition: "ally", ownerIds: ["p1"] });
      b.tokens.hero = structuredClone(a.tokens.hero);
      const to = onHex(g, "ogre", "huge", { col: 10, row: 7 });
      checkPair({ name: `${g.orient}: a Huge creature beside a wall no player holds`, a, b, drags: [{ who: DM, tokenId: "ogre", to: { x: to.x, y: to.y } }] });
      // A device that read the room's own tokens, which carry no mark, would count the creature otherwise, and the check says so.
      assert.throws(() => assertMembership(a, a, DM, "s1", "the room as the DM's device"), /otherwise than the server/);
    }
  });
});

describe("ops stored before op version 37 judge a creature's outline by the build's walls", () => {
  const OLD = { opVersion: 36 };
  const LIVE = {};
  const NOW = { opVersion: 37 };
  for (const [name, g] of SHAPES) {
    test(`${name}: every stored mark and audience, seen by all`, () => {
      const { s, ogre } = middleWallRoom(g, { perPlayer: true });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      assert.equal(inSightOfNonOwners(s, ogre, OLD), false, "the build's walls withhold it");
      for (const env of [LIVE, NOW]) {
        assert.equal(inSightOfNonOwners(s, ogre, env), true, "the walls players hold show it");
        assert.equal(seenByNonOwners(s, ogre, env), true);
        assert.deepEqual(seenMark(s, ogre, env, "here"), { seen: true });
      }
      assert.equal(seenByNonOwners(s, ogre, OLD), false);
      assert.deepEqual(seenMark(s, ogre, OLD, "here"), { seenBy: [] });
      // A walk's spots on a whole-party scene, where no spot need stand on ground every player shares.
      const party = middleWallRoom(g);
      const spot = [{ x: party.ogre.x, y: party.ogre.y, elevation: 0 }];
      assert.equal(seenAtEvery(party.s, party.ogre, spot, NOW), true);
      assert.equal(seenAtEvery(party.s, party.ogre, spot, LIVE), true);
      assert.equal(seenAtEvery(party.s, party.ogre, spot, OLD), false);
      // A turn, an area and a line about it.
      const row: InitEntry = { id: "e1", tokenId: "ogre", value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false };
      s.encounter = { id: "enc1", rev: 1, round: 1, activeEntryId: "e1", entries: [row] } as unknown as RoomState["encounter"];
      assert.deepEqual(rowSeenMark(s, row, NOW), { seen: true });
      assert.deepEqual(rowSeenMark(s, row, OLD), { seenBy: [] });
      assert.equal(activeRowShownTo(s, P1, NOW), true);
      assert.equal(activeRowShownTo(s, P1, OLD), false);
      const area = template("t1", { sceneId: "s1", attachedTo: "ogre", origin: { x: ogre.x + 1.5, y: ogre.y + 1.5, z: 0 }, ownerId: "dm1", visibility: "all" });
      assert.deepEqual(areaSeenMark(s, area, ogre, NOW), { seen: true });
      assert.deepEqual(areaSeenMark(s, area, ogre, OLD), { hidden: true });
      // A line marked seen by all reaches every player who sees the creature as the op leaves the room.
      const line: Pick<LogEntry, "kind" | "data"> = { kind: "event", data: { type: "life", tokenId: "ogre", life: "dead", seen: true } };
      assert.equal(lineReader(s, 37)(line).audience, "shared");
      assert.equal(lineReader(s)(line).audience, "shared");
      assert.equal(lineReader(s, 36)(line).audience, "dm");
      // The reducer's own projections: a correction's copies and a trap step's check.
      assert.equal(projectEntityForOp(keys.token("ogre"), s, P1, { sceneId: "s1" }, OLD), null);
      assert.notEqual(projectEntityForOp(keys.token("ogre"), s, P1, { sceneId: "s1" }, NOW), null);
      assert.equal(projectStateForOp(s, P1, { sceneId: "s1" }, OLD).tokens.ogre, undefined);
      assert.ok(projectStateForOp(s, P1, { sceneId: "s1" }, LIVE).tokens.ogre);
    });

    test(`${name}: a sight holder's marks and audience by their own copy`, () => {
      // Only p1's own layer reveals the hexes the build's clip cuts off.
      const { s, ogre } = middleWallRoom(g, { holders: ["p1"], layer: { holder: "p1" } });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      for (const env of [OLD, NOW]) assert.equal(inSightOfNonOwners(s, ogre, env), false, "no ground every player holds shows it");
      assert.deepEqual(seenMark(s, ogre, NOW, "here"), { seenBy: ["p1"] });
      assert.deepEqual(seenMark(s, ogre, OLD, "here"), { seenBy: [] });
      const row: InitEntry = { id: "e1", tokenId: "ogre", value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false };
      s.encounter = { id: "enc1", rev: 1, round: 1, activeEntryId: "e1", entries: [row] } as unknown as RoomState["encounter"];
      assert.deepEqual(rowSeenMark(s, row, NOW), { seenBy: ["p1"] });
      assert.deepEqual(rowSeenMark(s, row, OLD), { seenBy: [] });
      const area = template("t1", { sceneId: "s1", origin: { x: ogre.x + 1.5, y: ogre.y + 1.5, z: 0 }, ownerId: "dm1", visibility: "all" });
      assert.deepEqual(areaSeenMark(s, area, ogre, NOW), { seenBy: ["p1"] });
      assert.deepEqual(areaSeenMark(s, area, ogre, OLD), { seenBy: [] });
      const line: Pick<LogEntry, "kind" | "data"> = { kind: "event", data: { type: "life", tokenId: "ogre", life: "dead", seenBy: ["p1"] } };
      const now = lineReader(s, 37)(line);
      assert.equal(now.audience, "party");
      assert.deepEqual(now.audience === "party" ? now.views.map(([id]) => id) : [], ["p1"]);
      assert.equal(lineReader(s, 36)(line).audience, "dm");
    });
  }
});

describe("seen by all on a per-player hex scene is what the shared class's copy shows, and every screen shows it", () => {
  for (const [name, g] of SHAPES) {
    test(`${name}: a wall through a Gargantuan creature's dark middle on ground only P1 holds`, () => {
      const s = hexRoom(g, { vision: true, holders: ["p1", "p2"] });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      const ogre = onHex(g, "ogre", "gargantuan", { col: 8, row: 8 }, { name: "Ogre", kind: "npc" });
      s.tokens.lamp = onHex(g, "lamp", "medium", { col: 10, row: 8 }, { name: "Lamp", kind: "npc", disposition: "ally", partyVision: true, light: { bright: 5, dim: 0 } });
      const c = hexCenter(g, { col: 8, row: 8 });
      const a: [number, number] = [q(c.x + 0.6), q(c.y - 2.2)];
      const b: [number, number] = [q(c.x + 0.6), q(c.y + 2.2)];
      const all = sceneHexes(g, s.scenes.s1!.bounds);
      const strip = new Set<string>();
      for (let t = 0; t <= 200; t++) {
        const y = a[1] + ((b[1] - a[1]) * t) / 200;
        for (const dx of [-0.02, 0, 0.02]) strip.add(hexKey(hexAt(g, { x: a[0] + dx, y })));
      }
      liftSubs(s, "party", subsOf(g, all.filter((h) => !strip.has(hexKey(h)))));
      liftSubs(s, { holder: "p1" }, subsOf(g, all.filter((h) => strip.has(hexKey(h)))));
      wall(s, "a2w000000001", a, b);
      s.tokens.ogre = ogre;
      assert.equal(withheldWhereItStands(s, ogre), false, "seen by all");
      const p1Copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
      assert.equal(withheldFromViewer(p1Copy, { memberId: "", role: "player" }, ogre), true, "P1's own copy withholds it");
      for (const v of [P1, P2, P3, DISPLAY]) assert.ok(projectState(s, v, { sceneId: "s1" }).tokens.ogre, `${v.memberId}'s screen shows it`);
      assert.equal(withheldFromViewer(s, P1, ogre), false, "and so does P1's drag frame");
    });
  }

  test("one wall whose held pieces round off the eye's step: not seen by all, and no screen shows it", () => {
    const s = hexRoom(ROWS, { holders: ["p1", "p2"] });
    s.meta = { ...s.meta, playerSceneId: "s1" };
    liftSubs(s, "dm", [[46, 19]]);
    wall(s, "a7w000000001", [11.625, 4.84375], [12.453125, 4.984375]);
    const ogre = onHex(ROWS, "ogre", "huge", { col: 11, row: 5 }, { name: "Ogre", kind: "npc" });
    s.tokens.ogre = ogre;
    assert.equal(withheldWhereItStands(s, ogre), true);
    for (const v of [P1, P2, P3, DISPLAY]) assert.equal(projectState(s, v, { sceneId: "s1" }).tokens.ogre, undefined, v.memberId);
  });

  for (const vision of [false, true]) {
    test(`random rooms, ${vision ? "with vision and memory" : "with fog alone"}: seen by all is on every player's screen, a table display's too`, () => {
      let seen = 0;
      let onlyShared = 0;
      for (let n = 0; n < (vision ? 300 : 200); n++) {
        const { s, ogre, holders } = randomRoom(n, { vision, perPlayer: true, seed: vision ? 0xb17 : 0xa17 });
        s.meta = { ...s.meta, playerSceneId: "s1" };
        if (withheldWhereItStands(s, ogre)) continue;
        seen++;
        for (const v of [P1, P2, P3, DISPLAY]) assert.ok(projectState(s, v, { sceneId: "s1" }).tokens.ogre, `room ${n}: ${v.memberId}'s screen`);
        for (const h of holders) {
          const copy = projectState(s, { memberId: h, role: "player" }, { sceneId: "s1" }) as unknown as RoomState;
          if (withheldFromViewer(copy, { memberId: "", role: "player" }, ogre)) onlyShared++;
        }
      }
      assert.ok(seen > 150, `${seen} seen by all`);
      if (vision) assert.ok(onlyShared > 0, `${onlyShared} holder screens show it only by the shared answer`);
    });
  }

  test("seen by all reads neither the roster of holders nor which layer revealed the ground", () => {
    let pairs = 0;
    for (let n = 0; n < 120; n++) {
      const r = rng(0x8a8 + n);
      const g = chance(r, 0.5) ? ROWS : COLUMNS;
      const vision = chance(r, 0.5);
      const at = { col: int(r, 6, 13), row: int(r, 5, 10) };
      const subs = subsOf(g, sceneHexes(g, { w: 20, h: 16 }).filter(() => chance(r, 0.4)));
      const c = hexCenter(g, at);
      const walls: [number, number, number, number][] = [];
      for (let i = int(r, 1, 5); i > 0; i--) {
        const x = c.x + (r() - 0.5) * 5;
        const y = c.y + (r() - 0.5) * 5;
        walls.push([q(x), q(y), q(x + (r() - 0.5) * 2), q(y + (r() - 0.5) * 2)]);
      }
      const make = (holders: string[], layer: "dm" | "party") => {
        const s = hexRoom(g, { vision, holders });
        s.meta = { ...s.meta, playerSceneId: "s1" };
        liftSubs(s, layer, subs);
        walls.forEach((w, i) => wall(s, `pr${String(n).padStart(4, "0")}${i}00000`.slice(0, 12), [w[0], w[1]], [w[2], w[3]]));
        if (vision) s.tokens.lamp = onHex(g, "lamp", "medium", { col: at.col + 3, row: at.row }, { name: "Lamp", kind: "npc", disposition: "ally", partyVision: true, light: { bright: 15, dim: 10 } });
        s.tokens.ogre = onHex(g, "ogre", "gargantuan", at, { name: "Ogre", kind: "npc" });
        return s;
      };
      const copyWithout = (s: RoomState, v: Viewer) => {
        const t = structuredClone(s);
        delete t.tokens.ogre;
        return stableStringify(projectState(t, v, { sceneId: "s1" }));
      };
      // Zero holders against p1 as the first, and the DM's reveals against the party's explored layer.
      for (const [x, y, v] of [
        [make([], "dm"), make(["p1"], "dm"), P2],
        [make(["p1"], "dm"), make(["p1"], "party"), P3],
      ] as const) {
        if (copyWithout(x, v) !== copyWithout(y, v)) continue;
        pairs++;
        assert.equal(withheldWhereItStands(y, y.tokens.ogre!), withheldWhereItStands(x, x.tokens.ogre!), `room ${n}`);
        assert.equal(stableStringify(projectState(y, v, { sceneId: "s1" })), stableStringify(projectState(x, v, { sceneId: "s1" })), `room ${n}: ${v.memberId}'s copy`);
      }
    }
    assert.ok(pairs > 100, `${pairs} pairs`);
  });

  for (const [name, g] of SHAPES) {
    test(`${name}: a Huge rider seen by all that P1's own copy clips is a member of the group every device walks`, () => {
      const s = hexRoom(g, { vision: true, holders: ["p1", "p2"] });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      const at = { col: 8, row: 8 };
      s.tokens.lamp = onHex(g, "lamp", "medium", { col: 10, row: 8 }, { name: "Lamp", kind: "npc", disposition: "ally", partyVision: true, light: { bright: 5, dim: 0 } });
      const c = hexCenter(g, at);
      const a: [number, number] = [q(c.x + 0.6), q(c.y - 2.2)];
      const b: [number, number] = [q(c.x + 0.6), q(c.y + 2.2)];
      const all = sceneHexes(g, s.scenes.s1!.bounds);
      const strip = new Set<string>();
      for (let t = 0; t <= 200; t++) {
        const y = a[1] + ((b[1] - a[1]) * t) / 200;
        for (const dx of [-0.02, 0, 0.02]) strip.add(hexKey(hexAt(g, { x: a[0] + dx, y })));
      }
      liftSubs(s, "party", subsOf(g, all.filter((h) => !strip.has(hexKey(h)))));
      liftSubs(s, { holder: "p1" }, subsOf(g, all.filter((h) => strip.has(hexKey(h)))));
      wall(s, "grw000000001", a, b);
      s.tokens.beast = onHex(g, "beast", "gargantuan", at, { name: "Beast", kind: "npc" });
      s.tokens.rider = { ...onHex(g, "rider", "huge", at, { name: "Rider", kind: "npc" }), attached: { to: "beast", kind: "ride" } };
      const rider = s.tokens.rider!;
      assert.equal(inSightOfNonOwners(s, rider, {}), true, "seen by all");
      const p1Copy = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
      assert.equal(withheldFromViewer(p1Copy, { memberId: "", role: "player" }, rider), true, "P1's own copy clips it");
      const server = walkerFor(s, rider, (t) => s.tokens[t.id] !== undefined && inSightOfNonOwners(s, s.tokens[t.id]!, {}));
      for (const v of [P1, P2, P3, DM]) {
        const view = projectState(s, v, { sceneId: "s1" }) as unknown as RoomState;
        const mine = view.tokens.rider!;
        assert.ok(mine, `${v.memberId}'s screen shows it`);
        const device = walkerFor(view, mine, (t) => view.tokens[t.id] !== undefined && publicToken(view, view.tokens[t.id]!, { role: v.role }));
        assert.deepEqual(device.offHolder, server.offHolder, `${v.memberId}'s device walks it off its mount as the server does`);
      }
    });
  }
});

describe("devices read seen by all from the projection's mark", () => {
  test("random per-player rooms with vision and memory: a holder's, a non-holder's and the DM's device answer as the server does", () => {
    let marked = 0;
    for (let n = 0; n < 400; n++) {
      const { s, ogre } = randomRoom(n, { vision: n % 4 !== 0, perPlayer: true, seed: 0xe17 });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      const server = inSightOfNonOwners(s, ogre, {});
      for (const v of [P1, P2, P3, DM]) {
        const view = projectState(s, v, { sceneId: "s1" }) as unknown as RoomState;
        const mine = view.tokens.ogre;
        if (!mine) continue;
        assert.equal(publicToken(view, mine, { role: v.role }), server, `room ${n}: ${v.memberId}'s device`);
        if ((mine as Token & { seenAll?: true }).seenAll) marked++;
      }
    }
    assert.ok(marked > 500, `${marked} marked copies`);
  });

  for (const [name, g] of SHAPES) {
    test(`${name}: where a device's own walls would answer otherwise, its answer is still the server's`, () => {
      // A holder's copy holds a wall the shared class's lacks.
      const s = hexRoom(g, { vision: true, holders: ["p1", "p2"] });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      s.tokens.lamp = onHex(g, "lamp", "medium", { col: 10, row: 8 }, { name: "Lamp", kind: "npc", disposition: "ally", partyVision: true, light: { bright: 5, dim: 0 } });
      const c = hexCenter(g, { col: 8, row: 8 });
      const a: [number, number] = [q(c.x + 0.6), q(c.y - 2.2)];
      const b: [number, number] = [q(c.x + 0.6), q(c.y + 2.2)];
      const all = sceneHexes(g, s.scenes.s1!.bounds);
      const strip = new Set<string>();
      for (let t = 0; t <= 200; t++) {
        const y = a[1] + ((b[1] - a[1]) * t) / 200;
        for (const dx of [-0.02, 0, 0.02]) strip.add(hexKey(hexAt(g, { x: a[0] + dx, y })));
      }
      liftSubs(s, "party", subsOf(g, all.filter((h) => !strip.has(hexKey(h)))));
      liftSubs(s, { holder: "p1" }, subsOf(g, all.filter((h) => strip.has(hexKey(h)))));
      wall(s, "dmw000000001", a, b);
      s.tokens.ogre = onHex(g, "ogre", "gargantuan", { col: 8, row: 8 }, { name: "Ogre", kind: "npc" });
      const holder = projectState(s, P1, { sceneId: "s1" }) as unknown as RoomState;
      assert.equal(withheldWhereItStands(holder, holder.tokens.ogre!), true, "P1's own walls withhold it");
      assert.equal(publicToken(holder, holder.tokens.ogre!, { role: "player" }), true, "P1's device reads the mark");
      // The DM's view holds the build's walls on a whole-party scene, where the party's copy lacks one.
      const { s: dmRoom, ogre } = middleWallRoom(g);
      const view = projectState(dmRoom, DM, { sceneId: "s1" }) as unknown as RoomState;
      assert.equal(withheldWhereItStands(view, view.tokens.ogre!), true, "the build's walls withhold it");
      assert.equal(inSightOfNonOwners(dmRoom, ogre, {}), true);
      assert.equal(publicToken(view, view.tokens.ogre!, { role: "dm" }), true, "the DM's device reads the mark");
      // And a wall the DM added where the party remembers none, out of sight on a whole-party vision scene.
      const m = hexRoom(g, { vision: true });
      const at = { col: 9, row: 8 };
      const big = onHex(g, "ogre", "huge", at, { name: "Ogre", kind: "npc" });
      m.tokens.lamp = onHex(g, "lamp", "medium", { col: 13, row: 8 }, { name: "Lamp", kind: "npc", disposition: "ally", partyVision: true, light: { bright: 15, dim: 0 } });
      liftSubs(m, "party", subsOf(g, occupiedHexes(g, big).flatMap((h) => [h, ...hexNeighbors(g, h)])));
      const ctr = storedCenter(big);
      const w: FreeWall = { id: "dmm000000001", a: [q(ctr.x + 0.3), q(ctr.y - 0.6)], b: [q(ctr.x + 0.3), q(ctr.y + 0.6)], f: { kind: "wall" } };
      wall(m, w.id, w.a, w.b);
      rememberWall(m, null, w, null);
      m.tokens.ogre = big;
      const dmView = projectState(m, DM, { sceneId: "s1" }) as unknown as RoomState;
      if (dmView.tokens.ogre) assert.equal(publicToken(dmView, dmView.tokens.ogre, { role: "dm" }), inSightOfNonOwners(m, big, {}), "the DM's device with the party's memory");
    });

    test(`${name}: a revealed Large object carrying a PC is public on every device, and the PC's Get off walks as the server's`, () => {
      const { s } = middleWallRoom(g, { holders: ["p1"] });
      s.meta = { ...s.meta, playerSceneId: "s1" };
      const ogre = s.tokens.ogre!;
      delete s.tokens.ogre;
      s.tokens.cart = { ...ogre, id: "cart", name: "Cart", kind: "object", size: "huge", disposition: "neutral" };
      s.tokens.pc = { ...onHex(g, "pc", "medium", { col: 9, row: 7 }, { name: "Hero", kind: "pc", disposition: "ally", ownerIds: ["p1"] }), attached: { to: "cart", kind: "ride" } };
      const cart = s.tokens.cart!;
      assert.equal(inSightOfNonOwners(s, cart, {}), true, "the server sees the cart");
      assert.equal(inSightOfNonOwners(s, cart, { opVersion: 36 }), false, "where the build's walls would not");
      const server = walkerFor(s, s.tokens.pc!, (t) => s.tokens[t.id] !== undefined && inSightOfNonOwners(s, s.tokens[t.id]!, {}));
      assert.ok(server.offHolder, "the server walks the PC off the cart");
      for (const v of [P1, P2, DM]) {
        const view = projectState(s, v, { sceneId: "s1" }) as unknown as RoomState;
        assert.ok(view.tokens.cart && view.tokens.pc, `${v.memberId} holds both`);
        assert.equal(publicToken(view, view.tokens.cart!, { role: v.role }), true, `${v.memberId}'s device`);
        const device = walkerFor(view, view.tokens.pc!, (t) => view.tokens[t.id] !== undefined && publicToken(view, view.tokens[t.id]!, { role: v.role }));
        assert.deepEqual(device.offHolder, server.offHolder, `${v.memberId}'s Get off`);
      }
    });
  }

  test("the mark is absent where the shared class's copy withholds the token, and only on hex scenes", () => {
    const { s } = middleWallRoom(ROWS, { holders: ["p1"], layer: { holder: "p1" } });
    s.meta = { ...s.meta, playerSceneId: "s1" };
    const view = projectState(s, P1, { sceneId: "s1" });
    assert.ok(view.tokens.ogre, "P1's own layer shows it");
    assert.equal(view.tokens.ogre!.seenAll, undefined);
    const squares = room({ scenes: { s1: scene("s1", { fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } }) } });
    squares.tokens.goblin = { ...onHex(ROWS, "goblin", "medium", { col: 2, row: 2 }), sceneId: "s1", fogExempt: true };
    for (const v of [P1, DM]) assert.equal(projectState(squares, v, { sceneId: "s1" }).tokens.goblin?.seenAll, undefined, v.memberId);
  });
});

describe("what re-projects a hex creature when a copy of the walls round it can change", () => {
  test("a fog, explored or memory write, a sight change where memory is, and a scene's bounds, each to the DM too", () => {
    const { s, ogre } = middleWallRoom(ROWS, { vision: true, holders: ["p1"] });
    const far = onHex(ROWS, "far", "huge", { col: 2, row: 14 }, { name: "Far", kind: "npc" });
    s.scenes.s1 = { ...s.scenes.s1!, bounds: { w: 120, h: 16 } };
    s.tokens.far = { ...far, x: far.x + 100 };
    const c = storedCenter(ogre);
    const tx = Math.floor(c.x / 16);
    const ty = Math.floor(c.y / 16);
    const near = keys.token(ogre.id);
    for (const key of [keys.fog("s1", tx, ty), keys.explored("s1", tx, ty), keys.exploredBy("s1", "p1", tx, ty), keys.memory("s1", tx, ty), keys.memoryBy("s1", "p1", tx, ty)]) {
      const out = dependents(s, [key]);
      assert.ok(out.includes(near), `${key} re-projects the creature`);
      assert.ok(!out.includes(keys.token("far")), `${key} leaves the far one`);
    }
    // Sight decides live or remembered only where memory is, so a sight change beside the creature's tile re-projects it only then.
    assert.ok(!dependents(s, [keys.sight("s1", tx + 1, ty)]).includes(near));
    const w: FreeWall = { id: "depwall00001", a: [q(c.x), q(c.y - 0.5)], b: [q(c.x), q(c.y + 0.5)], f: { kind: "wall" } };
    rememberWall(s, null, w, w);
    assert.ok(dependents(s, [keys.sight("s1", tx + 1, ty)]).includes(near), "a sight change where memory is");
    const shrunk = { ...s, scenes: { ...s.scenes, s1: { ...s.scenes.s1!, bounds: { w: 110, h: 16 } } } };
    for (const out of [dependents(shrunk, [keys.scene("s1")], s), dependents(s, [keys.scene("s1")], shrunk)]) {
      assert.ok(out.includes(near), "a change of the scene's bounds");
      assert.ok(out.includes(keys.token("far")));
    }
    const renamed = { ...s, scenes: { ...s.scenes, s1: { ...s.scenes.s1!, name: "Hall" } } };
    assert.ok(!dependents(renamed, [keys.scene("s1")], s).includes(near), "a new name changes no copy");
    assert.equal(tileKey("s1", tx, ty), `s1:${tx},${ty}`);
  });
});

/*
 * What the reducer stores must replay as it was stored, so every projection
 * it reaches takes the op's envelope or reads no walls. This walks the
 * reducer's imports and checks each name taken from project.ts, so a new
 * caller of a live projection fails here before it reaches a replay.
 */
describe("the reducer projects only through calls that take the op's envelope", () => {
  const SHARED = dirname(fileURLToPath(import.meta.url));
  /** Take the op's envelope (the index of that argument), so an op stored before op version 37 reads the build's walls. */
  const BY_ENVELOPE: Record<string, number> = {
    activeRowShownTo: 2,
    areaSeenMark: 3,
    inSightOfNonOwners: 2,
    lineReader: 1,
    projectEntityForOp: 4,
    projectStateForOp: 3,
    rowSeenByNonOwners: 2,
    rowSeenMark: 2,
    seenAtEvery: 3,
    seenByNonOwners: 2,
    seenMark: 2,
  };
  /** Read ownership, members, grids, fog, the clock or text, and no walls. */
  const NO_WALLS = new Set(["allKeys", "anyPlayer", "gridOfScene", "gridOfToken", "groundAnyPlayerSees", "hash128", "hashValue", "heldClock", "initiativeHidden", "listsStripped", "ownsCharacter", "ownsToken", "playerPlays", "playersToken", "stableStringify", "stampCells", "unionSightOf"]);
  /*
   * permissions.ts judges ops live, before the reducer applies them, and
   * calls live projections. The reducer takes only these from it, each
   * read and found to project nothing, so the walk stops there.
   */
  const FROM_PERMISSIONS = new Set(["ANSWERED_MEANWHILE", "ASK_CLOSED", "MOVE_PLAYERS_FIRST_BACK", "SETTLED_MEANWHILE", "expectOf", "fixPending", "playersTypeTotals", "promptRefusal"]);

  type Import = { from: string; names: string[] };
  function importsOf(file: string): Import[] {
    const out: Import[] = [];
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s+"([^"]+)"/gm)) {
      const spec = m[3]!;
      if (m[1] || !(spec.startsWith(".") || spec.startsWith("#shared/"))) continue;
      const from = spec.startsWith("#shared/") ? join(SHARED, spec.slice("#shared/".length)) : join(dirname(file), spec);
      const braces = /\{([^}]*)\}/.exec(m[2]!);
      const names = (braces ? braces[1]!.split(",") : [])
        .map((n) => n.trim())
        .filter((n) => n !== "" && !n.startsWith("type "))
        .map((n) => n.split(/\s+as\s+/)[0]!);
      out.push({ from, names });
    }
    return out;
  }

  /** The args of every call of `name` in `src`, split at top-level commas. */
  function callsOf(src: string, name: string): string[][] {
    const out: string[][] = [];
    for (const m of src.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
      const args: string[] = [];
      let depth = 0;
      let arg = "";
      for (let i = m.index + m[0].length; i < src.length; i++) {
        const ch = src[i]!;
        if (depth === 0 && (ch === "," || ch === ")")) {
          if (arg.trim() !== "") args.push(arg.trim());
          arg = "";
          if (ch === ")") break;
          continue;
        }
        if ("([{".includes(ch)) depth++;
        if (")]}".includes(ch)) depth--;
        arg += ch;
      }
      out.push(args);
    }
    return out;
  }

  test("every name the reducer's modules take from project.ts, and every call of one that takes the envelope", () => {
    const project = join(SHARED, "project.ts");
    const permissions = join(SHARED, "permissions.ts");
    const seen = new Set<string>();
    const stack = [join(SHARED, "reducer.ts")];
    const wrong: string[] = [];
    let projecting = 0;
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      const here = relative(SHARED, file);
      for (const { from, names } of importsOf(file)) {
        if (from === project) {
          projecting++;
          for (const name of names) {
            if (NO_WALLS.has(name)) continue;
            const at = BY_ENVELOPE[name];
            if (at === undefined) {
              wrong.push(`${here} takes ${name}, a live projection`);
              continue;
            }
            for (const args of callsOf(src, name)) if (args.length <= at || /^\{\s*\}$/.test(args[at]!)) wrong.push(`${here} calls ${name}(${args.join(", ")}) with no envelope`);
          }
        } else if (from === permissions) {
          for (const name of names) if (!FROM_PERMISSIONS.has(name)) wrong.push(`${here} takes ${name} from permissions.ts, not yet read for projections`);
        } else if (existsSync(from)) stack.push(from);
      }
    }
    assert.deepEqual(wrong, []);
    assert.ok(seen.size > 50 && projecting > 15, `the walk reached ${seen.size} modules, ${projecting} taking from project.ts`);
  });
});
