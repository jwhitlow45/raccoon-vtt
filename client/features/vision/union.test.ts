import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { liftSubs, wall } from "#shared/discoveryTestutil.ts";
import { holderTileKey, tileKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { cellVision } from "#shared/perPlayerTestutil.ts";
import { projectState, withheldFromViewer } from "#shared/project.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { occupiedHexes, storedCenter } from "#shared/rules/footprint.ts";
import { gridOfShape } from "#shared/rules/grid.ts";
import { hexKey, hexSubcells, type HexGrid } from "#shared/rules/hex.ts";
import { onHex } from "#shared/rules/hexWalls.testkit.ts";
import { clipFootprint, sightClipOf } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { DM, member, reveal, room, scene, token } from "#shared/testutil.ts";
import { addCandidates } from "../encounter/logic.ts";
import { outlineRows } from "../outliner/rows.ts";
import { unionView, withheldFromEveryPlayer } from "./union.ts";

/**
 * The DM's tools read the union on a per-player scene
 * (docs/design/design-v1-per-player-vision.md decision 14): the Outliner and the
 * tracker's "visible" add say a creature or a label reaches players when
 * any player gets it, by every source's sight and every holder's map.
 */

const real = { ...visionRules };
before(() => Object.assign(visionRules, cellVision));
after(() => Object.assign(visionRules, real));

const dmView = (state: RoomState): RoomState => projectState(state, DM, { sceneId: "s1" }) as unknown as RoomState;
const P3: Viewer = { memberId: "p3", role: "player" };

/** A per-player scene with fog: the DM revealed the north west, the party explored a corner south of it, and p1 alone remembers a room east of it, all in one tile. */
function table(vision: boolean): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: vision, light: "dark", perPlayer: true } });
  reveal(s, "s1", { x: 0, y: 0, w: 4, h: 4 });
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] };
  const own = Object.values(rasterizeFogOps({}, "s1", s.scenes.s1.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 8, y: 0, w: 4, h: 4 } }]))[0]!;
  s.exploredBy[holderTileKey("s1", "p1", own.tx, own.ty)] = { ...own, memberId: "p1" };
  const party = Object.values(rasterizeFogOps({}, "s1", s.scenes.s1.bounds, [{ id: "p", mode: "reveal", shape: { kind: "rect", x: 0, y: 6, w: 2, h: 2 } }]))[0]!;
  s.exploredTiles[tileKey("s1", party.tx, party.ty)] = party;
  s.labels.east = { id: "east", rev: 0, sceneId: "s1", x: 9.5, y: 1.5, text: "Crypt", size: 1 };
  s.labels.far = { id: "far", rev: 0, sceneId: "s1", x: 20.5, y: 20.5, text: "Vault", size: 1 };
  s.tokens.gob = token("gob", { name: "Goblin", x: 9, y: 1 });
  s.tokens.boss = token("boss", { name: "Boss", x: 20, y: 20 });
  return s;
}

describe("the union the DM's tools read (decision 14)", () => {
  test("with fog alone, a label and a creature on ground only one holder remembers reach players, and the rest stay under fog", () => {
    const view = dmView(table(false));
    const rows = new Map(outlineRows(view, "s1", new Map()).map((r) => [r.key, r.mark]));
    assert.equal(rows.get("label:east"), null, "p1 gets it");
    assert.equal(rows.get("label:far"), "Under fog");
    assert.equal(rows.get("token:gob"), null);
    assert.equal(rows.get("token:boss"), "Under fog");
    view.tokens.scout = token("scout", { name: "Scout", x: 0, y: 6 });
    assert.equal(withheldFromEveryPlayer(view, view.tokens.scout), false, "the party's own ground stays in the union");
    delete view.tokens.scout;
    assert.deepEqual(addCandidates(view, "s1", "visible", null, new Map()).map((t) => t.id), ["gob"]);
    assert.equal(withheldFromEveryPlayer(view, view.tokens.gob!), false);
    assert.equal(withheldFromEveryPlayer(view, view.tokens.boss!), true);
    assert.equal(projectState(table(false), P3, { sceneId: "s1" }).labels.east, undefined, "a player who is no holder does not get the label");
  });

  test("with vision on, a creature only one holder's own creature sees is visible to players, by the union's sight", () => {
    const s = table(true);
    // Thorn sees one cell around it in the dark, by the stub sight, so the boss beside it and not the goblin.
    s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", ownerIds: ["p1"], x: 19, y: 20 });
    const view = dmView(s);
    assert.ok(Object.keys((view as RoomState & { sight?: object }).sight ?? {}).length > 0, "the DM holds the union's sight");
    const rows = new Map(outlineRows(view, "s1", new Map()).map((r) => [r.key, r.mark]));
    assert.equal(rows.get("token:boss"), null, "Thorn's player sees it");
    assert.equal(rows.get("token:gob"), "Out of the party's sight");
    assert.deepEqual(addCandidates(view, "s1", "visible", null, new Map()).map((t) => t.id), ["boss", "thorn"], "Thorn's own creature too, never the goblin");
  });

  test("a whole-party view is the DM's own", () => {
    const s = table(false);
    s.scenes.s1 = { ...s.scenes.s1!, vision: { on: false, light: "dark" } };
    s.holders = {};
    s.exploredBy = {};
    const view = dmView(s);
    assert.equal(unionView(view), view);
  });
});

describe("the union on hexes", () => {
  test("a Huge creature every player sees by the walls they hold reaches some player, though the DM's view holds a wall in the dark through its middle", () => {
    const g = gridOfShape("hexRows") as HexGrid;
    const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1") } });
    s.scenes.s1 = scene("s1", { gridShape: "hexRows", bounds: { w: 20, h: 16 }, autoWalls: "off", fogEnabled: true, vision: { on: false, light: "bright", perPlayer: true } });
    s.buildChunks = {};
    s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "p1", on: true }] };
    const at = { col: 9, row: 7 };
    const ogre = onHex(g, "ogre", "huge", at, { kind: "npc", name: "Ogre" });
    const c = storedCenter(ogre);
    const q = (v: number) => Math.round(v * 64) / 64;
    wall(s, "midwall00001", [q(c.x - 0.25), q(c.y)], [q(c.x + 0.25), q(c.y)]);
    const kept = new Set(clipFootprint(g, ogre, sightClipOf(sceneWalls(s.scenes.s1, s.buildChunks))).kept.map((sub) => sub.join(",")));
    const cut = occupiedHexes(g, ogre).filter((h) => hexKey(h) !== hexKey(at) && hexSubcells(g, h).every((sub) => !kept.has(sub.join(","))));
    assert.ok(cut.length > 0, "the build's wall cuts some of its hexes off");
    liftSubs(s, "dm", cut.flatMap((h) => hexSubcells(g, h)));
    s.tokens.ogre = ogre;
    const view = dmView(s);
    assert.equal(withheldFromViewer(unionView(view), { memberId: "", role: "player" }, view.tokens.ogre!), true, "the build's walls in the DM's view withhold it");
    assert.equal(withheldFromEveryPlayer(view, view.tokens.ogre!), false, "the server marks it seen by all");
  });
});
