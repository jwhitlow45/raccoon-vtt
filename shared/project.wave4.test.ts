import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chunkKey, keys, readEntity, tileKey } from "./keys.ts";
import type { RoomState, SightTile } from "./model.ts";
import type { Op } from "./protocol.ts";
import { allKeys, dependents, inSightOfNonOwners, projectEntity, projectState, seenByNonOwners, stableStringify, withheldWhereItStands } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { visionRules, type PartySight, type SightProbe, type VisionRules } from "./ruleHooks.ts";
import { decodeTile, encodeTile, getBit, TILE_BYTES } from "./rules/fog.ts";
import { DM, P1, P2, character, env, reveal, room, scene, token } from "./testutil.ts";

/**
 * Projection on wave 4 scenes (docs/design-v1-maps-vision.md 4.3): the
 * token rule on vision scenes, party members, the merged fog, sight tiles,
 * the explored layer and the DM-only teleport line. Sight itself is part
 * 4C's, so these run on a stand-in party that sees every creature west of
 * x = 10 and holds one sight tile, (0, 0).
 */
const seesWest = (t: SightProbe) => t.x < 10;
const fake: VisionRules = {
  partySight: (): PartySight => ({ seesSubcells: () => false, seesToken: seesWest, tiles: new Map<string, SightTile>([["0,0", { f: 3 }]]) }),
  // No scene here is per player, so nothing asks.
  holderSight: (): PartySight => ({ seesSubcells: () => false, seesToken: () => false, tiles: new Map() }),
  sightFromTiles: (tiles, sceneId): PartySight => {
    const held = tiles[`${sceneId}:0,0`];
    return held ? { seesSubcells: () => false, seesToken: seesWest, tiles: new Map([["0,0", held]]) } : { seesSubcells: () => false, seesToken: () => false, tiles: new Map() };
  },
};
const real = { ...visionRules };
before(() => Object.assign(visionRules, fake));
after(() => Object.assign(visionRules, real));

/** Sub-cell bits with one cell rectangle revealed, in tile-local cells. */
function bitsOf(cells: { x0: number; y0: number; x1: number; y1: number }): string {
  const bytes = new Uint8Array(TILE_BYTES);
  for (let sy = cells.y0 * 4; sy < cells.y1 * 4; sy++) {
    for (let sx = cells.x0 * 4; sx < cells.x1 * 4; sx++) {
      const i = sy * 64 + sx;
      bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
    }
  }
  return encodeTile(bytes);
}

const cellOpen = (bits: string | undefined, x: number, y: number) => {
  const b = bits ? decodeTile(bits) : null;
  return b !== null && getBit(b, x * 4 + 1, y * 4 + 1);
};

function visionRoom(): RoomState {
  const state = room();
  state.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark" } });
  state.characters.c1 = character("c1", { ownerIds: ["p1"] });
  state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" }, x: 30, y: 20 });
  state.tokens.ally = token("ally", { kind: "npc", partyVision: true, x: 31, y: 20, light: { bright: 20, dim: 20 } });
  state.tokens.near = token("near", { x: 3, y: 3 });
  state.tokens.far = token("far", { x: 20, y: 3 });
  state.tokens.exempt = token("exempt", { x: 21, y: 3, fogExempt: true });
  state.tokens.hidden = token("hidden", { x: 4, y: 4, visibility: "dm" });
  // The DM's fog reveals where `far` stands, which no longer decides anything on a vision scene.
  reveal(state, "s1", { x: 0, y: 0, w: 32, h: 8 });
  return state;
}

describe("tokens on a vision scene", () => {
  test("players get creatures in the party's sight, party members and exempt ones always, and nothing the DM hid", () => {
    const state = visionRoom();
    const p = projectState(state, P2, { sceneId: "s1" });
    assert.deepEqual(Object.keys(p.tokens).sort(), ["ally", "exempt", "near", "pc"]);
    assert.equal(p.tokens.ally!.aboveFog, true, "a party member is drawn above the fog");
    assert.equal(p.tokens.near!.aboveFog, false);
    assert.deepEqual(Object.keys(projectState(state, DM, { sceneId: "s1" }).tokens).sort(), ["ally", "exempt", "far", "hidden", "near", "pc"]);
  });

  test("with vision turned off the fog decides again, on the merged layers", () => {
    const state = visionRoom();
    state.scenes.s1!.vision = { on: false, light: "dark" };
    assert.ok(projectState(state, P2, { sceneId: "s1" }).tokens.far, "revealed by the DM's fog");
    state.fogTiles = {};
    assert.equal(projectState(state, P2, { sceneId: "s1" }).tokens.far, undefined);
    state.exploredTiles[tileKey("s1", 1, 0)] = { sceneId: "s1", tx: 1, ty: 0, rev: 1, bits: bitsOf({ x0: 4, y0: 3, x1: 5, y1: 4 }) };
    assert.ok(projectState(state, P2, { sceneId: "s1" }).tokens.far, "explored ground shows it once vision is off");
  });

  test("a party member is always shown, on a scene with plain fog too", () => {
    const state = visionRoom();
    state.scenes.s1!.vision = undefined;
    state.fogTiles = {};
    const p = projectState(state, P2, { sceneId: "s1" });
    assert.ok(p.tokens.ally && p.tokens.pc);
    assert.equal(p.tokens.far, undefined);
  });

  test("the seen marks follow the same rule, and a client reads them from the sight tiles it holds", () => {
    const state = visionRoom();
    assert.equal(seenByNonOwners(state, state.tokens.near!, env(1)), true);
    assert.equal(seenByNonOwners(state, state.tokens.far!, env(1)), false);
    assert.equal(seenByNonOwners(state, state.tokens.ally!, env(1)), true);
    assert.equal(seenByNonOwners(state, state.tokens.hidden!, env(1)), false);
    assert.equal(inSightOfNonOwners(state, state.tokens.far!, env(1)), false);
    state.meta.view.blackout = true;
    assert.equal(seenByNonOwners(state, state.tokens.near!, env(1)), false, "nothing is seen behind a blackout");
    state.meta.view.blackout = false;
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.equal(seenByNonOwners(view, view.tokens.near!, env(1)), true);
    const blind = { ...view, sight: {} } as unknown as RoomState;
    assert.equal(seenByNonOwners(blind, view.tokens.near!, env(1)), false, "a client with no tiles counts nothing seen");
  });

  test("a creature revealed on its turn out of the party's sight stays withheld, its row too, until it walks into sight", () => {
    let state = visionRoom();
    state.tokens.lurker = token("lurker", { name: "Lurker", x: 20, y: 5, visibility: "dm" });
    const step = (op: Op, seq: number) => {
      const r = applyOp(state, op, DM, env(seq));
      assert.ok(r.ok);
      state = r.state;
    };
    step({ t: "encounter.start", entries: [{ id: "n1", tokenId: "pc", value: 20 }, { id: "n2", tokenId: "lurker", value: 10 }] }, 1);
    step({ t: "encounter.next" }, 2);
    step({ t: "encounter.next" }, 3);
    assert.equal(state.tokens.lurker!.fogExemptAuto, true, "revealed");
    let p = projectState(state, P2, { sceneId: "s1" });
    assert.equal(p.tokens.lurker, undefined, "out of sight, though the DM's fog is lifted there");
    assert.deepEqual(p.encounter!.entries.map((e) => e.id), ["n1"]);
    assert.equal(p.encounter!.activeEntryId, null);
    assert.equal(state.encounter!.turnStart!.seen, undefined, "where its turn began is marked unseen");
    assert.equal(withheldWhereItStands(state, state.tokens.lurker!), true, "the ephemeral channel withholds its previews there");
    // An op stored before op version 4 marks it seen anywhere, as that build showed it, so it replays to the same state.
    assert.equal(inSightOfNonOwners(state, state.tokens.lurker!, { opVersion: 3 }), true);
    assert.equal(inSightOfNonOwners(state, state.tokens.lurker!, env(4)), false);
    step({ t: "token.move", tokenId: "lurker", x: 5, y: 5 }, 4);
    p = projectState(state, P2, { sceneId: "s1" });
    assert.equal(p.tokens.lurker?.aboveFog, false, "in sight, drawn like any creature");
    assert.equal(p.encounter!.activeEntryId, "n2");
    assert.equal(withheldWhereItStands(state, state.tokens.lurker!), false);
  });

  test("the ephemeral channel's question gives the projection's answer for a token at any spot", () => {
    const state = visionRoom();
    assert.equal(withheldWhereItStands(state, state.tokens.near!), false);
    assert.equal(withheldWhereItStands(state, { ...state.tokens.near!, x: 12 }), true);
    assert.equal(withheldWhereItStands(state, { ...state.tokens.ally!, x: 12 }), false, "a party member is never withheld");
    state.scenes.s1!.vision = undefined;
    state.fogTiles = {};
    assert.equal(withheldWhereItStands(state, state.tokens.near!), true, "fully fogged where vision is off");
  });

  test("the reducer marks a creature's log lines by sight", () => {
    const state = visionRoom();
    const hit = (tokenId: string) => {
      const r = applyOp(state, { t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 3 } }, DM, env(1));
      assert.ok(r.ok);
      return r.log[0]!.data!;
    };
    assert.equal("seen" in hit("near"), true);
    assert.equal("seen" in hit("far"), false);
  });
});

describe("wave 4 fields", () => {
  test("a squeeze reaches everyone who sees the token, its light only the DM and its owners, and party membership only the DM", () => {
    const state = visionRoom();
    state.tokens.near!.squeeze = true;
    state.tokens.near!.light = { bright: 5, dim: 5 };
    state.tokens.mine = token("mine", { ownerIds: ["p1"], x: 2, y: 2, light: { bright: 20, dim: 20 }, partyVision: true });
    const other = projectState(state, P2, { sceneId: "s1" });
    assert.equal(other.tokens.near!.squeeze, true);
    for (const t of Object.values(other.tokens)) {
      assert.ok(!("light" in t), `light of ${t.id}`);
      assert.ok(!("partyVision" in t), `partyVision of ${t.id}`);
    }
    const owner = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(owner.tokens.mine!.light, { bright: 20, dim: 20 });
    assert.ok(!("partyVision" in owner.tokens.mine!));
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.equal(dm.tokens.ally!.partyVision, true);
    assert.deepEqual(dm.tokens.ally!.light, { bright: 20, dim: 20 });
  });

  test("the DM's edits of a token's light or party mark move nothing a non-owner sees, and every player's copy carries rev 0", () => {
    const state = visionRoom();
    state.tokens.mine = token("mine", { ownerIds: ["p1"], x: 2, y: 2 });
    const viewers = { owner: P1, other: P2 };
    const before = Object.fromEntries(Object.entries(viewers).map(([k, v]) => [k, projectEntity(keys.token("mine"), state, v, { sceneId: "s1" })]));
    assert.ok(before.other && before.owner, "both players see the token");
    // Each DM edit writes the token and bumps its rev, as the reducer does.
    let next = state;
    for (const patch of [{ light: { bright: 20, dim: 20 } }, { partyVision: true }] as const) {
      const result = applyOp(next, { t: "token.update", tokenId: "mine", patch }, DM, env(2));
      assert.ok(result.ok);
      next = result.state;
    }
    assert.ok(next.tokens.mine!.rev > state.tokens.mine!.rev, "the DM's edits moved the stored rev");
    const other = projectEntity(keys.token("mine"), next, P2, { sceneId: "s1" });
    assert.equal(stableStringify(other), stableStringify(before.other), "a non-owner's copy changed");
    const owner = projectEntity(keys.token("mine"), next, P1, { sceneId: "s1" }) as { rev: number; light?: unknown } | null;
    assert.equal(owner?.rev, 0);
    assert.deepEqual(owner?.light, { bright: 20, dim: 20 }, "the owner gets the light to change it");
    assert.equal((before.owner as { rev: number } | null)?.rev, 0);
  });

  test("players get a scene's vision and movement settings, and a chunk's heights and stairs", () => {
    const state = visionRoom();
    state.scenes.s1!.blockMovement = true;
    const heights = encodeTile(new Uint8Array(TILE_BYTES).fill(10));
    const up = ".".repeat(255) + "n";
    state.buildChunks[chunkKey("s1", 1, 1)] = { sceneId: "s1", cx: 1, cy: 1, rev: 3, cells: {}, edges: {}, heights, up };
    // Players hold the build only where their fog is lifted (docs/design-v1-map-discovery.md 5.2).
    state.scenes.s1!.bounds = { w: 40, h: 40 };
    reveal(state, "s1", { x: 16, y: 16, w: 16, h: 16 });
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.equal(p.scenes.s1!.blockMovement, true);
    assert.deepEqual(p.scenes.s1!.vision, { on: true, light: "dark" });
    const known = encodeTile(new Uint8Array(32).fill(255));
    // The stair mark paints its cell, so the scene's rule walls its north and west edges: bits 510 and 511.
    const edges = new Uint8Array(64);
    edges[63] = 0xc0;
    const auto = encodeTile(edges);
    assert.deepEqual(p.buildChunks[chunkKey("s1", 1, 1)], { sceneId: "s1", cx: 1, cy: 1, rev: 0, cells: {}, edges: {}, heights, up, known, auto, upDir: up });
  });

  test("a hidden secret door beside a stair mark projects by the one painted predicate, as the walls read it", () => {
    const state = visionRoom();
    const up = Array.from({ length: 256 }, (_, i) => (i === 3 * 16 + 2 ? "a" : ".")).join("");
    const door = { kind: "door", state: "closed", secret: true, discovered: false } as const;
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "3,3,w": door }, up };
    const shown = (rule: "all" | "floor" | "off") => {
      state.scenes.s1!.autoWalls = rule;
      return projectState(state, P1, { sceneId: "s1" }).buildChunks[chunkKey("s1", 0, 0)]?.edges["3,3,w"];
    };
    // The stair mark at (2, 3) is a painted Stairs cell beside the empty (3, 3): an automatic wall under "all", so the door goes.
    assert.equal(shown("all"), undefined);
    assert.deepEqual(shown("floor"), { kind: "wall" });
    assert.deepEqual(shown("off"), { kind: "wall" });
  });

  test("a teleport's line is the DM's alone, the token's owners included", () => {
    const state = visionRoom();
    state.log.push({ id: "5:0", at: "x", kind: "event", data: { type: "teleport", tokenId: "pc", past: "wall" } });
    assert.equal(projectState(state, DM, { sceneId: "s1" }).log.length, 1);
    assert.equal(projectState(state, P1, { sceneId: "s1" }).log.length, 0);
    assert.equal(projectEntity(keys.log("5:0"), state, P1, { sceneId: "s1" }), null);
  });
});

describe("the merged fog and the explored layer", () => {
  function explored(): RoomState {
    const state = visionRoom();
    state.fogTiles = {};
    reveal(state, "s1", { x: 0, y: 0, w: 2, h: 2 });
    state.exploredTiles[tileKey("s1", 0, 0)] = { sceneId: "s1", tx: 0, ty: 0, rev: 4, bits: bitsOf({ x0: 4, y0: 4, x1: 6, y1: 6 }) };
    state.exploredTiles[tileKey("s1", 1, 1)] = { sceneId: "s1", tx: 1, ty: 1, rev: 2, bits: bitsOf({ x0: 0, y0: 0, x1: 1, y1: 1 }) };
    return state;
  }

  test("players get one fog, each tile the two layers joined, and a tile only the party explored", () => {
    const state = explored();
    const p = projectState(state, P1, { sceneId: "s1" });
    const tile = p.fogTiles[tileKey("s1", 0, 0)]!;
    assert.ok(cellOpen(tile.bits, 1, 1) && cellOpen(tile.bits, 5, 5) && !cellOpen(tile.bits, 8, 8));
    assert.deepEqual(p.fogTiles[tileKey("s1", 1, 1)], { ...state.exploredTiles[tileKey("s1", 1, 1)]!, rev: 0 });
    assert.equal(tile.rev, 0, "neither layer's count of edits reaches players");
    // A DM reveal of ground the party already explored changes nothing players receive.
    const before = projectState(state, P1, { sceneId: "s1" }).fogTiles[tileKey("s1", 0, 0)];
    const revealed = applyOp(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 4, y: 4, w: 2, h: 2 } }] }, DM, env(2));
    assert.ok(revealed.ok);
    assert.equal(stableStringify(projectState(revealed.state, P1, { sceneId: "s1" }).fogTiles[tileKey("s1", 0, 0)]), stableStringify(before));
    // Nor does the party exploring ground the DM revealed.
    const seen = applyOp(state, { t: "sys.explore", sceneId: "s1", tiles: [{ tx: 0, ty: 0, bits: bitsOf({ x0: 0, y0: 0, x1: 2, y1: 2 }) }] }, DM, env(3));
    assert.ok(seen.ok);
    assert.equal(stableStringify(projectState(seen.state, P1, { sceneId: "s1" }).fogTiles[tileKey("s1", 0, 0)]), stableStringify(before));
    assert.deepEqual(p.exploredTiles, {}, "players never get the layer itself");
    for (const key of allKeys(state)) {
      if (key === keys.encounterHistory) continue;
      assert.equal(stableStringify(projectEntity(key, state, P1, { sceneId: "s1" })), stableStringify(readEntity(p as unknown as RoomState, key)), key);
    }
  });

  test("the DM gets both layers apart", () => {
    const state = explored();
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.deepEqual(dm.fogTiles, state.fogTiles);
    assert.deepEqual(dm.exploredTiles, state.exploredTiles);
    assert.deepEqual(projectState(state, DM, { sceneId: "s2" }).exploredTiles, {});
  });

  test("labels and stamps on explored ground reach players, and stay withheld under unexplored fog", () => {
    const state = explored();
    state.labels.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 16.5, y: 16.5, text: "Well", size: 0.5 };
    state.labels.l2 = { id: "l2", rev: 0, sceneId: "s1", x: 30.5, y: 25.5, text: "Trap", size: 0.5 };
    state.stamps.st = { id: "st", rev: 0, sceneId: "s1", art: { key: "crate" }, x: 5.5, y: 5.5, w: 0.5, h: 0.5, rotation: 0, z: 0, visibility: "all" };
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.ok(p.labels.l1 && p.stamps.st);
    assert.equal(p.labels.l2, undefined);
  });

  test("an explored write re-projects the fog tile and what stands on it, and every key either layer holds is listed", () => {
    const state = explored();
    state.labels.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 16.5, y: 16.5, text: "Well", size: 0.5 };
    state.tokens.deep = token("deep", { x: 17, y: 17 });
    const deps = dependents(state, [keys.explored("s1", 1, 1)]);
    for (const key of [keys.fog("s1", 1, 1), keys.label("l1"), keys.token("deep")]) assert.ok(deps.includes(key), key);
    assert.ok(!deps.includes(keys.token("near")));
    const all = allKeys(state);
    for (const key of [keys.fog("s1", 1, 1), keys.explored("s1", 0, 0), keys.explored("s1", 1, 1)]) assert.ok(all.includes(key), key);
  });
});

describe("sight tiles", () => {
  test("players and the DM get the tiles of their scene while its vision is on, and nothing behind a blackout", () => {
    const state = visionRoom();
    assert.deepEqual(projectState(state, P1, { sceneId: "s1" }).sight, { "s1:0,0": { f: 3 } });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).sight, { "s1:0,0": { f: 3 } });
    assert.deepEqual(projectState(state, DM, { sceneId: "s2" }).sight, {});
    assert.deepEqual(projectEntity(keys.sight("s1", 0, 0), state, P1, { sceneId: "s1" }), { f: 3 });
    assert.equal(projectEntity(keys.sight("s1", 1, 0), state, P1, { sceneId: "s1" }), null);
    state.meta.view.blackout = true;
    assert.deepEqual(projectState(state, P1, { sceneId: "s1" }).sight, {});
    state.meta.view.blackout = false;
    state.scenes.s1!.vision = { on: false, light: "dark" };
    assert.deepEqual(projectState(state, P1, { sceneId: "s1" }).sight, {});
    assert.equal(projectEntity(keys.sight("s1", 0, 0), state, P1, { sceneId: "s1" }), null);
  });

  test("the server's keys cover every tile of a vision scene, and a projection lists its own", () => {
    const state = visionRoom();
    const sightKeys = allKeys(state).filter((k) => k.startsWith("sight:"));
    assert.equal(sightKeys.length, 3 * 2, "a 40 x 30 scene has 3 x 2 tiles");
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    assert.deepEqual(
      allKeys(view).filter((k) => k.startsWith("sight:")),
      ["sight:s1:0,0"],
    );
  });
});
