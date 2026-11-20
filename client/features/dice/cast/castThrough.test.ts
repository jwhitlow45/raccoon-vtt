import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANA, BREE, GROUND, UPPER, thornToken, tower, withOpening } from "#shared/floorLinksTestutil.ts";
import type { AreaTemplate, FloorLink, RoomState, Token, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { castAsk, deepClone, reveal, template, token } from "#shared/testutil.ts";
import { caughtTokens, contextFrom, inAreaEntries, inAreaText } from "../../areas/coverage.ts";
import { liveGroundOf } from "../../areas/liveGround.ts";
import { namesAcross, throughInputs } from "../../areas/through.ts";
import { askCaught, castCardText } from "./castStart.ts";

/*
 * A player's ask for saves on an area over an opening
 * (docs/design/design-v1-floors.md phase 4, 9.2): the DM's card counts what
 * the DM's page will catch, across the opening and hidden creatures
 * included, and the player's block names what their device reaches by the
 * gate every device reads alike (areas/through.ts), so an opening they were
 * not sent reads as none.
 */

const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const goblin = (id: string, sceneId: string, x: number, y: number, over: Partial<Token> = {}): Token => token(id, { name: id === "kobold" ? "Kobold" : "Goblin", sceneId, x, y, ...over });
/** Ana's Fireball, cast by Thorn, over the hole upstairs. */
const FIREBALL: AreaTemplate = template("a1", { sceneId: UPPER, size: 20, origin: { x: 7, y: 7, z: 0 }, ownerId: "p1", casterId: "thorn", spell: "Fireball" });

/** Thorn upstairs at 2, 2, a kobold beside the hole there, a goblin below it, Upper floor reached, Ana's Fireball over the hole, and the opening unless told. */
function room(over: { opening?: boolean; tokens?: Token[] } = {}): RoomState {
  const tokens = [thornToken({ sceneId: UPPER, x: 2, y: 2 }), goblin("kobold", UPPER, 8, 8), goblin("below", GROUND, 6, 6), ...(over.tokens ?? [])];
  const base = tower({ tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), templates: { a1: FIREBALL }, openFloors: { [UPPER]: { sceneId: UPPER, rev: 1 } } });
  return over.opening === false ? base : withOpening(base);
}

const copyOf = (state: RoomState, viewer: Viewer): RoomState => projectState(state, viewer, { sceneId: state.meta.playerSceneId }) as unknown as RoomState;

/** A block's In area line on a viewer's device, as CastBlock reads it: the area's floor and the openings its copy holds, on its live ground. */
function blockLine(state: RoomState, viewer: Viewer, area: AreaTemplate = FIREBALL): string {
  const copy = copyOf(state, viewer);
  const scene = copy.scenes[UPPER]!;
  const live = liveGroundOf({ scene, role: "player", fogTiles: copy.fogTiles, sight: {} });
  const ctx = contextFrom({ tokens: copy.tokens, buildChunks: copy.buildChunks, settings: copy.meta.settings, ...(live ? { live } : {}) }, scene);
  const across = throughInputs(copy, UPPER, "player");
  return inAreaText(inAreaEntries(caughtTokens(area, ctx, UPPER, across), namesAcross(copy.tokens, across), copy.characters, new Map()));
}

describe("the DM's card counts what the page will catch", () => {
  test("the goblin below and a hidden one beside it, as the page's rows read them", () => {
    const s = room();
    assert.deepEqual(askCaught(s, FIREBALL, throughInputs(s, UPPER, "dm")), ["kobold", "below"]);
    const hidden = room({ tokens: [goblin("lurker", GROUND, 7, 7, { visibility: "dm" })] });
    assert.deepEqual(askCaught(hidden, FIREBALL, throughInputs(hidden, UPPER, "dm")), ["kobold", "below", "lurker"]);
    const ask = castAsk("k1", { sceneId: UPPER, area: "a1", caster: "thorn" });
    assert.equal(castCardText(hidden, ask, { viewing: UPPER, caught: askCaught(hidden, FIREBALL, throughInputs(hidden, UPPER, "dm")).length, labels: new Map() }).where, "In the area: 3");
  });

  test("no opening, or none given, counts the area's floor alone", () => {
    const s = room({ opening: false });
    assert.deepEqual(askCaught(s, FIREBALL, throughInputs(s, UPPER, "dm")), ["kobold"]);
    assert.deepEqual(askCaught(room(), FIREBALL, undefined), ["kobold"]);
    assert.deepEqual(askCaught(room(), { ...FIREBALL, sceneId: "gone" }, undefined), [], "an area on a floor the view lacks");
  });
});

describe("the player's block names what their device reaches", () => {
  test("Ana's, Bree's and the display's line names the goblin below, never a hidden one", () => {
    const s = room({ tokens: [goblin("lurker", GROUND, 7, 7, { visibility: "dm" })] });
    for (const viewer of [ANA, BREE, DISPLAY]) assert.equal(blockLine(s, viewer), "Goblin, Kobold", viewer.memberId);
  });

  /** Fog on upstairs, revealed everywhere but the hole's squares, so no player is sent its end, and fog off below. */
  function unsent(opening: boolean): RoomState {
    const s = deepClone(room({ opening }));
    s.scenes[UPPER] = { ...s.scenes[UPPER]!, fogEnabled: true };
    for (const r of [{ x: 0, y: 0, w: 20, h: 6 }, { x: 0, y: 8, w: 20, h: 12 }, { x: 0, y: 6, w: 6, h: 2 }, { x: 8, y: 6, w: 12, h: 2 }]) reveal(s, UPPER, r);
    return s;
  }

  test("twin: an opening whose end lies under full fog names what no opening does", () => {
    // Cast from beside the hole, so its rays to the kobold cross no fog.
    const beside = { ...FIREBALL, origin: { x: 9, y: 9, z: 0 } };
    const [a, b] = [unsent(true), unsent(false)];
    assert.equal(copyOf(a, ANA).floorLinks?.o1, undefined, "Ana was not sent the end");
    for (const viewer of [ANA, BREE, DISPLAY]) {
      assert.equal(blockLine(a, viewer, beside), blockLine(b, viewer, beside), viewer.memberId);
      assert.equal(blockLine(a, viewer, beside), "Kobold", viewer.memberId);
    }
    const shown = deepClone(a);
    reveal(shown, UPPER, { x: 6, y: 6, w: 2, h: 2 });
    assert.equal(blockLine(shown, ANA, beside), "Goblin, Kobold", "once the end is sent, the goblin below");
  });

  test("twin: a hidden end names what no opening does", () => {
    const s = room();
    const hidden: RoomState = { ...s, floorLinks: Object.fromEntries(Object.entries(s.floorLinks ?? {}).map(([id, l]) => [id, { ...(l as FloorLink), hidden: true as const }])) };
    for (const viewer of [ANA, BREE, DISPLAY]) assert.equal(blockLine(hidden, viewer), blockLine(room({ opening: false }), viewer), viewer.memberId);
    assert.equal(blockLine(hidden, ANA), "Kobold");
  });
});

describe("the names a line reads across an opening", () => {
  test("the floor's own tokens with those across added, the same object while neither changes", () => {
    const s = room();
    const own: Record<string, Token> = { kobold: s.tokens.kobold! };
    const across = throughInputs(s, UPPER, "dm");
    const names = namesAcross(own, across);
    assert.deepEqual(Object.keys(names).sort(), ["below", "kobold"]);
    assert.equal(namesAcross(own, across), names);
    assert.equal(namesAcross(own, undefined), own, "no opening, the floor's own");
  });
});
