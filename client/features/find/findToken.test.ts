import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, Token } from "#shared/model.ts";
import { character, token } from "#shared/testutil.ts";
import { fitRect, NO_INSETS, viewToScreen } from "../../lib/camera.ts";
import { isometric, TOP_DOWN, toView, viewBox } from "../../lib/view.ts";
import { barCover, largerEach, pastBars } from "../../canvas/barDock.ts";
import { FIND_ROOM_CELLS, findCamera, findRect, findTokenCamera, frameOf, nextOwnToken, sheetCover } from "./findToken.ts";
import { boardPickFor, drawnAt, DrawnHeightsMemo, flatPick, groundIn, ringCenter, tokenBase } from "../../canvas/boardPick.ts";
import { world } from "../movement/testing.ts";

function view(tokens: Token[], characters: Character[] = []) {
  return { tokens: Object.fromEntries(tokens.map((t) => [t.id, t])), characters: Object.fromEntries(characters.map((c) => [c.id, c])) };
}

function presses(v: ReturnType<typeof view>, count: number, memberId = "p1", sceneId = "s1"): (string | null)[] {
  const found: (string | null)[] = [];
  let lastId: string | null = null;
  for (let i = 0; i < count; i++) {
    const next = nextOwnToken({ view: v, sceneId, memberId, lastId });
    found.push(next?.id ?? null);
    lastId = next?.id ?? lastId;
  }
  return found;
}

describe("find my token", () => {
  test("finds nothing when the player owns no token on the scene", () => {
    const v = view([token("t1"), token("t2", { ownerIds: ["p2"] }), token("t3", { ownerIds: ["p1"], sceneId: "s2" })]);
    assert.equal(nextOwnToken({ view: v, sceneId: "s1", memberId: "p1", lastId: null }), null);
  });

  test("finds the one token again on every press", () => {
    const v = view([token("t1", { ownerIds: ["p1"], kind: "pc" }), token("t2")]);
    assert.deepEqual(presses(v, 3), ["t1", "t1", "t1"]);
  });

  test("cycles through several, the character first, then creatures, then objects", () => {
    const v = view([
      token("a-marker", { ownerIds: ["p1"], kind: "object" }),
      token("b-familiar", { ownerIds: ["p1"], kind: "npc" }),
      token("c-hero", { ownerIds: ["p1"], kind: "pc" }),
      token("d-wolf", { ownerIds: ["p1"], kind: "monster" }),
      token("e-goblin"),
    ]);
    assert.deepEqual(presses(v, 5), ["c-hero", "b-familiar", "d-wolf", "a-marker", "c-hero"]);
  });

  test("counts a token owned through its character", () => {
    const v = view([token("t1", { kind: "pc", actor: { ref: "c1" } })], [character("c1", { ownerIds: ["p1"] })]);
    assert.equal(nextOwnToken({ view: v, sceneId: "s1", memberId: "p1", lastId: null })?.id, "t1");
    assert.equal(nextOwnToken({ view: v, sceneId: "s1", memberId: "p2", lastId: null }), null);
  });

  test("starts over when the token found last is gone", () => {
    const v = view([token("t1", { ownerIds: ["p1"] }), token("t2", { ownerIds: ["p1"] })]);
    assert.equal(nextOwnToken({ view: v, sceneId: "s1", memberId: "p1", lastId: "deleted" })?.id, "t1");
  });

  test("fits the token with room around it", () => {
    assert.deepEqual(findRect({ x: 10, y: 6, size: "large" }), {
      x: 10 - FIND_ROOM_CELLS,
      y: 6 - FIND_ROOM_CELLS,
      width: 2 + FIND_ROOM_CELLS * 2,
      height: 2 + FIND_ROOM_CELLS * 2,
    });
  });

  test("keeps clear of a phone's open sheet", () => {
    assert.deepEqual(sheetCover(null), { top: 0, right: 0, bottom: 0, left: 0 });
    assert.deepEqual(sheetCover({ placement: "bottom", width: 390, height: 401.5 }), { top: 0, right: 0, bottom: 402, left: 0 });
    assert.deepEqual(sheetCover({ placement: "right", width: 340, height: 280 }), { top: 0, right: 340, bottom: 0, left: 0 });
  });

  test("zooms to the token between the bars, and centers it there", () => {
    const viewport = { width: 390, height: 844 };
    const bars = { top: 52, right: 0, bottom: 60, left: 0 };
    const target = findRect({ x: 10, y: 6, size: "medium" });
    const cam = findCamera(viewport, target, bars, NO_INSETS);
    assert.deepEqual(cam, fitRect(viewport, viewBox(TOP_DOWN, target), 24, bars));
    // The token's middle lands in the middle of the part the bars leave clear.
    assert.equal(10.5 * cam.scale + cam.x, 195);
    assert.equal(6.5 * cam.scale + cam.y, 52 + (844 - 52 - 60) / 2);
  });

  test("keeps the zoom with a sheet open, and centers the token above it", () => {
    const viewport = { width: 390, height: 844 };
    const bars = { top: 52, right: 0, bottom: 60, left: 0 };
    const target = findRect({ x: 10, y: 6, size: "medium" });
    const cover = sheetCover({ placement: "bottom", width: 390, height: 400 });
    const cam = findCamera(viewport, target, bars, cover);
    assert.equal(cam.scale, fitRect(viewport, viewBox(TOP_DOWN, target), 24, bars).scale);
    assert.equal(6.5 * cam.scale + cam.y, 52 + (844 - 52 - 60 - cover.bottom) / 2);
  });

  test("keeps the zoom with the docked token bar open, and lands the token clear of it", () => {
    const viewport = { width: 920, height: 800 };
    const bars = { top: 52, right: 0, bottom: 60, left: 0 };
    const target = findRect({ x: 30, y: 6, size: "medium" });
    // The bar in the lane covers the right 312 px and the 8 px margin past the bars (canvas/barDock.ts barCover).
    const cover = largerEach(NO_INSETS, pastBars(barCover(viewport, bars, { box: { left: 608, top: 300, width: 304, height: 432 }, laneLeft: 600, freeRight: 912 }), bars));
    const cam = findCamera(viewport, target, bars, cover);
    assert.equal(cam.scale, fitRect(viewport, viewBox(TOP_DOWN, target), 24, bars).scale);
    const x = 30.5 * cam.scale + cam.x;
    assert.equal(x, (920 - 320) / 2);
    assert.ok(x + 0.5 * cam.scale <= 600, "the token ends left of the bar");
  });

  test("a sheet that leaves no map centers between the bars instead", () => {
    const viewport = { width: 390, height: 300 };
    const bars = { top: 52, right: 0, bottom: 60, left: 0 };
    const target = findRect({ x: 10, y: 6, size: "medium" });
    const cam = findCamera(viewport, target, bars, { top: 0, right: 0, bottom: 250, left: 0 });
    assert.equal(6.5 * cam.scale + cam.y, 52 + (300 - 52 - 60) / 2);
  });
});

describe("Find my token on raised ground, in a pit and in the air (ISO34-ASTRA-2)", () => {
  const viewport = { width: 800, height: 600 };
  const bars = { top: 56, right: 0, bottom: 64, left: 0 };
  // A 20 ft platform over cells 8 to 13 each way, and a 10 ft pit over cells 2 to 5.
  const heights: Record<string, number> = {};
  for (let y = 8; y < 14; y++) for (let x = 8; x < 14; x++) heights[`${x},${y}`] = 20;
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) heights[`${x},${y}`] = -10;
  const state = world({ heights });
  const cases = [
    { name: "on a 20 ft platform", t: token("t1", { x: 10, y: 10, elevation: 20 }), base: 4 },
    { name: "down in a 10 ft pit", t: token("t2", { x: 3, y: 3, elevation: -10 }), base: -2 },
    { name: "flying 30 ft over flat ground", t: token("t3", { x: 20, y: 4, elevation: 30 }), base: 6 },
    { name: "on the ground beside the 20 ft platform", t: token("t4", { x: 6, y: 10 }), base: 0 },
  ];
  for (const c of cases) {
    test(`its ring shows in the middle of the map left clear, and the room round it fits, ${c.name}, at every turn`, () => {
      for (const turn of [0, 1, 2, 3] as const) {
        const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera: { x: 0, y: 0, scale: 40 }, lowPower: false }, new DrawnHeightsMemo());
        const target = findRect(c.t);
        assert.equal(tokenBase(pick, c.t), c.base);
        const cam = findCamera(viewport, target, bars, NO_INSETS, frameOf(pick, target, tokenBase(pick, c.t)));
        const ring = ringCenter({ ...pick, camera: cam }, c.t);
        assert.ok(Math.abs(ring.x - 400) < 1e-6 && Math.abs(ring.y - (56 + (600 - 120) / 2)) < 1e-6, `turn ${turn}: ${JSON.stringify(ring)}`);
        // The room's ground, every cell's top where it is raised, inside the map left clear.
        for (let y = target.y; y < target.y + target.height - 1e-9; y++) {
          for (let x = target.x; x < target.x + target.width - 1e-9; x++) {
            const z = Math.max(0, drawnAt(pick, { x: x + 0.01, y: y + 0.01 }));
            for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
              const at = viewToScreen(cam, toView(isometric(turn), { x: Math.min(x + dx, target.x + target.width), y: Math.min(y + dy, target.y + target.height) }, z));
              assert.ok(at.x >= -1e-6 && at.x <= 800 + 1e-6 && at.y >= 56 - 1e-6 && at.y <= 600 - 64 + 1e-6, `turn ${turn}, cell ${x},${y}: ${JSON.stringify(at)}`);
            }
          }
        }
      }
    });
  }

  test("a flier whose lift the zoom caps: its ring centers where it draws at the zoom found, from a close zoom (ISO34-ASTRA-13, OPUS-13)", () => {
    for (const feet of [100, 500, 1000]) {
      const t = token("roc", { x: 20, y: 4, elevation: feet });
      for (const turn of [0, 1, 2, 3] as const) {
        const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(turn), camera: { x: 0, y: 0, scale: 80 }, lowPower: false, canvasHeight: 600 }, new DrawnHeightsMemo());
        const target = findRect(t);
        const cam = findTokenCamera(viewport, target, bars, NO_INSETS, pick, t);
        const ring = ringCenter({ ...pick, camera: cam }, t);
        assert.ok(Math.abs(ring.x - 400) < 1e-6 && Math.abs(ring.y - (56 + (600 - 120) / 2)) < 1e-6, `${feet} ft, turn ${turn}: ${JSON.stringify([ring, cam.scale])}`);
        if (feet > 100) continue;
        // 100 ft fits with its ground at a zoom farther than the cap at 80 px would give, so the ground round it shows too.
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const at = viewToScreen(cam, toView(isometric(turn), { x: target.x + dx * target.width, y: target.y + dy * target.height }, 0));
          assert.ok(at.x >= -1e-6 && at.x <= 800 + 1e-6 && at.y >= 56 - 1e-6 && at.y <= 600 - 64 + 1e-6, `turn ${turn}: the room's corner ${JSON.stringify(at)}`);
        }
      }
    }
    // 1000 ft is capped even at the farthest zoom, so the second pass centers the capped ring there.
    const far = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(0), camera: { x: 0, y: 0, scale: 80 }, lowPower: false, canvasHeight: 600 }, new DrawnHeightsMemo());
    const high = token("roc", { x: 20, y: 4, elevation: 1000 });
    const cam = findTokenCamera(viewport, findRect(high), bars, NO_INSETS, far, high);
    assert.ok(tokenBase({ ...far, camera: cam }, high) < 200, "its lift is capped at the zoom found");
  });

  test("an outline row's box frames on the highest drawn ground under it", () => {
    const pick = boardPickFor({ room: state, scene: state.scenes.s1!, role: "dm", fog: false, view: isometric(0), camera: { x: 0, y: 0, scale: 40 }, lowPower: false }, new DrawnHeightsMemo());
    assert.equal(groundIn(pick, { x: 7.5, y: 9, width: 2, height: 1 }), 4);
    assert.equal(groundIn(pick, { x: 3, y: 3, width: 1, height: 1 }), -2);
    assert.equal(groundIn(flatPick({ x: 0, y: 0, scale: 40 }), { x: 7.5, y: 9, width: 2, height: 1 }), 0);
  });
});

describe("Find my token in Isometric (docs/design-v1-isometric-view.md 4.2)", () => {
  test("the found token's middle shows in the middle of the map left clear, at every turn", () => {
    const viewport = { width: 390, height: 844 };
    const bars = { top: 56, right: 0, bottom: 64, left: 0 };
    const target = findRect(token("t1", { x: 12, y: 7 }));
    for (const turn of [0, 1, 2, 3] as const) {
      const cam = findCamera(viewport, target, bars, NO_INSETS, { view: isometric(turn), lift: 0, z: 0 });
      const shown = viewToScreen(cam, toView(isometric(turn), { x: target.x + target.width / 2, y: target.y + target.height / 2 }));
      assert.ok(Math.abs(shown.x - 195) < 1e-9 && Math.abs(shown.y - (56 + (844 - 120) / 2)) < 1e-9, `turn ${turn}`);
      // The room around it fits as the board draws it, a diamond wider than the square it stands for.
      for (const c of [
        { x: target.x, y: target.y },
        { x: target.x + target.width, y: target.y },
        { x: target.x, y: target.y + target.height },
        { x: target.x + target.width, y: target.y + target.height },
      ]) {
        const at = viewToScreen(cam, toView(isometric(turn), c));
        assert.ok(at.x >= 0 && at.x <= 390 && at.y >= 56 && at.y <= 844 - 64, `turn ${turn}, corner ${c.x},${c.y}`);
      }
    }
  });
});

