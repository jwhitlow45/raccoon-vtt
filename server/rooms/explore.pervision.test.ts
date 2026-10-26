import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey, tileKey } from "#shared/keys.ts";
import { LIMITS } from "#shared/limits.ts";
import type { Actor, EdgeFeature, FogTile, RoomState, SightTile, Token } from "#shared/model.ts";
import { changedSightKeys, perPlayerScene, sightHolders } from "#shared/project.ts";
import { serverOnlyOpSchema, type Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { visionRules } from "#shared/ruleHooks.ts";
import { decodeTile, getBit, TILE_BYTES, TILE_CELLS } from "#shared/rules/fog.ts";
import { clearVisionCache, seenFogBits, visionCacheReport, visionReport } from "#shared/rules/vision.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { actor, apply, chance, character, env, int, member, pick, reveal, rng, room, scene, token } from "#shared/testutil.ts";
import { SERVER_ACTOR } from "./actor.ts";
import { exploreOp } from "./explore.ts";

/**
 * The explore step on a per-player scene (docs/design-v1-per-player-vision.md
 * 6.1 and 6.3, lane PV3), on real sight: the shared sight into the party's
 * layer, each holder's own sight into theirs, and the joins the holder list
 * gains, ticked by the cap in force.
 */

const dark = (senses = "darkvision 30 ft"): { inline: Actor } => ({ inline: actor({ senses }) });

/** Whether the sub-cell at the center of a cell is set in a layer's tile, in scene cells. */
function cellSet(tile: FogTile | { bits: string } | undefined, x: number, y: number): boolean {
  const b = tile ? decodeTile(tile.bits) : null;
  return b !== null && getBit(b, (x % TILE_CELLS) * 4 + 1, (y % TILE_CELLS) * 4 + 1);
}

/**
 * A dark corridor 48 cells wide: p1's character in its west tile, a lamp
 * bearer that shares sight with the party in the middle one, and p2's
 * character in the east one, each with darkvision 30 ft, so each sees one
 * tile alone. Both players see for themselves.
 */
function corridor(): RoomState {
  const state = room();
  state.scenes = { s1: scene("s1", { bounds: { w: 48, h: 16 }, fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } }) };
  state.tokens = {
    a: token("a", { kind: "pc", ownerIds: ["p1"], x: 4, y: 8, actor: dark() }),
    lamp: token("lamp", { kind: "npc", disposition: "ally", partyVision: true, x: 24, y: 8, actor: dark() }),
    b: token("b", { kind: "pc", ownerIds: ["p2"], x: 40, y: 8, actor: dark() }),
  };
  state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] } };
  return state;
}

function applied(state: RoomState, op: Op): RoomState {
  const parsed = serverOnlyOpSchema.safeParse(op);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.issues[0]?.message);
  const result = applyOp(state, parsed.data, SERVER_ACTOR, env(99));
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.state;
}

describe("the explore step on a per-player scene", () => {
  test("the shared sight goes into the party's layer, and each holder's own sight into theirs alone", () => {
    clearVisionCache();
    const state = corridor();
    const op = exploreOp(state);
    assert.ok(op);
    assert.deepEqual(
      op.tiles.map((t) => [t.tx, t.ty]),
      [[1, 0]],
      "the party's layer gets only what the lamp bearer sees",
    );
    assert.deepEqual(
      op.members?.map((m) => [m.memberId, m.tiles.map((t) => [t.tx, t.ty])]),
      [
        ["p1", [[0, 0]]],
        ["p2", [[2, 0]]],
      ],
    );
    assert.equal(op.join, undefined, "both players already have an entry");
    const after = applied(state, op);
    const party = (x: number) => after.exploredTiles[tileKey("s1", Math.floor(x / 16), 0)];
    const own = (id: string, x: number) => after.exploredBy[holderTileKey("s1", id, Math.floor(x / 16), 0)];
    assert.ok(cellSet(own("p1", 4), 4, 8) && !cellSet(party(4), 4, 8) && !cellSet(own("p2", 4), 4, 8), "p1's ground is p1's alone");
    assert.ok(cellSet(party(24), 24, 8) && !cellSet(own("p1", 24), 24, 8), "the lamp's ground is the party's");
    assert.ok(cellSet(own("p2", 40), 40, 8) && !cellSet(own("p1", 40), 40, 8), "p2's ground is p2's alone");
    assert.equal(exploreOp(after), null, "nothing new to record");
  });

  test("a holder's new ground leaves out what the shared sight sees and what the party's layer holds", () => {
    clearVisionCache();
    let state = applied(corridor(), exploreOp(corridor())!);
    // p1's character walks to stand beside the lamp bearer: all it sees there the lamp bearer sees too, but for its west edge.
    state = apply(state, { t: "token.move", tokenId: "a", x: 20, y: 8 });
    const op = exploreOp(state);
    assert.ok(op);
    const p1 = op.members?.find((m) => m.memberId === "p1");
    assert.ok(p1, "p1 sees ground the lamp bearer does not");
    for (const t of p1.tiles) {
      const bits = decodeTile(t.bits)!;
      const shared = visionRules.holderSight(state, "s1", null).tiles.get(`${t.tx},${t.ty}`);
      const party = state.exploredTiles[tileKey("s1", t.tx, t.ty)];
      const sharedBits = shared ? seenFogBits(shared) : new Uint8Array(TILE_BYTES);
      const partyBits = party ? decodeTile(party.bits)! : new Uint8Array(TILE_BYTES);
      const held = state.exploredBy[holderTileKey("s1", "p1", t.tx, t.ty)];
      const heldBits = held ? decodeTile(held.bits)! : new Uint8Array(TILE_BYTES);
      for (let i = 0; i < bits.length; i++) assert.equal(bits[i]! & (sharedBits[i]! | partyBits[i]!) & ~heldBits[i]!, 0, `tile ${t.tx},${t.ty} byte ${i}`);
    }
    assert.ok(cellSet(p1.tiles.find((t) => t.tx === 0), 15, 8), "the ground west of the lamp's reach is p1's");
  });

  test("a holder lent only what everyone is lent, and a player who does not see for themselves, remember nothing of their own", () => {
    clearVisionCache();
    const state = corridor();
    state.members.p3 = member("p3");
    state.holders.s1!.entries.push({ memberId: "p3", on: true });
    state.tokens.b = { ...state.tokens.b!, ownerIds: ["p2", "p4"] };
    state.members.p4 = member("p4");
    state.holders.s1!.entries.push({ memberId: "p4", on: false });
    const op = exploreOp(state);
    assert.deepEqual(
      op?.members?.map((m) => m.memberId),
      ["p1", "p2"],
    );
  });

  test("the DM's layer is never read: a reveal changes nothing the step writes", () => {
    clearVisionCache();
    const state = corridor();
    const was = exploreOp(state);
    reveal(state, "s1", { x: 0, y: 0, w: 48, h: 16 });
    assert.deepEqual(exploreOp(state), was);
  });

  test("with vision off nothing explores or joins, with fog off only joins, and nothing behind a blackout or off the player scene", () => {
    clearVisionCache();
    const unlisted = () => {
      const s = corridor();
      s.holders = {};
      return s;
    };
    const off = unlisted();
    off.scenes.s1 = { ...off.scenes.s1!, vision: { on: false, light: "dark", perPlayer: true } };
    assert.equal(exploreOp(off), null, "vision off");
    const noFog = unlisted();
    noFog.scenes.s1 = { ...noFog.scenes.s1!, fogEnabled: false };
    const joins = exploreOp(noFog);
    assert.deepEqual(joins, { t: "sys.explore", sceneId: "s1", tiles: [], join: [{ memberId: "p1", on: true }, { memberId: "p2", on: true }] }, "fog off: joins only");
    const blackout = unlisted();
    blackout.meta = { ...blackout.meta, view: { follow: false, blackout: true } };
    assert.equal(exploreOp(blackout), null, "blackout");
    const elsewhere = unlisted();
    elsewhere.scenes.s2 = scene("s2", { order: 1 });
    elsewhere.meta = { ...elsewhere.meta, playerSceneId: "s2" };
    assert.equal(exploreOp(elsewhere), null, "a per-player scene the players are not on");
  });

  test("a player who joins ticked gets their first ground in the same op", () => {
    clearVisionCache();
    const state = corridor();
    state.holders = { s1: { sceneId: "s1", rev: 0, entries: [{ memberId: "p2", on: true }] } };
    const op = exploreOp(state);
    assert.deepEqual(op?.join, [{ memberId: "p1", on: true }]);
    assert.deepEqual(
      op?.members?.map((m) => m.memberId),
      ["p2", "p1"],
    );
    const after = applied(state, op!);
    assert.deepEqual(after.holders.s1?.entries, [
      { memberId: "p2", on: true },
      { memberId: "p1", on: true },
    ]);
    assert.ok(cellSet(after.exploredBy[holderTileKey("s1", "p1", 0, 0)], 4, 8));
  });

  test("with fog off the step writes nothing and still draws every holder's raster and the shared one, before the commit (review PV3-OPUS-4)", () => {
    clearVisionCache();
    const state = corridor();
    state.scenes = { s1: { ...state.scenes.s1!, fogEnabled: false } };
    assert.equal(exploreOp(state), null);
    // p1's and p2's rasters and the shared sight's: three sets.
    assert.equal(visionCacheReport().rasters, 3);
  });

  test("each fan-out finds the raster the step before it drew for its state before, so it draws none again (design 8.1)", () => {
    clearVisionCache();
    // The room's first state has the union computed, as the DM's snapshot computes it, and no holder's raster drawn.
    // So the first fan-out draws one for its state before, which no step read. That must not cost every later fan-out one.
    let before = corridor();
    visionRules.partySight(before, "s1");
    let drawnByLastStep: ReadonlyMap<string, SightTile> | null = null;
    for (let step = 1; step <= 4; step++) {
      const a = before.tokens.a!;
      const after = { ...before, tokens: { ...before.tokens, a: { ...a, x: a.x + 1 } } };
      const op = exploreOp(after);
      const committed = op ? applied(after, op) : after;
      const drawn = visionRules.holderSight(committed, "s1", "p1").tiles;
      changedSightKeys(before, committed, ["s1"]);
      if (drawnByLastStep) assert.equal(visionRules.holderSight(before, "s1", "p1").tiles, drawnByLastStep, `step ${step}'s fan-out read the raster step ${step - 1} drew`);
      drawnByLastStep = drawn;
      before = committed;
    }
  });
});

/**
 * Seven players, each owning one character on a bright per-player scene
 * with fog off, so the step only joins. The characters' ids order them
 * apart from their players' ids.
 */
function seven(): RoomState {
  const state = room();
  for (let i = 1; i <= 8; i++) state.members[`p${i}`] = member(`p${i}`);
  state.scenes = { s1: scene("s1", { vision: { on: true, light: "bright", perPlayer: true } }) };
  const owners = ["p5", "p3", "p1", "p7", "p2", "p6", "p4"];
  owners.forEach((id, i) => (state.tokens[`t${i + 1}`] = token(`t${i + 1}`, { kind: "pc", ownerIds: [id], x: 2 + 3 * i, y: 4, actor: { inline: actor() } })));
  // Creatures that are no source: the DM's own character, a fallen one, a hidden one and an object.
  state.tokens.t0 = token("t0", { kind: "pc", ownerIds: ["dm1"], x: 30, y: 10, actor: { inline: actor() } });
  state.tokens.t8 = token("t8", { kind: "pc", ownerIds: ["p8"], x: 31, y: 10, actor: { inline: actor({ life: "dead" }) } });
  state.tokens.t9 = token("t9", { kind: "pc", ownerIds: ["p8"], x: 32, y: 10, visibility: "dm", actor: { inline: actor() } });
  state.tokens.t10 = token("t10", { kind: "object", ownerIds: ["p8"], x: 33, y: 10, actor: { inline: actor() } });
  return state;
}

function withCap<T>(cap: number, body: () => T): T {
  const limits = LIMITS as { sightHoldersPerScene: number };
  const was = limits.sightHoldersPerScene;
  limits.sightHoldersPerScene = cap;
  try {
    return body();
  } finally {
    limits.sightHoldersPerScene = was;
  }
}

describe("the explore step's joins", () => {
  for (const cap of [6, 5]) {
    test(`at a cap of ${cap}, players join in their sources' order, ticked while fewer than ${cap} are`, () => {
      clearVisionCache();
      withCap(cap, () => {
        const state = seven();
        const op = exploreOp(state);
        const order = ["p5", "p3", "p1", "p7", "p2", "p6", "p4"];
        assert.deepEqual(
          op?.join,
          order.map((memberId, i) => ({ memberId, on: i < cap })),
        );
        const after = applied(state, op!);
        assert.equal(after.holders.s1?.entries.filter((e) => e.on).length, cap);
        assert.equal(exploreOp(after), null, "everyone who owns a source has an entry now");
      });
    });

    test(`at a cap of ${cap}, a list already at the cap takes a newcomer unticked, and one under it ticks them`, () => {
      clearVisionCache();
      withCap(cap, () => {
        const state = seven();
        const listed = ["p1", "p2", "p3", "p4", "p5"];
        state.holders = { s1: { sceneId: "s1", rev: 0, entries: listed.map((memberId) => ({ memberId, on: true })) } };
        assert.deepEqual(exploreOp(state)?.join, [
          { memberId: "p7", on: cap > 5 },
          { memberId: "p6", on: false },
        ]);
        // An entry that is off holds no place, nor one for a member who is no player.
        state.holders.s1!.entries[0] = { memberId: "p1", on: false };
        assert.deepEqual(exploreOp(state)?.join, [
          { memberId: "p7", on: true },
          { memberId: "p6", on: cap > 5 },
        ]);
        state.members.p2 = { ...state.members.p2!, kind: "dm" };
        assert.deepEqual(exploreOp(state)?.join, [
          { memberId: "p7", on: true },
          { memberId: "p6", on: true },
        ]);
      });
    });
  }

  test("a Blinded creature is still a source, so its player joins, and joins ticked with fog on (review PV3-OPUS-7)", () => {
    clearVisionCache();
    const state = room();
    state.scenes = { s1: scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } }) };
    state.tokens.a = token("a", { kind: "pc", ownerIds: ["p1"], x: 4, y: 4, actor: dark() });
    const result = applyOp(state, { t: "actor.effect.add", target: { tokenId: "a" }, effect: { id: "b1", key: "blinded" } }, { memberId: "dm1", role: "dm" }, env(2));
    assert.ok(result.ok);
    const blinded = result.state;
    assert.ok(visionReport(blinded, "s1", { walls: sceneWalls }).members.some((m) => m.tokenId === "a" && m.lends), "it lends sight");
    const op = exploreOp(blinded);
    assert.deepEqual(op?.join, [{ memberId: "p1", on: true }]);
    assert.ok(applied(blinded, op!).holders.s1?.entries.some((e) => e.memberId === "p1" && e.on));
  });

  test("a shared character's players join by id, and a companion after the creatures the DM marked", () => {
    clearVisionCache();
    const state = room();
    state.members.p3 = member("p3");
    state.scenes = { s1: scene("s1", { vision: { on: true, light: "bright", perPlayer: true } }) };
    state.characters.c1 = character("c1", { ownerIds: ["p2", "p1"] });
    state.tokens.z = token("z", { kind: "pc", actor: { ref: "c1" }, x: 3, y: 3 });
    assert.deepEqual(exploreOp(state)?.join, [
      { memberId: "p1", on: true },
      { memberId: "p2", on: true },
    ]);
    // A new collection, as the reducer writes one: the vision rules keep what they read by its identity.
    state.tokens = { ...state.tokens, a: token("a", { kind: "npc", companion: { of: "c1", turn: "shared" }, ownerIds: ["p3"], x: 5, y: 3, actor: { inline: actor() } }) };
    const sources = visionReport(state, "s1", { walls: sceneWalls }).members.filter((m) => m.lends).map((m) => m.tokenId);
    assert.deepEqual(sources, ["z", "a"], "the companion comes last in the cap's order");
    assert.deepEqual(exploreOp(state)?.join, [
      { memberId: "p1", on: true },
      { memberId: "p2", on: true },
      { memberId: "p3", on: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Random sequences

/**
 * The step after many random events (docs/design-v1-per-player-vision.md
 * 6.1 and 6.3), each event an op as the DM or the server applies it, then
 * the step and its op applied as the actor applies it. After each step:
 *
 * - X1, the op: it validates and the reducer applies it.
 * - X2, joins: exactly the players with no entry who own a source now, in
 *   the sources' order then by id, each ticked while fewer than the cap in
 *   force are, so no more than the cap are on after it, unless the DM's
 *   ticks or a higher cap put more on before.
 * - X3, the party's layer: it holds all the shared sight sees afterward,
 *   and the op adds there only what the shared sight sees.
 * - X4, a holder's layer: their layer and the party's together hold all
 *   their sight sees afterward, and the op adds to theirs only what they
 *   see and the party's layer does not hold.
 * - X5, no layer for anyone else: only players whose entry is on get one.
 * - X6, settled: a second step at once writes nothing.
 * - X7, branches: nothing behind a blackout or with vision off, no layers
 *   with fog off, and nothing off the player scene.
 * - X8, the DM's layer is never read: the op is the same with the DM's
 *   fog taken away.
 */
const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

function randomRoom(r: () => number): RoomState {
  const state = room();
  for (const id of PLAYERS.slice(0, chance(r, 0.5) ? 8 : int(r, 2, 7))) state.members[id] = member(id);
  const light = pick(r, ["bright", "dim", "dark"] as const);
  state.scenes = { s1: scene("s1", { bounds: { w: 40, h: 32 }, fogEnabled: chance(r, 0.85), vision: { on: chance(r, 0.9), light, perPlayer: true }, autoWalls: "off" }) };
  const edges: Record<string, EdgeFeature> = {};
  const walls = int(r, 0, 30);
  for (let i = 0; i < walls; i++) edges[`${int(r, 0, 15)},${int(r, 0, 15)},${pick(r, ["n", "w"])}`] = { kind: "wall" };
  if (Object.keys(edges).length > 0) state.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges } };
  const players = Object.keys(state.members).filter((id) => state.members[id]!.kind === "player");
  const creatures = int(r, 1, 12);
  for (let i = 0; i < creatures; i++) {
    const owners = chance(r, 0.2) ? [players[i % players.length]!, pick(r, players)] : chance(r, 0.85) ? [players[i % players.length]!] : [];
    state.tokens[`c${i}`] = token(`c${i}`, { kind: pick(r, ["pc", "pc", "npc", "monster"] as const), ownerIds: [...new Set(owners)], partyVision: chance(r, 0.15) || undefined, x: int(r, 0, 38), y: int(r, 0, 30), actor: dark(chance(r, 0.6) ? "darkvision 60 ft" : "") });
  }
  return state;
}

function randomEvent(r: () => number, state: RoomState): { op: Op; by: "dm" | "server" } {
  const players = Object.keys(state.members).filter((id) => state.members[id]!.kind === "player");
  const ids = Object.keys(state.tokens);
  const roll = r();
  const tokenId = pick(r, ids);
  if (roll < 0.35) return { op: { t: "token.move", tokenId, x: int(r, 0, 38), y: int(r, 0, 30) }, by: "dm" };
  if (roll < 0.45) return { op: { t: "token.update", tokenId, patch: { ownerIds: players.filter(() => chance(r, 0.3)) } }, by: "dm" };
  if (roll < 0.5) return { op: { t: "token.update", tokenId, patch: { partyVision: chance(r, 0.5) } }, by: "dm" };
  if (roll < 0.55) return { op: { t: "actor.life", target: { tokenId }, life: pick(r, ["alive", "alive", "dead"] as const) }, by: "dm" };
  // Blinded keeps a creature a source (review PV3-OPUS-7). A removal of an effect it lacks is refused, and the step still runs.
  if (roll < 0.6) return { op: chance(r, 0.6) ? { t: "actor.effect.add", target: { tokenId }, effect: { id: `blind-${tokenId}`, key: "blinded" } } : { t: "actor.effect.remove", target: { tokenId }, effectId: `blind-${tokenId}` }, by: "dm" };
  if (roll < 0.65) return { op: { t: "vision.holders", sceneId: "s1", on: players.filter(() => chance(r, 0.5)).slice(0, LIMITS.sightHoldersPerScene) }, by: "dm" };
  if (roll < 0.7) return { op: { t: "view.blackout", blackout: chance(r, 0.3) }, by: "dm" };
  if (roll < 0.76) return { op: { t: "scene.update", sceneId: "s1", patch: chance(r, 0.5) ? { fogEnabled: chance(r, 0.8) } : { vision: { on: chance(r, 0.85), light: pick(r, ["bright", "dim", "dark"] as const) } } }, by: "dm" };
  if (roll < 0.82) {
    const x = int(r, 0, 30);
    const y = int(r, 0, 24);
    return { op: { t: "fog.live", sceneId: "s1", ops: [{ id: `f${int(r, 0, 1e9)}`, mode: pick(r, ["reveal", "hide"] as const), shape: { kind: "rect", x, y, w: int(r, 1, 10), h: int(r, 1, 8) } }] }, by: "dm" };
  }
  if (roll < 0.87 && players.length < PLAYERS.length) {
    const id = PLAYERS.find((p) => !state.members[p])!;
    return { op: { t: "sys.memberJoin", member: { id, name: id, color: "#00ff00", kind: "player", createdAt: "2026-10-25T00:00:00.000Z" } }, by: "server" };
  }
  if (roll < 0.9 && players.length > 1) return { op: { t: "sys.memberSetKind", memberId: pick(r, players), kind: "dm" }, by: "server" };
  if (roll < 0.93 && players.length > 1) return { op: { t: "sys.memberRemove", memberId: pick(r, players) }, by: "server" };
  return { op: { t: "token.move", tokenId, x: int(r, 0, 38), y: int(r, 0, 30) }, by: "dm" };
}

function seenAt(state: RoomState, memberId: string | null, tx: number, ty: number): Uint8Array {
  const tile = visionRules.holderSight(state, "s1", memberId).tiles.get(`${tx},${ty}`);
  return tile ? seenFogBits(tile) : new Uint8Array(TILE_BYTES);
}

function bitsOf(tile: { bits: string } | undefined): Uint8Array {
  return (tile && decodeTile(tile.bits)) || new Uint8Array(TILE_BYTES);
}

function sourceOwners(state: RoomState): string[] {
  const out: string[] = [];
  for (const m of visionReport(state, "s1", { walls: sceneWalls }).members) {
    const t = state.tokens[m.tokenId];
    if (!m.lends || !t) continue;
    const c = "ref" in t.actor ? state.characters[t.actor.ref] : undefined;
    for (const id of [...new Set([...t.ownerIds, ...(c?.ownerIds ?? [])])].sort()) if (state.members[id]?.kind === "player" && !out.includes(id)) out.push(id);
  }
  return out;
}

function checkStep(state: RoomState, where: string): RoomState {
  const op = exploreOp(state);
  const scene = state.scenes.s1!;
  const on = (s: RoomState) => (s.holders.s1?.entries ?? []).filter((e) => e.on && s.members[e.memberId]?.kind === "player").length;
  // X7
  if (state.meta.view?.blackout === true || scene.vision?.on !== true || state.meta.playerSceneId !== "s1" || !perPlayerScene(scene)) {
    assert.equal(op, null, `${where} X7: nothing explores here`);
    return state;
  }
  // X2
  const listed = new Set((state.holders.s1?.entries ?? []).map((e) => e.memberId));
  const expected = sourceOwners(state).filter((id) => !listed.has(id));
  let count = on(state);
  const joins = expected.map((memberId) => ({ memberId, on: count < LIMITS.sightHoldersPerScene && ++count > 0 }));
  assert.deepEqual(op?.join ?? [], joins, `${where} X2: the joins`);
  if (!scene.fogEnabled) assert.ok(op === null || (op.tiles.length === 0 && op.members === undefined), `${where} X7: no layer with fog off`);
  // X8
  if (op) assert.deepEqual(exploreOp({ ...state, fogTiles: {} }), op, `${where} X8: the DM's layer is not read`);
  if (!op) {
    assert.equal(joins.length, 0, `${where} X2`);
  }
  // X1
  const after = op ? applied(state, op) : state;
  if (op?.join) assert.ok(on(after) <= Math.max(LIMITS.sightHoldersPerScene, on(state)), `${where} X2: the cap`);
  assert.deepEqual(
    sourceOwners(after).filter((id) => !(after.holders.s1?.entries ?? []).some((e) => e.memberId === id)),
    [],
    `${where} X2: every player who owns a source has an entry`,
  );
  if (scene.fogEnabled) {
    const holders = sightHolders(after, "s1");
    // X5
    for (const m of op?.members ?? []) assert.ok(holders.includes(m.memberId), `${where} X5: ${m.memberId} sees for themselves`);
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        const key = tileKey("s1", tx, ty);
        const partyBefore = bitsOf(state.exploredTiles[key]);
        const partyAfter = bitsOf(after.exploredTiles[key]);
        const shared = seenAt(state, null, tx, ty);
        for (let i = 0; i < TILE_BYTES; i++) {
          // X3
          assert.equal(shared[i]! & ~partyAfter[i]!, 0, `${where} X3: tile ${tx},${ty} holds all the shared sight sees`);
          assert.equal(partyAfter[i]! & ~partyBefore[i]! & ~shared[i]!, 0, `${where} X3: tile ${tx},${ty} gains only what the shared sight sees`);
        }
        for (const id of holders) {
          const own = seenAt(after, id, tx, ty);
          const ownBefore = bitsOf(state.exploredBy[holderTileKey("s1", id, tx, ty)]);
          const ownAfter = bitsOf(after.exploredBy[holderTileKey("s1", id, tx, ty)]);
          for (let i = 0; i < TILE_BYTES; i++) {
            // X4
            assert.equal(own[i]! & ~(ownAfter[i]! | partyAfter[i]!), 0, `${where} X4: ${id} remembers all they see at ${tx},${ty}`);
            assert.equal(ownAfter[i]! & ~ownBefore[i]! & ~(own[i]! & ~partyAfter[i]!), 0, `${where} X4: ${id} gains only their own ground at ${tx},${ty}`);
          }
        }
      }
    }
  }
  // X6
  assert.equal(exploreOp(after), null, `${where} X6: settled`);
  return after;
}

describe("the explore step over random events", () => {
  test("keeps X1 to X8 at caps 6 and 5", () => {
    for (let seed = 1; seed <= 40; seed++) {
      clearVisionCache();
      const r = rng(seed);
      withCap(seed % 3 === 0 ? 5 : 6, () => {
        let state = checkStep(randomRoom(r), `seed ${seed} start`);
        for (let step = 0; step < 30; step++) {
          const { op, by } = randomEvent(r, state);
          const result = applyOp(state, op, by === "server" ? SERVER_ACTOR : { memberId: "dm1", role: "dm" }, env(step + 2));
          if (result.ok) state = result.state;
          state = checkStep(state, `seed ${seed} step ${step} after ${op.t}`);
        }
      });
    }
  });
});
