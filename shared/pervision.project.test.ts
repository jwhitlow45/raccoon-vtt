import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { holderTileKey, keys, tileKey } from "./keys.ts";
import type { ExploredTile, FogTile, RoomState, Viewer } from "./model.ts";
import { cellVision } from "./perPlayerTestutil.ts";
import { partySightOf, presenceOf, projectEntity, projectState, sharedGround, withheldFromViewer } from "./project.ts";
import { visionRules } from "./ruleHooks.ts";
import { decodeTile, getBit, rasterizeFogOps } from "./rules/fog.ts";
import { publicToken } from "./rules/walkWorld.ts";
import { DM, actor, effect, member, room, scene, token } from "./testutil.ts";
import { SQUARES } from "./rules/grid.ts";

/**
 * Per-player vision's projection and what a device reads from it
 * (docs/design-v1-per-player-vision.md 6.2, 6.3, 6.6 and security rules 1,
 * 3, 7 and 10, lane PV1), by the stub sight of perPlayerTestutil.ts. p1 and
 * p2 see for themselves on a dark scene with fog, p1's layer reveals the
 * north west room and p2's the one south east of it, and p3 holds no sight.
 */
const P1: Viewer = { memberId: "p1", role: "player" };
const P2: Viewer = { memberId: "p2", role: "player" };
const P3: Viewer = { memberId: "p3", role: "player" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const ON_S1 = { sceneId: "s1" };

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

function layerTile(rect: { x: number; y: number; w: number; h: number }): FogTile {
  return Object.values(rasterizeFogOps({}, "s1", { w: 40, h: 30 }, [{ id: "r", mode: "reveal", shape: { kind: "rect", ...rect } }]))[0]!;
}

/** Puts a fog tile in a layer under its own key. */
function put(layer: Record<string, FogTile>, tile: FogTile): void {
  layer[tileKey(tile.sceneId, tile.tx, tile.ty)] = tile;
}

function holderTile(memberId: string, rect: { x: number; y: number; w: number; h: number }): ExploredTile {
  return { ...layerTile(rect), memberId };
}

const NORTH_WEST = { x: 0, y: 0, w: 4, h: 4 };
const SOUTH_EAST = { x: 8, y: 8, w: 4, h: 4 };

/** Thorn, which p1 and p2 own together, stands in the dark between the two rooms, so both have the same sources. */
function table(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }, { memberId: "p3", on: false }] };
  s.exploredBy[holderTileKey("s1", "p1", 0, 0)] = holderTile("p1", NORTH_WEST);
  s.exploredBy[holderTileKey("s1", "p2", 0, 0)] = holderTile("p2", SOUTH_EAST);
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1", "p2"], x: 20, y: 20, disposition: "ally" });
  s.labels.nw = { id: "nw", rev: 0, sceneId: "s1", x: 1.5, y: 1.5, text: "Crypt", size: 1 };
  s.labels.se = { id: "se", rev: 0, sceneId: "s1", x: 9.5, y: 9.5, text: "Vault", size: 1 };
  s.pins.nw = { id: "nw", rev: 0, sceneId: "s1", x: 2, y: 2, color: "#ffcc00", visibility: "all" };
  s.pins.se = { id: "se", rev: 0, sceneId: "s1", x: 10, y: 10, color: "#ffcc00", visibility: "all" };
  return s;
}

function view(state: RoomState, viewer: Viewer): RoomState {
  return projectState(state, viewer, ON_S1) as unknown as RoomState;
}

/** Whether a fog tile reveals any sub-cell of a cell. */
function reveals(tile: FogTile | undefined, x: number, y: number): boolean {
  const bits = tile ? decodeTile(tile.bits) : null;
  if (!bits) return false;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (getBit(bits, x * 4 + sx, y * 4 + sy)) return true;
  return false;
}

describe("each holder's own memory (6.3, security rule 1)", () => {
  test("two holders with the same sources and different past exploration keep their own fog, labels and pins", () => {
    const s = table();
    const one = view(s, P1);
    const two = view(s, P2);
    assert.deepEqual(Object.keys(one.labels), ["nw"]);
    assert.deepEqual(Object.keys(two.labels), ["se"]);
    assert.deepEqual(Object.keys(one.pins), ["nw"]);
    assert.deepEqual(Object.keys(two.pins), ["se"]);
    const at = tileKey("s1", 0, 0);
    assert.ok(reveals(one.fogTiles[at], 1, 1) && !reveals(one.fogTiles[at], 9, 9), "p1's fog is their own layer");
    assert.ok(reveals(two.fogTiles[at], 9, 9) && !reveals(two.fogTiles[at], 1, 1), "p2's fog is theirs");
    for (const other of [P3, DISPLAY]) {
      const v = view(s, other);
      assert.deepEqual(Object.keys(v.labels), [], "no layer of a holder reaches one who holds no sight");
      assert.deepEqual(Object.keys(v.pins), []);
      assert.equal(v.fogTiles[at], undefined);
    }
    const dm = view(s, DM);
    assert.deepEqual(Object.keys(dm.labels).sort(), ["nw", "se"]);
  });

  test("a holder's presence map is kept while its layers stand, and made again when one changes (PV1-O2)", () => {
    const s = table();
    const once = presenceOf(s, "p1", "s1");
    assert.ok(once[tileKey("s1", 0, 0)], "p1's layer's tile is present");
    assert.equal(presenceOf(s, "p1", "s1"), once, "a second label, stamp or pin reads the same map, not a copy of every tile");
    assert.notEqual(presenceOf(s, "p2", "s1"), once);
    const later = { ...s, exploredBy: { ...s.exploredBy, [holderTileKey("s1", "p1", 1, 1)]: holderTile("p1", { x: 20, y: 20, w: 2, h: 2 }) } };
    const again = presenceOf(later, "p1", "s1");
    assert.notEqual(again, once);
    assert.ok(again[tileKey("s1", 1, 1)]);
    assert.equal(presenceOf(s, "p3", "s1"), presenceOf(s, null, "s1"), "one who holds no sight reads the shared map");
  });

  test("two holders whose journal access differs keep their own pins on ground both remember", () => {
    const s = table();
    s.exploredBy[holderTileKey("s1", "p2", 0, 0)] = holderTile("p2", { x: 0, y: 0, w: 12, h: 12 });
    s.journal.note = { id: "note", rev: 0, title: "p1's note", access: { member: "p1" }, blocks: [] };
    s.pins.nw = { ...s.pins.nw!, pageId: "note" };
    assert.deepEqual(Object.keys(view(s, P1).pins), ["nw"]);
    assert.deepEqual(Object.keys(view(s, P2).pins), ["se"], "p2 remembers the ground but may not read the page");
    assert.deepEqual(Object.keys(view(s, P2).labels).sort(), ["nw", "se"]);
  });

  test("a holder whose creature went down sees the shared sight and keeps their map", () => {
    const s = table();
    s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 20, y: 20, disposition: "ally", actor: { inline: actor({ effects: [effect("u", { key: "unconscious" })] }) } });
    s.tokens.gob = token("gob", { name: "Goblin", x: 21, y: 20 });
    const up = table();
    up.tokens.thorn = { ...s.tokens.thorn!, actor: { inline: actor() } };
    up.tokens.gob = s.tokens.gob;
    assert.ok(view(up, P1).tokens.gob, "awake, Thorn sees the goblin beside him");
    const down = view(s, P1);
    assert.equal(down.tokens.gob, undefined, "down, Thorn's player has the shared sight, which has no source here");
    assert.deepEqual(Object.keys(down.labels), ["nw"]);
    assert.ok(reveals(down.fogTiles[tileKey("s1", 0, 0)], 1, 1));
  });
});

describe("what reaches whom (6.2, security rules 3 and 7)", () => {
  test("the DM gets every holder's layer joined and the list, no player or display gets either, and sightAll and fogAll are the same for everyone", () => {
    const s = table();
    put(s.fogTiles, layerTile({ x: 13, y: 0, w: 2, h: 2 }));
    s.tokens.scout = token("scout", { kind: "npc", name: "Scout", partyVision: true, x: 30, y: 25, disposition: "ally" });
    const dm = view(s, DM) as RoomState & { exploredAny?: Record<string, FogTile>; sightAll?: object; fogAll?: Record<string, FogTile> };
    const any = dm.exploredAny?.[tileKey("s1", 0, 0)];
    assert.ok(reveals(any, 1, 1) && reveals(any, 9, 9) && !reveals(any, 13, 0), "both layers joined, the DM's own fog apart");
    assert.deepEqual(dm.holders, { s1: s.holders.s1 });
    const shared = JSON.stringify([dm.sightAll, dm.fogAll]);
    assert.ok(dm.sightAll && dm.fogAll, "the scout's shared sight and the DM's reveal");
    for (const v of [P1, P2, P3, DISPLAY]) {
      const p = view(s, v) as RoomState & { exploredAny?: unknown; sightAll?: object; fogAll?: object };
      assert.equal(p.exploredAny, undefined);
      assert.equal(p.holders, undefined);
      assert.equal(p.exploredBy, undefined);
      assert.equal(JSON.stringify([p.sightAll, p.fogAll]), shared, `${v.memberId} gets the shared maps unchanged`);
    }
    assert.ok(!reveals(dm.fogAll![tileKey("s1", 0, 0)], 1, 1), "the shared fog holds no holder's layer");
  });

  test("a list a restored room holds on a whole-party scene reaches no one, by snapshot or by key (PV1-O9)", () => {
    const s = table();
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "dark" } };
    s.exploredBy = {};
    assert.equal(projectEntity(keys.holders("s1"), s, DM, ON_S1), null);
    assert.equal((view(s, DM) as RoomState & { holders?: unknown }).holders, undefined);
  });

  test("a whole-party scene holds none of the derived maps", () => {
    const s = table();
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "dark" } };
    s.holders = {};
    s.exploredBy = {};
    for (const v of [DM, P1, DISPLAY]) {
      const p = view(s, v) as RoomState & Record<string, unknown>;
      for (const name of ["sightAll", "fogAll", "exploredAny", "exploredBy"]) assert.equal(p[name], undefined, `${v.memberId} ${name}`);
    }
  });
});

describe("a device fails closed (security rule 10)", () => {
  test("partySightOf on a copy reads sightAll, and a copy without it sees nothing", () => {
    const s = table();
    s.tokens.scout = token("scout", { kind: "npc", name: "Scout", partyVision: true, x: 30, y: 25, disposition: "ally" });
    s.tokens.ogre = token("ogre", { name: "Ogre", x: 31, y: 25 });
    s.tokens.gob = token("gob", { name: "Goblin", x: 21, y: 20 });
    const one = view(s, P1);
    assert.ok(one.tokens.gob, "p1's own sight sees the goblin beside Thorn");
    assert.equal(partySightOf(one, "s1").seesToken(one.tokens.ogre!, SQUARES), true, "the shared sight sees the ogre");
    assert.equal(partySightOf(one, "s1").seesToken(one.tokens.gob!, SQUARES), false, "and not the goblin, which only p1's sight sees");
    const bare = { ...one } as RoomState & { sightAll?: unknown };
    delete bare.sightAll;
    assert.equal(partySightOf(bare, "s1").seesToken(one.tokens.ogre!, SQUARES), false);
  });

  test("the shared ground on a copy reads fogAll, and a copy without it is fully fogged", () => {
    const s = table();
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: false, light: "dark", perPlayer: true } };
    put(s.exploredTiles, layerTile({ x: 13, y: 0, w: 2, h: 2 }));
    const one = view(s, P1);
    const ground = sharedGround(one, "s1");
    assert.equal(ground(13, 0), true, "the party's layer is shared");
    assert.equal(ground(1, 1), false, "p1's own layer is not");
    const bare = { ...one } as RoomState & { fogAll?: unknown };
    delete bare.fogAll;
    assert.equal(sharedGround(bare, "s1")(13, 0), false);
    assert.equal(sharedGround(s, "s1")(1, 1), false, "the server reads the shared layers alike");
    assert.equal(sharedGround(s, "s1")(13, 0), true);
  });
});

describe("publicToken and withheldFromViewer (decision 10, security rule 2)", () => {
  /** A goblin only p1's sight or layer gives them, an ogre the shared ground holds, and Bree, p2's, far off. */
  function sides(vision: { on: boolean; fog: boolean }): RoomState {
    const s = table();
    s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: vision.fog, vision: { on: vision.on, light: "dark", perPlayer: true } };
    s.tokens.thorn = { ...s.tokens.thorn!, ownerIds: ["p1"], x: 2, y: 2 };
    s.tokens.bree = token("bree", { kind: "pc", name: "Bree", ownerIds: ["p2"], x: 38, y: 28, disposition: "ally" });
    s.tokens.gob = token("gob", { name: "Goblin", x: 3, y: 2 });
    s.tokens.scout = token("scout", { kind: "npc", name: "Scout", partyVision: true, x: 30, y: 25, disposition: "ally" });
    s.tokens.ogre = token("ogre", { name: "Ogre", x: 31, y: 25 });
    put(s.exploredTiles, layerTile({ x: 30, y: 24, w: 3, h: 3 }));
    return s;
  }
  const player = { role: "player" as const };
  const dm = { role: "dm" as const };

  test("vision on: the shared sight, on the server and on a holder's copy", () => {
    const s = sides({ on: true, fog: true });
    assert.equal(publicToken(s, s.tokens.gob!, dm), false);
    assert.equal(publicToken(s, s.tokens.ogre!, dm), true);
    const one = view(s, P1);
    assert.ok(one.tokens.gob);
    assert.equal(publicToken(one, one.tokens.gob!, player), false, "p1 sees it, but not every player does");
    assert.equal(publicToken(one, one.tokens.ogre!, player), true);
    assert.equal(publicToken(one, one.tokens.bree!, player), true, "a party member, always shown");
    assert.equal(withheldFromViewer(s, P1, s.tokens.gob!), false);
    assert.equal(withheldFromViewer(s, P2, s.tokens.gob!), true);
    assert.equal(withheldFromViewer(s, DM, s.tokens.gob!), false, "the DM has the union");
  });

  test("fog alone: the shared fog, never a holder's own layer", () => {
    const s = sides({ on: false, fog: true });
    const one = view(s, P1);
    assert.ok(one.tokens.gob, "p1's layer holds the goblin's ground");
    assert.equal(publicToken(one, one.tokens.gob!, player), false);
    assert.equal(publicToken(s, s.tokens.gob!, dm), false);
    assert.equal(publicToken(one, one.tokens.ogre!, player), true, "the party's layer is shared");
    assert.equal(withheldFromViewer(s, P1, s.tokens.gob!), false);
    assert.equal(withheldFromViewer(s, P2, s.tokens.gob!), true);
  });

  test("both off: nothing is withheld", () => {
    const s = sides({ on: false, fog: false });
    const two = view(s, P2);
    assert.equal(publicToken(two, two.tokens.gob!, player), true);
    assert.equal(publicToken(s, s.tokens.gob!, dm), true);
    assert.equal(withheldFromViewer(s, P2, s.tokens.gob!), false);
  });

  test("a whole-party scene keeps today's answers", () => {
    const s = sides({ on: true, fog: true });
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: true, light: "dark" } };
    s.holders = {};
    s.exploredBy = {};
    const one = view(s, P1);
    assert.equal(publicToken(one, one.tokens.gob!, player), true, "a player's copy holds only what the party sees");
    assert.equal(publicToken(s, s.tokens.gob!, dm), true, "Thorn is a party source");
  });
});
